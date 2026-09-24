import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { Client } from 'pg';
import { createClient } from 'redis';
import type {
  IntegrationEnvironmentOptions,
  IntegrationProfile,
  ServiceImageLock,
} from './environment-options.js';
import { imageLock, resolveOptions } from './environment-options.js';
import { createTestRunId } from './test-run-id.js';
import type { IntegrationEnvironmentState } from './environment-state.js';
import { dockerPreflight } from '../preflight/docker-preflight.js';
import { resourcePreflight } from '../preflight/resource-preflight.js';
import { reportStatus, type PreflightReport } from '../preflight/preflight-report.js';
import type { EnvironmentEvidence } from '../evidence/environment-evidence.js';
import type { HealthResult } from '../health/health-result.js';

const exec = promisify(execFile);

async function resolveImageDigests(profile: IntegrationProfile) {
  const selected =
    profile === 'postgres'
      ? ['postgres']
      : profile === 'base'
        ? ['postgres', 'redis', 'minio']
        : profile === 'search'
          ? ['postgres', 'redis', 'minio', 'opensearch']
          : profile === 'wazuh'
            ? ['wazuhManager', 'wazuhIndexer']
            : Object.keys(imageLock);
  const entries = Object.entries(imageLock).filter(([name]) => selected.includes(name)) as [
    keyof typeof imageLock,
    (typeof imageLock)[keyof typeof imageLock],
  ][];
  const resolved = Object.fromEntries(
    Object.entries(imageLock).map(([name, image]) => [name, { ...image, digest: null }]),
  ) as Record<keyof typeof imageLock, ServiceImageLock>;
  for (const [name, image] of entries) {
    try {
      const reference = image.digest
        ? `${image.image}@${image.digest}`
        : `${image.image}:${image.version}`;
      const result = await exec('docker', [
        'image',
        'inspect',
        reference,
        '--format',
        '{{json .RepoDigests}}',
      ]);
      const digests = JSON.parse(result.stdout) as string[];
      const recorded = image.digest
        ? digests.find((value) => value.endsWith(`@${image.digest}`))
        : digests.find((value) => value.includes('@sha256:'));
      resolved[name] = { ...image, digest: recorded?.split('@')[1] ?? null };
    } catch {
      resolved[name] = { ...image, digest: null };
    }
  }
  return resolved;
}
export interface IntegrationEnvironmentRuntime {
  readonly postgres?: {
    readonly connectionString: string;
    readonly container: StartedTestContainer;
  };
  readonly redis?: { readonly url: string; readonly container: StartedTestContainer };
  readonly objectStorage?: {
    readonly endpoint: string;
    readonly accessKey: string;
    readonly secretKey: string;
    readonly bucket: string;
    readonly container: StartedTestContainer;
  };
  readonly opensearch?:
    | { readonly endpoint: string; readonly container: StartedTestContainer }
    | { readonly blocked: true; readonly reason: string };
  readonly wazuh?: { readonly blocked: true; readonly reason: string };
}

function isBlockedComponent(
  value: IntegrationEnvironmentRuntime['opensearch'],
): value is { readonly blocked: true; readonly reason: string } {
  return value !== undefined && 'blocked' in value;
}

export class IntegrationEnvironment {
  readonly runId = createTestRunId();
  readonly startedAt = new Date().toISOString();
  private readonly options;
  private stateValue: IntegrationEnvironmentState = 'created';
  private runtimeValue: IntegrationEnvironmentRuntime = {};
  private preflightValue: PreflightReport | undefined;
  private healthResults: HealthResult[] = [];

  constructor(options: IntegrationEnvironmentOptions = {}) {
    this.options = resolveOptions(options);
  }

  get state(): IntegrationEnvironmentState {
    return this.stateValue;
  }
  get runtime(): IntegrationEnvironmentRuntime {
    return this.runtimeValue;
  }

  async preflight(): Promise<PreflightReport> {
    const docker = await dockerPreflight(this.options.profile);
    const resources = resourcePreflight(this.options.profile);
    const checks = [...docker.checks, ...resources.checks];
    if (this.options.profile === 'postgres')
      checks.push({
        name: 'postgres-image-lock',
        status: /^sha256:[0-9a-f]{64}$/u.test(imageLock.postgres.digest ?? '') ? 'PASS' : 'BLOCKED',
        detail: imageLock.postgres.digest ? 'Digest PostgreSQL fijado' : 'Falta digest PostgreSQL',
      });
    this.preflightValue = {
      status: reportStatus(checks),
      checks,
      generatedAt: new Date().toISOString(),
    };
    this.stateValue = this.preflightValue.status === 'PASS' ? 'preflight_passed' : 'blocked';
    return this.preflightValue;
  }

