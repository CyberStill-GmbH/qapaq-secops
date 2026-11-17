/**
 * Canales de aviso administrables: cifrado del webhook, enmascarado, autorización (solo
 * `notifications.manage`, CSRF y sesión reciente), validación y auditoría sin secretos.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryAuditStore } from '@qapaq/audit';
import { capabilitiesForRoles } from '@qapaq/access';
import { InMemoryChannelStore } from '@qapaq/soar';

import { ApiError } from '../src/http/api-error.js';
import {
  decryptSecret,
  deriveChannelKey,
  encryptSecret,
  NotificationChannelRegistry,
} from '../src/runtime/notification-channels.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';
import { NotificationChannelsController } from '../src/soc/notification-channels.controller.js';

const URL_A =
  'https://abc123.6a.environment.api.powerplatform.com/powerautomate/automations/direct/cu/05/workflows/82e70dbb3d92/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=SECRETSIGNATUREvalue123456';
const URL_B = URL_A.replace('SECRETSIGNATUREvalue123456', 'OTHERSIGNATUREvalue654321');
const NOW = new Date('2026-11-11T15:00:00.000Z');
const KEY = deriveChannelKey('k'.repeat(48));

function registry(store = new InMemoryChannelStore(), fetchImplementation?: typeof fetch) {
  return new NotificationChannelRegistry({
    tenantId: 't1',
    store,
    key: KEY,
    environmentTeamsUrl: URL_A,
    emailConfigured: false,
    pushConfigured: true,
    clock: () => NOW,
    ...(fetchImplementation ? { fetchImplementation } : {}),
  });
}

describe('cifrado del webhook', () => {
  it('AES-GCM con AAD: ida y vuelta, y no se descifra con otro tenant', () => {
    const sealed = encryptSecret(KEY, URL_A, 't1|teams');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('SECRETSIGNATURE');
    expect(decryptSecret(KEY, sealed, 't1|teams')).toBe(URL_A);
    expect(() => decryptSecret(KEY, sealed, 't2|teams')).toThrow();
  });
});

describe('registro de canales', () => {
  it('una respuesta tardía del destino anterior no verifica el webhook nuevo en otra réplica', async () => {
    const store = new InMemoryChannelStore();
    const sender = registry(store);
    await sender.initialize();
    const sentRevision = sender.view('teams').revision;
    const admin = registry(store);
    await admin.refresh();
    await admin.setTeamsUrl(URL_B, 'admin', sentRevision);
    const evidence = { channel: 'teams' as const, at: NOW.toISOString(), outcome: 'accepted' as const, httpStatus: 202, providerMessageId: null, providerLink: null, reason: null };
    await sender.recordOutcome('teams', evidence, true, sentRevision);
    await admin.refresh();
    expect(admin.view('teams')).toMatchObject({ setup: 'verify', health: { lastSuccessAt: null }, lastTest: { at: null } });
    expect(sender.view('teams').revision).toBe(admin.view('teams').revision);
    await sender.recordOutcome('teams', evidence, true, sender.view('teams').revision);
    await admin.refresh();
    expect(admin.view('teams')).toMatchObject({ setup: 'ready', lastTest: { outcome: 'accepted' } });
  });
  it('un fallo posterior al éxito vuelve a requerir verificación del canal', async () => {
    const channels = registry();
    await channels.initialize();
    const evidence = { channel: 'teams' as const, httpStatus: 202, providerMessageId: null, providerLink: null, reason: null };
    await channels.recordOutcome('teams', { ...evidence, at: NOW.toISOString(), outcome: 'accepted' });
    expect(channels.view('teams')).toMatchObject({ setup: 'ready', needsSetup: false });
    await channels.recordOutcome('teams', { ...evidence, at: new Date(NOW.getTime() + 1000).toISOString(), outcome: 'failed', httpStatus: 503 });
    expect(channels.view('teams')).toMatchObject({ status: 'degraded', setup: 'verify', needsSetup: true });
  });
  it('la URL de la base reemplaza a la de entorno, se guarda cifrada y nunca se expone', async () => {
    const store = new InMemoryChannelStore();
    const channels = registry(store);
    await channels.refresh();
    expect(channels.view('teams')).toMatchObject({ source: 'environment', configured: true });
    const result = await channels.setTeamsUrl(URL_B, 'admin-1');
    expect(result.ok).toBe(true);
    expect(channels.teamsUrl()).toEqual({ url: URL_B, source: 'database' });
    const saved = await store.get('t1', 'teams');
    expect(saved?.secretCiphertext).not.toContain('OTHERSIGNATURE');
    expect(JSON.stringify(channels.views())).not.toContain('SIGNATURE');
    // Otra réplica (otro registro sobre la misma base) la recoge al releer.
    const replica = registry(store);
    await replica.refresh();
    expect(replica.teamsUrl()?.url).toBe(URL_B);
  });

  it('rechaza URL inválidas sin tocar la configuración', async () => {
    const channels = registry();
    expect(await channels.setTeamsUrl('http://x.environment.api.powerplatform.com/a', 'a')).toEqual({
      ok: false,
      code: 'URL_NOT_HTTPS',
    });
    expect(channels.teamsUrl()?.source).toBe('environment');
  });

  it('el transporte usa la URL vigente, respeta «desactivado» y registra la salud', async () => {
    const calls: string[] = [];
    const fetchImplementation = ((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response(null, { status: 202, headers: { 'x-ms-workflow-run-id': '0858407198265688965' } }),
      );
    }) as unknown as typeof fetch;
    const channels = registry(new InMemoryChannelStore(), fetchImplementation);
    await channels.setTeamsUrl(URL_B, 'admin-1');
    const message = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: {} }], qapaq: { version: '2', clientRequestId: 'c', aggregateId: 'a' } } as const;
    const outcome = await channels.teamsTransport.send(message, 'c');
    expect(outcome).toMatchObject({ delivered: true, httpStatus: 202, providerMessageId: 'x-ms-workflow-run-id:0858407198265688965' });
    expect(calls).toEqual([URL_B]);
    expect(channels.view('teams')).toMatchObject({ status: 'ok', health: { lastHttpStatus: 202 } });
    await channels.setEnabled('teams', false, 'admin-1');
    expect(await channels.teamsTransport.send(message, 'c')).toMatchObject({
      delivered: false,
      failure: { code: 'CHANNEL_DISABLED' },
    });
    expect(calls).toHaveLength(1);
    expect(channels.view('teams').status).toBe('disabled');
    expect(channels.view('email').status).toBe('not_configured');
  });
});

describe('inicialización de canales al arrancar', () => {
  const json = (value: unknown) =>
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item));

  it('siembra una fila por canal, cifra la URL de entorno y la audita solo con máscaras', async () => {
    const store = new InMemoryChannelStore();
    const audit = new InMemoryAuditStore();
    const channels = registry(store);
    await channels.refresh();
    const result = await channels.initialize({ audit });
    expect(result.failed).toEqual([]);
    expect(result.seeded).toEqual([
      { channelId: 'teams', enabled: true, configured: true, secretStored: true, secretSkipped: null },
      { channelId: 'email', enabled: false, configured: false, secretStored: false, secretSkipped: null },
      { channelId: 'push', enabled: true, configured: true, secretStored: false, secretSkipped: null },
    ]);
    const teams = await store.get('t1', 'teams');
    expect(teams).toMatchObject({ enabled: true, updatedBy: 'system:bootstrap', revision: 1 });
    expect(teams?.secretCiphertext?.startsWith('v1:')).toBe(true);
    expect(teams?.secretCiphertext).not.toContain('SECRETSIGNATURE');
    // El canal sin configurar queda visible como pendiente, no como canal activo y sano.
    expect(channels.view('email')).toMatchObject({
      enabled: false,
      status: 'not_configured',
      setup: 'configure',
      needsSetup: true,
      revision: 1,
    });
    expect(channels.view('teams')).toMatchObject({
      source: 'database',
      status: 'unknown',
      setup: 'verify',
      needsSetup: true,
      revision: 1,
      updatedBy: 'system:bootstrap',
    });
    const events = await audit.range('t1', 1n, 10);
    expect(events.map((event) => [event.action, event.resource.id, event.actor.id, event.actor.type])).toEqual([
      ['notifications.channel.initialized', 'teams', 'system:bootstrap', 'service'],
      ['notifications.channel.initialized', 'email', 'system:bootstrap', 'service'],
      ['notifications.channel.initialized', 'push', 'system:bootstrap', 'service'],
    ]);
    expect(events[0]?.metadata).toMatchObject({ destination: 'https://abc123.…/…123456', secretStored: true });
    expect(json(events)).not.toContain('SIGNATURE');
    expect(json(events)).not.toContain('sig=');
    expect(json(channels.views())).not.toContain('SIGNATURE');
  });

  it('es idempotente: un segundo arranque no escribe ni audita nada', async () => {
    const store = new InMemoryChannelStore();
    const audit = new InMemoryAuditStore();
    await registry(store).initialize({ audit });
    const before = new Map(store.rows);
    const second = registry(store);
    await second.refresh();
    expect(await second.initialize({ audit })).toEqual({ seeded: [], failed: [] });
    expect(new Map(store.rows)).toEqual(before);
    expect(await audit.range('t1', 1n, 10)).toHaveLength(3);
  });

  it('la base manda: una fila existente no se reemplaza con la URL de entorno', async () => {
    const store = new InMemoryChannelStore();
    const first = registry(store);
    await first.initialize();
    expect((await first.setTeamsUrl(URL_B, 'admin-1')).ok).toBe(true);
    expect((await first.setEnabled('teams', false, 'admin-1')).ok).toBe(true);
    // Reinicio con la URL A todavía en el entorno.
    const restarted = registry(store);
    await restarted.refresh();
    expect((await restarted.initialize()).seeded).toEqual([]);
    expect(restarted.teamsUrl()).toEqual({ url: URL_B, source: 'database' });
    expect(restarted.view('teams')).toMatchObject({
      enabled: false,
      setup: 'enable',
      updatedBy: 'admin-1',
      revision: 3,
    });
  });

  it('sin clave de cifrado no guarda el secreto: la URL sigue viniendo del entorno y se informa', async () => {
    const store = new InMemoryChannelStore();
    const channels = new NotificationChannelRegistry({
      tenantId: 't1',
      store,
      environmentTeamsUrl: URL_A,
      emailConfigured: true,
      pushConfigured: false,
      clock: () => NOW,
    });
    const result = await channels.initialize();
    expect(result.seeded[0]).toEqual({
      channelId: 'teams',
      enabled: true,
      configured: true,
      secretStored: false,
      secretSkipped: 'ENCRYPTION_KEY_MISSING',
    });
    expect(await store.get('t1', 'teams')).toMatchObject({ secretCiphertext: null, secretHint: null, enabled: true });
    expect(channels.view('teams')).toMatchObject({ source: 'environment', configured: true });
    expect(channels.view('push')).toMatchObject({ enabled: false, setup: 'configure' });
  });

  it('sin base disponible no falla el arranque y el canal configurado sigue entregando', async () => {
    const errors: string[] = [];
    const down = {
      list: () => Promise.reject(new Error('down')),
      get: () => Promise.reject(new Error('down')),
      create: () => Promise.reject(new Error('down')),
      saveConfig: () => Promise.reject(new Error('down')),
      saveHealth: () => Promise.reject(new Error('down')),
    };
    const channels = new NotificationChannelRegistry({
      tenantId: 't1',
      store: down,
      key: KEY,
      environmentTeamsUrl: URL_A,
      emailConfigured: false,
      pushConfigured: false,
      clock: () => NOW,
      onError: (code) => errors.push(code),
    });
    await channels.refresh();
    expect(await channels.initialize()).toEqual({ seeded: [], failed: ['teams', 'email', 'push'] });
    expect(errors).toContain('CHANNEL_STORE_UNAVAILABLE');
    expect(channels.enabled('teams')).toBe(true);
    expect(channels.enabled('email')).toBe(false);
    expect(channels.view('teams').revision).toBe(0);
  });
});

describe('revisión de la configuración (compare-and-set)', () => {
  it('rechaza una revisión vieja y no pierde el cambio de otra réplica', async () => {
    const store = new InMemoryChannelStore();
    const a = registry(store);
    const b = registry(store);
    await a.initialize();
    await b.refresh();
    expect(await a.setEnabled('teams', false, 'admin-a', 1)).toMatchObject({ ok: true, view: { revision: 2 } });
    // `b` todavía tiene la revisión 1 en memoria: el CAS relee y rechaza.
    expect(await b.setEnabled('push', false, 'admin-b', 1)).toMatchObject({ ok: true });
    expect(await b.setTeamsUrl(URL_B, 'admin-b', 1)).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(await b.setEnabled('teams', true, 'admin-b', 1)).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(await store.get('t1', 'teams')).toMatchObject({ enabled: false, updatedBy: 'admin-a', revision: 2 });
    // Con la revisión vigente, pasa.
    expect(await b.setEnabled('teams', true, 'admin-b', 2)).toMatchObject({ ok: true, view: { revision: 3 } });
  });

  it('sin expectedRevision aplica el cambio sobre la fila vigente, no sobre la copia vieja', async () => {
    const store = new InMemoryChannelStore();
    const a = registry(store);
    const b = registry(store);
    await a.initialize();
    await b.refresh();
    await a.setTeamsUrl(URL_B, 'admin-a');
    expect(await b.setEnabled('teams', false, 'admin-b')).toMatchObject({ ok: true, view: { revision: 3 } });
    const replica = registry(store);
    await replica.refresh();
    expect(replica.teamsUrl()).toEqual({ url: URL_B, source: 'database' });
    expect(replica.enabled('teams')).toBe(false);
  });

  it('la salud de un envío no cambia la revisión ni pisa la configuración de otra réplica', async () => {
    const store = new InMemoryChannelStore();
    const fetchImplementation = (() =>
      Promise.resolve(new Response(null, { status: 202 }))) as unknown as typeof fetch;
    const sender = registry(store, fetchImplementation);
    const admin = registry(store);
    await sender.initialize();
    await admin.refresh();
    // El administrador cambia el webhook en otra réplica; `sender` aún no releyó.
    await admin.setTeamsUrl(URL_B, 'admin-1', 1);
    const message = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: {} }], qapaq: { version: '2', clientRequestId: 'c', aggregateId: 'a' } } as const;
    expect((await sender.teamsTransport.send(message, 'c')).delivered).toBe(true);
    const saved = await store.get('t1', 'teams');
    // El 202 fue del destino anterior: no certifica la configuración nueva.
    expect(saved).toMatchObject({ revision: 2, updatedBy: 'admin-1', lastHttpStatus: null });
    expect(decryptSecret(KEY, saved?.secretCiphertext ?? '', 't1|teams')).toBe(URL_B);
    // La consola sigue pudiendo guardar con la revisión que vio.
    expect(await admin.setEnabled('teams', false, 'admin-1', 2)).toMatchObject({ ok: true });
  });
});

describe('canal push', () => {
  it('apagado desde la consola no avisa a ningún dispositivo; activo, sí', async () => {
    const channels = registry();
    await channels.initialize();
    const calls: (readonly string[])[] = [];
    const devices = channels.devices({
      notify: (_tenantId, subjectKeys) => {
        calls.push(subjectKeys);
        return Promise.resolve(subjectKeys.length);
      },
    });
    expect(await devices.notify('t1', ['a', 'b'])).toBe(2);
    await channels.setEnabled('push', false, 'admin-1');
    expect(await devices.notify('t1', ['a', 'b'])).toBe(0);
    expect(calls).toHaveLength(1);
    await channels.setEnabled('push', true, 'admin-1');
    expect(await devices.notify('t1', ['a'])).toBe(1);
  });
});

describe('autorización y auditoría de la administración', () => {
  function harness(options: { capabilities: readonly string[]; sessionAgeMs?: number; csrf?: boolean }) {
    const audit = new InMemoryAuditStore();
    const channels = registry();
    const runtime = {
      now: () => NOW,
      audit,
      channels,
      consoleBaseUrl: 'https://dev.security.qapaq.pe',
      csrfTokenFor: () => 'csrf-ok',
      resolveActor: () =>
        Promise.resolve({
          ok: true,
          actor: {
            subjectId: 'admin-1',
            tenantId: 't1',
            sessionId: 's1',
            capabilities: new Set(options.capabilities),
            roles: [],
          },
          session: { id: 's1', createdAt: new Date(NOW.getTime() - (options.sessionAgeMs ?? 60_000)) },
        }),
    } as unknown as SecOpsRuntime;
    const request = {
      ip: '10.0.0.1',
      headers: {
        cookie: 'qapaq_session=s1',
        ...(options.csrf === false ? {} : { 'x-csrf-token': 'csrf-ok' }),
      },
    };
    return { controller: new NotificationChannelsController(runtime), request, audit, channels };
  }
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'OK';
    } catch (error) {
      return error instanceof ApiError ? (error.getResponse() as { code: string }).code : 'THROWN';
    }
  };

  it('solo el administrador de plataforma tiene notifications.manage', () => {
    expect(capabilitiesForRoles(['qapaq.platform.admin']).has('notifications.manage')).toBe(true);
    expect(capabilitiesForRoles(['qapaq.soc.lead']).has('notifications.manage')).toBe(false);
    expect(capabilitiesForRoles(['qapaq.soc.analyst']).has('notifications.manage')).toBe(false);
  });

  it('sin capability, sin CSRF o con sesión vieja no se cambia nada', async () => {
    const lead = harness({ capabilities: ['notifications.read', 'notifications.dispatch'] });
    expect(await code(lead.controller.setTeams(lead.request, { webhookUrl: URL_B }))).toBe('RESOURCE_UNAVAILABLE');
    const noCsrf = harness({ capabilities: ['notifications.manage'], csrf: false });
    expect(await code(noCsrf.controller.setTeams(noCsrf.request, { webhookUrl: URL_B }))).toBe('REQUEST_NOT_VERIFIED');
    const stale = harness({ capabilities: ['notifications.manage'], sessionAgeMs: 2 * 3_600_000 });
    expect(await code(stale.controller.disable(stale.request, 'teams'))).toBe('STEP_UP_REQUIRED');
    for (const h of [lead, noCsrf, stale]) expect(h.channels.teamsUrl()?.source).toBe('environment');
  });

  it('el cambio queda auditado con máscaras, nunca con la URL', async () => {
    const admin = harness({ capabilities: ['notifications.read', 'notifications.manage'] });
    const result = (await admin.controller.setTeams(admin.request, { webhookUrl: URL_B })) as {
      channel: { destination: string };
    };
    expect(result.channel.destination).toBe('https://abc123.…/…654321');
    expect(await code(admin.controller.setTeams(admin.request, { webhookUrl: 'https://evil.example/x' }))).toBe(
      'VALIDATION_FAILED',
    );
    const events = await admin.audit.range('t1', 1n, 10);
    expect(events.map((event) => event.action)).toEqual([
      'notifications.channel.webhook_updated',
      'notifications.channel.webhook_rejected',
    ]);
    const serialized = JSON.stringify(events, (_key, value) => (typeof value === 'bigint' ? String(value) : value));
    expect(serialized).not.toContain('SIGNATURE');
    expect(serialized).not.toContain('sig=');
    const listed = (await admin.controller.list(admin.request)) as { items: unknown[]; canManage: boolean };
    expect(listed.canManage).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('SIGNATURE');
  });

  it('expectedRevision: una revisión vieja responde STATE_CONFLICT sin cambiar nada y queda auditada', async () => {
    const admin = harness({ capabilities: ['notifications.read', 'notifications.manage'] });
    await admin.channels.initialize();
    const listed = (await admin.controller.list(admin.request)) as {
      items: { id: string; revision: number; setup: string; needsSetup: boolean }[];
    };
    expect(listed.items.map((item) => [item.id, item.revision, item.setup, item.needsSetup])).toEqual([
      ['teams', 1, 'verify', true],
      ['email', 1, 'configure', true],
      ['push', 1, 'verify', true],
    ]);
    const disabled = (await admin.controller.disable(admin.request, 'teams', { expectedRevision: 1 })) as {
      channel: { enabled: boolean; revision: number };
    };
    expect(disabled.channel).toMatchObject({ enabled: false, revision: 2 });
    expect(await code(admin.controller.enable(admin.request, 'teams', { expectedRevision: 1 }))).toBe('STATE_CONFLICT');
    expect(
      await code(admin.controller.setTeams(admin.request, { webhookUrl: URL_B, expectedRevision: 1 })),
    ).toBe('STATE_CONFLICT');
    expect(await code(admin.controller.enable(admin.request, 'teams', { expectedRevision: '2' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(admin.channels.view('teams')).toMatchObject({ enabled: false, revision: 2, source: 'database' });
    expect(admin.channels.teamsUrl()?.url).toBe(URL_A);
    // Sin expectedRevision (cliente anterior) sigue funcionando.
    expect(await code(admin.controller.enable(admin.request, 'teams'))).toBe('OK');
    const events = await admin.audit.range('t1', 1n, 10);
    expect(events.map((event) => event.action)).toEqual([
      'notifications.channel.disabled',
      'notifications.channel.enable_rejected',
      'notifications.channel.webhook_rejected',
      'notifications.channel.enabled',
    ]);
  });
});
