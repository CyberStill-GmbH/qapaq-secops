import type { Prisma, PrismaClient } from '../generated/client/client.js';

export interface TransactionLimits {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export const C04_TRANSACTION_LIMITS: TransactionLimits = {
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
};

/** Ejecuta una unidad de trabajo con los límites de C-04 dentro de PostgreSQL. */
export async function runDatabaseTransaction<T>(
  client: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  limits: TransactionLimits = C04_TRANSACTION_LIMITS,
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${limits.lockTimeoutMs}ms'`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${limits.statementTimeoutMs}ms'`);
      return work(tx);
    },
    { isolationLevel: 'ReadCommitted', timeout: 10_000, maxWait: 2_000 },
  ) as Promise<T>;
}
