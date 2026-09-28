import { WazuhIndexerClient } from '../wazuh-indexer-client.js';
import type { SecurityEventProvider } from '../../application/security-event-provider.js';
import { WazuhManagerClient } from './wazuh-manager.client.js';
import { WazuhSecurityEventProvider } from './wazuh-security-event.provider.js';

export interface WazuhProviderConfiguration {
  readonly sourceId: string;
  readonly indexer: {
    readonly baseUrl: string;
    readonly username: string;
    readonly password: string;
    readonly certificateAuthority: string;
    readonly connectTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly maximumPageSize: number;
    readonly retryLimit: number;
    readonly allowedIndex: string;
    readonly dataset: string;
    readonly cursorSigningKey: string;
    readonly cursorTtlMs: number;
    readonly maximumResponseBytes: number;
  };
  readonly manager: {
    readonly baseUrl: string;
    readonly username: string;
    readonly password: string;
    readonly certificateAuthority: string;
    readonly connectTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly maximumResponseBytes: number;
  };
}

/** Composition root helper; callers pass secrets already resolved through C-03. */
export function createWazuhSecurityEventProvider(
  config: WazuhProviderConfiguration,
): SecurityEventProvider {
  const indexer = new WazuhIndexerClient({
    endpoint: new URL(config.indexer.baseUrl),
    username: config.indexer.username,
    password: config.indexer.password,
    certificateAuthority: config.indexer.certificateAuthority,
    connectTimeoutMs: config.indexer.connectTimeoutMs,
    requestTimeoutMs: config.indexer.requestTimeoutMs,
  });
  const manager = new WazuhManagerClient({
    baseUrl: config.manager.baseUrl,
    username: config.manager.username,
    password: config.manager.password,
    certificateAuthority: config.manager.certificateAuthority,
    connectTimeoutMs: config.manager.connectTimeoutMs,
    requestTimeoutMs: config.manager.requestTimeoutMs,
    maximumResponseBytes: config.manager.maximumResponseBytes,
  });
  return new WazuhSecurityEventProvider({
    sourceId: config.sourceId,
    allowedDatasets: [config.indexer.dataset],
    allowedIndices: [config.indexer.allowedIndex],
    index: config.indexer.allowedIndex,
    maximumPageSize: config.indexer.maximumPageSize,
    retryLimit: config.indexer.retryLimit,
    maximumBackoffMs: 5_000,
    maximumResponseBytes: config.indexer.maximumResponseBytes,
    cursorSecret: config.indexer.cursorSigningKey,
    cursorTtlMs: config.indexer.cursorTtlMs,
    client: indexer,
    managerClient: manager,
  });
}
