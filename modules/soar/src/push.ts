/**
 * Sprint 5 — avisos al dispositivo (Web Push) por persona.
 *
 * Cada persona del SOC activa los avisos en un dispositivo desde la consola («Activar en este
 * dispositivo»): el navegador pide permiso y entrega una suscripción (endpoint del servicio de
 * push y claves). QAPAQ la guarda ligada a la persona; sin activar no se envía nada.
 *
 * Diseño de privacidad: el push **no lleva contenido**. QAPAQ solo despierta al dispositivo; su
 * service worker pide el detalle a QAPAQ con la sesión de la persona, que vuelve a aplicar
 * autorización. Así ningún dato del SOC pasa por los servicios de push (Google, Apple,
 * Mozilla, Microsoft), que de todos modos verían el contenido cifrado.
 *
 * Solo se aceptan endpoints de servicios de push conocidos: el API no debe convertirse en un
 * proxy hacia cualquier URL que un cliente registre.
 */

export const PUSH_ENDPOINT_HOST_SUFFIXES = Object.freeze([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
]);

export const PUSH_LIMITS = Object.freeze({
  /** Dispositivos activos por persona. */
  maximumPerSubject: 10,
  maximumEndpointLength: 1_024,
  maximumLabelLength: 80,
});

export interface PushSubscriptionRecord {
  readonly id: string;
  readonly tenantId: string;
  /** OID de Entra de la persona (o `sub` si la sesión no trae OID). */
  readonly subjectKey: string;
  readonly endpoint: string;
  /** Clave pública P-256 del navegador (base64url). Necesaria si algún día se cifra contenido. */
  readonly p256dh: string;
  /** Secreto de autenticación del navegador (base64url). */
  readonly auth: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
}

export type PushValidation =
  { readonly ok: true } | { readonly ok: false; readonly field: 'endpoint' | 'keys' | 'label' };

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/** Valida una suscripción del navegador antes de guardarla. */
export function validatePushSubscription(input: {
  readonly endpoint: unknown;
  readonly p256dh: unknown;
  readonly auth: unknown;
  readonly label: unknown;
}): PushValidation {
  if (
    typeof input.endpoint !== 'string' ||
    input.endpoint.length > PUSH_LIMITS.maximumEndpointLength
  ) {
    return { ok: false, field: 'endpoint' };
  }
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    return { ok: false, field: 'endpoint' };
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    !PUSH_ENDPOINT_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  ) {
    return { ok: false, field: 'endpoint' };
  }
  // p256dh: punto P-256 sin comprimir (65 bytes → 87 caracteres base64url); auth: 16 bytes.
  if (
    typeof input.p256dh !== 'string' ||
    typeof input.auth !== 'string' ||
    !BASE64URL.test(input.p256dh) ||
    !BASE64URL.test(input.auth) ||
    input.p256dh.length < 80 ||
    input.p256dh.length > 100 ||
    input.auth.length < 16 ||
    input.auth.length > 32
  ) {
    return { ok: false, field: 'keys' };
  }
  if (
    typeof input.label !== 'string' ||
    input.label.trim().length < 1 ||
    input.label.length > PUSH_LIMITS.maximumLabelLength
  ) {
    return { ok: false, field: 'label' };
  }
  return { ok: true };
}

export interface PushSubscriptionStore {
  /** Guarda o reactiva por endpoint (un mismo dispositivo no se duplica). */
  upsert(record: PushSubscriptionRecord): Promise<PushSubscriptionRecord>;
  /** Activas de una persona. */
  activeForSubject(
    tenantId: string,
    subjectKey: string,
  ): Promise<readonly PushSubscriptionRecord[]>;
  /** Activas de varias personas (destinatarios de un aviso). */
  activeForSubjects(
    tenantId: string,
    subjectKeys: readonly string[],
  ): Promise<readonly PushSubscriptionRecord[]>;
  /** Revoca; `false` si no existe, ya estaba revocada o no es de esa persona. */
  revoke(
    tenantId: string,
    id: string,
    subjectKey: string | null,
    reason: string,
    at: Date,
  ): Promise<boolean>;
  markDelivered(id: string, at: Date): Promise<void>;
}

/** Envío de un aviso sin contenido a un dispositivo. */
export type PushDeliveryResult = 'delivered' | 'gone' | 'failed';

export interface PushSender {
  readonly publicKey: string;
  send(subscription: PushSubscriptionRecord): Promise<PushDeliveryResult>;
}

/**
 * Avisa a los dispositivos de un conjunto de personas. Mejor esfuerzo y con concurrencia
 * acotada: un dispositivo caído no frena a los demás. Un endpoint que el servicio de push da por
 * terminado (404/410) se revoca para no reintentarlo nunca más.
 *
 * @returns cantidad de dispositivos avisados.
 */
export async function notifyDevices(input: {
  readonly store: PushSubscriptionStore;
  readonly sender: PushSender;
  readonly tenantId: string;
  readonly subjectKeys: readonly string[];
  readonly now: () => Date;
  readonly concurrency?: number;
}): Promise<number> {
  if (input.subjectKeys.length === 0) return 0;
  const subscriptions = await input.store.activeForSubjects(input.tenantId, input.subjectKeys);
  const concurrency = Math.max(1, input.concurrency ?? 8);
  let delivered = 0;
  for (let index = 0; index < subscriptions.length; index += concurrency) {
    const batch = subscriptions.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map(async (subscription) => {
        const result = await input.sender.send(subscription).catch(() => 'failed' as const);
        if (result === 'delivered') await input.store.markDelivered(subscription.id, input.now());
        if (result === 'gone') {
          await input.store.revoke(
            input.tenantId,
            subscription.id,
            null,
            'endpoint_gone',
            input.now(),
          );
        }
        return result;
      }),
    );
    delivered += results.filter((result) => result === 'delivered').length;
  }
  return delivered;
}
