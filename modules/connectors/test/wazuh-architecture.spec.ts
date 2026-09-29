import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WAZUH_GATEWAY_ROUTES } from '../src/infrastructure/wazuh/wazuh-gateway.client.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const connectorSource = resolve(repositoryRoot, 'modules/connectors/src');

async function sourceText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const values = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? sourceText(path)
        : entry.name.endsWith('.ts')
          ? readFile(path, 'utf8')
          : '';
    }),
  );
  return values.join('\n');
}

describe('C-10 cannot bypass C-28', () => {
  it('contains no direct backend client, URL, credentials, host or port in connector runtime', async () => {
    const runtime = await sourceText(connectorSource);
    const packageManifest = await readFile(
      resolve(repositoryRoot, 'modules/connectors/package.json'),
      'utf8',
    );
    const prohibited = [
      /@opensearch-project\//iu,
      /WAZUH_INDEXER_(?:URL|HOST|PORT|USERNAME|PASSWORD)/u,
      /OPENSEARCH_URL/u,
      /(?:localhost|127\.0\.0\.1):9200/u,
      /basic\s+[a-z0-9+/=]+/iu,
    ];
    for (const pattern of prohibited) {
      expect(runtime, `runtime matched prohibited ${pattern}`).not.toMatch(pattern);
      expect(packageManifest, `manifest matched prohibited ${pattern}`).not.toMatch(pattern);
    }
  });

  it('uses exactly routes and methods present in the C-28 allowlist', async () => {
    const inventory = JSON.parse(
      await readFile(resolve(repositoryRoot, 'platform/gateway/krakend/routes.json'), 'utf8'),
    ) as { routes: Array<{ path: string; method: string }> };
    expect(inventory.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: WAZUH_GATEWAY_ROUTES.health, method: 'GET' }),
        expect.objectContaining({ path: WAZUH_GATEWAY_ROUTES.search, method: 'POST' }),
      ]),
    );
    expect(Object.values(WAZUH_GATEWAY_ROUTES).sort()).toEqual(
      inventory.routes.map((route) => route.path).sort(),
    );
  });
});
