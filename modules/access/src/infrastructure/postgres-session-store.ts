/**
 * Adapter PostgreSQL de `SessionStore` (C-18/C-25). Se publica como subpath
 * (`@qapaq/access/postgres`) para que el runtime en memoria no cargue Prisma.
 *
 * El identificador de sesión es el valor de la cookie, o sea, una credencial. La base
 * guarda solo `sha256(id)`:
 *
 * - `byId(id)` busca por el hash del id recibido y devuelve la sesión con ese mismo id.
 * - `activeBySubject` no conoce los ids originales: devuelve sesiones cuyo `id` es
 *   `h:<hash>`. Ese valor solo sirve para revocarlas con `update` (reemplazo por sesión
 *   única). `byId` lo rechaza: el hash nunca funciona como cookie.
 * - `create`/`update` aceptan cualquiera de las dos formas.
 *
 * Una fila con un valor fuera de catálogo (estado, motivo, capability) es un error de
 * integridad y se reporta, no se adivina.
 */

import { createHash } from 'node:crypto';

import {
  closeDatabaseClient,
  createDatabaseClient,
  type DatabaseConnectionOptions,
} from '@qapaq/database';
import { PrismaSessionStore, type SessionRow } from '@qapaq/database/session-stores';

import { CAPABILITIES, type Capability } from '../capabilities.js';
import {
  SESSION_REVOCATION_REASONS,
  SESSION_STATES,
  type Session,
  type SessionRevocationReason,
  type SessionState,
} from '../session.js';
import type { SessionStore } from '../ports.js';

const HASHED_PREFIX = 'h:';

export class SessionIntegrityError extends Error {
  public constructor(public readonly column: string) {
    super(`Valor fuera de catálogo en access_sessions.${column}.`);
    this.name = 'SessionIntegrityError';
  }
}

/** Hash del identificador; un `h:<hash>` ya es el hash y se usa tal cual. */
export function sessionIdHash(sessionId: string): string {
  if (sessionId.startsWith(HASHED_PREFIX)) return sessionId.slice(HASHED_PREFIX.length);
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

function oneOf<T extends string>(catalog: readonly T[], value: string, column: string): T {
  if (!(catalog as readonly string[]).includes(value)) throw new SessionIntegrityError(column);
  return value as T;
}

function toRow(session: Session): SessionRow {
  return {
    idHash: sessionIdHash(session.id),
    tenantId: session.tenantId,
    subjectId: session.subjectId,
    subjectOid: session.oid?.toLowerCase() ?? null,
    displayName: session.displayName ?? null,
    email: session.email ?? null,
    state: session.state,
    roles: [...session.roles],
    scopes: [...session.scopes],
    capabilities: [...session.capabilities],
    amr: [...session.amr],
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    idpSessionId: session.idpSessionId ?? null,
    clientIp: session.clientIp,
    revokedAt: session.revokedAt ?? null,
    revocationReason: session.revocationReason ?? null,
    revision: session.revision,
  };
}

function toSession(row: SessionRow, id: string): Session {
  return {
    id,
    subjectId: row.subjectId,
    ...(row.subjectOid === null ? {} : { oid: row.subjectOid }),
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    ...(row.email === null ? {} : { email: row.email }),
    tenantId: row.tenantId,
    state: oneOf<SessionState>(SESSION_STATES, row.state, 'state'),
    roles: [...row.roles],
    scopes: [...row.scopes],
    capabilities: new Set(
      row.capabilities.map((capability) =>
        oneOf<Capability>(CAPABILITIES, capability, 'capabilities'),
      ),
    ),
    amr: [...row.amr],
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    ...(row.idpSessionId === null ? {} : { idpSessionId: row.idpSessionId }),
    clientIp: row.clientIp,
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
    ...(row.revocationReason === null
      ? {}
      : {
          revocationReason: oneOf<SessionRevocationReason>(
            SESSION_REVOCATION_REASONS,
            row.revocationReason,
            'revocation_reason',
          ),
        }),
    revision: row.revision,
  };
}

export class PostgresSessionStore implements SessionStore {
  private constructor(
    private readonly store: PrismaSessionStore,
    private readonly closeClient: () => Promise<void>,
  ) {}

  public static connect(options: DatabaseConnectionOptions): PostgresSessionStore {
    const client = createDatabaseClient(options);
    return new PostgresSessionStore(new PrismaSessionStore(client), () =>
      closeDatabaseClient(client),
    );
  }

  public create(session: Session): Promise<void> {
    return this.store.create(toRow(session));
  }

  public async byId(sessionId: string): Promise<Session | undefined> {
    // `byId` recibe el valor de la cookie. Un `h:<hash>` se rechaza: si se aceptara, quien
    // pudiera leer la base podría presentar el hash como cookie y abrir la sesión.
    if (sessionId.startsWith(HASHED_PREFIX)) return undefined;
    const row = await this.store.byIdHash(sessionIdHash(sessionId));
    return row ? toSession(row, sessionId) : undefined;
  }

  public async activeBySubject(tenantId: string, subjectId: string): Promise<readonly Session[]> {
    const rows = await this.store.activeBySubject(tenantId, subjectId);
    return rows.map((row) => toSession(row, `${HASHED_PREFIX}${row.idHash}`));
  }

  public async activeByOid(tenantId: string, oid: string): Promise<readonly Session[]> {
    const rows = await this.store.activeByOid(tenantId, oid);
    return rows.map((row) => toSession(row, `${HASHED_PREFIX}${row.idHash}`));
  }

  public update(session: Session, expectedRevision: number): Promise<boolean> {
    return this.store.update(toRow(session), expectedRevision);
  }

  public async recentByTenant(
    tenantId: string,
    since: Date,
    limit: number,
  ): Promise<readonly Session[]> {
    const rows = await this.store.recentByTenant(tenantId, since, limit);
    return rows.map((row) => toSession(row, `${HASHED_PREFIX}${row.idHash}`));
  }

  public async byReference(reference: string): Promise<Session | undefined> {
    if (!reference.startsWith(HASHED_PREFIX)) return undefined;
    const row = await this.store.byIdHash(sessionIdHash(reference));
    return row ? toSession(row, reference) : undefined;
  }

  public close(): Promise<void> {
    return this.closeClient();
  }
}

// Sprint 5 · fase 3: el padrón comparte el subpath `@qapaq/access/postgres`.
export { DirectoryIntegrityError, PostgresDirectoryStore } from './postgres-directory-store.js';
