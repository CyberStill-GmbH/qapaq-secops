/**
 * Historial de conversaciones de Qapaqzito en la API: almacén (memoria o PostgreSQL), retención y
 * auditoría de borrados.
 *
 * - El almacén durable se usa cuando la persistencia SOC es `postgres`; en memoria en desarrollo
 *   y pruebas. Se importa de forma diferida para que el runtime en memoria no cargue Prisma.
 * - Retención (`QAPAQ_QAPAQZITO_RETENTION_DAYS`): purga perezosa del tenant al listar y al guardar,
 *   como mucho una vez por minuto y proceso. Es borrado real.
 * - Auditoría: `assistant.conversation.delete` y `assistant.conversation.purge` registran solo
 *   identificadores y conteos; el contenido nunca va a auditoría ni a logs.
 */

import { randomUUID } from 'node:crypto';

import { recordAudit, type AuditStore } from '@qapaq/audit';
import { InMemoryConversationStore, type ConversationStore } from '@qapaq/assistant';

import { loadAssistantConfig, loadAssistantHistoryConfig } from './assistant-config.js';

/** Conexión a PostgreSQL (misma forma que la de los demás almacenes durables). */
export interface ConversationDatabaseConnection {
  readonly connectionString: string;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly maxConnections?: number;
}

export type ClosableConversationStore = ConversationStore & { close(): Promise<void> };

const DAY_MS = 86_400_000;
/** Intervalo mínimo entre purgas perezosas del mismo tenant (por proceso). */
const PURGE_INTERVAL_MS = 60_000;
const RETENTION_ACTOR = 'system:assistant-retention';

export class ConversationHistory {
  private readonly lastPurge = new Map<string, number>();

  public constructor(
    public readonly store: ConversationStore,
    public readonly retentionDays: number,
    private readonly purgeIntervalMs = PURGE_INTERVAL_MS,
  ) {}

  /** Instante antes del cual una conversación inactiva ya venció. */
  public cutoff(now: Date): Date {
    return new Date(now.getTime() - this.retentionDays * DAY_MS);
  }

  /**
   * Purga perezosa. Nunca falla hacia quien llama: si la base no responde, se reintenta en la
   * siguiente oportunidad. Devuelve cuántas borró (0 si no tocaba).
   */
  public async purgeExpired(
    audit: AuditStore,
    tenantId: string,
    now: Date,
    correlationId: string,
  ): Promise<number> {
    const last = this.lastPurge.get(tenantId);
    if (last !== undefined && now.getTime() - last < this.purgeIntervalMs) return 0;
    this.lastPurge.set(tenantId, now.getTime());
    try {
      const purged = await this.store.purgeOlderThan(tenantId, this.cutoff(now));
      if (purged > 0) {
        await auditConversationRemoval(audit, {
          tenantId,
          actor: { id: RETENTION_ACTOR, type: 'service' },
          action: 'assistant.conversation.purge',
          resourceId: 'retention',
          count: purged,
          reason: `retention:${this.retentionDays}d`,
          correlationId,
          at: now,
        });
      }
      return purged;
    } catch {
      this.lastPurge.delete(tenantId);
      return 0;
    }
  }
}

export interface ConversationRemoval {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly type: 'user' | 'service' };
  readonly action: 'assistant.conversation.delete' | 'assistant.conversation.purge';
  /** Id de la conversación, `all` (todas las mías), `retention` o `limit`. */
  readonly resourceId: string;
  readonly count: number;
  readonly reason?: string;
  readonly correlationId: string;
  readonly at: Date;
}

/** Auditoría de borrados del historial: identificadores y conteos, nunca texto. */
export async function auditConversationRemoval(
  audit: AuditStore,
  removal: ConversationRemoval,
): Promise<void> {
  await recordAudit(audit, {
    id: randomUUID(),
    tenantId: removal.tenantId,
    occurredAt: removal.at,
    actor: removal.actor,
    action: removal.action,
    resource: { type: 'assistant_conversation', id: removal.resourceId },
    outcome: 'succeeded',
    correlationId: removal.correlationId,
    ...(removal.reason ? { reason: removal.reason } : {}),
    metadata: { count: removal.count },
  });
}

/**
 * Almacén del historial según configuración. `undefined` si Qapaqzito o su historial están
 * apagados; en memoria sin conexión; PostgreSQL con ella.
 */
export async function assistantConversationStoreFor(
  environment: Readonly<Record<string, string | undefined>>,
  connection?: ConversationDatabaseConnection,
): Promise<ClosableConversationStore | undefined> {
  if (!loadAssistantConfig(environment).enabled) return undefined;
  if (!loadAssistantHistoryConfig(environment).enabled) return undefined;
  if (!connection) return new InMemoryConversationStore();
  const { PostgresConversationStore } = await import('@qapaq/assistant/postgres');
  return PostgresConversationStore.connect(connection);
}
