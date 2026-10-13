import type {
  EventFilters,
  JsonObject,
  SecurityEventProvider,
} from '../../application/security-event-provider.js';
import { SecurityEventProviderError } from '../../application/security-event-provider.js';
import { WazuhGatewayClient, WazuhGatewayError } from './wazuh-gateway.client.js';
import {
  WazuhSecurityEventProvider,
  type WazuhConnectorTelemetry,
} from './wazuh-security-event.provider.js';

export interface WazuhProviderConfiguration {
  readonly sourceId: string;
  readonly gateway: {
    readonly baseUrl: string;
    readonly accessToken: string | (() => Promise<string>);
    readonly requestTimeoutMs: number;
    readonly maximumPageSize: number;
    readonly retryLimit: number;
    readonly dataset: string;
    readonly cursorSigningKey: string;
    readonly cursorTtlMs: number;
    readonly maximumResponseBytes: number;
    /** Permitted only for loopback integration tests and local development. */
    readonly allowInsecureLocalhost?: boolean;
    /** HTTP hacia `*.qapaq.internal` dentro de la VPC (ver `WazuhGatewayClientOptions`). */
    readonly allowPrivateServiceHttp?: boolean;
  };
  readonly telemetry?: WazuhConnectorTelemetry;
  /** Compilador de filtros neutrales a DSL (ver `WazuhSecurityEventProviderOptions`). */
  readonly compileFilters?: (filters: EventFilters) => readonly JsonObject[] | undefined;
  /** Campo de stream para la actividad (ver `WazuhSecurityEventProviderOptions`). */
  readonly activityField?: string;
}

/** Composition root helper; callers pass C-28 credentials already resolved through C-03. */
export function createWazuhSecurityEventProvider(
  config: WazuhProviderConfiguration,
): SecurityEventProvider {
  let gateway: WazuhGatewayClient;
  try {
    gateway = new WazuhGatewayClient({
      baseUrl: config.gateway.baseUrl,
      accessToken: config.gateway.accessToken,
      requestTimeoutMs: config.gateway.requestTimeoutMs,
      maximumResponseBytes: config.gateway.maximumResponseBytes,
      ...(config.gateway.allowInsecureLocalhost === undefined
        ? {}
        : { allowInsecureLocalhost: config.gateway.allowInsecureLocalhost }),
      ...(config.gateway.allowPrivateServiceHttp === undefined
        ? {}
        : { allowPrivateServiceHttp: config.gateway.allowPrivateServiceHttp }),
    });
  } catch (error) {
    if (error instanceof WazuhGatewayError && error.code === 'CONFIGURATION_INVALID')
      throw new SecurityEventProviderError('PROVIDER_CONFIGURATION_INVALID', 'health', false);
    throw error;
  }
  return new WazuhSecurityEventProvider({
    sourceId: config.sourceId,
    allowedDatasets: [config.gateway.dataset],
    maximumPageSize: config.gateway.maximumPageSize,
    retryLimit: config.gateway.retryLimit,
    maximumBackoffMs: 5_000,
    maximumResponseBytes: config.gateway.maximumResponseBytes,
    cursorSecret: config.gateway.cursorSigningKey,
    cursorTtlMs: config.gateway.cursorTtlMs,
    client: gateway,
    ...(config.telemetry ? { telemetry: config.telemetry } : {}),
    ...(config.compileFilters ? { compileFilters: config.compileFilters } : {}),
    ...(config.activityField ? { activityField: config.activityField } : {}),
  });
}
