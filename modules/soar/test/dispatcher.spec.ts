import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryAuditStore, verifyChain } from '@qapaq/audit';
import type { OutboxMessageDraft } from '@qapaq/soc';

import { dispatchMessage, drainOutbox, type DispatchDependencies } from '../src/dispatcher.js';
import {
  ConsoleFallbackChannel,
  InMemoryAttemptStore,
  InMemoryOutbox,
} from '../src/memory-stores.js';
import { acknowledge, createAttempt } from '../src/notification.js';
import { RETRY_POLICY, nextDelayMs } from '../src/delivery-policy.js';
import { DEFAULT_NOTIFICATION_POLICY } from '../src/notification-policy.js';
import type { DeliveryOutcome, NotificationTransport } from '../src/teams-adapter.js';
import type { TeamsMessage } from '../src/teams-payload.js';

const AT = new Date('2026-10-08T09:00:00.000Z');

function criticalMessage(overrides: Partial<OutboxMessageDraft> = {}): OutboxMessageDraft {
  return {
    messageId: 'msg-1',
    tenantId: 'tenant-1',
    aggregateType: 'incident',
    aggregateId: 'inc-1',
    messageType: 'soc.incident.opened',
    schemaVersion: '1.0.0',
    idempotencyKey: 'key-critical-1',
    payload: { title: 'Acceso no autorizado', severity: 'critical', status: 'open', alertCount: 1 },
    availableAt: AT,
    ...overrides,
  };
}

class ScriptedTransport implements NotificationTransport {
  public readonly destinationRef = 'teams:canal-soc';
  public readonly calls: { message: TeamsMessage; clientRequestId: string }[] = [];

  public constructor(private readonly script: readonly DeliveryOutcome[]) {}

  public send(message: TeamsMessage, clientRequestId: string): Promise<DeliveryOutcome> {
    this.calls.push({ message, clientRequestId });
    const index = Math.min(this.calls.length - 1, this.script.length - 1);
    return Promise.resolve(this.script[index]!);
  }
}

let outbox: InMemoryOutbox;
let attempts: InMemoryAttemptStore;
let fallback: ConsoleFallbackChannel;
let audit: InMemoryAuditStore;
let sequence: number;

function dependencies(transport: NotificationTransport, now = AT): DispatchDependencies {
  return {
    outbox,
    attempts,
    transport,
    fallback,
    audit,
    clock: { now: () => now },
    ids: {
      next: () => {
        sequence += 1;
        return `0199bf33-0000-7000-8000-${sequence.toString().padStart(12, '0')}`;
      },
    },
    consoleBaseUrl: 'https://soc.qapaq.pe',
  };
}

beforeEach(() => {
  outbox = new InMemoryOutbox();
  attempts = new InMemoryAttemptStore();
  fallback = new ConsoleFallbackChannel();
  audit = new InMemoryAuditStore();
  sequence = 0;
});

describe('notification batch failure isolation', () => {
  it.each([1, 2])(
    'finishes healthy claimed messages with %i workers and reports the first failure',
    async (concurrency) => {
      const firstFailure = new Error('ATTEMPT_STORE_UNAVAILABLE');
      const secondFailure = new Error('SECOND_ATTEMPT_STORE_FAILURE');
      const originalLookup = attempts.byIdempotencyKey.bind(attempts);
      vi.spyOn(attempts, 'byIdempotencyKey').mockImplementation((tenantId, key) => {
        if (key === 'failed-first') return Promise.reject(firstFailure);
        if (key === 'failed-second') return Promise.reject(secondFailure);
        return originalLookup(tenantId, key);
      });
      for (const id of ['failed-first', 'failed-second', 'healthy']) {
        outbox.enqueue(criticalMessage({ messageId: id, aggregateId: id, idempotencyKey: id }));
      }
      const transport = new ScriptedTransport([{ delivered: true, httpStatus: 202 }]);
      const deps = dependencies(transport);

      await expect(drainOutbox(deps, 3, concurrency)).rejects.toBe(firstFailure);

      expect(transport.calls.map((call) => call.message.qapaq.aggregateId)).toEqual(['healthy']);
      expect(outbox.rows.get('healthy')?.status).toBe('published');
      expect((await attempts.byIdempotencyKey('tenant-1', 'healthy'))?.status).toBe('sent');
      expect(outbox.rows.get('failed-first')?.status).toBe('processing');
      expect(outbox.rows.get('failed-second')?.status).toBe('processing');
      expect((await audit.range('tenant-1', 1n, 10)).map((event) => event.action)).toEqual([
        'soar.notification.sent',
      ]);
      expect(await drainOutbox(deps, 3, concurrency)).toEqual([]);
      expect(transport.calls).toHaveLength(1);
    },
  );

  it('propagates an undefined rejection after completing the rest of the claimed batch', async () => {
    const originalLookup = attempts.byIdempotencyKey.bind(attempts);
    vi.spyOn(attempts, 'byIdempotencyKey').mockImplementation((tenantId, key) =>
      key === 'failed' ? Promise.reject(undefined) : originalLookup(tenantId, key),
    );
    for (const id of ['failed', 'healthy']) {
      outbox.enqueue(criticalMessage({ messageId: id, aggregateId: id, idempotencyKey: id }));
    }
    const transport = new ScriptedTransport([{ delivered: true }]);

    await expect(drainOutbox(dependencies(transport), 2, 2)).rejects.toBeUndefined();

    expect(outbox.rows.get('healthy')?.status).toBe('published');
    expect(transport.calls).toHaveLength(1);
  });
});

