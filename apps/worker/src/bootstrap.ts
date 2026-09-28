import { loadWorkerEntrypointConfig, type EnvironmentInput } from '@qapaq/configuration';
import { composeWorker } from './composition-root.js';
import type { WorkerEvent } from './lifecycle/worker-runtime.js';

export function buildWorker(environment: EnvironmentInput, emit: WorkerEvent) {
  const config = loadWorkerEntrypointConfig(environment);
  emit('starting');
  return composeWorker(config, emit);
}
