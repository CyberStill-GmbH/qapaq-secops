import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
  '../prisma/migrations/20261023120000_role_request_closer_sod/migration.sql',
  import.meta.url,
);

describe('SoD de quien cierra una solicitud de rol', () => {
  it('rechaza datos históricos incompatibles antes de reemplazar la restricción', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const preflight = sql.indexOf('IF EXISTS');
    const drop = sql.indexOf('DROP CONSTRAINT');

    expect(preflight).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(preflight);
    expect(sql).toContain('"closed_by_oid" = "access_approver_oid"');
    expect(sql).toContain('NOT VALID');
    expect(sql).toContain('VALIDATE CONSTRAINT "access_role_requests_closer_distinct"');
    expect(sql).toContain('OR "closed_by_oid" <> "access_approver_oid"');
  });
});
