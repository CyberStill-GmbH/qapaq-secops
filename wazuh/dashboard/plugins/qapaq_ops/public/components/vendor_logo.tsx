/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  BRAND_ASSETS_PATH,
  IntegrationSpec,
  isVendorId,
  VendorId,
  vendorLogoUrl,
  VENDORS,
} from '../../common';
import { Monogram } from './overview_parts';

/**
 * Logotipo oficial de un proveedor sobre placa clara (conserva sus colores en tema claro y
 * oscuro). Decorativo cuando el nombre ya está al lado (`decorative`), si no lleva `alt`.
 */
export function VendorLogo({
  id,
  basePath,
  size = 'm',
  decorative = false,
}: {
  id: VendorId;
  basePath: string;
  size?: 's' | 'm' | 'l';
  decorative?: boolean;
}) {
  // Un id fuera del catálogo (fuente nueva sin marca) cae en el motor del SIEM, nunca rompe la vista.
  const mark = VENDORS[id] ?? VENDORS.wazuh;
  return (
    <span
      className={`qapaqVendor qapaqVendor--${size}`}
      style={{ ['--qapaq-vendor-color' as string]: mark.color } as React.CSSProperties}
      data-vendor={id}
    >
      <img
        src={vendorLogoUrl(basePath, mark.id)}
        alt={decorative ? '' : mark.name}
        loading="lazy"
        draggable={false}
      />
    </span>
  );
}

/** Distintivo de origen para filas y cabeceras: logotipo + nombre del proveedor. */
export function SourceBadge({
  id,
  basePath,
  label,
}: {
  id: VendorId;
  basePath: string;
  label?: string;
}) {
  return (
    <span className="qapaqSourceBadge" title={`Origen: ${label ?? (VENDORS[id] ?? VENDORS.wazuh).name}`}>
      <VendorLogo id={id} basePath={basePath} size="s" decorative />
      <span className="qapaqSourceBadge__label">{label ?? (VENDORS[id] ?? VENDORS.wazuh).name}</span>
    </span>
  );
}

/** Imagen propia de QAPAQ para servicios que no son de terceros (Respond, Qapaqzito). */
const OWN_MARKS: Partial<Record<string, string>> = {
  respond: 'ankay.svg',
  qapaqzito: 'qapaq-qapaqzito.webp',
};

/** Marca de una integración: logotipo del proveedor, imagen QAPAQ propia o monograma. */
export function ServiceMark({ spec, basePath }: { spec: IntegrationSpec; basePath: string }) {
  const vendor = spec.id === 'wazuh' ? 'wazuh' : spec.id;
  if (isVendorId(vendor)) return <VendorLogo id={vendor} basePath={basePath} size="l" decorative />;
  const own = OWN_MARKS[spec.id];
  if (own) {
    return (
      <span className="qapaqVendor qapaqVendor--l qapaqVendor--own" data-vendor={spec.id}>
        <img src={`${basePath}${BRAND_ASSETS_PATH}/${own}`} alt="" draggable={false} />
      </span>
    );
  }
  return <Monogram text={spec.monogram} />;
}
