import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { root, secret } from './support.mjs';

test('compiled React artifact, assets and static health', async () => {
  const require = createRequire(resolve(root, 'apps/web/package.json'));
  const { preview } = await import(pathToFileURL(require.resolve('vite')).href);
  const server = await preview({
    configFile: false,
    root: resolve(root, 'apps/web'),
    preview: { port: 0, host: '127.0.0.1' },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="root"/u);
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/gu)].map(
      (match) => match[1],
    );
    assert.ok(assets.some((asset) => asset.endsWith('.js')));
    for (const asset of assets) assert.equal((await fetch(new URL(asset, base))).status, 200);
    const health = await fetch(`${base}/health.json`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'qapaq-secops-web' });
    for (const file of await readdir(resolve(root, 'apps/web/dist'), { recursive: true })) {
      if (!/\.(js|css|html|json)$/u.test(file)) continue;
      const source = await readFile(resolve(root, 'apps/web/dist', file), 'utf8');
      assert.ok(!source.includes(secret), file);
      assert.doesNotMatch(
        source,
        /QAPAQ_(?:POSTGRES|REDIS|MINIO|WAZUH)|SECRET_TOKEN|secret:\/\/|BEGIN (?:RSA |EC )?PRIVATE KEY|https?:\/\/[^/\s]+:[^/\s]+@/u,
      );
    }
  } finally {
    await server.close();
  }
  assert.equal(server.httpServer.listening, false);
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(1_000) }));
});
