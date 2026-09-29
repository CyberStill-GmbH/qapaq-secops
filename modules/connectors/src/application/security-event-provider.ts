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

export interface EventQuery {
  readonly sourceId: string;
  readonly dataset: string;
  readonly from: string;
  readonly to: string;
  readonly pageSize: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
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
}
