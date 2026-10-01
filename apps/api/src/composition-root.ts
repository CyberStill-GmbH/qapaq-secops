import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApiConfig } from '@qapaq/configuration';
import { AppModule } from './app.module.js';
import type { ApiLifecycle } from './lifecycle.js';
import type { SecOpsRuntime } from './runtime/secops-runtime.js';

export async function composeApi(
  _config: ApiConfig,
  lifecycle: ApiLifecycle,
  runtime?: SecOpsRuntime,
) {
  const adapter = new FastifyAdapter({
    bodyLimit: 1024 * 1024,
    requestTimeout: 15_000,
    logger: false,
    forceCloseConnections: 'idle',
    // El BFF decide la IP del cliente con su propia política de proxies confiables
    // (C-25); delegarlo en Fastify haría confiable cualquier X-Forwarded-For.
    trustProxy: false,
  });
  // Fastify no emite X-Powered-By. CORS permanece deshabilitado.
  return NestFactory.create<NestFastifyApplication>(
    AppModule.compose(lifecycle, [], runtime),
    adapter,
    { logger: false, abortOnError: false },
  );
}