describe('notification backoff after slow failures', () => {
  it.each([
    { class: 'transient' as const, code: 'HTTP_429', result: 'retry_scheduled' },
    { class: 'ambiguous' as const, code: 'REQUEST_TIMEOUT', result: 'indeterminate_retry' },
  ])('waits after a slow $code and preserves the idempotency key', async (failure) => {
    let now = AT;
    const clientRequestIds: string[] = [];
    const transport: NotificationTransport = {
      destinationRef: 'teams:canal-soc',
      async send(_message, clientRequestId) {
        clientRequestIds.push(clientRequestId);
        if (clientRequestIds.length > 1) return { delivered: true, httpStatus: 202 };
        now = new Date(AT.getTime() + RETRY_POLICY.requestTimeoutMs);
        return {
          delivered: false,
          failure: { class: failure.class, code: failure.code, detail: 'slow response' },
        };
      },
    };
    const deps = { ...dependencies(transport), clock: { now: () => now } };
    outbox.enqueue(criticalMessage());

    const [first] = await drainOutbox(deps);
    const failedAt = now;
    const retryAt = new Date(failedAt.getTime() + nextDelayMs(1));

    expect(first?.code).toBe(failure.result);
    expect(first?.attempt?.updatedAt).toEqual(failedAt);
    expect(first?.attempt?.availableAt).toEqual(retryAt);
    expect(outbox.rows.get('msg-1')?.availableAt).toEqual(retryAt);
    expect(await drainOutbox(deps)).toEqual([]);
    now = new Date(retryAt.getTime() - 1);
    expect(await drainOutbox(deps)).toEqual([]);
    now = retryAt;
    expect((await drainOutbox(deps)).map((result) => result.code)).toEqual(['delivered']);
    expect(clientRequestIds).toHaveLength(2);
    expect(clientRequestIds[0]).toBe(clientRequestIds[1]);
    expect(outbox.rows.get('msg-1')?.status).toBe('published');
  });
});

