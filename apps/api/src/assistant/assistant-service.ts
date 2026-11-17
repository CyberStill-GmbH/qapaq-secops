/**
 * Servicio de Qapaqzito: configuración validada, puerto del modelo y límite de tasa por persona.
 *
 * El límite es en memoria (por proceso): suficiente contra abuso y costo accidental; en Lambda
 * aplica por instancia, así que el tope real depende de la concurrencia. Un límite global exigiría
 * un almacén compartido (DynamoDB) y queda como mejora.
 */

import {
  ArtifactVault,
  DEFAULT_ASSISTANT_LIMITS,
  type ArtifactStore,
  type AssistantLimits,
  type AssistantModel,
  type ConversationStore,
} from '@qapaq/assistant';

import {
  loadAssistantConfig,
  loadAssistantHistoryConfig,
  type AssistantConfig,
} from './assistant-config.js';
import { createClaudeModel } from './claude-model.js';
import { ConversationHistory } from './conversation-history.js';
import { createReportsClient, type ReportsClient } from './reports-client.js';

type EnabledConfig = Extract<AssistantConfig, { enabled: true }>;

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  public constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** `true` si la petición cabe en la ventana (y la registra). */
  public take(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [id, stamps] of this.hits) {
        if (stamps.every((at) => now - at >= this.windowMs)) this.hits.delete(id);
      }
    }
    return true;
  }
}

export interface AssistantService {
  readonly config: EnabledConfig;
  readonly model: AssistantModel;
  readonly limits: AssistantLimits;
  readonly limiter: SlidingWindowLimiter;
  /** Historial de conversaciones; ausente con `QAPAQ_QAPAQZITO_HISTORY_ENABLED=false`. */
  readonly history?: ConversationHistory;
  /** Archivos generados (informes); ausente en pruebas que no lo configuran. */
  readonly artifacts?: ArtifactVault;
  /** Cliente del servicio de informes; ausente si `QAPAQ_REPORTS_URL` no está configurado. */
  readonly reports?: ReportsClient;
}

export function createAssistantService(
  environment: Readonly<Record<string, string | undefined>>,
  modelFactory: (config: EnabledConfig) => AssistantModel = (config) => createClaudeModel(config),
  /** Almacén del historial (ver `assistantConversationStoreFor`); sin él, el chat no guarda. */
  conversations?: ConversationStore,
  /** Almacén de archivos generados (ver `assistantArtifactStoreFor`). */
  artifacts?: ArtifactStore,
  reports: ReportsClient | undefined = createReportsClient(environment),
): AssistantService | undefined {
  const config = loadAssistantConfig(environment);
  if (!config.enabled) return undefined;
  const history = loadAssistantHistoryConfig(environment);
  return {
    config,
    model: modelFactory(config),
    limits: environment['AWS_LAMBDA_FUNCTION_NAME']
      ? DEFAULT_ASSISTANT_LIMITS
      : Object.freeze({ ...DEFAULT_ASSISTANT_LIMITS, deadlineMs: 55_000 }),
    limiter: new SlidingWindowLimiter(config.rateLimit.max, config.rateLimit.windowMs),
    ...(artifacts ? { artifacts: new ArtifactVault(artifacts) } : {}),
    ...(reports ? { reports } : {}),
    ...(history.enabled && conversations
      ? { history: new ConversationHistory(conversations, history.retentionDays) }
      : {}),
  };
}
