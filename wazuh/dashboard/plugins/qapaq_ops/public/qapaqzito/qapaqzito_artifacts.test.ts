/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QapaqzitoArtifactCard } from './qapaqzito_artifact_card';
import {
  artifactDownloadUrl,
  autoDownloadOnce,
  expiryLabel,
  formatBytes,
  isArtifactExpired,
  triggerDownload,
} from './qapaqzito_artifacts';
import type { ArtifactRef } from './chat_client';

const NOW = Date.parse('2026-11-13T18:00:00Z');
const ARTIFACT: ArtifactRef = {
  id: 'abc-123',
  filename: 'QAPAQ-informe-alertas-2026-11-13-1200.pdf',
  format: 'pdf',
  title: 'Informe de alertas P1/P2',
  size: 183204,
  createdAt: '2026-11-13T17:00:00Z',
  expiresAt: '2026-11-14T17:00:00Z',
  url: '/api/assistant/artifacts/abc-123',
};

function fakeDocument() {
  const clicks: Array<{ href: string; download: string }> = [];
  let removed = 0;
  const appended: unknown[] = [];
  return {
    clicks,
    appended,
    removed: () => removed,
    doc: {
      createElement: () => ({
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click() {
          clicks.push({ href: this.href, download: this.download });
        },
        remove() {
          removed += 1;
        },
      }),
      body: { appendChild: (node: unknown) => void appended.push(node) },
    },
  };
}

describe('archivos de Qapaqzito', () => {
  it('construye la URL con el prefijo del cliente QAPAQ (misma base que el resto de la API)', () => {
    expect(artifactDownloadUrl('/api', ARTIFACT)).toBe('/api/assistant/artifacts/abc-123');
    expect(artifactDownloadUrl('/qapaq/api/', ARTIFACT)).toBe('/qapaq/api/assistant/artifacts/abc-123');
  });

  it('formatea tamaño y vencimiento', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(183204)).toBe('179 KB');
    expect(formatBytes(1572864)).toBe('1,5 MB');
    expect(expiryLabel(ARTIFACT, NOW)).toBe('Vence en 23 h');
    expect(expiryLabel({ expiresAt: '2026-11-13T18:40:00Z' }, NOW)).toBe('Vence en 40 min');
    expect(expiryLabel({ expiresAt: '2026-11-13T17:59:00Z' }, NOW)).toBe('Expirado');
    expect(isArtifactExpired({ expiresAt: 'no-fecha' }, NOW)).toBe(true);
  });

  it('descarga con un <a download> temporal y lo retira', () => {
    const { doc, clicks, removed, appended } = fakeDocument();
    triggerDownload('/api/assistant/artifacts/abc-123', ARTIFACT.filename, doc);
    expect(clicks).toEqual([
      { href: '/api/assistant/artifacts/abc-123', download: ARTIFACT.filename },
    ]);
    expect(appended).toHaveLength(1);
    expect(removed()).toBe(1);
  });

  it('descarga automática UNA sola vez por artefacto y nunca si ya expiró', () => {
    const { doc, clicks } = fakeDocument();
    const seen = new Set<string>();
    expect(autoDownloadOnce(seen, ARTIFACT, '/api', { now: NOW, doc })).toBe(true);
    expect(autoDownloadOnce(seen, ARTIFACT, '/api', { now: NOW, doc })).toBe(false);
    const expired = { ...ARTIFACT, id: 'old', expiresAt: '2026-11-13T10:00:00Z' };
    expect(autoDownloadOnce(seen, expired, '/api', { now: NOW, doc })).toBe(false);
    expect(clicks).toHaveLength(1);
  });

  it('la tarjeta muestra icono, título, archivo, tamaño y «Descargar»', () => {
    const markup = renderToStaticMarkup(
      React.createElement(QapaqzitoArtifactCard, { artifact: ARTIFACT, apiPrefix: '/api', now: NOW }),
    );
    expect(markup).toContain('Informe de alertas P1/P2');
    expect(markup).toContain(ARTIFACT.filename);
    expect(markup).toContain('179 KB');
    expect(markup).toContain('Vence en 23 h');
    expect(markup).toContain('data-format="pdf"');
    expect(markup).toContain('href="/api/assistant/artifacts/abc-123"');
    expect(markup).toContain('Descargar');
  });

  it('una tarjeta expirada deshabilita la descarga («Expirado»)', () => {
    const markup = renderToStaticMarkup(
      React.createElement(QapaqzitoArtifactCard, {
        artifact: { ...ARTIFACT, format: 'xlsx', expiresAt: '2026-11-13T10:00:00Z' },
        apiPrefix: '/api',
        now: NOW,
      }),
    );
    expect(markup).toContain('disabled');
    expect(markup).toContain('Expirado');
    expect(markup).not.toContain('href=');
    expect(markup).toContain('data-format="xlsx"');
  });
});
