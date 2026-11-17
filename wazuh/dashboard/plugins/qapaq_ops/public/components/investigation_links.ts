/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { entityKey, EntityKind } from '../../common';

/** Ruta de esta misma vista para pivotar a otra entidad (se comparte y sobrevive a recargar). */
export function entityInvestigationHref(basePath: string, kind: EntityKind, value: string, at: string) {
  const params = new URLSearchParams({ investigate: '1', entity: entityKey({ kind, value }), at });
  return `${basePath}/app/qapaq-alerts?${params.toString()}`;
}

export function alertInvestigationHref(basePath: string, alertId: string) {
  return `${basePath}/app/qapaq-alerts?${new URLSearchParams({ id: alertId, investigate: '1' })}`;
}
