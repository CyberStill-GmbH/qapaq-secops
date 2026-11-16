import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { ProviderRecord, WazuhAlertHintLookupProvider } from '@qapaq/connectors';
import type { SecurityEvent } from '@qapaq/contracts';
import type { WazuhPushHint } from '@qapaq/soc';
import { PrismaWazuhPushInboxStore } from '../../../platform/database/src/wazuh-push-inbox-store.ts';
import { createDatabaseClient } from '../../../platform/database/src/client.ts';
import { WazuhPushController } from '../src/soc/wazuh-push.controller.ts';
import type { IncomingRequest } from '../src/http/http-contracts.ts';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.ts';
import { createWazuhPushInboxPass } from '../src/runtime/wazuh-push-inbox.ts';

const SECRET = 'local-wazuh-push-load-benchmark-only';
const PHASES = {
  smoke: [
    { name: 'sustained', ratePerSecond: 10, durationSeconds: 5 },
    { name: 'burst', ratePerSecond: 50, durationSeconds: 5 },
  ],
  acceptance: [
    { name: 'sustained', ratePerSecond: 10, durationSeconds: 600 },
    { name: 'burst', ratePerSecond: 50, durationSeconds: 60 },
  ],
} as const;

type Profile = keyof typeof PHASES;
type Sample = { phase: string; milliseconds: number };

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.ceil(fraction * ordered.length) - 1]!.toFixed(2));
}

function makeSignature(body: WazuhPushHint, timestamp: string) {
  const canonicalBody = JSON.stringify({
    alertId: body.alertId,
    managerName: body.managerName,
    occurredAt: body.occurredAt,
  });
  const signature = createHmac('sha256', SECRET)
    .update(`${timestamp}.${canonicalBody}`, 'utf8')
    .digest('hex');
  const request: IncomingRequest = {
    headers: {
      'x-qapaq-timestamp': timestamp,
      'x-qapaq-signature': `sha256=${signature}`,
      'content-length': String(Buffer.byteLength(canonicalBody, 'utf8')),
    },
    ip: '127.0.0.1',
  };
  return {
    request,
    body: { alertId: body.alertId, managerName: body.managerName, occurredAt: body.occurredAt },
  };
}

function syntheticRecord(alertId: string, managerName: string, occurredAt: string): ProviderRecord {
  const timestamp = new Date(occurredAt).toISOString();
  return {
    sourceRecordId: alertId,
    dataset: 'wazuh-alerts',
    occurredAt: timestamp,
    collectedAt: new Date().toISOString(),
    metadata: {},
    raw: {
      timestamp,
      id: alertId,
      manager: { name: managerName },
      agent: { id: '000', name: managerName },
      rule: {
        id: '100510',
        level: 12,
        description: 'Synthetic load benchmark event',
        groups: ['office365'],
      },
      data: { integration: 'office365', office365: { Operation: 'SyntheticOperation' } },
    },
  };
}

