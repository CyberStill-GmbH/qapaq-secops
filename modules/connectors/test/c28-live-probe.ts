import assert from 'node:assert/strict';
import { createWazuhSecurityEventProvider } from '../src/infrastructure/wazuh/wazuh-provider.factory.js';

const baseUrl = process.env['C10_GATEWAY_BASE_URL'];
const accessToken = process.env['C10_GATEWAY_ACCESS_TOKEN'];
assert.ok(baseUrl, 'C10_GATEWAY_BASE_URL is required');
assert.ok(accessToken, 'C10_GATEWAY_ACCESS_TOKEN is required');

const provider = createWazuhSecurityEventProvider({
  sourceId: 'c10-controlled-integration',
  gateway: {
    baseUrl,
    accessToken,
    requestTimeoutMs: 4_500,
    maximumPageSize: 10,
    retryLimit: 0,
    dataset: 'wazuh-alerts',
    cursorSigningKey: 'c10-controlled-integration-cursor-key',
    cursorTtlMs: 60_000,
    maximumResponseBytes: 1_000_000,
    allowInsecureLocalhost: true,
  },
});

const health = await provider.health();
assert.equal(health.status, 'healthy');
assert.deepEqual(
  health.components.map((component) => component.name),
  ['c28-wazuh-gateway'],
);

const page = await provider.readPage({
  sourceId: 'c10-controlled-integration',
  dataset: 'wazuh-alerts',
  from: '2026-09-28T11:00:00.000Z',
  to: '2026-09-28T13:00:00.000Z',
  pageSize: 2,
});
assert.equal(page.items.length, 1);
assert.equal(page.items[0]?.sourceRecordId, 'c10-gateway-proof');
assert.equal(page.items[0]?.occurredAt, '2026-09-28T12:00:00.000Z');
assert.equal(page.hasMore, false);
console.log('C-10 -> C-28 -> controlled Wazuh Indexer: PASS');
