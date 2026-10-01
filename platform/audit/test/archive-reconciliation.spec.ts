import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordAudit } from '../src/audit-writer.js';
import type { AuditEventDraft, SealedAuditEvent } from '../src/audit-event.js';
import { AuditArchiveError, FileAuditArchive } from '../src/file-archive.js';
import { InMemoryAuditStore } from '../src/memory-store.js';
import { reconcileAudit } from '../src/reconciliation.js';

const AT = new Date('2026-10-07T12:00:00.000Z');

function draft(index: number): AuditEventDraft {
  return {
    id: `0199bf00-0000-7000-8000-00000000000${index}`,
    tenantId: 'tenant-1',
    occurredAt: new Date(AT.getTime() + index * 1_000),
    actor: { id: 'analyst-1', type: 'user' },
    action: 'soc.alert.triage',
    resource: { type: 'alert', id: `alert-${index}` },
    outcome: 'succeeded',
    correlationId: `corr-${index}`,
    metadata: { note: `evento ${index}` },
  };
}

let root: string;
let archive: FileAuditArchive;
let store: InMemoryAuditStore;
let sealed: SealedAuditEvent[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qapaq-audit-'));
  archive = new FileAuditArchive(root);
  store = new InMemoryAuditStore();
  sealed = [];
  for (let index = 1; index <= 4; index += 1) sealed.push(await recordAudit(store, draft(index)));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('C-19 · archivo en ficheros', () => {
  it('escribe un segmento legible y reconstruye los eventos', async () => {
    const ref = await archive.write('tenant-1', sealed);
    const back = await archive.read(ref);

    expect(ref.eventCount).toBe(4);
    expect(ref.fromSequence).toBe(1n);
    expect(ref.toSequence).toBe(4n);
    expect(back.map((event) => event.hash)).toEqual(sealed.map((event) => event.hash));
    expect(back[0]?.occurredAt.toISOString()).toBe(sealed[0]?.occurredAt.toISOString());
  });

  it('rechaza un segmento alterado antes de interpretarlo', async () => {
    const ref = await archive.write('tenant-1', sealed);
    await writeFile(ref.objectRef, '{"id":"falso"}\n', 'utf8');

    await expect(archive.read(ref)).rejects.toMatchObject({ code: 'SEGMENT_CORRUPT' });
  });

  it('informa segmento ausente en lugar de devolver vacío', async () => {
    const ref = await archive.write('tenant-1', sealed);
    await rm(ref.objectRef);

    await expect(archive.read(ref)).rejects.toBeInstanceOf(AuditArchiveError);
  });

  it('no admite segmentos vacíos', async () => {
    await expect(archive.write('tenant-1', [])).rejects.toMatchObject({ code: 'EMPTY_SEGMENT' });
  });
});

describe('C-19 · reconciliación', () => {
  it('reconcilia sin hallazgos cuando el archivo cubre toda la cadena', async () => {
    await archive.write('tenant-1', sealed);

    const report = await reconcileAudit('tenant-1', store, archive);

    expect(report.ok).toBe(true);
    expect(report.comparedEvents).toBe(4);
    expect(report.archivedThroughSequence).toBe(4n);
  });

  it('señala lo pendiente de archivar sin tratarlo como corrupción', async () => {
    await archive.write('tenant-1', sealed.slice(0, 2));

    const report = await reconcileAudit('tenant-1', store, archive);

    expect(report.findings.map((finding) => finding.code)).toEqual(['ARCHIVE_BEHIND']);
    expect(report.findings[0]?.sequence).toBe(3n);
  });

  it('detecta el hueco cuando falta un segmento intermedio', async () => {
    await archive.write('tenant-1', sealed.slice(0, 1));
    await archive.write('tenant-1', sealed.slice(2));

    const report = await reconcileAudit('tenant-1', store, archive);

    expect(report.findings.map((finding) => finding.code)).toContain('ARCHIVE_GAP');
  });

  it('detecta divergencia entre la fila viva y la archivada', async () => {
    await archive.write('tenant-1', sealed);
    store.forceReplaceForTamperSpec('tenant-1', { ...sealed[2]!, hash: 'a'.repeat(64) });

    const report = await reconcileAudit('tenant-1', store, archive);
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toContain('ARCHIVE_DIVERGED');
    expect(codes).toContain('LIVE_CHAIN_BROKEN');
  });

  it('reporta el segmento ilegible y continúa el resto de la reconciliación', async () => {
    const ref = await archive.write('tenant-1', sealed);
    await writeFile(ref.objectRef, 'corrupto\n', 'utf8');

    const report = await reconcileAudit('tenant-1', store, archive);

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain('ARCHIVE_UNREADABLE');
  });
});
