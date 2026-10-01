import { describe, expect, it } from 'vitest';

import {
  AUDIT_CHAIN_GENESIS,
  AuditDraftError,
  auditHash,
  sealAuditEvent,
  type AuditEventDraft,
} from '../src/audit-event.js';
import { canonicalize } from '../src/canonical-json.js';
import { verifyChain } from '../src/hash-chain.js';
import { AuditAppendConflictError, InMemoryAuditStore } from '../src/memory-store.js';
import { recordAudit } from '../src/audit-writer.js';

const AT = new Date('2026-10-07T12:00:00.000Z');

function draft(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    id: '0199bf00-0000-7000-8000-000000000001',
    tenantId: 'tenant-1',
    occurredAt: AT,
    actor: { id: 'analyst-1', type: 'user', sessionId: 'sess-1', ip: '10.10.1.5' },
    action: 'soc.alert.triage',
    resource: { type: 'alert', id: 'alert-1' },
    outcome: 'succeeded',
    correlationId: 'corr-1',
    ...overrides,
  };
}

async function chainOf(store: InMemoryAuditStore, count: number) {
  const sealed = [];
  for (let index = 0; index < count; index += 1) {
    sealed.push(
      await recordAudit(
        store,
        draft({
          id: `0199bf00-0000-7000-8000-00000000000${index + 1}`,
          resource: { type: 'alert', id: `alert-${index + 1}` },
        }),
      ),
    );
  }
  return sealed;
}

describe('C-19 · sellado y cadena de hash', () => {
  it('encadena desde el génesis y avanza una secuencia por evento', async () => {
    const store = new InMemoryAuditStore();
    const [first, second] = await chainOf(store, 2);

    expect(first!.sequence).toBe(1n);
    expect(first!.previousHash).toBe(AUDIT_CHAIN_GENESIS);
    expect(second!.sequence).toBe(2n);
    expect(second!.previousHash).toBe(first!.hash);
    expect(verifyChain([first!, second!]).ok).toBe(true);
  });

  it('aísla la cadena de cada tenant', async () => {
    const store = new InMemoryAuditStore();
    await recordAudit(store, draft());
    const other = await recordAudit(store, draft({ tenantId: 'tenant-2' }));

    expect(other.sequence).toBe(1n);
    expect(other.previousHash).toBe(AUDIT_CHAIN_GENESIS);
  });

  it('produce el mismo hash con metadata equivalente en distinto orden de claves', () => {
    const left = sealAuditEvent(draft({ metadata: { b: 2, a: 1 } }), undefined);
    const right = sealAuditEvent(draft({ metadata: { a: 1, b: 2 } }), undefined);

    expect(left.hash).toBe(right.hash);
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('cambia el hash ante cualquier cambio de contenido', () => {
    const base = sealAuditEvent(draft(), undefined);
    const altered = sealAuditEvent(draft({ outcome: 'denied' }), undefined);

    expect(altered.hash).not.toBe(base.hash);
  });

  it('rechaza borradores incompletos antes de sellar', () => {
    expect(() => sealAuditEvent(draft({ action: '' }), undefined)).toThrow(AuditDraftError);
    expect(() => sealAuditEvent(draft({ correlationId: '' }), undefined)).toThrow(
      /CORRELATION_REQUIRED/u,
    );
    expect(() =>
      sealAuditEvent(draft({ metadata: { blob: 'x'.repeat(9000) } }), undefined),
    ).toThrow(/METADATA_TOO_LARGE/u);
  });

  it('detecta manipulación de una fila ya sellada', async () => {
    const store = new InMemoryAuditStore();
    const events = await chainOf(store, 3);
    const tampered = { ...events[1]!, outcome: 'denied' as const };
    store.forceReplaceForTamperSpec('tenant-1', tampered);

    const verification = verifyChain(await store.range('tenant-1', 1n, 10));

    expect(verification.ok).toBe(false);
    expect(verification.violations.map((violation) => violation.code)).toContain('TAMPERED');
  });

  it('detecta el borrado de un eslabón como hueco', async () => {
    const store = new InMemoryAuditStore();
    await chainOf(store, 3);
    store.forceDeleteForGapSpec('tenant-1', 2n);

    const verification = verifyChain(await store.range('tenant-1', 1n, 10));

    expect(verification.ok).toBe(false);
    expect(verification.violations[0]?.code).toBe('GAP');
  });

  it('detecta una bifurcación cuyo enlace previo no corresponde', async () => {
    const store = new InMemoryAuditStore();
    const events = await chainOf(store, 2);
    const forgedPrevious = 'f'.repeat(64);
    const forged = {
      ...events[1]!,
      previousHash: forgedPrevious,
      hash: auditHash(events[1]!, 2n, forgedPrevious),
    };
    store.forceReplaceForTamperSpec('tenant-1', forged);

    const verification = verifyChain(await store.range('tenant-1', 1n, 10));

    expect(verification.violations.map((violation) => violation.code)).toEqual(['FORKED']);
  });

  it('acepta una página intermedia cuando se le entrega la cabeza previa', async () => {
    const store = new InMemoryAuditStore();
    const events = await chainOf(store, 4);
    const page = events.slice(2);

    expect(
      verifyChain(page, { from: { sequence: events[1]!.sequence, hash: events[1]!.hash } }).ok,
    ).toBe(true);
    expect(verifyChain(page).ok).toBe(false);
  });

  it('relee la cabeza y reintenta cuando otra transacción gana la secuencia', async () => {
    const store = new InMemoryAuditStore();
    await recordAudit(store, draft());
    let firstAppend = true;
    const racing = {
      head: (tenantId: string) => store.head(tenantId),
      append: async (event: Parameters<InMemoryAuditStore['append']>[0]) => {
        if (firstAppend) {
          firstAppend = false;
          // Otra transacción selló y escribió la secuencia 2 entre el head() y el append().
          await store.append(
            sealAuditEvent(
              draft({
                id: '0199bf00-0000-7000-8000-0000000000ff',
                action: 'access.session.close',
              }),
              await store.head('tenant-1'),
            ),
          );
          throw new AuditAppendConflictError(event.tenantId, event.sequence);
        }
        return store.append(event);
      },
      read: (query: Parameters<InMemoryAuditStore['read']>[0]) => store.read(query),
      range: (tenantId: string, from: bigint, limit: number) => store.range(tenantId, from, limit),
    };

    const sealed = await recordAudit(racing, draft({ action: 'soc.incident.open' }));

    expect(sealed.sequence).toBe(3n);
    expect(verifyChain(await store.range('tenant-1', 1n, 10)).ok).toBe(true);
  });

  it('no expone ninguna operación de actualización o borrado en el contrato del store', () => {
    const store = new InMemoryAuditStore();
    // Los `force*` son utilidades de spec y están fuera del contrato `AuditStore`.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object).filter(
      (name) => name !== 'constructor' && !name.startsWith('force'),
    );

    expect(surface.some((name) => /update|delete|remove|truncate|purge/iu.test(name))).toBe(false);
    expect(surface).toEqual(expect.arrayContaining(['append', 'head', 'range', 'read']));
  });
});
