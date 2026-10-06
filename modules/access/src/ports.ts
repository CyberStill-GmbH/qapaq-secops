/**
 * Puertos de C-18/C-25. Solo tipos: el dominio no conoce MSAL, Redis ni PostgreSQL.
 *
 * El intercambio de código por tokens es un puerto y no una llamada directa para que el
 * dominio se pueda probar sin tenant, y para que el día que Entra cambie de endpoint no
 * haya que tocar la política de admisión.
 */

import type { JsonWebKey } from './id-token.js';
import type { PendingHandshake } from './oidc-handshake.js';
import type { Session } from './session.js';
import type { AttemptCounter, RateLimitState } from './lockout.js';

export interface HandshakeStore {
  save(handshake: PendingHandshake): Promise<void>;
  /** Devuelve y marca consumido en una sola operación atómica: el replay no puede ganar. */
  consume(
    state: string,
    browserBinding: string | undefined,
    now: Date,
  ): Promise<PendingHandshake | undefined>;
}

export interface SessionStore {
  create(session: Session): Promise<void>;
  byId(sessionId: string): Promise<Session | undefined>;
  activeBySubject(tenantId: string, subjectId: string): Promise<readonly Session[]>;
  /** Compare-and-set sobre `revision`; `false` si otra escritura se adelantó. */
  update(session: Session, expectedRevision: number): Promise<boolean>;
}

export interface AttemptStore {
  get(subjectKey: string, originKey: string): Promise<AttemptCounter | undefined>;
  save(counter: AttemptCounter): Promise<void>;
}

export interface RateLimitStore {
  get(key: string): Promise<RateLimitState | undefined>;
  save(state: RateLimitState): Promise<void>;
}

export interface JwksProvider {
  /** Claves vigentes del tenant. El adapter cachea y refresca ante `kid` desconocido. */
  keys(): Promise<readonly JsonWebKey[]>;
}

export interface TokenExchangeResult {
  readonly idToken: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresInSeconds: number;
}

export interface TokenExchange {
  exchange(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<TokenExchangeResult>;
}