describe('C-20 · despacho de críticos', () => {
  it('despacha concurrentemente una tanda acotada y conserva el resultado de cada aviso', async () => {
    let active = 0;
    let maximumActive = 0;
    const transport: NotificationTransport = {
      destinationRef: 'teams:canal-soc',
      async send() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { delivered: true, httpStatus: 202 };
      },
    };
    const messages = [
      criticalMessage({
        messageId: 'urgent-1',
        aggregateId: 'incident-1',
        idempotencyKey: 'key-urgent-1',
      }),
      criticalMessage({
        messageId: 'urgent-2',
        aggregateId: 'incident-2',
        idempotencyKey: 'key-urgent-2',
      }),
    ];
    messages.forEach((message) => outbox.enqueue(message));

    const results = await drainOutbox(dependencies(transport), 2, 2);

    expect(maximumActive).toBe(2);
    expect(results.map((result) => result.code)).toEqual(['delivered', 'delivered']);
    expect(outbox.rows.get('urgent-1')?.status).toBe('published');
    expect(outbox.rows.get('urgent-2')?.status).toBe('published');
  });

  it('entrega el crítico, marca el outbox y audita el envío', async () => {
    const transport = new ScriptedTransport([{ delivered: true, httpStatus: 202 }]);
    const message = criticalMessage();
    outbox.enqueue(message);

    const result = await dispatchMessage(dependencies(transport), message);

    expect(result.code).toBe('delivered');
    expect(result.attempt?.status).toBe('sent');
    expect(result.attempt?.delivery?.[0]).toMatchObject({
      channel: 'teams',
      outcome: 'accepted',
      responseAt: AT.toISOString(),
    });
    expect(outbox.rows.get('msg-1')?.status).toBe('published');
    expect((await audit.range('tenant-1', 1n, 10)).map((event) => event.action)).toEqual([
      'soar.notification.sent',
    ]);
  });

  it('no notifica lo que no es crítico y lo cierra igualmente', async () => {
    const transport = new ScriptedTransport([{ delivered: true }]);
    const message = criticalMessage({
      messageType: 'soc.alert.triaged',
      payload: { title: 'Triada', severity: 'low', status: 'triaged', alertCount: 1 },
    });
    outbox.enqueue(message);

    const result = await dispatchMessage(dependencies(transport), message);

    expect(result.code).toBe('skipped_not_critical');
    expect(transport.calls).toHaveLength(0);
    expect(outbox.rows.get('msg-1')?.status).toBe('published');
  });

  it('notifica una alerta P1 escalada', async () => {
    const transport = new ScriptedTransport([{ delivered: true }]);
    const message = criticalMessage({
      messageType: 'soc.alert.escalated',
      aggregateType: 'alert',
      payload: {
        title: 'Alerta P1',
        priority: 'P1',
        status: 'escalated',
        verdict: 'true_positive',
      },
    });
    outbox.enqueue(message);

    expect((await dispatchMessage(dependencies(transport), message)).code).toBe('delivered');
  });

  it('reprocesar un mensaje ya entregado no publica un segundo mensaje', async () => {
    const transport = new ScriptedTransport([{ delivered: true }]);
    const message = criticalMessage();
    outbox.enqueue(message);

    await dispatchMessage(dependencies(transport), message);
    const again = await dispatchMessage(dependencies(transport), message);

    expect(again.code).toBe('already_delivered');
    expect(transport.calls).toHaveLength(1);
  });
});

describe('C-20 · fallos y reintentos', () => {
  it('programa reintento con espera creciente ante un fallo transitorio', async () => {
    const transport = new ScriptedTransport([
      { delivered: false, failure: { class: 'transient', code: 'HTTP_500', detail: 'x' } },
    ]);
    const message = criticalMessage();
    outbox.enqueue(message);

    const result = await dispatchMessage(dependencies(transport), message);

    expect(result.code).toBe('retry_scheduled');
    expect(result.attempt?.status).toBe('pending');
    expect(outbox.rows.get('msg-1')?.availableAt.getTime()).toBe(AT.getTime() + nextDelayMs(1));
  });

  it('ante timeout ambiguo reintenta con el mismo identificador de cliente', async () => {
    const transport = new ScriptedTransport([
      { delivered: false, failure: { class: 'ambiguous', code: 'REQUEST_TIMEOUT', detail: 'x' } },
      { delivered: true, httpStatus: 202 },
    ]);
    const message = criticalMessage();
    outbox.enqueue(message);

    const first = await dispatchMessage(dependencies(transport), message);
    const second = await dispatchMessage(dependencies(transport), message);

    expect(first.code).toBe('indeterminate_retry');
    expect(first.attempt?.status).toBe('indeterminate');
    expect(second.code).toBe('delivered');
    expect(transport.calls[0]?.clientRequestId).toBe(transport.calls[1]?.clientRequestId);
  });

  it('no reintenta un fallo permanente: va directo al fallback', async () => {
    const transport = new ScriptedTransport([
      { delivered: false, failure: { class: 'permanent', code: 'HTTP_403', detail: 'x' } },
    ]);
    const message = criticalMessage();
    outbox.enqueue(message);

    const result = await dispatchMessage(dependencies(transport), message);

    expect(result.code).toBe('fallback_used');
    expect(result.attempt?.channel).toBe('manual_console');
    expect(fallback.delivered).toHaveLength(1);
    expect(transport.calls).toHaveLength(1);
  });

  it('agota los reintentos y cae al fallback sin perder el crítico', async () => {
    const transport = new ScriptedTransport([
      { delivered: false, failure: { class: 'transient', code: 'HTTP_500', detail: 'x' } },
    ]);
    const message = criticalMessage();
    outbox.enqueue(message);

    const results = [];
    for (let attempt = 0; attempt < RETRY_POLICY.maximumAttempts; attempt += 1) {
      results.push(await dispatchMessage(dependencies(transport), message));
    }

    expect(results.at(-1)?.code).toBe('fallback_used');
    expect(results.at(-1)?.attempt?.attemptCount).toBe(RETRY_POLICY.maximumAttempts);
    expect(fallback.delivered).toHaveLength(1);
    expect(outbox.rows.get('msg-1')?.status).toBe('published');
  });

  it('audita la caída al fallback con su motivo', async () => {
    const transport = new ScriptedTransport([
      { delivered: false, failure: { class: 'permanent', code: 'HTTP_401', detail: 'x' } },
    ]);
    const message = criticalMessage();
    outbox.enqueue(message);
    await dispatchMessage(dependencies(transport), message);
    const events = await audit.range('tenant-1', 1n, 10);

    expect(events[0]).toMatchObject({
      action: 'soar.notification.fallback',
      reason: 'HTTP_401',
      outcome: 'succeeded',
    });
    expect(verifyChain(events).ok).toBe(true);
  });
});

