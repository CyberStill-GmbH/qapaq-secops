import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryAuditStore, verifyChain } from '@qapaq/audit';
import type { OutboxMessageDraft } from '@qapaq/soc';

import { dispatchMessage, drainOutbox, type DispatchDependencies } from '../src/dispatcher.js';
import {
  ConsoleFallbackChannel,
  InMemoryAttemptStore,
  InMemoryOutbox,
} from '../src/memory-stores.js';
import { acknowledge } from '../src/notification.js';
import { RETRY_POLICY, nextDelayMs } from '../src/delivery-policy.js';
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

describe('C-20 · despacho de críticos', () => {
  it('entrega el crítico, marca el outbox y audita el envío', async () => {
    const transport = new ScriptedTransport([{ delivered: true, httpStatus: 202 }]);
    const message = criticalMessage();
    outbox.enqueue(message);

    const result = await dispatchMessage(dependencies(transport), message);

    expect(result.code).toBe('delivered');
    expect(result.attempt?.status).toBe('sent');
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
