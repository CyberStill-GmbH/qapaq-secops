/**
 * Excepción demo: acceso con usuario y contraseña de UNA cuenta administrativa sintética.
 *
 * Es una excepción temporal y consciente a la política vigente (MFA dentro de la red, passkey
 * fuera; docs/04-identidad-y-acceso.md, sección «Excepción demo: contraseña del administrador»).
 * Este módulo reúne lo que la hace acotada y verificable:
 *
 * - **Credencial**: solo un hash scrypt autodescrito (`$scrypt$ln=…,r=…,p=…$sal$clave`), con
 *   N ≥ 2^15 y sal ≥ 16 bytes. Un hash mal formado o con parámetros débiles impide arrancar.
 *   La comprobación cuesta lo mismo para un usuario inexistente que para una contraseña
 *   errónea (siempre se calcula el scrypt con la sal configurada) y compara en tiempo constante.
 * - **Identidad**: una sola persona sintética con `sub` estable `demo-admin:<hash corto>`, el rol
 *   `qapaq.platform.admin` y nada más, `amr: ['pwd']` (no se inventa MFA). No tiene `oid`: no
 *   cruza con el padrón de Entra ni hereda grants.
 * - **JWT**: tras verificar la contraseña se emite un código de un solo uso (ligado al `nonce` y
 *   al `code_verifier` PKCE del handshake) que se canjea por un JWT RS256 firmado con una clave
 *   generada en memoria en cada arranque. El runtime lo valida con el mismo `validateIdToken` que
 *   el token de Entra, contra el JWKS propio de este emisor. El JWT nunca sale del proceso: la
 *   persona recibe solo la cookie HttpOnly de una sesión servidor-side revocable.
 * - **Vigencia**: `activeAt` corta en `until` sin reinicio; el runtime invalida además las
 *   sesiones de esta cuenta al vencer.
 * - **Cuentas adicionales** (opcional, `QAPAQ_DEMO_ACCOUNTS`): hasta `DEMO_ACCOUNTS_MAX` cuentas
 *   sintéticas más, cada una con exactamente uno de los cuatro roles runtime (nunca un rol
 *   aprobador). Comparten emisor, clave, vencimiento, tope de intentos y verificación en tiempo
 *   constante con el administrador; cada una tiene su propio `sub` (derivado de usuario y rol), así
 *   que la sesión única es por cuenta y un cambio de rol invalida las sesiones anteriores.
 */

import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

import type { JsonWebKey, JwksProvider, TokenExchange, TokenExchangeResult } from '@qapaq/access';
import {
  ConfigurationError,
  DEMO_ACCOUNT_ROLES,
  DEMO_ACCOUNTS_MAX,
  type ConfigurationProfileName,
  type DemoAccountRole,
} from '@qapaq/configuration';

/** Único rol que concede la excepción. */
export const DEMO_ADMIN_ROLE = 'qapaq.platform.admin';
export const DEMO_ADMIN_SUBJECT_PREFIX = 'demo-admin:';
/** Vida absoluta máxima de una sesión abierta por la excepción (nunca más allá de `until`). */
export const DEMO_ADMIN_SESSION_MAX_MS = 8 * 60 * 60 * 1000;
/** Vida del JWT: solo existe para cruzar el canje y la validación dentro del proceso. */
export const DEMO_ADMIN_TOKEN_TTL_SECONDS = 300;
/** Política mínima de contraseña al generar el hash. */
export const DEMO_ADMIN_PASSWORD_MIN_LENGTH = 14;
export const DEMO_ADMIN_PASSWORD_MAX_LENGTH = 256;
/** Tope propio de intentos de la ruta por origen, además del límite de tasa general. */
export const DEMO_ADMIN_ATTEMPT_POLICY = Object.freeze({
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
  /** Verificaciones scrypt simultáneas: protege CPU y memoria del proceso. */
  maxConcurrentVerifications: 4,
});

export const SCRYPT_LIMITS = Object.freeze({
  minLogN: 15,
  maxLogN: 17,
  minR: 8,
  maxR: 16,
  minP: 1,
  maxP: 4,
  minSaltBytes: 16,
  maxSaltBytes: 64,
  minKeyBytes: 32,
  maxKeyBytes: 64,
  /** Memoria de una verificación (128·N·r); acota hashes que tumbarían el proceso. */
  maxMemoryBytes: 128 * 1024 * 1024,
});

/** Parámetros por defecto del script de generación (scripts/dev/hash-demo-admin-password.mjs). */
export const SCRYPT_DEFAULTS = Object.freeze({ logN: 16, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });

