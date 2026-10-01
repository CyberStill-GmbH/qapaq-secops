/**
 * Stores en memoria de C-18/C-25, para unit specs y para el harness E2E.
 *
 * Reproducen las dos propiedades de las que depende el dominio: consumo atómico del
 * `state` y compare-and-set sobre la revisión de sesión. Node ejecuta cada método sin
 * interrupción, de modo que la atomicidad es real dentro del proceso; el adapter
 * distribuido debe conseguirla con la base o con Redis.
 */

import type { PendingHandshake } from './oidc-handshake.js';
import type { Session } from './session.js';
import type { AttemptCounter, RateLimitState } from './lockout.js';
import type { AttemptStore, HandshakeStore, RateLimitStore, SessionStore } from './ports.js';

export class InMemoryHandshakeStore implements HandshakeStore {
  private readonly entries = new Map<string, PendingHandshake>();

  public save(handshake: PendingHandshake): Promise<void> {
    this.entries.set(handshake.state, handshake);
    return Promise.resolve();
  }

  public consume(state: string, now: Date): Promise<PendingHandshake | undefined> {
    const stored = this.entries.get(state);
    if (!stored) return Promise.resolve(undefined);
    this.entries.set(state, { ...stored, consumedAt: stored.consumedAt ?? now });
    return Promise.resolve(stored);
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  public create(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }

  public byId(sessionId: string): Promise<Session | undefined> {
    return Promise.resolve(this.sessions.get(sessionId));
  }

  public activeBySubject(tenantId: string, subjectId: string): Promise<readonly Session[]> {
    return Promise.resolve(
      [...this.sessions.values()].filter(
        (session) =>
          session.tenantId === tenantId &&
          session.subjectId === subjectId &&
          session.state === 'active',
      ),
    );
  }

  public update(session: Session, expectedRevision: number): Promise<boolean> {
    const current = this.sessions.get(session.id);
    if (!current || current.revision !== expectedRevision) return Promise.resolve(false);
    this.sessions.set(session.id, session);
    return Promise.resolve(true);
  }
}

export class InMemoryAttemptStore implements AttemptStore {
  private readonly counters = new Map<string, AttemptCounter>();

  public get(subjectKey: string, originKey: string): Promise<AttemptCounter | undefined> {
    return Promise.resolve(this.counters.get(`${subjectKey}|${originKey}`));
  }

  public save(counter: AttemptCounter): Promise<void> {
    this.counters.set(`${counter.subjectKey}|${counter.originKey}`, counter);
    return Promise.resolve();
  }
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly states = new Map<string, RateLimitState>();

  public get(key: string): Promise<RateLimitState | undefined> {
    return Promise.resolve(this.states.get(key));
  }

  public save(state: RateLimitState): Promise<void> {
    this.states.set(state.key, state);
    return Promise.resolve();
  }
}
