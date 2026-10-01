/**
 * Arranque del stack para el E2E: API como proceso real y consola compilada.
 *
 * La API no se importa: se ejecuta como el proceso que se desplegará, con su propio
 * ciclo de vida y su configuración por entorno. Importarla en el proceso de pruebas
 * habría ocultado justamente los fallos de arranque que interesa observar.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Stack {
  readonly baseUrl: string;
  readonly apiPort: number;
  close(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolveWith, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('NO_PORT'));
      const { port } = address;
      probe.close(() => resolveWith(port));
    });
  });
}

async function waitForReady(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.ok) return;
    } catch {
      // El proceso todavía no escucha; se reintenta hasta el límite.
    }
    if (Date.now() > deadline) throw new Error('API_NOT_READY');
    await new Promise((sleep) => setTimeout(sleep, 250));
  }
}

function startApi(port: number): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=development', 'src/main.ts'],
    {
      // El proceso arranca desde su propio paquete: así tsx resuelve el tsconfig del
      // API (decoradores de Nest) igual que en `pnpm dev:api`.
      cwd: resolve('apps/api'),
      env: {
        ...process.env,
        QAPAQ_PROFILE: 'test',
        QAPAQ_API_HOST: '127.0.0.1',
        QAPAQ_API_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[api] ${chunk.toString('utf8')}`);
  });
  return child;
}

export async function startStack(): Promise<Stack> {
  const apiPort = await freePort();
  const api = startApi(apiPort);
  await waitForReady(apiPort);

  const require = createRequire(resolve('apps/web/package.json'));
  const vite = (await import(pathToFileURL(require.resolve('vite')).href)) as typeof import('vite');
  process.env['VITE_API_ORIGIN'] = `http://127.0.0.1:${apiPort}`;
  await vite.build({ root: resolve('apps/web'), logLevel: 'error' });
  const preview = await vite.preview({
    root: resolve('apps/web'),
    preview: { port: 0, host: '127.0.0.1' },
    logLevel: 'error',
  });
  const address = preview.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('PREVIEW_NOT_LISTENING');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiPort,
    close: async () => {
      await preview.close();
      api.kill('SIGTERM');
      await new Promise((done) => {
        api.once('exit', done);
        setTimeout(() => {
          api.kill('SIGKILL');
          done(undefined);
        }, 8_000).unref();
      });
    },
  };
}

export function securityEvent(recordId: string, tenantId: string) {
  return {
    schemaVersion: '1.0.0',
    recordId,
    eventUid: `siem-qapaq-lab:alerts:${recordId}`,
    eventUidType: 'native',
    kind: 'alert',
    occurredAt: '2026-10-08T09:00:00.000Z',
    observedAt: '2026-10-08T09:00:01.000Z',
    receivedAt: '2026-10-08T09:00:02.000Z',
    source: {
      kind: 'siem',
      vendor: 'Wazuh, Inc.',
      product: 'Wazuh',
      dataset: 'alerts',
      instanceId: 'siem-qapaq-lab',
      nativeEventId: recordId,
    },
    tenant: { id: tenantId },
    severity: {
      normalized: 'critical',
      score: 95,
      originalValue: 14,
      originalLabel: 'critical',
      originalScale: 'wazuh-level-0-15',
      mappingId: 'qapaq.wazuh.severity',
      mappingVersion: '1.0.0',
    },
    category: ['intrusion_detection'],
    outcome: 'success',
    action: 'alert.created',
    entities: {
      identities: [{ kind: 'user', id: 'identity-1', principal: 'jperez@qapaq.pe' }],
      resources: [{ kind: 'host', id: 'host-1', name: 'srv-app-01.qapaq.local', type: 'endpoint' }],
    },
    detection: {
      rule: {
        id: '5716',
        name: 'Acceso sospechoso desde Microsoft 365',
        version: '1',
        provider: 'wazuh',
        groups: ['office365', 'authentication_failed'],
      },
    },
    raw: {
      ref: `raw:${recordId}`,
      sha256: 'a'.repeat(64),
      mediaType: 'application/json',
      sizeBytes: 1024,
    },
    provenance: {
      connector: 'qapaq-wazuh-indexer',
      connectorVersion: '1.0.0',
      parserVersion: '1.0.0',
      mappingVersion: '1.0.0',
      timestampQuality: 'source',
      ingestionPath: [
        { kind: 'origin', vendor: 'Microsoft', product: 'Microsoft 365' },
        {
          kind: 'collector',
          vendor: 'Wazuh, Inc.',
          product: 'Wazuh',
          instanceId: 'siem-qapaq-lab',
        },
        { kind: 'adapter', vendor: 'QAPAQ', product: 'QAPAQ SecOps' },
      ],
    },
  };
}
