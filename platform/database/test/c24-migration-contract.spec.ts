import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
  '../prisma/migrations/20260929000000_c24_secret_control_plane/migration.sql',
  import.meta.url,
);
const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);

const readMigration = async (): Promise<string> => readFile(migrationPath, 'utf8');

describe('contrato de migración C-24', () => {
  it('declara solo las dos tablas del control plane', async () => {
    const sql = await readMigration();
    const tables = [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]);
    expect(tables).toEqual(['integration_secret_metadata', 'integration_secret_operations']);
  });

  it('no declara ninguna columna capaz de alojar material secreto', async () => {
    const sql = await readMigration();
    const columns = [
      ...sql.slice(0, sql.indexOf('CREATE UNIQUE INDEX')).matchAll(/^\s{4}"([a-z_]+)"\s+[A-Z]/gmu),
    ].map((match) => match[1]);
    expect(columns.length).toBeGreaterThan(20);
    const forbidden =
      /(^|_)(secret|secret_value|plaintext|password|token|credential|api_key|client_secret|private_key|ciphertext|encrypted.*|value)$/u;
    const offenders = columns.filter((column) => column !== undefined && forbidden.test(column));
    expect(offenders).toEqual([]);
    expect(columns).toContain('secret_ref');
    expect(columns).toContain('fingerprint');
  });

  it('no introduce cifrado reversible ni almacenamiento de valores', async () => {
    const sql = await readMigration();
    expect(sql).not.toMatch(/pgcrypto|pgp_sym_encrypt|pgp_sym_decrypt|encrypt\(|decrypt\(/iu);
    expect(sql).not.toContain('BYTEA');
  });

  it('acota el fingerprint a una longitud fija no reversible', async () => {
    const sql = await readMigration();
    expect(sql).toContain('integration_secret_metadata_fingerprint_check');
    expect(sql).toContain("'^hmac-sha256:v1:[0-9a-f]{8}:[A-Za-z0-9_-]{22}$'");
  });

  it('impone identidad inmutable, revisión monótona y revocación terminal', async () => {
    const sql = await readMigration();
    expect(sql).toContain('c24_protect_identity');
    expect(sql).toContain('c24_protect_lifecycle');
    expect(sql).toContain('Secreto C-24 revocado es terminal');
    expect(sql).toContain('Revisión C-24 no monótona');
    expect(sql).toContain('integration_secret_operations_immutable');
    expect(sql).not.toContain('ON DELETE CASCADE');
  });

  it('restringe las etiquetas para que no sirvan de almacén encubierto', async () => {
    const sql = await readMigration();
    expect(sql).toContain('c24_labels_are_safe');
    expect(sql).toMatch(/entry\.key ~\*/u);
    expect(sql).toContain('length(entry.value) > 128');
  });

  it('mantiene el schema Prisma alineado y sin campos de valor', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const model = schema.slice(
      schema.indexOf('model IntegrationSecretMetadata'),
      schema.indexOf('model IntegrationSecretOperation'),
    );
    expect(model).toContain('secretRef');
    expect(model).toContain('fingerprint');
    expect(model).not.toMatch(/\b(secretValue|plaintext|password|token|clientSecret)\b/u);
  });
});