  async start(): Promise<IntegrationEnvironmentRuntime> {
    if (this.stateValue === 'healthy' || this.stateValue === 'starting')
      throw new Error('El entorno ya fue iniciado');
    const report = this.preflightValue ?? (await this.preflight());
    if (report.status !== 'PASS')
      throw new Error(`Preflight ${report.status}; no se inicia el entorno`);
    this.stateValue = 'starting';
    try {
      const labels = {
        'qapaq.test': 'true',
        'qapaq.test.run-id': this.runId,
        'qapaq.test.owner': 'platform-testing',
      };
      const profile = this.options.profile;
      if (
        profile === 'postgres' ||
        profile === 'base' ||
        profile === 'search' ||
        profile === 'full'
      ) {
        if (profile === 'postgres' && !imageLock.postgres.digest)
          throw new Error('Falta digest PostgreSQL para C-04');
        const postgres = await new GenericContainer(
          profile === 'postgres'
            ? `${imageLock.postgres.image}@${imageLock.postgres.digest}`
            : `${imageLock.postgres.image}:${imageLock.postgres.version}`,
        )
          .withEnvironment({
            POSTGRES_DB: 'qapaq_test',
            POSTGRES_USER: 'qapaq',
            POSTGRES_PASSWORD: `test-${this.runId}`,
          })
          .withExposedPorts(5432)
          .withLabels(labels)
          .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
          .start();
        this.runtimeValue = {
          ...this.runtimeValue,
          postgres: {
            container: postgres,
            connectionString: `postgresql://qapaq:test-${this.runId}@${postgres.getHost()}:${postgres.getMappedPort(5432)}/qapaq_test`,
          },
        };
      }
      if (profile === 'base' || profile === 'search' || profile === 'full') {
        const redis = await new GenericContainer(
          `${imageLock.redis.image}:${imageLock.redis.version}`,
        )
          .withExposedPorts(6379)
          .withLabels(labels)
          .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
          .start();
        this.runtimeValue = {
          ...this.runtimeValue,
          redis: {
            container: redis,
            url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
          },
        };
      }
      if (profile === 'base' || profile === 'search' || profile === 'full') {
        const minio = await new GenericContainer(
          `${imageLock.minio.image}:${imageLock.minio.version}`,
        )
          .withEnvironment({
            MINIO_ROOT_USER: 'qapaq-test',
            MINIO_ROOT_PASSWORD: `test-${this.runId}`,
          })
          .withCommand(['server', '/data'])
          .withExposedPorts(9000)
          .withLabels(labels)
          .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
          .start();
        this.runtimeValue = {
          ...this.runtimeValue,
          objectStorage: {
            container: minio,
            endpoint: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
            accessKey: 'qapaq-test',
            secretKey: `test-${this.runId}`,
            bucket: `qapaq-${this.runId}`,
          },
        };
      }
      if (profile === 'search' || profile === 'full')
        this.runtimeValue = {
          ...this.runtimeValue,
          opensearch: {
            blocked: true,
            reason:
              'OpenSearch requiere TLS y configuración de seguridad aprobada antes de aceptar el perfil search.',
          },
        };
      if (profile === 'wazuh' || profile === 'full')
        this.runtimeValue = {
          ...this.runtimeValue,
          wazuh: {
            blocked: true,
            reason:
              'La topología Wazuh requiere el Compose oficial y recursos dedicados; usar infra:setup-wazuh.',
          },
        };
      this.stateValue = 'healthy';
      return this.runtimeValue;
    } catch (error) {
      await this.stop().catch(() => undefined);
      this.stateValue = 'failed';
      throw error;
    }
  }

