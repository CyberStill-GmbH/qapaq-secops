import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
  '../prisma/migrations/20260922000000_c04_admission/migration.sql',
  import.meta.url,
);

describe('contrato de migración C-04', () => {
  it('declara exactamente las siete tablas funcionales y sus restricciones', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const tables = [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]);

    expect(tables).toEqual([
      'sources',
      'source_checkpoints',
      'ingestion_manifests',
      'raw_event_references',
      'event_inbox',
      'outbox_messages',
      'quarantined_events',
    ]);
    expect((sql.match(/ADD CONSTRAINT/g) ?? []).length).toBeGreaterThanOrEqual(20);
    expect(sql).not.toContain('ON DELETE CASCADE');
    expect(sql).toContain('outbox_messages_payload_check');
    expect(sql).toContain('quarantined_events_receipt_fkey');
  });
});
