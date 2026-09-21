import { Client } from '@opensearch-project/opensearch';

export interface WazuhIndexerConnection {
  readonly endpoint: URL;
  readonly username: string;
  readonly password: string;
  readonly certificateAuthority: string;
}

export interface WazuhIndexerHealth {
  readonly clusterName: string;
  readonly status: string;
}

export class WazuhIndexerClient {
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
    });
  }

  public async health(): Promise<WazuhIndexerHealth> {
    const response = await this.#client.cluster.health();
    return {
      clusterName: response.body.cluster_name,
      status: response.body.status,
    };
  }
}
