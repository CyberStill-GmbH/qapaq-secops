import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadApiConfig } from '@qapaq/configuration';

import { AppModule } from './app.module.js';

const config = loadApiConfig(process.env);
const adapter = new FastifyAdapter({
  bodyLimit: 1024 * 1024,
  requestTimeout: 15_000,
});
const application = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
  logger: ['error', 'warn', 'log'],
});

application.enableShutdownHooks();
await application.listen(config.port, config.host);
