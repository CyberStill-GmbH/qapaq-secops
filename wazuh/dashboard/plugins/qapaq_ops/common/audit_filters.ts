/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/** «tipo» o «tipo:id» → filtros `resourceType` / `resourceId` del BFF. */
export function parseResource(value: string): { resourceType?: string; resourceId?: string } {
  const text = value.trim();
  if (!text) return {};
  const separator = text.indexOf(':');
  if (separator === -1) return { resourceType: text };
  const resourceType = text.slice(0, separator).trim();
  const resourceId = text.slice(separator + 1).trim();
  return {
    resourceType: resourceType || undefined,
    resourceId: resourceId || undefined,
  };
}
