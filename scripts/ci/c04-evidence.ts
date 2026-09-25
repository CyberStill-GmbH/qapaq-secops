import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { IntegrationEnvironment } from '../../platform/testing/src/index.js';
import { redactEvidence } from '../../platform/testing/src/evidence/environment-evidence.js';
import { writeEnvironmentEvidence } from '../../platform/testing/src/evidence/evidence-writer.js';
import databaseManifest from '../../platform/database/package.json' with { type: 'json' };
import workspaceManifest from '../../package.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '../..');
const environment = new IntegrationEnvironment({ profile: 'postgres', repositoryRoot: root });
const command = 'pnpm --filter @qapaq/database test';
let suiteExitCode: number | null = null;
let failure = '';
let failureDetail = '';
let cleanupStatus: 'PASS' | 'FAIL' = 'PASS';

function runSuite(connectionString: string): Promise<number> {
  return new Promise((done, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--filter', '@qapaq/database', 'test'],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: connectionString },
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    );
    child.once('error', reject);
    child.once('close', (code) => done(code ?? 1));
  });
}

try {
  const preflight = await environment.preflight();
  if (preflight.status !== 'PASS') {
    failure = 'PREFLIGHT_BLOCKED';
    throw new Error(failure);
  }
  const runtime = await environment.start();
  if (!runtime.postgres) {
    failure = 'POSTGRES_NOT_STARTED';
    throw new Error(failure);
  }
  const health = await environment.health();
  if (health.status !== 'PASS') {
    failure = 'POSTGRES_UNHEALTHY';
    throw new Error(failure);
  }
  suiteExitCode = await runSuite(runtime.postgres.connectionString);
  if (suiteExitCode !== 0) failure = 'Suite PostgreSQL C-04 falló';
} catch (error) {
  failure = failure || 'EXECUTION_FAILED';
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
  failureDetail = message
    .replaceAll(`test-${environment.runId}`, '[REDACTED]')
    .replace(/postgresql:\/\/[^\s]+/gu, '[REDACTED]')
    .slice(0, 512);
} finally {
  const evidence = await environment.collectEvidence();
  try {
    await environment.stop();
  } catch {
    cleanupStatus = 'FAIL';
  }
  const complete =
    suiteExitCode === 0 &&
    !failure &&
    cleanupStatus === 'PASS' &&
    evidence.result === 'PASS' &&
    evidence.images.postgres.digest !== null;
  const report = redactEvidence({
    ...evidence,
    cleanup: { status: cleanupStatus, remainingOwnedResources: [] },
    result: complete ? 'PASS' : evidence.result === 'BLOCKED' ? 'BLOCKED' : 'FAIL',
    suite: {
      name: 'C-04 PostgreSQL',
      status: suiteExitCode === null ? 'NOT_RUN' : suiteExitCode === 0 ? 'PASS' : 'FAIL',
      checks: [command, `exitCode=${suiteExitCode ?? 'NOT_RUN'}`],
    },
    versions: {
      node: process.version,
      pnpm: workspaceManifest.packageManager,
      prisma: databaseManifest.dependencies['@prisma/client'],
      postgres: evidence.images.postgres.version,
    },
    ...(failure ? { failure } : {}),
    ...(failureDetail ? { failureDetail } : {}),
  } as const);
  await writeEnvironmentEvidence(root, report);
  if (!complete) process.exitCode = 1;
}
