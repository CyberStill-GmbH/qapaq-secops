import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApiConfig } from '@qapaq/configuration';
import { AppModule } from './app.module.js';
import type { ApiLifecycle } from './lifecycle.js';

export async function composeApi(_config: ApiConfig, lifecycle: ApiLifecycle) {
  const adapter = new FastifyAdapter({
    bodyLimit: 1024 * 1024,
    requestTimeout: 15_000,
    logger: false,
    forceCloseConnections: 'idle',
  });
  // Fastify no emite X-Powered-By. CORS permanece deshabilitado.
  return NestFactory.create<NestFastifyApplication>(AppModule.compose(lifecycle), adapter, {
    logger: false,
    abortOnError: false,
  });
}
