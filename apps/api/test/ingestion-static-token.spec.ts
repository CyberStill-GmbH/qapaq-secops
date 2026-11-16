/**
 * Ingesta de Wazuh sin Entra (`QAPAQ_WAZUH_GATEWAY_AUTH=static-token`): el API arranca sin client
 * secret y el proveedor C-28 envía el bearer estático solo por TLS o a loopback.
 */

import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SecretValue } from '@qapaq/configuration';

import { buildApi } from '../src/bootstrap.js';
import { createWazuhEventProvider } from '../src/runtime/wazuh-ingestion.js';
import { StaticGatewayTokenSource } from '../src/runtime/workload-token.js';

const TOKEN = 'q3Vx9ZkL2mN8pR4tW7yB1cE5gH0jA6sD/uF+oI3eKw=';

describe('ingesta wazuh con token estático', () => {
  const seen: Array<{ url: string; method: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? '', method: request.method ?? '', headers: request.headers });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'green' }));
  });
  let baseUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('el API arranca sin client secret de Entra', async () => {
    const built = await buildApi(
      {
        QAPAQ_PROFILE: 'test',
        QAPAQ_INGESTION_SOURCE: 'wazuh',
        QAPAQ_WAZUH_GATEWAY_BASE_URL: baseUrl,
        QAPAQ_WAZUH_GATEWAY_AUTH: 'static-token',
        QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN: TOKEN,
      },
      () => {},
    );
    await built.application.close();
  });

  it('envía el bearer estático a la ruta C-28 de salud', async () => {
    const provider = createWazuhEventProvider({
      sourceId: 'wazuh-indexer',
      gatewayBaseUrl: baseUrl,
      accessToken: new StaticGatewayTokenSource(new SecretValue(TOKEN)).token,
      tlsOrLoopbackOnly: true,
    });
    await provider.health();
    const health = seen.find((request) => request.url === '/wazuh/_cluster/health');
    expect(health?.method).toBe('GET');
    expect(health?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('no admite HTTP hacia *.qapaq.internal con token estático', () => {
    expect(() =>
      createWazuhEventProvider({
        sourceId: 'wazuh-indexer',
        gatewayBaseUrl: 'http://krakend.demo.qapaq.internal:8080',
        accessToken: new StaticGatewayTokenSource(new SecretValue(TOKEN)).token,
        tlsOrLoopbackOnly: true,
      }),
    ).toThrow();
  });
});
