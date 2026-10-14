import type { EnvironmentInput } from '@qapaq/configuration';
import { buildApi } from './bootstrap.js';

/** Runtime acotado que reutiliza stores, políticas y envío de notificaciones del API. */
export async function buildNotificationDrain(
  environment: EnvironmentInput,
  onDispatchError?: (error: unknown) => void,
) {
  const api = await buildApi(environment, () => undefined, onDispatchError);
  return {
    drain: (limit?: number) => api.runtime.drainNotifications(limit),
    close: () => api.stop(),
  };
}

export { NOTIFICATION_DRAIN_JOB, NOTIFICATION_QUEUE_NAME } from './runtime/notification-queue.js';
export { redisConnectionOptions } from './runtime/redis-options.js';