describe('C-20 · drenaje y acuse', () => {
  it('drena solo lo disponible y respeta la espera programada', async () => {
    const transport = new ScriptedTransport([
      { delivered: false, failure: { class: 'transient', code: 'HTTP_500', detail: 'x' } },
    ]);
    outbox.enqueue(criticalMessage());
    outbox.enqueue(
      criticalMessage({
        messageId: 'msg-2',
        idempotencyKey: 'key-critical-2',
        aggregateId: 'inc-2',
      }),
    );

    const first = await drainOutbox(dependencies(transport));
    const immediate = await drainOutbox(dependencies(transport));

    expect(first).toHaveLength(2);
    expect(immediate).toHaveLength(0);
  });

  it('reintenta cuando llega el momento programado', async () => {
    const failing = new ScriptedTransport([
      { delivered: false, failure: { class: 'transient', code: 'HTTP_500', detail: 'x' } },
    ]);
    outbox.enqueue(criticalMessage());
    await drainOutbox(dependencies(failing));

    const later = new Date(AT.getTime() + nextDelayMs(1));
    const succeeding = new ScriptedTransport([{ delivered: true }]);
    const results = await drainOutbox(dependencies(succeeding, later));

    expect(results.map((result) => result.code)).toEqual(['delivered']);
  });

  it('SENT no es acuse: el acuse humano es un estado aparte', async () => {
    const transport = new ScriptedTransport([{ delivered: true }]);
    const message = criticalMessage();
    outbox.enqueue(message);
    const result = await dispatchMessage(dependencies(transport), message);
    const sent = result.attempt!;

    expect(sent.acknowledgedAt).toBeNull();

    const acknowledged = acknowledge(sent, 'analyst-1', new Date(AT.getTime() + 60_000));

    expect(acknowledged.ok && acknowledged.attempt.status).toBe('acknowledged');
    expect(acknowledged.ok && acknowledged.attempt.acknowledgedBy).toBe('analyst-1');
  });

  it('no admite acuse de lo que nunca se entregó, ni dos veces', async () => {
    const transport = new ScriptedTransport([
      { delivered: false, failure: { class: 'transient', code: 'HTTP_500', detail: 'x' } },
    ]);
    const message = criticalMessage();
    outbox.enqueue(message);
    const pending = (await dispatchMessage(dependencies(transport), message)).attempt!;

    expect(acknowledge(pending, 'analyst-1', AT)).toMatchObject({
      ok: false,
      code: 'NOT_DELIVERED',
    });

    const delivered = { ...pending, status: 'sent' as const };
    const once = acknowledge(delivered, 'analyst-1', AT);

    expect(once.ok && acknowledge(once.attempt, 'analyst-1', AT)).toMatchObject({
      ok: false,
      code: 'ALREADY_ACKNOWLEDGED',
    });
  });

  it('admite acuse sobre una entrega indeterminada', async () => {
    const transport = new ScriptedTransport([
      { delivered: false, failure: { class: 'ambiguous', code: 'REQUEST_TIMEOUT', detail: 'x' } },
    ]);
    const message = criticalMessage();
    outbox.enqueue(message);
    const indeterminate = (await dispatchMessage(dependencies(transport), message)).attempt!;

    expect(acknowledge(indeterminate, 'analyst-1', AT).ok).toBe(true);
  });
});

