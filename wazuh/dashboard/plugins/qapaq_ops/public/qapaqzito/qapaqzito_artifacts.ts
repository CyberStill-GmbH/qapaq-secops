/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { ArtifactRef } from './chat_client';

/** Utilidades puras de los archivos (informes) que genera Qapaqzito. */

export const FORMAT_LABEL: Readonly<Record<ArtifactRef['format'], string>> = {
  pdf: 'PDF',
  xlsx: 'Excel',
  csv: 'CSV',
};

/** Texto corto del icono de formato (el color lo pone el CSS por `data-format`). */
export const FORMAT_GLYPH: Readonly<Record<ArtifactRef['format'], string>> = {
  pdf: 'PDF',
  xlsx: 'XLS',
  csv: 'CSV',
};

/**
 * URL de descarga con el MISMO prefijo que el cliente QAPAQ (`apiPrefix`, mismo origen), de modo que
 * la cookie de sesión viaja igual que en el resto de llamadas. Se construye a partir del id (ya
 * validado) y no del `url` que envía la API.
 */
export function artifactDownloadUrl(apiPrefix: string, artifact: Pick<ArtifactRef, 'id'>): string {
  return `${apiPrefix.replace(/\/+$/u, '')}/assistant/artifacts/${encodeURIComponent(artifact.id)}`;
}

export function isArtifactExpired(
  artifact: Pick<ArtifactRef, 'expiresAt'>,
  now: number = Date.now(),
): boolean {
  const expires = Date.parse(artifact.expiresAt);
  return Number.isNaN(expires) || expires <= now;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace('.', ',');
  return `${text} ${units[unit]}`;
}

/** «Expirado» o «Vence en 23 h» / «Vence en 40 min». */
export function expiryLabel(
  artifact: Pick<ArtifactRef, 'expiresAt'>,
  now: number = Date.now(),
): string {
  if (isArtifactExpired(artifact, now)) return 'Expirado';
  const minutes = Math.max(1, Math.floor((Date.parse(artifact.expiresAt) - now) / 60000));
  if (minutes < 60) return `Vence en ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `Vence en ${hours} h` : `Vence en ${Math.floor(hours / 24)} días`;
}

interface AnchorLike {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  click(): void;
  remove(): void;
}

export interface DownloadDocument {
  createElement(tag: 'a'): AnchorLike;
  readonly body: { appendChild(node: AnchorLike): unknown };
}

/**
 * Descarga un archivo del mismo origen con un `<a download>` temporal. La respuesta lleva
 * `content-disposition: attachment`, así que el navegador no navega fuera de la consola.
 */
export function triggerDownload(
  url: string,
  filename: string,
  doc: DownloadDocument = document as unknown as DownloadDocument,
): void {
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Descarga automática una sola vez por artefacto en la sesión en vivo. Devuelve `true` si disparó
 * la descarga. `seen` lo conserva el panel para no repetirla (evento SSE + respuesta final).
 */
export function autoDownloadOnce(
  seen: Set<string>,
  artifact: ArtifactRef,
  apiPrefix: string,
  options: { now?: number; doc?: DownloadDocument } = {},
): boolean {
  if (seen.has(artifact.id) || isArtifactExpired(artifact, options.now)) return false;
  seen.add(artifact.id);
  triggerDownload(artifactDownloadUrl(apiPrefix, artifact), artifact.filename, options.doc);
  return true;
}
