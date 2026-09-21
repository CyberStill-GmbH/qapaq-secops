import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigurationError, loadApiConfig } from '@qapaq/configuration';

import { AppModule } from './app.module.js';

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  const adapter = new FastifyAdapter({ bodyLimit: 1024 * 1024, requestTimeout: 15_000 });
  const application = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['error', 'warn', 'log'],
  });
  application.enableShutdownHooks();
  await application.listen(config.port, config.host);
}

try {
  await main();
} catch (error) {
  const safeError =
    error instanceof ConfigurationError
      ? error.toJSON()
      : { code: 'BOOTSTRAP_FAILED', message: 'La aplicación no pudo iniciar de forma segura.' };
  process.stderr.write(`${JSON.stringify(safeError)}\n`);
  process.exitCode = 1;
}
