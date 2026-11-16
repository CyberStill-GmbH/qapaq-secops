import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_LIMITS,
  ArtifactError,
  ArtifactVault,
  InMemoryArtifactStore,
  artifactRefOf,
  safeArtifactFilename,
} from '../src/artifacts.js';
import { QAPAQZITO_SYSTEM_PROMPT } from '../src/prompt.js';

const ana = { tenantId: 't1', ownerId: 'ana' };
const luis = { tenantId: 't1', ownerId: 'luis' };
const otherTenantAna = { tenantId: 't2', ownerId: 'ana' };
const bytes = (text = '%PDF-1.7 demo') => new TextEncoder().encode(text);

function vaultAt(clock: { now: Date }, store = new InMemoryArtifactStore()) {
  return { store, vault: new ArtifactVault(store, () => clock.now) };
}

describe('archivos generados por Qapaqzito', () => {
  it('guarda con hash, tamaño, tipo y vigencia de 24 h', async () => {
    const clock = { now: new Date('2026-11-13T17:00:00Z') };
    const { vault } = vaultAt(clock);
    const meta = await vault.create(ana, {
      filename: 'QAPAQ-informe-alertas-2026-11-13-1200',
      format: 'pdf',
      title: 'Informe',
      content: bytes(),
    });
    expect(meta.filename).toBe('QAPAQ-informe-alertas-2026-11-13-1200.pdf');
    expect(meta.contentType).toBe('application/pdf');
    expect(meta.size).toBe(bytes().byteLength);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(meta.expiresAt.getTime() - meta.createdAt.getTime()).toBe(24 * 3_600_000);
    expect(artifactRefOf(meta)).toMatchObject({
      id: meta.id,
      format: 'pdf',
      url: `/api/assistant/artifacts/${meta.id}`,
      expiresAt: '2026-11-14T17:00:00.000Z',
    });
  });

  it('aislamiento por dueño y tenant: lo ajeno se comporta como inexistente', async () => {
    const clock = { now: new Date('2026-11-13T17:00:00Z') };
    const { vault } = vaultAt(clock);
    const mine = await vault.create(ana, {
      filename: 'a',
      format: 'csv',
      title: 'A',
      content: bytes('a,b'),
    });
    expect(await vault.get(ana, mine.id)).toBeDefined();
    expect(await vault.get(luis, mine.id)).toBeUndefined();
    expect(await vault.get(otherTenantAna, mine.id)).toBeUndefined();
    expect((await vault.list(ana)).map((item) => item.id)).toEqual([mine.id]);
    expect(await vault.list(luis)).toEqual([]);
    expect(await vault.list(otherTenantAna)).toEqual([]);
  });

  it('vence a las 24 h: no se lista ni se descarga, y la purga lo borra', async () => {
    const clock = { now: new Date('2026-11-13T17:00:00Z') };
    const { vault, store } = vaultAt(clock);
    const meta = await vault.create(ana, {
      filename: 'a',
      format: 'xlsx',
      title: 'A',
      content: bytes('x'),
    });
    clock.now = new Date('2026-11-14T16:59:59Z');
    expect(await vault.get(ana, meta.id)).toBeDefined();
    clock.now = new Date('2026-11-14T17:00:01Z');
    expect(await vault.get(ana, meta.id)).toBeUndefined();
    expect(await vault.list(ana)).toEqual([]);
    expect(await store.purgeExpired(clock.now)).toBe(1);
    expect(await store.purgeExpired(clock.now)).toBe(0);
  });

  it('topes: 25 MB por archivo, vacío y 20 por persona por día', async () => {
    const clock = { now: new Date('2026-11-13T17:00:00Z') };
    const { vault } = vaultAt(clock);
    await expect(
      vault.create(ana, {
        filename: 'x',
        format: 'pdf',
        title: 'x',
        content: new Uint8Array(ARTIFACT_LIMITS.maxBytes + 1),
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(
      vault.create(ana, { filename: 'x', format: 'pdf', title: 'x', content: new Uint8Array(0) }),
    ).rejects.toMatchObject({ code: 'EMPTY' });
    for (let index = 0; index < ARTIFACT_LIMITS.maxPerOwnerPerDay; index += 1) {
      await vault.create(ana, {
        filename: `f${index}`,
        format: 'csv',
        title: 'x',
        content: bytes('a'),
      });
    }
    await expect(
      vault.create(ana, { filename: 'extra', format: 'csv', title: 'x', content: bytes('a') }),
    ).rejects.toBeInstanceOf(ArtifactError);
    // Otra persona no comparte el cupo; pasadas 24 h el cupo se libera.
    await expect(
      vault.create(luis, { filename: 'l', format: 'csv', title: 'x', content: bytes('a') }),
    ).resolves.toBeDefined();
    clock.now = new Date('2026-11-14T17:00:01Z');
    await expect(
      vault.create(ana, { filename: 'again', format: 'csv', title: 'x', content: bytes('a') }),
    ).resolves.toBeDefined();
  });

  it('nombre de archivo seguro: ASCII, sin rutas ni caracteres de control', () => {
    expect(safeArtifactFilename('../../etc/passwd', 'pdf')).toBe('etc-passwd.pdf');
    expect(safeArtifactFilename('Informe ñandú "crítico"\r\n', 'xlsx')).toBe(
      'Informe-nandu-critico.xlsx',
    );
    expect(safeArtifactFilename('', 'csv')).toBe('QAPAQ-informe.csv');
    expect(safeArtifactFilename('reporte.pdf', 'pdf')).toBe('reporte.pdf');
    expect(safeArtifactFilename('x'.repeat(500), 'pdf').length).toBeLessThanOrEqual(124);
  });
});

describe('prompt de Qapaqzito · informes', () => {
  it('indica usar generate_report ante informe/reporte/PDF/Excel/CSV y no pegar tablas', () => {
    expect(QAPAQZITO_SYSTEM_PROMPT).toContain('generate_report');
    expect(QAPAQZITO_SYSTEM_PROMPT).toContain('informe, reporte, PDF, Excel o CSV');
    expect(QAPAQZITO_SYSTEM_PROMPT).toContain('no pegues tablas largas en el chat');
    expect(QAPAQZITO_SYSTEM_PROMPT).toContain('identificador de la página actual');
    expect(QAPAQZITO_SYSTEM_PROMPT).toContain('adjunto');
  });
});
