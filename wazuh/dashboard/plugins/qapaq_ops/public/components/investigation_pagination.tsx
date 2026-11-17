/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { EuiButton, EuiCallOut } from '@elastic/eui';

/** Pagination controls kept as a small component so the actual React click handlers are testable. */
export function InvestigationPagination({
  loading,
  error,
  remaining,
  onLoadMore,
  onReset,
}: {
  readonly loading: boolean;
  readonly error: boolean;
  readonly remaining: number;
  readonly onLoadMore: () => Promise<unknown>;
  readonly onReset: () => void;
}) {
  if (error) {
    return (
      <EuiCallOut
        size="s"
        color="danger"
        iconType="alert"
        title="No se pudo cargar la siguiente página"
      >
        <p>
          Los eventos ya cargados siguen disponibles. Reintenta para continuar la misma consulta.
        </p>
        <EuiButton size="s" onClick={() => void onLoadMore()}>
          Reintentar página
        </EuiButton>{' '}
        <EuiButton size="s" color="text" onClick={onReset}>
          Reiniciar consulta
        </EuiButton>
      </EuiCallOut>
    );
  }

  return (
    <EuiButton size="s" isLoading={loading} isDisabled={loading} onClick={() => void onLoadMore()}>
      {loading ? 'Cargando eventos…' : `Cargar más eventos (${Math.max(0, remaining)} restantes)`}
    </EuiButton>
  );
}