function databaseName(connectionString: string): string {
  const pathname = new URL(connectionString).pathname.replace(/^\//u, '');
  return decodeURIComponent(pathname);
}

function readProfile(): Profile {
  const argument = process.argv[2] ?? 'smoke';
  if (argument !== 'smoke' && argument !== 'acceptance') {
    throw new Error(
      'Usage: pnpm --filter @qapaq/api exec tsx --conditions=development scripts/measure-wazuh-push-load.ts [smoke|acceptance]',
    );
  }
  return argument;
}

async function main() {
  const profile = readProfile();
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString)
    throw new Error('DATABASE_URL must point to a dedicated, migrated benchmark database.');
  if (process.env['QAPAQ_WAZUH_BENCHMARK_ALLOW_DATABASE_MUTATION'] !== '1') {
    throw new Error(
      'Set QAPAQ_WAZUH_BENCHMARK_ALLOW_DATABASE_MUTATION=1 only after selecting a disposable database.',
    );
  }
  const name = databaseName(connectionString);
  if (!/(?:^|[_-])(bench|benchmark)(?:$|[_-])/iu.test(name)) {
    throw new Error(
      `Refusing to write to database "${name}": its name must contain a benchmark marker.`,
    );
  }

  const client = createDatabaseClient({ connectionString, maxConnections: 12 });
  const store = new PrismaWazuhPushInboxStore(client);
  try {
    await store.ready();
    const initial = await store.metrics();
    const existing = Object.values(initial.counts).reduce((sum, count) => sum + count, 0);
    if (existing !== 0)
      throw new Error('Benchmark inbox is not empty; use a fresh dedicated benchmark database.');

    const controllerRuntime = {
      wazuhPushSecret: SECRET,
      canAcceptWazuhPush: true,
      now: () => new Date(),
      acceptWazuhPushHint: (hint: WazuhPushHint) => store.enqueue(hint),
    } as unknown as SecOpsRuntime;
    const controller = new WazuhPushController(controllerRuntime);
    const provider: WazuhAlertHintLookupProvider = {
      findByAlertHint: async (hint) => ({
        status: 'found',
        record: syntheticRecord(hint.alertId, hint.managerName, hint.occurredAt),
      }),
    };
    const consumeBatch = createWazuhPushInboxPass({
      store,
      provider,
      tenantId: 'benchmark-tenant',
      sourceId: 'benchmark-wazuh-indexer',
      now: () => new Date(),
      promote: async (_event: SecurityEvent) => 'promoted',
    });

    const acknowledgements: Sample[] = [];
    const phaseCounts: Record<string, number> = {};
    const allAcknowledgements: Promise<void>[] = [];
    const benchmarkStartedAt = performance.now();

    const consumer = (async () => {
      let producerDone = false;
      let consumerError: unknown;
      const runUntilDone = async () => {
        try {
          while (true) {
            const counts = await store.metrics();
            if (producerDone && counts.counts.pending === 0 && counts.counts.processing === 0)
              break;
            const claimed = await consumeBatch();
            if (claimed === 0) await delay(10);
          }
        } catch (error) {
          consumerError = error;
        }
      };
      const runner = runUntilDone();
      return {
        finish: async () => {
          producerDone = true;
          await runner;
          if (consumerError) throw consumerError;
        },
      };
    })();

    for (const phase of PHASES[profile]) {
      const phaseStart = performance.now();
      const total = phase.ratePerSecond * phase.durationSeconds;
      for (let index = 0; index < total; index += 1) {
        const target = phaseStart + (index * 1_000) / phase.ratePerSecond;
        const waitMs = target - performance.now();
        if (waitMs > 1) await delay(waitMs);

        const occurredAt = new Date().toISOString();
        const hint: WazuhPushHint = {
          alertId: `load-${profile}-${phase.name}-${index}`,
          managerName: 'benchmark-wazuh-manager',
          occurredAt,
          idempotencyKey: '0'.repeat(64),
        };
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const { request, body } = makeSignature(hint, timestamp);
        const started = performance.now();
        const accepted = controller.wake(request, body).then((result) => {
          if (result.accepted !== true)
            throw new Error('Unexpected non-accepted controller response.');
          acknowledgements.push({ phase: phase.name, milliseconds: performance.now() - started });
        });
        allAcknowledgements.push(accepted);
        phaseCounts[phase.name] = (phaseCounts[phase.name] ?? 0) + 1;
      }
    }
    await Promise.all(allAcknowledgements);
    const productionDuration = (performance.now() - benchmarkStartedAt) / 1_000;
    const consumerControl = await consumer;
    await consumerControl.finish();

    const final = await store.metrics();
    const ackP95 = percentile(
      acknowledgements.map((sample) => sample.milliseconds),
      0.95,
    );
    const processed = final.counts.processed;
    const expected = acknowledgements.length;
    const receiptToProcessedP95 = final.receiptToHandlerMs.p95;
    const ackPass = ackP95 !== null && ackP95 < 1_000;
    const consumerDrained =
      processed === expected && final.counts.pending === 0 && final.counts.processing === 0;
    const syntheticLatencyPass = receiptToProcessedP95 !== null && receiptToProcessedP95 < 10_000;
    const result = {
      profile,
      database: name,
      workload: PHASES[profile],
      requestsAccepted: acknowledgements.length,
      requestsByPhase: phaseCounts,
      observedProductionSeconds: Number(productionDuration.toFixed(2)),
      authenticatedControllerToDurableCommitMsByPhase: Object.fromEntries(
        PHASES[profile].map((phase) => {
          const samples = acknowledgements
            .filter((sample) => sample.phase === phase.name)
            .map((sample) => sample.milliseconds);
          return [
            phase.name,
            {
              sampleCount: samples.length,
              p50: percentile(samples, 0.5),
              p95: percentile(samples, 0.95),
              p99: percentile(samples, 0.99),
            },
          ];
        }),
      ),
      authenticatedControllerToDurableCommitMs: {
        sampleCount: acknowledgements.length,
        p50: percentile(
          acknowledgements.map((sample) => sample.milliseconds),
          0.5,
        ),
        p95: ackP95,
        p99: percentile(
          acknowledgements.map((sample) => sample.milliseconds),
          0.99,
        ),
        targetP95Ms: 1_000,
        result: ackPass ? 'PASS' : 'FAIL',
      },
      syntheticConsumerPath: {
        processed,
        pending: final.counts.pending,
        processing: final.counts.processing,
        receiptToProcessedP50Ms: final.receiptToHandlerMs.p50,
        receiptToProcessedP95Ms: receiptToProcessedP95,
        receiptToProcessedP99Ms: final.receiptToHandlerMs.p99,
        syntheticLatencyTargetP95Ms: 10_000,
        result: consumerDrained && syntheticLatencyPass ? 'PASS' : 'FAIL',
      },
      endToEndIndexerSocSlo: 'NOT_MEASURED',
      overall:
        ackPass && consumerDrained && syntheticLatencyPass
          ? 'PASS_LOCAL_COMPONENT_BENCHMARK'
          : 'FAIL',
    };
    console.log(JSON.stringify(result, null, 2));
    if (result.overall === 'FAIL') process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Benchmark failed.');
  process.exitCode = 1;
});
