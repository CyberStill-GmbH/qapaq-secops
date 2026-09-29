import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const guardsPath = new URL(
  '../prisma/migrations/20260929120000_c24_lifecycle_guards/migration.sql',
  import.meta.url,
);
const basePath = new URL(
  '../prisma/migrations/20260928180000_c24_secret_metadata/migration.sql',
  import.meta.url,
);

const readGuards = async (): Promise<string> => readFile(guardsPath, 'utf8');

describe('contrato de guardas de ciclo de vida C-24', () => {
  it('no altera datos ni estructura: solo añade funciones y triggers', async () => {
    const sql = await readGuards();
    expect(sql).not.toMatch(/\b(ALTER TABLE|DROP|INSERT|UPDATE\s+"|DELETE FROM|CREATE TABLE)\b/u);
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  it('impone identidad inmutable sobre el secreto gestionado', async () => {
    const sql = await readGuards();
    expect(sql).toContain('c24_protect_secret_identity');
    expect(sql).toContain('managed_secrets_identity_immutable');
    for (const column of ['logical_name', 'provider', 'created_at', 'created_by'])
      expect(sql).toContain(`NEW."${column}" <> OLD."${column}"`);
  });

  it('impide retroceder la revisión, reactivar un revocado y bajar la versión', async () => {
    const sql = await readGuards();
    expect(sql).toContain('NEW."revision" <= OLD."revision"');
    expect(sql).toContain(`OLD."status" = 'REVOKED'`);
    expect(sql).toContain('NEW."current_version" < OLD."current_version"');
  });

  it('impide reactivar una versión ya reemplazada o revocada', async () => {
    const sql = await readGuards();
    expect(sql).toContain('c24_protect_version_history');
    expect(sql).toContain(`OLD."status" <> 'ACTIVE' AND NEW."status" = 'ACTIVE'`);
    for (const column of ['version', 'fingerprint', 'provider_ref'])
      expect(sql).toContain(`NEW."${column}" <> OLD."${column}"`);
  });

  it('solo referencia columnas declaradas por la migración base', async () => {
    const [guards, base] = await Promise.all([readGuards(), readFile(basePath, 'utf8')]);
    const declared = new Set(
      [...base.matchAll(/^\s{4}"([a-z_]+)"\s+[A-Z]/gmu)].map((match) => match[1]),
    );
    const referenced = new Set(
      [...guards.matchAll(/(?:NEW|OLD)\."([a-z_]+)"/gu)].map((match) => match[1]),
    );
    expect(referenced.size).toBeGreaterThan(5);
    for (const column of referenced) expect([...declared], column).toContain(column);
  });

  it('usa el código de error de violación de restricción, como C-04', async () => {
    const sql = await readGuards();
    expect([...(sql.match(/ERRCODE = '23514'/gu) ?? [])].length).toBeGreaterThanOrEqual(6);
  });
});
