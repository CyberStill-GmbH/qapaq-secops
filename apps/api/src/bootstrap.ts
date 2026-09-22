import { loadApiConfig, type EnvironmentInput } from '@qapaq/configuration';
import { composeApi } from './composition-root.js';
import { ApiLifecycle, type ApiEvent } from './lifecycle.js';

/** Límite de cierre de C-02: 5 segundos; aún no hay dependencias remotas. */
export const API_SHUTDOWN_TIMEOUT_MS = 5_000;
export async function buildApi(environment: EnvironmentInput, emit: ApiEvent) {
  const config = loadApiConfig(environment);
  const lifecycle = new ApiLifecycle(emit);
  emit('starting');
  const application = await composeApi(config, lifecycle);
  let listening: Promise<unknown> | undefined;
  const stop = () =>
    lifecycle.shutdown(async () => {
      // Si llega una señal durante el arranque, esperar antes de cerrar evita dejar un servidor abierto.
      if (listening) await Promise.allSettled([listening]);
      await application.close();
    }, API_SHUTDOWN_TIMEOUT_MS);
  return {
    application,
    lifecycle,
    stop,
    async start() {
      try {
        if (lifecycle.state !== 'starting') throw new Error('STARTUP_CANCELLED');
        listening = application.listen(config.port, config.host);
        await listening;
        if (lifecycle.state === 'starting') lifecycle.markReady();
      } catch (error) {
        lifecycle.fail();
        await stop();
        throw error;
      }
    },
  };
}
