/**
 * Emisor OIDC local, solo para desarrollo y pruebas.
 *
 * Permite recorrer el flujo completo —autorización, código, `id_token`, sesión— sin
 * depender del tenant de Entra, que es un recurso externo y bloqueante. El código de
 * validación es el mismo en ambos modos: lo único que cambia es quién firma.
 *
 * Se niega a construirse en el perfil de producción. Esa comprobación es la frontera
 * entre una herramienta de desarrollo y una puerta trasera.
 */

import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import type { JsonWebKey } from '@qapaq/access';

export const LOCAL_ISSUER_KID = 'qapaq-local-dev';

export interface LocalPrincipal {
  readonly subjectId: string;
  readonly username: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly amr: readonly string[];
}

/** Personas sintéticas del entorno local, una por rol del catálogo. */
export const LOCAL_PRINCIPALS: Readonly<Record<string, LocalPrincipal>> = Object.freeze({
  'analista@qapaq.pe': {
    subjectId: 'local-analyst-1',
    username: 'analista@qapaq.pe',
    displayName: 'Ana Lista',
    roles: ['qapaq.soc.analyst'],
    amr: ['pwd', 'mfa'],
  },
  'lider@qapaq.pe': {
    subjectId: 'local-lead-1',
    username: 'lider@qapaq.pe',
    displayName: 'Luis Líder',
    roles: ['qapaq.soc.lead'],
    amr: ['fido'],
  },
  'auditor@qapaq.pe': {
    subjectId: 'local-auditor-1',
    username: 'auditor@qapaq.pe',
    displayName: 'Aída Auditora',
    roles: ['qapaq.auditor'],
    amr: ['pwd', 'mfa'],
  },
  'admin@qapaq.pe': {
    subjectId: 'local-platform-admin-1',
    username: 'admin@qapaq.pe',
    displayName: 'Ada Admin',
    roles: ['qapaq.platform.admin'],
    amr: ['fido'],
  },
  'sinrol@qapaq.pe': {
    subjectId: 'local-norole-1',
    username: 'sinrol@qapaq.pe',
    displayName: 'Sin Rol',
    roles: [],
    amr: ['pwd', 'mfa'],
  },
});

interface IssuedCode {
  readonly username: string;
  readonly nonce: string;
  readonly issuedAt: number;
}

export interface LocalIssuerOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly profile: string;
}

export class LocalDevelopmentIssuer {
  private readonly privateKey: KeyObject;
  public readonly jwks: readonly JsonWebKey[];
  private readonly codes = new Map<string, IssuedCode>();

  public constructor(private readonly options: LocalIssuerOptions) {
    if (options.profile === 'production') {
      throw new Error('LOCAL_ISSUER_FORBIDDEN_IN_PRODUCTION');
    }
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    this.jwks = [
      { kid: LOCAL_ISSUER_KID, kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' },
    ];
  }

  /** Simula la pantalla de Entra: entrega un código ligado al usuario y al `nonce`. */
  public issueCode(username: string, nonce: string, now: Date): string {
    const code = randomUUID();
    this.codes.set(code, { username, nonce, issuedAt: now.getTime() });
    return code;
  }

  public exchange(code: string, now: Date): string {
    const issued = this.codes.get(code);
    if (!issued) throw new Error('LOCAL_CODE_UNKNOWN');
    this.codes.delete(code);
    const principal = LOCAL_PRINCIPALS[issued.username];
    if (!principal) throw new Error('LOCAL_PRINCIPAL_UNKNOWN');
    return this.sign(principal, issued.nonce, now);
  }

  public sign(principal: LocalPrincipal, nonce: string, now: Date): string {
    const seconds = Math.floor(now.getTime() / 1000);
    const header = { typ: 'JWT', alg: 'RS256', kid: LOCAL_ISSUER_KID };
    const claims = {
      iss: this.options.issuer,
      aud: this.options.audience,
      sub: principal.subjectId,
      oid: principal.subjectId,
      tid: this.options.tenantId,
      iat: seconds,
      nbf: seconds,
      exp: seconds + 3600,
      nonce,
      amr: [...principal.amr],
      roles: [...principal.roles],
      preferred_username: principal.username,
      name: principal.displayName,
      sid: `local-${principal.subjectId}`,
    };
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const signingInput = `${encode(header)}.${encode(claims)}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput, 'ascii');
    signer.end();
    return `${signingInput}.${signer.sign(this.privateKey).toString('base64url')}`;
  }
}
