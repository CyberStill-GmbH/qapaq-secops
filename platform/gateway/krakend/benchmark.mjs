#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...parts] = arg.replace(/^--/, '').split('=');
    return [key, parts.join('=') || 'true'];
  }),
);
const endpoint = process.env.BENCHMARK_URL;
const token = process.env.BENCHMARK_BEARER_TOKEN;
const scenario = process.env.BENCHMARK_SCENARIO ?? 'healthy';
const method = process.env.BENCHMARK_METHOD ?? 'POST';
const concurrency = Number(args.get('concurrency') ?? 4);
const durationSeconds = Number(args.get('duration-seconds') ?? 10);
if (args.get('confirm-nonprod') !== 'true')
  throw new Error('Pass --confirm-nonprod=true only for an isolated test environment.');
if (!endpoint || !token)
  throw new Error('Set BENCHMARK_URL and BENCHMARK_BEARER_TOKEN in the process environment.');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128)
  throw new Error('concurrency must be 1..128');
if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 120)
  throw new Error('duration-seconds must be 1..120');
if (!['healthy', 'slow', 'error', 'rate-limit'].includes(scenario))
  throw new Error('BENCHMARK_SCENARIO must be healthy, slow, error, or rate-limit.');
if (!['GET', 'POST'].includes(method)) throw new Error('BENCHMARK_METHOD must be GET or POST.');
const url = new URL(endpoint);
if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
  throw new Error('Benchmark target must use HTTPS unless it is loopback.');
}

const stopAt = performance.now() + durationSeconds * 1000;
const latencies = [];
let completed = 0;
let failed = 0;
const statusCounts = {};
async function worker() {
  while (performance.now() < stopAt) {
    const started = performance.now();
    try {
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      const requestOptions = {
        method,
        headers,
        signal: AbortSignal.timeout(5000),
      };
      if (method === 'POST') {
        headers['content-type'] = 'application/json';
        requestOptions.body = JSON.stringify(
          scenario === 'slow'
            ? { controlStatus: 'slow' }
            : scenario === 'error'
              ? { controlStatus: 500 }
              : {},
        );
      }
      const response = await fetch(url, requestOptions);
      await response.arrayBuffer();
      statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
      if (!response.ok) failed++;
    } catch {
      failed++;
    } finally {
      latencies.push(performance.now() - started);
      completed++;
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
latencies.sort((a, b) => a - b);
const percentile = (p) =>
  latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)] ?? 0;

console.log(
  JSON.stringify(
    {
      durationSeconds,
      concurrency,
      requests: completed,
      throughputRps: Number((completed / durationSeconds).toFixed(2)),
      p50Ms: Number(percentile(0.5).toFixed(2)),
      p95Ms: Number(percentile(0.95).toFixed(2)),
      p99Ms: Number(percentile(0.99).toFixed(2)),
      errorRate: Number((failed / Math.max(completed, 1)).toFixed(6)),
      scenario,
      method,
      statusCounts,
    },
    null,
    2,
  ),
);
