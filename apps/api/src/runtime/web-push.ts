/**
 * Sprint 5 — emisor Web Push con VAPID (RFC 8292), sin contenido.
 *
 * Cada aviso es un `POST` vacío al endpoint del servicio de push del navegador, firmado con un
 * JWT ES256 de la clave VAPID del API (`aud` = origen del endpoint, `exp` ≤ 12 h, `sub` = URL de
 * la consola). Sin cuerpo no hace falta cifrado (RFC 8291): el service worker, al despertar,
 * pide el detalle a QAPAQ con la sesión de la persona.
 *
 * - `TTL: 300`: un aviso de hace más de 5 minutos ya no sirve; el servicio lo descarta.
 * - `Urgency: high`: los móviles lo entregan aunque estén en ahorro de energía.
 * - 404/410 → `gone` (la suscripción terminó); 2xx → `delivered`; cualquier otra cosa → `failed`.
 *
 * La clave privada llega desde Secrets Manager (`QAPAQ_VAPID_PRIVATE_KEY`, PKCS#8 en base64) y
 * nunca se registra. Sin clave configurada (desarrollo) se genera una efímera por proceso.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';

import type { PushDeliveryResult, PushSender, PushSubscriptionRecord } from '@qapaq/soar';

const TOKEN_LIFETIME_S = 12 * 3_600;
const REQUEST_TIMEOUT_MS = 10_000;

const base64url = (buffer: Buffer) => buffer.toString('base64url');

/** Clave privada VAPID desde PKCS#8 (DER en base64); valida que sea P-256. */
export function vapidKeyFrom(pkcs8Base64: string): KeyObject {
  const key = createPrivateKey({
    key: Buffer.from(pkcs8Base64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('VAPID_KEY_INVALID');
  }
  return key;
}

/** Clave efímera para desarrollo y pruebas. */
export function ephemeralVapidKey(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
}

/** Clave pública en el formato que espera `PushManager.subscribe` (punto sin comprimir). */
export function vapidPublicKey(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string; y: string };
  return base64url(
    Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ]),
  );
}

export class VapidPushSender implements PushSender {
  public readonly publicKey: string;
  readonly #tokens = new Map<string, { readonly token: string; readonly until: number }>();

  public constructor(
    private readonly options: {
      readonly privateKey: KeyObject;
      /** `mailto:` o URL https del responsable (RFC 8292 §2.1). */
      readonly subject: string;
      readonly fetch?: typeof globalThis.fetch;
      readonly now?: () => number;
    },
  ) {
    this.publicKey = vapidPublicKey(options.privateKey);
  }

  /** JWT por audiencia, reutilizado hasta una hora antes de vencer. */
  #token(audience: string): string {
    const now = Math.floor((this.options.now ?? Date.now)() / 1_000);
    const cached = this.#tokens.get(audience);
    if (cached && cached.until > now + 3_600) return cached.token;
    const header = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const exp = now + TOKEN_LIFETIME_S;
    const claims = base64url(
      Buffer.from(JSON.stringify({ aud: audience, exp, sub: this.options.subject })),
    );
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: this.options.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    const token = `${header}.${claims}.${base64url(signature)}`;
    this.#tokens.set(audience, { token, until: exp });
    return token;
  }

  public async send(subscription: PushSubscriptionRecord): Promise<PushDeliveryResult> {
    const endpoint = new URL(subscription.endpoint);
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(endpoint, {
        method: 'POST',
        headers: {
          authorization: `vapid t=${this.#token(endpoint.origin)}, k=${this.publicKey}`,
          ttl: '300',
          urgency: 'high',
          'content-length': '0',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 404 || response.status === 410) return 'gone';
      return response.ok ? 'delivered' : 'failed';
    } catch {
      return 'failed';
    }
  }
}
