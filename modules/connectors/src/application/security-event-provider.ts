export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export interface SourceCapabilities {
  readonly providerType: string;
  readonly providerVersion?: string;
  readonly datasets: readonly string[];
  readonly paginationModes: readonly string[];
  readonly supportsRawRecords: boolean;
  readonly supportsReplay: boolean;
  readonly supportsHealth: boolean;
  readonly maxPageSize: number;
  readonly ordering: { readonly primaryField: string; readonly tieBreaker: string };
}

/**
 * Filtros neutrales del explorador de eventos (Sprint 5 · fase 1), en el vocabulario del
 * contrato `SecurityEvent`. Cada proveedor los compila a su consulta; el llamador nunca envía
 * lenguaje de consulta del proveedor.
 */
export interface EventFilters {
  readonly severity?: readonly string[];
  readonly category?: readonly string[];
  readonly outcome?: string;
}

export interface EventQuery {
  readonly filters?: EventFilters;
  /**
   * Orden por hora del evento. `asc` (por defecto) sirve a la ingesta, que avanza una marca de
   * agua; `desc` sirve al explorador, que muestra primero lo más reciente.
   */
  readonly order?: 'asc' | 'desc';
  readonly sourceId: string;
  readonly dataset: string;
  readonly from: string;
  readonly to: string;
  readonly pageSize: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

/**
 * Actividad por *stream* de la fuente (p. ej. cada suscripción de un servicio SaaS) en una
 * ventana: cuántos eventos llegaron y cuándo fue el último. Es una medición informativa para la
 * salud por fuente; no prueba que la fuente esté sana.
 */
export interface ActivityQuery {
  readonly sourceId: string;
  readonly dataset: string;
  readonly from: string;
  readonly to: string;
  readonly signal?: AbortSignal;
}

export interface StreamActivity {
  readonly stream: string;
  readonly count: number;
  readonly lastEventAt: string | null;
}

export interface ProviderRecord {
  readonly sourceRecordId: string;
  readonly dataset: string;
  readonly occurredAt?: string;
  readonly collectedAt: string;
  readonly raw: JsonObject;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface EventPage {
  readonly items: readonly ProviderRecord[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly readAt: string;
}

export type ProviderErrorCode =
  | 'PROVIDER_CONFIGURATION_INVALID'
  | 'PROVIDER_GATEWAY_UNAVAILABLE'
  | 'PROVIDER_UPSTREAM_UNAVAILABLE'
  | 'PROVIDER_UPSTREAM_SERVER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTHENTICATION_FAILED'
  | 'PROVIDER_AUTHORIZATION_DENIED'
  | 'PROVIDER_TLS_VALIDATION_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_QUERY_REJECTED'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'PROVIDER_CURSOR_INVALID'
  | 'PROVIDER_CURSOR_EXPIRED'
  | 'PROVIDER_CURSOR_INCOMPATIBLE'
  | 'PROVIDER_VERSION_UNSUPPORTED';

export class SecurityEventProviderError extends Error {
  public constructor(
    public readonly code: ProviderErrorCode,
    public readonly operation: 'health' | 'readPage',
    public readonly retryable: boolean,
    message = code,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SecurityEventProviderError';
  }
}

export interface ProviderComponentHealth {
  readonly name: string;
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly code: string;
  readonly latencyMs?: number;
  readonly message: string;
}

export interface ProviderHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly checkedAt: string;
  readonly components: readonly ProviderComponentHealth[];
}

export interface SecurityEventProvider {
  capabilities(): Promise<SourceCapabilities>;
  health(): Promise<ProviderHealth>;
  readPage(query: EventQuery): Promise<EventPage>;
  /** Actividad por stream (opcional: no todo proveedor la ofrece). */
  readActivity?(query: ActivityQuery): Promise<readonly StreamActivity[]>;
}
