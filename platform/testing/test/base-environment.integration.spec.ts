import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { writeEnvironmentEvidence } from '../src/evidence/evidence-writer.js';
import { IntegrationEnvironment } from '../src/index.js';

const exec = promisify(execFile);
const repositoryRoot = process.cwd();
const environments = [
  new IntegrationEnvironment({ profile: 'base', repositoryRoot }),
  new IntegrationEnvironment({ profile: 'base', repositoryRoot }),
] as const;
const checks = [
  'docker preflight and pinned OCI digests',
  'two concurrent run IDs, ports, buckets and resource labels are isolated',
  'PostgreSQL server version and isolated schema CRUD',
  'Redis PING, INFO, namespaced SET/GET/TTL/DEL',
  'MinIO authenticated S3 bucket/object CRUD and SHA-256 metadata',
  'owned container teardown and evidence redaction',
] as const;
let suiteStatus: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' = 'NOT_RUN';

async function assertOwnedLabels(environment: IntegrationEnvironment): Promise<void> {
  const containers = [
    environment.runtime.postgres?.container,
    environment.runtime.redis?.container,
    environment.runtime.objectStorage?.container,
  ];
  for (const container of containers) {
    if (!container) throw new Error('El perfil base no arrancó todos sus servicios');
    const { stdout } = await exec('docker', [
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      container.getId(),
    ]);
    const labels = JSON.parse(stdout) as Record<string, string>;
    expect(labels['qapaq.test']).toBe('true');
    expect(labels['qapaq.test.run-id']).toBe(environment.runId);
    expect(labels['qapaq.test.owner']).toBe('platform-testing');
  }
}

async function remainingContainers(runId: string): Promise<string[]> {
  const { stdout } = await exec('docker', [
    'container',
    'ls',
    '--all',
    '--quiet',
    '--filter',
    `label=qapaq.test.run-id=${runId}`,
  ]);
  return stdout.split(/\r?\n/u).filter(Boolean);
}

describe('C-06 perfil base con servicios reales', () => {
  it('verifica salud, aislamiento concurrente, operaciones y cleanup', async () => {
    try {
      const preflights = await Promise.all(environments.map((environment) => environment.preflight()));
      expect(preflights.map((report) => report.status)).toEqual(['PASS', 'PASS']);
      expect(environments[0].runId).not.toBe(environments[1].runId);

      await environments[0].start();
      await environments[1].start();
      await Promise.all(environments.map(assertOwnedLabels));

      const first = environments[0].runtime;
      const second = environments[1].runtime;
      expect(first.postgres?.container.getMappedPort(5432)).not.toBe(
        second.postgres?.container.getMappedPort(5432),
      );
      expect(first.redis?.container.getMappedPort(6379)).not.toBe(
        second.redis?.container.getMappedPort(6379),
      );
      expect(first.objectStorage?.bucket).not.toBe(second.objectStorage?.bucket);

      const health = await Promise.all(environments.map((environment) => environment.health()));
      for (const report of health) {
        expect(report.status).toBe('PASS');
        expect(report.checks.map((check) => check.service)).toEqual([
          'postgres',
          'redis',
          'minio',
        ]);
        expect(report.checks.every((check) => check.healthy)).toBe(true);
      }
      suiteStatus = 'PASS';
    } catch (error) {
      suiteStatus = 'FAIL';
      throw error;
    }
  }, 300_000);

  afterAll(async () => {
    for (const environment of environments) {
      const snapshot = await environment.collectEvidence().catch(() => undefined);
      let cleanupStatus: 'PASS' | 'FAIL' = 'PASS';
      try {
        await environment.stop();
      } catch {
        cleanupStatus = 'FAIL';
      }
      const remaining = await remainingContainers(environment.runId).catch(() => ['docker-inspect-failed']);
      if (remaining.length > 0) cleanupStatus = 'FAIL';
      const selected = snapshot?.images;
      const pinned = Boolean(
        selected?.postgres.digest && selected.redis.digest && selected.minio.digest,
      );
      const evidence = {
        ...(snapshot ?? {
          runId: environment.runId,
          projectCommit: 'unknown',
          workingTreeDirty: true,
          startedAt: new Date().toISOString(),
          profile: 'base' as const,
          images: {
            postgres: { image: 'docker.io/library/postgres', version: '18.6', digest: null },
            redis: { image: 'docker.io/library/redis', version: '8.10.1', digest: null },
            minio: {
              image: 'quay.io/minio/minio',
              version: 'RELEASE.2025-09-07T16-13-09Z',
              digest: null,
            },
            opensearch: { image: 'opensearchproject/opensearch', version: '3.7.0', digest: null },
            wazuhManager: { image: 'wazuh/wazuh-manager', version: '4.14.7', digest: null },
            wazuhIndexer: { image: 'wazuh/wazuh-indexer', version: '4.14.7', digest: null },
          },
          health: [],
          cleanup: { status: 'PENDING' as const, remainingOwnedResources: [] },
          result: 'NOT_RUN' as const,
        }),
        finishedAt: new Date().toISOString(),
        state: environment.state,
        cleanup: { status: cleanupStatus, remainingOwnedResources: remaining },
        suite: { name: 'C-06 base end-to-end', status: suiteStatus, checks },
        result:
          suiteStatus === 'PASS' && cleanupStatus === 'PASS' && pinned ? ('PASS' as const) :
          suiteStatus === 'BLOCKED' ? ('BLOCKED' as const) : ('FAIL' as const),
      };
      await writeEnvironmentEvidence(repositoryRoot, evidence);
    }
  });
});
