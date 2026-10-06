/**
 * C-18/C-25 — sesión del BFF y sesión única por persona.
 *
 * La cookie del navegador es un identificador opaco; el estado vive aquí. Eso permite
 * revocar de verdad, algo que un JWT autocontenido no concede.
 *
 * Sesión única (C-25): abrir una sesión invalida las anteriores de la misma persona.
 * Dos aperturas simultáneas son una carrera legítima —dos pestañas, dos dispositivos— y
 * deben converger en que sobrevive exactamente una: la más reciente. La función es pura
 * y decide; el store aplica el resultado bajo compare-and-set.
 */

import { randomBytes } from 'node:crypto';

import type { Capability } from './capabilities.js';

export const SESSION_LIMITS = Object.freeze({
  /** Inactividad tolerada. Vencida, se exige volver a pasar por Entra. */
  idleTimeoutMs: 30 * 60 * 1000,
  /** Vida máxima, se use o no. Una sesión eterna no es una sesión. */
  absoluteTimeoutMs: 8 * 60 * 60 * 1000,
  identifierBytes: 32,
});

export const SESSION_STATES = ['active', 'expired', 'revoked', 'superseded'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_REVOCATION_REASONS = [
  'logout',
  'superseded',
  'idle_timeout',
  'absolute_timeout',
  'identity_revoked',
  'administrative',
] as const;
export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];

export interface Session {
  readonly id: string;
  readonly subjectId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly tenantId: string;
  readonly state: SessionState;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly capabilities: ReadonlySet<Capability>;
  readonly amr: readonly string[];
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly idpSessionId?: string;
  readonly clientIp: string;
  readonly revokedAt?: Date;
  readonly revocationReason?: SessionRevocationReason;
  /** Avanza en cada mutación; el store escribe con compare-and-set sobre este valor. */
  readonly revision: number;
}

export interface OpenSessionInput {
  readonly subjectId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly capabilities: ReadonlySet<Capability>;
  readonly amr: readonly string[];
  readonly clientIp: string;
  readonly idpSessionId?: string;
}

export interface OpenSessionPlan {
  readonly session: Session;
  /** Sesiones previas de la misma persona que quedan invalidadas por esta apertura. */
  readonly supersedes: readonly string[];
}

export function newSessionId(randomSource: (bytes: number) => Buffer = randomBytes): string {
  return randomSource(SESSION_LIMITS.identifierBytes).toString('base64url');
}

export function openSession(
  input: OpenSessionInput,
  existing: readonly Session[],
  now: Date,
  randomSource: (bytes: number) => Buffer = randomBytes,
): OpenSessionPlan {
  const session: Session = {
    id: newSessionId(randomSource),
    subjectId: input.subjectId,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.email === undefined ? {} : { email: input.email }),
    tenantId: input.tenantId,
    state: 'active',
    roles: [...input.roles],
    scopes: [...input.scopes],
    capabilities: new Set(input.capabilities),
    amr: [...input.amr],
    createdAt: now,
    lastSeenAt: now,
    absoluteExpiresAt: new Date(now.getTime() + SESSION_LIMITS.absoluteTimeoutMs),
    ...(input.idpSessionId === undefined ? {} : { idpSessionId: input.idpSessionId }),
    clientIp: input.clientIp,
    revision: 1,
  };
  const supersedes = existing
    .filter(
      (candidate) =>
        candidate.subjectId === input.subjectId &&
        candidate.tenantId === input.tenantId &&
        candidate.state === 'active',
    )
    .map((candidate) => candidate.id);
  return { session, supersedes };
}

export type SessionEvaluation =
  | { readonly valid: true; readonly session: Session }
  | {
      readonly valid: false;
      readonly state: Exclude<SessionState, 'active'>;
      readonly reason: SessionRevocationReason;
    };

export function evaluateSession(session: Session | undefined, now: Date): SessionEvaluation {
  if (!session) return { valid: false, state: 'revoked', reason: 'administrative' };
  if (session.state === 'revoked' || session.state === 'superseded') {
    return {
      valid: false,
      state: session.state,
      reason:
        session.revocationReason ??
        (session.state === 'superseded' ? 'superseded' : 'administrative'),
    };
  }
  if (now.getTime() >= session.absoluteExpiresAt.getTime()) {
    return { valid: false, state: 'expired', reason: 'absolute_timeout' };
  }
  if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_LIMITS.idleTimeoutMs) {
    return { valid: false, state: 'expired', reason: 'idle_timeout' };
  }
  return { valid: true, session: { ...session, lastSeenAt: now, revision: session.revision + 1 } };
}

export function revokeSession(
  session: Session,
  reason: SessionRevocationReason,
  now: Date,
): Session {
  return {
    ...session,
    state: reason === 'superseded' ? 'superseded' : 'revoked',
    revokedAt: now,
    revocationReason: reason,
    revision: session.revision + 1,
  };
}
