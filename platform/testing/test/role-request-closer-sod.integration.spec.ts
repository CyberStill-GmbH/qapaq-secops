import { readFile } from 'node:fs/promises';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IntegrationEnvironment } from '../src/index.js';

const repositoryRoot = process.cwd();
const environment = new IntegrationEnvironment({ profile: 'postgres', repositoryRoot });
const initialMigration = new URL(
  '../../database/prisma/migrations/20261020130000_access_role_requests/migration.sql',
  import.meta.url,
);
const sodMigration = new URL(
  '../../database/prisma/migrations/20261023120000_role_request_closer_sod/migration.sql',
  import.meta.url,
);
const TENANT = 'tenant-role-closer-sod';
const TARGET = '22222222-2222-4222-8222-222222222222';
const REQUESTER = '11111111-1111-4111-8111-111111111111';
const ACCESS_APPROVER = '33333333-3333-4333-8333-333333333333';
const SECURITY_APPROVER = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';

let client: Client | undefined;
let blocked = false;

describe('PostgreSQL · SoD de cierre de solicitud de rol', () => {
  beforeAll(async () => {
    const preflight = await environment.preflight();
    if (preflight.status !== 'PASS') {
      if (process.env['CI'] === 'true') {
        throw new Error(
          'El preflight de PostgreSQL debe pasar en CI para verificar la restricción SoD',
        );
      }
      blocked = true;
      return;
    }
    const runtime = await environment.start();
    if (!runtime.postgres) throw new Error('PostgreSQL no disponible en el perfil postgres');

    client = new Client({ connectionString: runtime.postgres.connectionString });
    await client.connect();
    await client.query(await readFile(initialMigration, 'utf8'));

    // Simula una fila histórica que pasa la restricción antigua, pero viola la regla de SoD.
    await client.query(
      `INSERT INTO "access_role_requests" (
        "tenant_id", "id", "target_oid", "action", "role", "reason", "ticket",
        "expected_grant_revision", "requester_oid", "requester_subject_id", "created_at",
        "status", "access_approver_oid", "access_approver_subject_id", "access_approved_at",
        "access_reason", "closed_by_oid", "closed_by", "closed_at", "closed_reason",
        "revision", "updated_at"
      ) VALUES (
        $1, $2::uuid, $3::uuid, 'grant', 'qapaq.platform.admin',
        'Elevación de acceso para cobertura del SOC.', NULL, 0, $4::uuid, 'requester-subject',
        now(), 'rejected', $5::uuid, 'access-subject', now(), 'Aprobación de Acceso.',
        $5::uuid, 'access-subject', now(), 'Rechazo de Seguridad.', 3, now()
      )`,
      [TENANT, REQUEST_ID, TARGET, REQUESTER, ACCESS_APPROVER],
    );
  }, 300_000);

  afterAll(async () => {
    await client?.end();
    await environment.stop();
  });

  it('no instala la nueva regla sobre datos incompatibles y la aplica tras remediación', async ({
    skip,
  }) => {
    if (blocked || !client) return skip();

    const migrationSql = await readFile(sodMigration, 'utf8');
    await expect(client.query(migrationSql)).rejects.toThrow(
      /closure by the prior access approver/iu,
    );
    await client.query('ROLLBACK');

    const oldConstraint = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'access_role_requests'::regclass
          AND conname = 'access_role_requests_closer_distinct'`,
    );
    expect(oldConstraint.rows).toHaveLength(1);
    expect(oldConstraint.rows[0]?.definition).not.toContain('access_approver_oid');

    // La migración no corrige ni borra evidencia: el operador cambia el cierre a una tercera persona.
    await client.query(
      `UPDATE "access_role_requests"
          SET "closed_by_oid" = $1::uuid, "closed_by" = 'security-subject'
        WHERE "tenant_id" = $2 AND "id" = $3::uuid`,
      [SECURITY_APPROVER, TENANT, REQUEST_ID],
    );
    await client.query(migrationSql);

    await expect(
      client.query(
        `UPDATE "access_role_requests"
            SET "closed_by_oid" = $1::uuid, "closed_by" = 'access-subject'
          WHERE "tenant_id" = $2 AND "id" = $3::uuid`,
        [ACCESS_APPROVER, TENANT, REQUEST_ID],
      ),
    ).rejects.toThrow(/access_role_requests_closer_distinct/iu);

    const preserved = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "access_role_requests" WHERE "tenant_id" = $1`,
      [TENANT],
    );
    expect(preserved.rows[0]?.count).toBe('1');
  }, 120_000);
});
