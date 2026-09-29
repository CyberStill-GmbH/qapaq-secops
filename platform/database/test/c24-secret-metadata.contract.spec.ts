import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const migrationPath = new URL(
  '../prisma/migrations/20260928180000_c24_secret_metadata/migration.sql',
  import.meta.url,
);

describe('C-24 metadata-only persistence contract', () => {
  it('creates only the five allowlisted lifecycle metadata tables', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect([...sql.matchAll(/CREATE TABLE "([^"]+)"/gu)].map((match) => match[1])).toEqual([
      'managed_secrets',
      'secret_versions',
      'secret_lifecycle_operations',
      'secret_lifecycle_audit',
      'secret_reconciliations',
    ]);
    expect(sql).toContain('hmac-sha256:v1:');
    expect(sql).toContain('secret_lifecycle_audit_immutable');
    expect(sql).not.toContain('ON DELETE CASCADE');
  });

  it('contains no plaintext credential column in Prisma or SQL', async () => {
    const content = `${await readFile(schemaPath, 'utf8')}\n${await readFile(migrationPath, 'utf8')}`;
    expect(content).not.toMatch(
      /secret_value|plaintext|credential_value|private_key|api_key|client_secret|password|\btoken\b/iu,
    );
  });
});
