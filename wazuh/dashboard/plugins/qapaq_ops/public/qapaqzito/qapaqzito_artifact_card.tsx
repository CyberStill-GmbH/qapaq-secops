/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  artifactDownloadUrl,
  expiryLabel,
  FORMAT_GLYPH,
  FORMAT_LABEL,
  formatBytes,
  isArtifactExpired,
} from './qapaqzito_artifacts';
import { Icon } from './qapaqzito_icons';
import type { ArtifactRef } from './chat_client';

/** Tarjeta de archivo (PDF/Excel/CSV) generado por Qapaqzito, con descarga manual. */
export function QapaqzitoArtifactCard({
  artifact,
  apiPrefix,
  now,
}: {
  artifact: ArtifactRef;
  apiPrefix: string;
  now?: number;
}) {
  const expired = isArtifactExpired(artifact, now);
  return (
    <div
      className={`qapaqQapaqzito__file${expired ? ' is-expired' : ''}`}
      data-test-subj="qapaqQapaqzitoArtifact"
    >
      <span className="qapaqQapaqzito__fileIcon" data-format={artifact.format} aria-hidden="true">
        {FORMAT_GLYPH[artifact.format]}
      </span>
      <span className="qapaqQapaqzito__fileMeta">
        <strong title={artifact.title}>{artifact.title}</strong>
        <span title={artifact.filename}>{artifact.filename}</span>
        <small>
          {FORMAT_LABEL[artifact.format]} · {formatBytes(artifact.size)} ·{' '}
          {expiryLabel(artifact, now)}
        </small>
      </span>
      {expired ? (
        <button type="button" className="qapaqQapaqzito__fileButton" disabled>
          Expirado
        </button>
      ) : (
        <a
          className="qapaqQapaqzito__fileButton"
          href={artifactDownloadUrl(apiPrefix, artifact)}
          download={artifact.filename}
          aria-label={`Descargar ${artifact.filename}`}
        >
          <Icon name="download" size={14} /> Descargar
        </a>
      )}
    </div>
  );
}

export function QapaqzitoArtifactList({
  artifacts,
  apiPrefix,
}: {
  artifacts: readonly ArtifactRef[];
  apiPrefix: string;
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="qapaqQapaqzito__files" aria-label="Archivos generados">
      {artifacts.map((artifact) => (
        <QapaqzitoArtifactCard key={artifact.id} artifact={artifact} apiPrefix={apiPrefix} />
      ))}
    </div>
  );
}
