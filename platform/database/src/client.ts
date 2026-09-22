import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client/client.js';

export interface DatabaseConnectionOptions {
  readonly connectionString: string;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly maxConnections?: number;
}

/** Crea el cliente Prisma sin exponer el adaptador a los módulos de negocio. */
export function createDatabaseClient(options: DatabaseConnectionOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMs }),
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
    ...(options.statementTimeoutMs === undefined
      ? {}
      : { options: `-c statement_timeout=${options.statementTimeoutMs}` }),
  });
  return new PrismaClient({ adapter });
}

export async function closeDatabaseClient(client: PrismaClient): Promise<void> {
  await client.$disconnect();
}