describe('C-20 · plazas P2 y destinatarios push', () => {
  it('reserva plazas P2 concurrentemente y no cuenta un P1 enviado', async () => {
    const p1 = createAttempt({
      id: 'p1',
      tenantId: 'tenant-1',
      messageId: 'p1',
      idempotencyKey: 'p1-key',
      at: AT,
    });
    await attempts.save({
      ...p1,
      status: 'sent',
      sentAt: AT,
      context: { priority: 'P1' },
    });

    const reservations = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        attempts.reserveP2ImmediateSlot('tenant-1', `p2-${index}`, AT, 10),
      ),
    );

    expect(reservations.filter(Boolean)).toHaveLength(10);
    expect(await attempts.reserveP2ImmediateSlot('tenant-1', 'p2-0', AT, 10)).toBe(true);
    expect(await attempts.reserveP2ImmediateSlot('tenant-1', 'p2-overflow', AT, 10)).toBe(false);
  });

  it('fencea el quiet window de grupo y trata entrega, fallo y ambigüedad', async () => {
    const reserve = (key: string, attempt: string, fence: string, at = AT) =>
      attempts.reserveGroupDispatchSlot(
        'tenant-1',
        'group-a',
        key,
        attempt,
        fence,
        at,
        30_000,
        120_000,
      );
    const settle = (
      key: string,
      fence: string,
      result: 'delivered' | 'failed' | 'uncertain',
      at = AT,
    ) =>
      attempts.settleGroupDispatchSlot(
        'tenant-1',
        'group-a',
        key,
        fence,
        at,
        30_000,
        120_000,
        result,
      );

    const first = await reserve('message-1', 'attempt-1', 'fence-1');
    expect(first).toEqual({ granted: true, coveredBy: null });
    await expect(reserve('message-2', 'attempt-2', 'fence-2')).resolves.toEqual({
      granted: false,
      coveredBy: 'attempt-1',
    });

    await settle('message-1', 'fence-1', 'failed');
    const afterKnownFailure = await reserve('message-2', 'attempt-2', 'fence-2');
    expect(afterKnownFailure.granted).toBe(true);
    await settle('message-2', 'fence-2', 'uncertain');
    await expect(reserve('message-3', 'attempt-3', 'fence-3')).resolves.toMatchObject({
      granted: false,
      coveredBy: 'attempt-2',
    });

    // Reconciliation retry of the same idempotent message takes a new fence; the old fence
    // cannot release the reservation after that takeover.
    expect((await reserve('message-2', 'attempt-2', 'fence-2b')).granted).toBe(true);
    await settle('message-2', 'fence-2', 'failed');
    await expect(reserve('message-3', 'attempt-3', 'fence-3')).resolves.toMatchObject({
      granted: false,
      coveredBy: 'attempt-2',
    });
    await settle('message-2', 'fence-2b', 'delivered');
    await expect(reserve('message-3', 'attempt-3', 'fence-3')).resolves.toMatchObject({
      granted: false,
      coveredBy: 'attempt-2',
    });
    expect(
      (await reserve('message-3', 'attempt-3', 'fence-3', new Date(AT.getTime() + 30_001))).granted,
    ).toBe(true);
  });

  it('no aplica el cupo P2 a un aviso P1; limita los avisos P2 siguientes', async () => {
    const transport = new ScriptedTransport([{ delivered: true, httpStatus: 202 }]);
    const policy = { ...DEFAULT_NOTIFICATION_POLICY, maxImmediatePerHour: 1 };
    const deps = { ...dependencies(transport), policy };
    const p1: OutboxMessageDraft = {
      ...criticalMessage(),
      aggregateType: 'alert',
      messageType: 'soc.alert.created',
      payload: { title: 'P1 urgente', priority: 'P1', ruleId: 'r-p1' },
    };
    const p2 = (id: string): OutboxMessageDraft => ({
      ...criticalMessage(),
      messageId: id,
      aggregateType: 'alert',
      aggregateId: id,
      messageType: 'soc.alert.created',
      idempotencyKey: `${id}-key`,
      payload: { title: 'P2 alerta', priority: 'P2', ruleId: id },
    });

    expect((await dispatchMessage(deps, p1)).code).toBe('delivered');
    expect((await dispatchMessage(deps, p2('p2-first'))).code).toBe('delivered');
    expect((await dispatchMessage(deps, p2('p2-second'))).code).toBe('suppressed');
    expect(transport.calls).toHaveLength(2);
  });

  it('envía push a todos los destinatarios aunque Teams mencione como máximo 25', async () => {
    const recipients = Array.from({ length: 30 }, (_, index) => ({
      upn: `analyst-${index}@example.test`,
      displayName: `Analyst ${index}`,
      subjectKey: `oid-${index}`,
    }));
    const transport = new ScriptedTransport([{ delivered: true, httpStatus: 202 }]);
    const devices = { notify: vi.fn(async () => recipients.length) };
    const deps: DispatchDependencies = {
      ...dependencies(transport),
      recipients: { recipientsFor: async () => recipients },
      devices,
    };
    const message = criticalMessage();
    outbox.enqueue(message);

    await dispatchMessage(deps, message);

    expect(devices.notify).toHaveBeenCalledWith(
      'tenant-1',
      recipients.map((recipient) => recipient.subjectKey),
    );
    const content = transport.calls[0]!.message.attachments[0].content;
    const msteams = content['msteams'] as { entities: readonly unknown[] };
    expect(msteams.entities).toHaveLength(25);
  });

  it('libera el cupo P2 al fallar el canal y permite otra alerta', async () => {
    const policy = { ...DEFAULT_NOTIFICATION_POLICY, maxImmediatePerHour: 1 };
    const transport = new ScriptedTransport([
      {
        delivered: false,
        httpStatus: 503,
        failure: { class: 'transient', code: 'UNAVAILABLE', detail: 'No disponible.' },
      },
      { delivered: true, httpStatus: 202 },
    ]);
    const deps = { ...dependencies(transport), policy };
    const p2 = (id: string): OutboxMessageDraft => ({
      ...criticalMessage(),
      messageId: id,
      aggregateType: 'alert',
      aggregateId: id,
      messageType: 'soc.alert.created',
      idempotencyKey: `${id}-key`,
      payload: { title: 'Alerta P2', priority: 'P2', ruleId: id },
    });
    const failed = p2('p2-failed');
    const next = p2('p2-next');
    outbox.enqueue(failed);
    outbox.enqueue(next);

    expect((await dispatchMessage(deps, failed)).code).toBe('retry_scheduled');
    expect((await dispatchMessage(deps, next)).code).toBe('delivered');
  });

  it('renueva idempotentemente el cupo de una alerta P2 al reintentar', async () => {
    const policy = { ...DEFAULT_NOTIFICATION_POLICY, maxImmediatePerHour: 1 };
    const transport = new ScriptedTransport([
      {
        delivered: false,
        httpStatus: 503,
        failure: { class: 'transient', code: 'UNAVAILABLE', detail: 'No disponible.' },
      },
      { delivered: true, httpStatus: 202 },
    ]);
    const deps = { ...dependencies(transport), policy };
    const message: OutboxMessageDraft = {
      ...criticalMessage(),
      aggregateType: 'alert',
      messageType: 'soc.alert.created',
      payload: { title: 'Alerta P2', priority: 'P2', ruleId: 'r-p2-retry' },
    };
    outbox.enqueue(message);

    expect((await dispatchMessage(deps, message)).code).toBe('retry_scheduled');
    expect((await dispatchMessage(deps, message)).code).toBe('delivered');
    expect(transport.calls).toHaveLength(2);
    expect(await attempts.reserveP2ImmediateSlot('tenant-1', 'p2-after-confirmed', AT, 1)).toBe(
      false,
    );
  });

  it('acota las plazas ambiguas a dos minutos y mantiene las confirmadas una hora', async () => {
    expect(await attempts.reserveP2ImmediateSlot('tenant-1', 'ambiguous', AT, 1)).toBe(true);
    await attempts.settleP2ImmediateSlot('tenant-1', 'ambiguous', AT, 'uncertain');
    expect(
      await attempts.reserveP2ImmediateSlot(
        'tenant-1',
        'after-lease',
        new Date(AT.getTime() + 120_001),
        1,
      ),
    ).toBe(true);

    await attempts.settleP2ImmediateSlot('tenant-1', 'after-lease', AT, 'delivered');
    expect(
      await attempts.reserveP2ImmediateSlot(
        'tenant-1',
        'within-hour',
        new Date(AT.getTime() + 120_002),
        1,
      ),
    ).toBe(false);
    expect(
      await attempts.reserveP2ImmediateSlot(
        'tenant-1',
        'after-hour',
        new Date(AT.getTime() + 3_600_001),
        1,
      ),
    ).toBe(true);
  });
});