  async health(): Promise<{
    readonly status: 'PASS' | 'BLOCKED';
    readonly checks: readonly HealthResult[];
  }> {
    if (this.stateValue !== 'healthy') return { status: 'BLOCKED', checks: this.healthResults };
    const checks: HealthResult[] = [];
    if (this.runtimeValue.postgres) {
      const started = Date.now();
      const client = new Client({ connectionString: this.runtimeValue.postgres.connectionString });
      try {
        await client.connect();
        const result = await client.query<{ value: number }>('SELECT 1 AS value');
        checks.push({
          service: 'postgres',
          healthy: result.rows[0]?.value === 1,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          detail: 'SELECT 1',
        });
      } catch {
        checks.push({
          service: 'postgres',
          healthy: false,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          detail: 'fallo de conexión',
        });
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    if (this.runtimeValue.redis) {
      const started = Date.now();
      const client = createClient({ url: this.runtimeValue.redis.url });
      try {
        await client.connect();
        checks.push({
          service: 'redis',
          healthy: (await client.ping()) === 'PONG',
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          detail: 'PING',
        });
      } catch {
        checks.push({
          service: 'redis',
          healthy: false,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          detail: 'fallo de conexión',
        });
      } finally {
        await client.quit().catch(() => undefined);
      }
    }
    if (this.runtimeValue.objectStorage) {
      const started = Date.now();
      try {
        const response = await fetch(
          `${this.runtimeValue.objectStorage.endpoint}/minio/health/live`,
        );
        checks.push({
          service: 'minio',
          healthy: response.ok,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          detail: 'health/live',
        });
      } catch {
        checks.push({
          service: 'minio',
          healthy: false,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          detail: 'fallo HTTP',
        });
      }
    }
    if (isBlockedComponent(this.runtimeValue.opensearch))
      checks.push({
        service: 'opensearch',
        healthy: false,
        checkedAt: new Date().toISOString(),
        durationMs: 0,
        detail: this.runtimeValue.opensearch.reason,
      });
    if (this.runtimeValue.wazuh?.blocked)
      checks.push({
        service: 'wazuh',
        healthy: false,
        checkedAt: new Date().toISOString(),
        durationMs: 0,
        detail: this.runtimeValue.wazuh.reason,
      });
    this.healthResults = checks;
    return { status: checks.every((check) => check.healthy) ? 'PASS' : 'BLOCKED', checks };
  }

  async collectEvidence(): Promise<EnvironmentEvidence> {
    let projectCommit = 'unknown';
    let workingTreeDirty = true;
    try {
      projectCommit = (
        await exec('git', ['rev-parse', 'HEAD'], { cwd: this.options.repositoryRoot })
      ).stdout.trim();
      workingTreeDirty =
        (
          await exec('git', ['status', '--porcelain'], { cwd: this.options.repositoryRoot })
        ).stdout.trim().length > 0;
    } catch {
      /* el informe conserva un valor seguro si git no está disponible */
    }
    const blockedComponent =
      isBlockedComponent(this.runtimeValue.opensearch) || this.runtimeValue.wazuh?.blocked;
    const resolvedImages =
      this.stateValue === 'healthy'
        ? await resolveImageDigests(this.options.profile)
        : { ...imageLock, postgres: { ...imageLock.postgres, digest: null } };
    const postgresLockVerified =
      this.options.profile !== 'postgres' ||
      (resolvedImages.postgres.digest !== null &&
        resolvedImages.postgres.digest === imageLock.postgres.digest);
    return {
      runId: this.runId,
      projectCommit,
      workingTreeDirty,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      profile: this.options.profile,
      state: this.stateValue,
      images: resolvedImages,
      ...(this.preflightValue ? { preflight: this.preflightValue } : {}),
      health: this.healthResults,
      cleanup: { status: 'PENDING', remainingOwnedResources: [] },
      result:
        this.stateValue === 'healthy' &&
        !blockedComponent &&
        postgresLockVerified &&
        this.healthResults.length > 0 &&
        this.healthResults.every((check) => check.healthy)
          ? 'PASS'
          : this.stateValue === 'blocked' || blockedComponent
            ? 'BLOCKED'
            : 'FAIL',
    };
  }

  async stop(): Promise<void> {
    if (this.stateValue === 'stopped' || this.stateValue === 'created') return;
    this.stateValue = 'stopping';
    const containers = [
      this.runtimeValue.postgres?.container,
      this.runtimeValue.redis?.container,
      this.runtimeValue.objectStorage?.container,
      this.runtimeValue.opensearch && 'container' in this.runtimeValue.opensearch
        ? this.runtimeValue.opensearch.container
        : undefined,
    ].filter((container): container is StartedTestContainer => container !== undefined);
    await Promise.all(containers.map((container) => container.stop()));
    this.runtimeValue = {};
    this.stateValue = 'stopped';
  }
}
