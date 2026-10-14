/**
 * Sprint 5 — avisos al dispositivo (Web Push sin contenido, VAPID RFC 8292).
 *
 * Fija la firma VAPID (verificable con la clave pública publicada), los encabezados, el manejo
 * de suscripciones terminadas y la validación de endpoints. Endpoints sintéticos.
 */

import { createPublicKey, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  InMemoryPushSubscriptionStore,
  notifyDevices,
  validatePushSubscription,
  type PushSubscriptionRecord,
} from '@qapaq/soar';

import { ephemeralVapidKey, VapidPushSender, vapidPublicKey } from '../src/runtime/web-push.js';

const P256DH = 'B'.repeat(87);
const AUTH = 'A'.repeat(22);
const subscription = (
  id: string,
  endpoint: string,
  subjectKey = 'oid-1',
): PushSubscriptionRecord => ({
  id,
  tenantId: 't',
  subjectKey,
  endpoint,
  p256dh: P256DH,
  auth: AUTH,
  label: 'Laptop',
  createdAt: new Date('2026-10-13T01:00:00.000Z'),
  lastSuccessAt: null,
  revokedAt: null,
  revocationReason: null,
});

describe('emisor VAPID', () => {
  it('firma un JWT ES256 verificable con la clave pública y envía sin cuerpo', async () => {
    const key = ephemeralVapidKey();
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = new VapidPushSender({
      privateKey: key,
      subject: 'https://qapaq-secops.jappi.net.pe',
      now: () => Date.parse('2026-10-13T01:00:00.000Z'),
      fetch: (async (url: URL, init: RequestInit) => {
        calls.push({ url: url.toString(), init });
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    expect(sender.publicKey).toBe(vapidPublicKey(key));
    expect(Buffer.from(sender.publicKey, 'base64url')).toHaveLength(65);

    expect(await sender.send(subscription('s1', 'https://fcm.googleapis.com/fcm/send/abc'))).toBe(
      'delivered',
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.body).toBeUndefined();
    expect(headers).toMatchObject({ ttl: '300', urgency: 'high', 'content-length': '0' });
    const [, token, publicKey] = /^vapid t=([^,]+), k=(.+)$/u.exec(headers['authorization']!)!;
    expect(publicKey).toBe(sender.publicKey);
    const [header, claims, signature] = token!.split('.');
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: createPublicKey(key), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
    const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8'));
    expect(payload).toMatchObject({
      aud: 'https://fcm.googleapis.com',
      sub: 'https://qapaq-secops.jappi.net.pe',
    });
    expect(payload.exp - Date.parse('2026-10-13T01:00:00.000Z') / 1_000).toBeLessThanOrEqual(
      12 * 3_600,
    );
  });

  it('410 es una suscripción terminada; se revoca y no se vuelve a intentar', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.upsert(subscription('s-ok', 'https://fcm.googleapis.com/fcm/send/ok'));
    await store.upsert(
      subscription('s-gone', 'https://updates.push.services.mozilla.com/wpush/v2/gone'),
    );
    const sender = new VapidPushSender({
      privateKey: ephemeralVapidKey(),
      subject: 'https://qapaq-secops.jappi.net.pe',
      fetch: (async (url: URL) =>
        new Response(null, {
          status: url.hostname.includes('mozilla') ? 410 : 201,
        })) as unknown as typeof fetch,
    });
    const delivered = await notifyDevices({
      store,
      sender,
      tenantId: 't',
      subjectKeys: ['OID-1'],
      now: () => new Date('2026-10-13T01:05:00.000Z'),
    });
    expect(delivered).toBe(1);
    expect(store.rows.get('s-gone')).toMatchObject({ revocationReason: 'endpoint_gone' });
    expect(store.rows.get('s-ok')?.lastSuccessAt).toEqual(new Date('2026-10-13T01:05:00.000Z'));
    expect(await store.activeForSubject('t', 'oid-1')).toHaveLength(1);
  });
});

describe('validación de suscripciones', () => {
  const valid = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: P256DH,
    auth: AUTH,
    label: 'Celular',
  };

  it('acepta los servicios de push conocidos', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://wns2-bl2p.notify.windows.com/w/?token=x',
      'https://web.push.apple.com/x',
    ]) {
      expect(validatePushSubscription({ ...valid, endpoint })).toEqual({ ok: true });
    }
  });

  it.each([
    ['endpoint', 'http://fcm.googleapis.com/x'],
    ['endpoint', 'https://atacante.example/fcm.googleapis.com'],
    ['endpoint', 'https://fcm.googleapis.com.atacante.example/x'],
    ['endpoint', 'https://169.254.169.254/latest/meta-data'],
  ])('rechaza %s %s', (field, endpoint) => {
    expect(validatePushSubscription({ ...valid, endpoint })).toEqual({ ok: false, field });
  });

  it('rechaza claves y etiquetas inválidas', () => {
    expect(validatePushSubscription({ ...valid, p256dh: 'corta' })).toEqual({
      ok: false,
      field: 'keys',
    });
    expect(validatePushSubscription({ ...valid, label: '' })).toEqual({
      ok: false,
      field: 'label',
    });
  });
});
