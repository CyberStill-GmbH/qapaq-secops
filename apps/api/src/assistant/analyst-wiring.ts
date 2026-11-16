/**
 * Composición del Analista IA para el arranque del API (ver `bootstrap.ts`).
 *
 * - Almacén: PostgreSQL con pool propio y mínimo (importación diferida, `ready()` al arrancar)
 *   cuando el SOC es durable; si no, los gemelos en memoria.
 * - Con `QAPAQ_ANALYST_ENABLED=false` y la tabla no disponible, la fachada no se publica (la consola
 *   muestra «no habilitado») y el API arranca igual; con el analista activo, el arranque falla.
 * - Proveedor y credenciales: los de Qapaqzito; cliente sin reintentos (`analyst-model.ts`).
 */

import {
  InMemoryAnalystSettingsStore,
  InMemoryInvestigationStore,
  type AnalystSettingsStore,
  type EvidenceSourceHealth,
  type InvestigationRunnerOptions,
  type InvestigationStore,
} from '@qapaq/assistant';

import { correlatorGet } from '../runtime/correlator-link.js';
import { AnalystHost, type AnalystLog } from '../runtime/analyst-host.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';
import { evaluateMonitor } from '../runtime/source-health.js';
import { RuntimeSocActions } from './analyst-actions.js';
import { loadAnalystConfig } from './analyst-config.js';
import { RuntimeEvidenceReader } from './analyst-evidence.js';
import { createAnalystMessagesClient, createAnalystModel } from './analyst-model.js';
import type { MessagesClient } from './claude-model.js';
import { SOC_KNOWLEDGE } from './soc-knowledge.generated.js';

export interface AnalystDatabaseConnection {
  readonly connectionString: string;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly maxConnections?: number;
}

export interface AnalystComposition {
  readonly host: AnalystHost | undefined;
  close(): Promise<void>;
}

/** Salud de las fuentes del tenant para la evidencia (misma evaluación que `/api/sources/health`). */
export function runtimeSourceHealth(
  runtime: SecOpsRuntime,
): (() => Promise<readonly EvidenceSourceHealth[]>) | undefined {
  const monitor = runtime.sourceHealth;
  if (!monitor) return undefined;
  return async () => {
    if (monitor.key.tenantId !== runtime.tenantId) return [];
    const evaluation = await evaluateMonitor(monitor, runtime.soc.ingestion, runtime.now());
    return [
      {
        id: monitor.key.sourceId,
        label: monitor.displayName,
        state: evaluation.state,
        fresh: evaluation.state === 'healthy',
      },
    ];
  };
}

export async function composeAnalyst(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly runtime: SecOpsRuntime;
  readonly connection?: AnalystDatabaseConnection;
  readonly log?: AnalystLog;
  /** Solo pruebas: cliente del proveedor simulado (nunca se llama a un proveedor real). */
  readonly client?: MessagesClient;
}): Promise<AnalystComposition> {
  const { runtime } = input;
  const config = loadAnalystConfig(input.environment);
  let store: InvestigationStore;
  let settings: AnalystSettingsStore;
  let close: () => Promise<void> = async () => undefined;
  if (input.connection) {
    const { PostgresInvestigationStore } = await import('@qapaq/assistant/postgres-investigations');
    const postgres = PostgresInvestigationStore.connect({ maxConnections: 2, ...input.connection });
    try {
      await postgres.ready();
    } catch (error) {
      await postgres.close().catch(() => undefined);
      if (config.enabled) throw error;
      input.log?.('analyst.store.unavailable', { code: 'ANALYST_STORE_UNAVAILABLE' });
      return { host: undefined, close: async () => undefined };
    }
    store = postgres;
    settings = postgres.settings;
    close = () => postgres.close();
  } else {
    store = new InMemoryInvestigationStore();
    settings = new InMemoryAnalystSettingsStore();
  }

  let models: InvestigationRunnerOptions['models'] = {};
  if (config.enabled && config.provider) {
    const client = input.client ?? createAnalystMessagesClient(config.provider);
    models = {
      economy: {
        id: config.models.economy,
        model: createAnalystModel({ model: config.models.economy, tier: 'economy' }, client),
      },
      advanced: {
        id: config.models.advanced,
        model: createAnalystModel({ model: config.models.advanced, tier: 'advanced' }, client),
      },
    };
  }
  const link = runtime.correlatorRead;
  const sourceHealth = runtimeSourceHealth(runtime);
  const host = new AnalystHost({
    tenantId: runtime.tenantId,
    config,
    store,
    settings,
    evidence: new RuntimeEvidenceReader({
      tenantId: runtime.tenantId,
      soc: runtime.soc,
      knowledge: SOC_KNOWLEDGE,
      ...(runtime.events ? { events: runtime.events } : {}),
      audit: runtime.audit,
      notifications: runtime.notifications,
      ...(link ? { correlator: (path: string) => correlatorGet(link, path) } : {}),
      ...(sourceHealth ? { sourceHealth } : {}),
      now: () => runtime.now(),
    }),
    actions: new RuntimeSocActions({
      tenantId: runtime.tenantId,
      soc: () => runtime.socDependencies(),
      read: runtime.soc,
      audit: runtime.audit,
      kickDispatch: () => runtime.dispatcher.kick(),
    }),
    models,
    soc: runtime.soc,
    clock: () => runtime.now(),
    consoleBaseUrl: runtime.consoleBaseUrl,
    sendDigest: (digest) => runtime.sendAnalystDigest(digest),
    ...(input.log ? { log: input.log } : {}),
  });
  return { host, close };
}