const CODE_TTL_MS = 60_000;
const BASE64 = '[A-Za-z0-9+/]+';
const SCRYPT_FORMAT = new RegExp(
  `^\\$scrypt\\$ln=(\\d{1,2}),r=(\\d{1,2}),p=(\\d{1,2})\\$(${BASE64})\\$(${BASE64})$`,
  'u',
);

export interface ScryptHash {
  readonly logN: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function decodeBase64(value: string): Buffer | undefined {
  // Sin relleno, como en el formato PHC; un resto de 1 carácter no es base64 válido.
  if (value.length % 4 === 1) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64').replace(/=+$/u, '') === value ? decoded : undefined;
}

/** Interpreta un hash autodescrito; `undefined` si la forma o los parámetros no cumplen. */
export function parseScryptHash(text: string): ScryptHash | undefined {
  const match = SCRYPT_FORMAT.exec(text);
  if (!match) return undefined;
  const [logN, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const salt = decodeBase64(match[4]!);
  const key = decodeBase64(match[5]!);
  if (
    !salt ||
    !key ||
    logN < SCRYPT_LIMITS.minLogN ||
    logN > SCRYPT_LIMITS.maxLogN ||
    r < SCRYPT_LIMITS.minR ||
    r > SCRYPT_LIMITS.maxR ||
    p < SCRYPT_LIMITS.minP ||
    p > SCRYPT_LIMITS.maxP ||
    salt.length < SCRYPT_LIMITS.minSaltBytes ||
    salt.length > SCRYPT_LIMITS.maxSaltBytes ||
    key.length < SCRYPT_LIMITS.minKeyBytes ||
    key.length > SCRYPT_LIMITS.maxKeyBytes ||
    scryptMemory(logN, r) > SCRYPT_LIMITS.maxMemoryBytes
  ) {
    return undefined;
  }
  return { logN, r, p, salt, key };
}

export function formatScryptHash(hash: ScryptHash): string {
  const encode = (value: Buffer) => value.toString('base64').replace(/=+$/u, '');
  return `$scrypt$ln=${hash.logN},r=${hash.r},p=${hash.p}$${encode(hash.salt)}$${encode(hash.key)}`;
}

function scryptMemory(logN: number, r: number): number {
  return 128 * 2 ** logN * r;
}

function passwordBytes(password: string): Buffer {
  return Buffer.from(password.normalize('NFC'), 'utf8');
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  logN: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passwordBytes(password),
      salt,
      keyLength,
      { N: 2 ** logN, r, p, maxmem: 2 * scryptMemory(logN, r) },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Valida la política mínima; devuelve el motivo o `undefined` si la contraseña la cumple. */
export function demoAdminPasswordPolicyViolation(password: string): string | undefined {
  const length = [...password.normalize('NFC')].length;
  if (length < DEMO_ADMIN_PASSWORD_MIN_LENGTH) return 'TOO_SHORT';
  if (length > DEMO_ADMIN_PASSWORD_MAX_LENGTH) return 'TOO_LONG';
  if (password.trim() !== password) return 'SURROUNDING_WHITESPACE';
  return undefined;
}

/** Genera el hash autodescrito. Rechaza contraseñas que no cumplen la política mínima. */
export async function hashDemoAdminPassword(
  password: string,
  options: { readonly logN?: number; readonly salt?: Buffer } = {},
): Promise<string> {
  const violation = demoAdminPasswordPolicyViolation(password);
  if (violation) throw new Error(`DEMO_ADMIN_PASSWORD_${violation}`);
  const logN = options.logN ?? SCRYPT_DEFAULTS.logN;
  const salt = options.salt ?? randomBytes(SCRYPT_DEFAULTS.saltBytes);
  const key = await deriveKey(
    password,
    salt,
    SCRYPT_DEFAULTS.keyBytes,
    logN,
    SCRYPT_DEFAULTS.r,
    SCRYPT_DEFAULTS.p,
  );
  const formatted = formatScryptHash({
    logN,
    r: SCRYPT_DEFAULTS.r,
    p: SCRYPT_DEFAULTS.p,
    salt,
    key,
  });
  if (!parseScryptHash(formatted)) throw new Error('DEMO_ADMIN_HASH_PARAMETERS_INVALID');
  return formatted;
}

/** Comprueba una contraseña contra el hash, en tiempo constante respecto a su contenido. */
export async function verifyScryptPassword(password: string, hash: ScryptHash): Promise<boolean> {
  const derived = await deriveKey(
    password.slice(0, DEMO_ADMIN_PASSWORD_MAX_LENGTH),
    hash.salt,
    hash.key.length,
    hash.logN,
    hash.r,
    hash.p,
  );
  return timingSafeEqual(derived, hash.key);
}

/** `sub` de una cuenta demo adicional: depende del usuario y del rol (cambiar el rol lo cambia). */
export function demoAccountSubjectOf(username: string, role: string): string {
  const digest = createHash('sha256')
    .update(`qapaq-demo-account:${role}:${username}`, 'utf8')
    .digest('hex');
  return `${DEMO_ADMIN_SUBJECT_PREFIX}${digest.slice(0, 16)}`;
}

const ROLE_DISPLAY_NAMES: Readonly<Record<DemoAccountRole, string>> = Object.freeze({
  'qapaq.platform.admin': 'Administrador demo',
  'qapaq.soc.analyst': 'Analista SOC demo',
  'qapaq.soc.lead': 'Líder SOC demo',
  'qapaq.auditor': 'Auditor demo',
});

/** Cuenta sintética ya validada: el hash se conserva interpretado, nunca su texto. */
export interface DemoAccount {
  readonly username: string;
  readonly role: DemoAccountRole;
  readonly subjectId: string;
  readonly displayName: string;
  readonly hash: ScryptHash;
  readonly usernameDigest: Buffer;
}

export interface DemoAccountOptions {
  readonly username: string;
  readonly role: string;
  /** Hash autodescrito; se valida aquí y su texto no se conserva. */
  readonly passwordHash: string;
}

export function isDemoAdminSubject(subjectId: string): boolean {
  return subjectId.startsWith(DEMO_ADMIN_SUBJECT_PREFIX);
}

/** `sub` estable derivado del usuario: no revela el usuario y no cambia entre arranques. */
export function demoAdminSubjectOf(username: string): string {
  const digest = createHash('sha256').update(`qapaq-demo-admin:${username}`, 'utf8').digest('hex');
  return `${DEMO_ADMIN_SUBJECT_PREFIX}${digest.slice(0, 16)}`;
}

export interface DemoAdminLoginOptions {
  readonly username: string;
  /** Hash autodescrito; se valida aquí y su texto no se conserva. */
  readonly passwordHash: string;
  readonly until: Date;
  /** Emisor propio del JWT; distinto del de Entra para que sus claves nunca se mezclen. */
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly profile: ConfigurationProfileName;
  /** Cuentas demo adicionales (`QAPAQ_DEMO_ACCOUNTS`); como máximo `DEMO_ACCOUNTS_MAX`. */
  readonly accounts?: readonly DemoAccountOptions[];
}

export type DemoAdminVerification = 'match' | 'mismatch' | 'busy';

export type DemoAccountAuthentication =
  | { readonly result: 'match'; readonly account: DemoAccount }
  | { readonly result: 'mismatch' | 'busy' };

interface IssuedCode {
  readonly subjectId: string;
  readonly nonce: string;
  readonly codeVerifierDigest: Buffer;
  readonly expiresAt: number;
}

export class DemoAdminLogin {
  /** `sub` del administrador (compatibilidad: la cuenta original de la excepción). */
  public readonly subjectId: string;
  public readonly username: string;
  public readonly until: Date;
  public readonly issuer: string;
  public readonly jwks: readonly JsonWebKey[];
  /** Administrador primero; después, las cuentas adicionales en el orden configurado. */
  public readonly accounts: readonly DemoAccount[];
  readonly #bySubject: ReadonlyMap<string, DemoAccount>;
  readonly #privateKey: KeyObject;
  readonly #kid: string;
  readonly #codes = new Map<string, IssuedCode>();
  readonly #attempts = new Map<string, { count: number; windowStartedAt: number }>();
  #inFlight = 0;

  public constructor(private readonly options: DemoAdminLoginOptions) {
    // Solo el nombre de la variable: ni el usuario ni el hash llegan al error.
    const invalid = (path: string, message: string) =>
      new ConfigurationError({
        code: 'CONFIG_VALUE_INVALID',
        message,
        path,
        profile: options.profile,
      });
    const hash = parseScryptHash(options.passwordHash);
    if (!hash) {
      throw invalid(
        'QAPAQ_DEMO_ADMIN_PASSWORD_HASH',
        'El hash de la contraseña demo no es un scrypt válido.',
      );
    }
    const admin: DemoAccount = Object.freeze({
      username: options.username,
      role: DEMO_ADMIN_ROLE,
      subjectId: demoAdminSubjectOf(options.username),
      displayName: 'Administrador demo (excepción temporal)',
      hash,
      usernameDigest: this.#digest(options.username),
    });
    const extra = options.accounts ?? [];
    if (extra.length > DEMO_ACCOUNTS_MAX) {
      throw invalid('QAPAQ_DEMO_ACCOUNTS', 'Demasiadas cuentas demo.');
    }
    const accounts: DemoAccount[] = [admin];
    for (const account of extra) {
      const accountHash = parseScryptHash(account.passwordHash);
      if (!accountHash) {
        throw invalid('QAPAQ_DEMO_ACCOUNTS', 'El hash de una cuenta demo no es un scrypt válido.');
      }
      if (!(DEMO_ACCOUNT_ROLES as readonly string[]).includes(account.role)) {
        throw invalid('QAPAQ_DEMO_ACCOUNTS', 'Una cuenta demo tiene un rol no admitido.');
      }
      if (accounts.some((existing) => existing.username === account.username)) {
        throw invalid('QAPAQ_DEMO_ACCOUNTS', 'Una cuenta demo repite usuario.');
      }
      const role = account.role as DemoAccountRole;
      accounts.push(
        Object.freeze({
          username: account.username,
          role,
          subjectId: demoAccountSubjectOf(account.username, role),
          displayName: `${ROLE_DISPLAY_NAMES[role]} (excepción temporal)`,
          hash: accountHash,
          usernameDigest: this.#digest(account.username),
        }),
      );
    }
    const bySubject = new Map(accounts.map((account) => [account.subjectId, account]));
    if (bySubject.size !== accounts.length) {
      throw invalid('QAPAQ_DEMO_ACCOUNTS', 'Dos cuentas demo comparten sujeto.');
    }
    this.accounts = Object.freeze(accounts);
    this.#bySubject = bySubject;
    this.username = options.username;
    this.subjectId = admin.subjectId;
    this.until = new Date(options.until.getTime());
    this.issuer = options.issuer;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#privateKey = privateKey;
    this.#kid = `qapaq-demo-admin-${randomUUID()}`;
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    this.jwks = Object.freeze([
      { kid: this.#kid, kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' } as const,
    ]);
  }

  /** Cuenta configurada con ese `sub`; `undefined` si no es una cuenta de esta excepción. */
  public accountForSubject(subjectId: string): DemoAccount | undefined {
    return this.#bySubject.get(subjectId);
  }

  /** Vigente estrictamente antes de `until`. Vencida, la excepción no existe. */
  public activeAt(now: Date): boolean {
    return now.getTime() < this.until.getTime();
  }

  /**
   * Tope propio de intentos por origen (ventana fija). Cuenta cada intento, acierte o no, para
   * que el ritmo de prueba de contraseñas quede acotado aunque el atacante rote cuentas.
   */
  public consumeAttempt(originKey: string, now: Date): boolean {
    const at = now.getTime();
    if (this.#attempts.size > 10_000) {
      for (const [key, value] of this.#attempts) {
        if (at - value.windowStartedAt >= DEMO_ADMIN_ATTEMPT_POLICY.windowMs) {
          this.#attempts.delete(key);
        }
      }
    }
    const current = this.#attempts.get(originKey);
    const window =
      !current || at - current.windowStartedAt >= DEMO_ADMIN_ATTEMPT_POLICY.windowMs
        ? { count: 0, windowStartedAt: at }
        : current;
    if (window.count >= DEMO_ADMIN_ATTEMPT_POLICY.maxAttempts) {
      this.#attempts.set(originKey, window);
      return false;
    }
    this.#attempts.set(originKey, { ...window, count: window.count + 1 });
    return true;
  }

  /**
   * Compara usuario y contraseña. Siempre calcula el scrypt con la sal configurada, exista o
   * no el usuario, y combina ambos resultados sin cortocircuito: el tiempo y la respuesta no
   * distinguen «usuario inexistente» de «contraseña errónea».
   */
  public async verify(username: string, password: string): Promise<DemoAdminVerification> {
    return (await this.authenticate(username, password)).result;
  }

  /**
   * Como `verify`, pero devuelve la cuenta que coincide. Compara el usuario con TODAS las cuentas
   * (sin cortocircuito) y calcula exactamente un scrypt: el de la cuenta encontrada o, si no hay
   * ninguna, el del administrador. Así ni el tiempo ni la respuesta revelan qué usuarios existen.
   */
  public async authenticate(
    username: string,
    password: string,
  ): Promise<DemoAccountAuthentication> {
    if (this.#inFlight >= DEMO_ADMIN_ATTEMPT_POLICY.maxConcurrentVerifications) {
      return { result: 'busy' };
    }
    this.#inFlight += 1;
    try {
      const candidate = this.#digest(username.trim().toLowerCase());
      let found: DemoAccount | undefined;
      for (const account of this.accounts) {
        const matches = timingSafeEqual(candidate, account.usernameDigest);
        if (matches && found === undefined) found = account;
      }
      const target = found ?? this.accounts[0]!;
      const passwordMatches = await verifyScryptPassword(password, target.hash);
      // Ambos valores ya están calculados: combinarlos no abre una diferencia de tiempo.
      return found !== undefined && passwordMatches
        ? { result: 'match', account: found }
        : { result: 'mismatch' };
    } finally {
      this.#inFlight -= 1;
    }
  }

  /** Código de un solo uso, ligado al `nonce` y al `code_verifier` PKCE del handshake. */
  public issueCode(
    nonce: string,
    codeVerifier: string,
    now: Date,
    account: DemoAccount = this.accounts[0]!,
  ): string {
    for (const [code, issued] of this.#codes) {
      if (issued.expiresAt <= now.getTime()) this.#codes.delete(code);
    }
    const code = randomBytes(32).toString('base64url');
    this.#codes.set(code, {
      subjectId: account.subjectId,
      nonce,
      codeVerifierDigest: this.#digest(codeVerifier),
      expiresAt: now.getTime() + CODE_TTL_MS,
    });
    return code;
  }

  public exchange(code: string, codeVerifier: string, now: Date): string {
    const issued = this.#codes.get(code);
    this.#codes.delete(code);
    if (!issued || issued.expiresAt <= now.getTime()) throw new Error('DEMO_ADMIN_CODE_UNKNOWN');
    if (!timingSafeEqual(this.#digest(codeVerifier), issued.codeVerifierDigest)) {
      throw new Error('DEMO_ADMIN_PKCE_MISMATCH');
    }
    if (!this.activeAt(now)) throw new Error('DEMO_ADMIN_LOGIN_EXPIRED');
    const account = this.#bySubject.get(issued.subjectId);
    if (!account) throw new Error('DEMO_ADMIN_CODE_UNKNOWN');
    return this.sign(issued.nonce, now, account);
  }

  /** Firma el JWT de la persona sintética. `exp` nunca supera el vencimiento de la excepción. */
  public sign(nonce: string, now: Date, account: DemoAccount = this.accounts[0]!): string {
    const seconds = Math.floor(now.getTime() / 1000);
    const exp = Math.min(
      seconds + DEMO_ADMIN_TOKEN_TTL_SECONDS,
      Math.floor(this.until.getTime() / 1000),
    );
    const jti = randomUUID();
    const header = { typ: 'JWT', alg: 'RS256', kid: this.#kid };
    const claims = {
      iss: this.issuer,
      aud: this.options.audience,
      sub: account.subjectId,
      tid: this.options.tenantId,
      iat: seconds,
      nbf: seconds,
      exp,
      jti,
      nonce,
      amr: ['pwd'],
      roles: [account.role],
      preferred_username: account.username,
      name: account.displayName,
      sid: `demo-admin-session:${jti}`,
    };
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const signingInput = `${encode(header)}.${encode(claims)}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput, 'ascii');
    signer.end();
    return `${signingInput}.${signer.sign(this.#privateKey).toString('base64url')}`;
  }

  #digest(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
  }
}

/** JWKS del emisor demo: solo su clave en memoria, nunca mezclada con la de Entra. */
export class DemoAdminJwksProvider implements JwksProvider {
  public constructor(private readonly login: DemoAdminLogin) {}

  public keys(): Promise<readonly JsonWebKey[]> {
    return Promise.resolve(this.login.jwks);
  }
}

/** Canje del código demo por su JWT, con la misma forma que el canje de Entra. */
export class DemoAdminTokenExchange implements TokenExchange {
  public constructor(
    private readonly login: DemoAdminLogin,
    private readonly clock: () => Date,
  ) {}

  public exchange(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<TokenExchangeResult> {
    try {
      return Promise.resolve({
        idToken: this.login.exchange(input.code, input.codeVerifier, this.clock()),
        expiresInSeconds: DEMO_ADMIN_TOKEN_TTL_SECONDS,
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('DEMO_ADMIN_EXCHANGE'));
    }
  }
}
