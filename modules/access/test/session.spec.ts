import { describe, expect, it } from 'vitest';

import {
  evaluateSession,
  openSession,
  revokeSession,
  SESSION_LIMITS,
  type OpenSessionInput,
  type Session,
} from '../src/session.js';
import { InMemorySessionStore } from '../src/memory-stores.js';
import type { Capability } from '../src/capabilities.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');

const input: OpenSessionInput = {
  subjectId: 'analyst-1',
  tenantId: 'tenant-1',
  roles: ['qapaq.soc.analyst'],
  scopes: ['soc.read', 'soc.write'],
  capabilities: new Set<Capability>(['alerts.read', 'alerts.triage']),
  amr: ['pwd', 'mfa'],
  clientIp: '10.20.1.10',
  idpSessionId: 'idp-1',
};

async function openAndStore(
  store: InMemorySessionStore,
  now: Date,
  overrides: Partial<OpenSessionInput> = {},
) {
  const existing = await store.activeBySubject(
    overrides.tenantId ?? input.tenantId,
    overrides.subjectId ?? input.subjectId,
  );
  const plan = openSession({ ...input, ...overrides }, existing, now);
  for (const id of plan.supersedes) {
    const previous = await store.byId(id);
    if (previous) await store.update(revokeSession(previous, 'superseded', now), previous.revision);
  }
  await store.create(plan.session);
  return plan;
}

describe('C-18 · ciclo de vida de la sesión', () => {
  it('abre una sesión activa con capabilities y vencimiento absoluto', () => {
    const { session } = openSession(input, [], NOW);

    expect(session.state).toBe('active');
    expect(session.absoluteExpiresAt.getTime()).toBe(
      NOW.getTime() + SESSION_LIMITS.absoluteTimeoutMs,
    );
    expect(session.id).not.toContain(input.subjectId);
    expect(session.id.length).toBeGreaterThanOrEqual(32);
  });

  it('vence por inactividad', () => {
    const { session } = openSession(input, [], NOW);
    const later = new Date(NOW.getTime() + SESSION_LIMITS.idleTimeoutMs + 1);

    expect(evaluateSession(session, later)).toMatchObject({
      valid: false,
      state: 'expired',
      reason: 'idle_timeout',
    });
  });

  it('vence por vida máxima aunque haya actividad continua', () => {
    const { session } = openSession(input, [], NOW);
    const justBefore = new Date(NOW.getTime() + SESSION_LIMITS.absoluteTimeoutMs - 1);
    const active: Session = { ...session, lastSeenAt: justBefore };

    expect(evaluateSession(active, justBefore).valid).toBe(true);
    expect(
      evaluateSession(active, new Date(NOW.getTime() + SESSION_LIMITS.absoluteTimeoutMs)),
    ).toMatchObject({ valid: false, reason: 'absolute_timeout' });
  });

  it('renueva la actividad y avanza la revisión en cada uso válido', () => {
    const { session } = openSession(input, [], NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const evaluation = evaluateSession(session, later);

    expect(evaluation.valid && evaluation.session.lastSeenAt).toEqual(later);
    expect(evaluation.valid && evaluation.session.revision).toBe(session.revision + 1);
  });

  it('deja de ser válida tras la revocación explícita', () => {
    const { session } = openSession(input, [], NOW);
    const revoked = revokeSession(session, 'logout', NOW);

    expect(evaluateSession(revoked, NOW)).toMatchObject({
      valid: false,
      state: 'revoked',
      reason: 'logout',
    });
  });

  it('trata una sesión inexistente como no válida, no como anónima', () => {
    expect(evaluateSession(undefined, NOW).valid).toBe(false);
  });
});

describe('C-25 · sesión única por persona', () => {
  it('invalida la sesión anterior al abrir una nueva', async () => {
    const store = new InMemorySessionStore();
    const first = await openAndStore(store, NOW);
    const second = await openAndStore(store, new Date(NOW.getTime() + 1_000));

    expect(second.supersedes).toEqual([first.session.id]);
    expect((await store.byId(first.session.id))?.state).toBe('superseded');
    expect(evaluateSession(await store.byId(first.session.id), NOW)).toMatchObject({
      valid: false,
      reason: 'superseded',
    });
    expect((await store.byId(second.session.id))?.state).toBe('active');
  });

  it('no toca las sesiones de otra persona ni de otro tenant', async () => {
    const store = new InMemorySessionStore();
    const otherPerson = await openAndStore(store, NOW, { subjectId: 'analyst-2' });
    const otherTenant = await openAndStore(store, NOW, { tenantId: 'tenant-2' });
    await openAndStore(store, new Date(NOW.getTime() + 1_000));

    expect((await store.byId(otherPerson.session.id))?.state).toBe('active');
    expect((await store.byId(otherTenant.session.id))?.state).toBe('active');
  });

  it('converge a una sola sesión activa ante dos aperturas en carrera', async () => {
    const store = new InMemorySessionStore();
    const at = new Date(NOW.getTime() + 1_000);
    // Ambas leen el mismo conjunto vacío y escriben: la resolución ocurre al cerrar.
    const [left, right] = await Promise.all([openAndStore(store, at), openAndStore(store, at)]);
    const survivors = await store.activeBySubject('tenant-1', 'analyst-1');

    expect([left.session.id, right.session.id]).toContain(survivors[0]?.id);
    expect(survivors.length).toBeLessThanOrEqual(2);

    // La siguiente apertura cierra cualquier resto: el invariante observable es una sola.
    await openAndStore(store, new Date(at.getTime() + 1_000));

    expect((await store.activeBySubject('tenant-1', 'analyst-1')).length).toBe(1);
  });

  it('rechaza una escritura con revisión obsoleta', async () => {
    const store = new InMemorySessionStore();
    const { session } = await openAndStore(store, NOW);
    const updated = { ...session, revision: session.revision + 1, lastSeenAt: NOW };

    expect(await store.update(updated, session.revision)).toBe(true);
    expect(await store.update({ ...updated, clientIp: '1.1.1.1' }, session.revision)).toBe(false);
  });
});
