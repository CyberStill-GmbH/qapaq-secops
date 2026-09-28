import type { loadWorkerEntrypointConfig } from '@qapaq/configuration';
import { WorkerRuntime, type WorkerEvent } from './lifecycle/worker-runtime.js';

export function composeWorker(
  _config: ReturnType<typeof loadWorkerEntrypointConfig>,
  emit: WorkerEvent,
) {
  return new WorkerRuntime(emit);
}
