import { Client } from '@opensearch-project/opensearch';
import type {
  WazuhReadClient,
  WazuhSearchResponse,
} from './wazuh/wazuh-security-event.provider.js';

export interface WazuhIndexerConnection {
  readonly endpoint: URL;
  readonly username: string;
  readonly password: string;
  readonly certificateAuthority: string;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export interface WazuhIndexerHealth {
  readonly clusterName: string;
  readonly status: string;
}

export class WazuhIndexerClient implements WazuhReadClient {
  readonly #client: Client;

  public constructor(connection: WazuhIndexerConnection) {
    if (connection.endpoint.protocol !== 'https:') {
      throw new Error('Wazuh Indexer must use HTTPS');
    }
    if (connection.certificateAuthority.trim() === '') {
      throw new Error('Wazuh Indexer CA is required');
    }

    this.#client = new Client({
      node: connection.endpoint.toString(),
      auth: { username: connection.username, password: connection.password },
      ssl: {
        ca: connection.certificateAuthority,
        rejectUnauthorized: true,
      },
      requestTimeout: connection.requestTimeoutMs,
      pingTimeout: connection.connectTimeoutMs,
      maxRetries: 0,
    });
  }

  public async health(signal?: AbortSignal): Promise<WazuhIndexerHealth> {
    const operation = this.#client.cluster.health();
    const abort = () => operation.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const response = await operation;
      return { clusterName: response.body.cluster_name, status: response.body.status };
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  public async search(options: {
    readonly index: string;
    readonly body: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<WazuhSearchResponse> {
    const operation = this.#client.search({
      index: options.index,
      body: options.body,
    });
    const abort = () => operation.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      const response = await operation;
      return response.body as unknown as WazuhSearchResponse;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  public async close(): Promise<void> {
    await this.#client.close();
  }
}
