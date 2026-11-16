/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Logotipos oficiales de los proveedores integrados (uso nominativo: identifican el origen del
 * dato). Los SVG viven en `wazuh/dashboard/assets/svg/vendors/` con su NOTICE (fuente, versión y
 * titular) y el core los sirve en `/ui/qapaq/vendors/`. Siempre se muestran junto al nombre completo.
 */

export const VENDOR_ASSETS_PATH = '/ui/qapaq/vendors';

export const VENDOR_IDS = [
  'wazuh',
  'office365',
  'bitdefender',
  'snyk',
  'cloudflare',
  'aws',
] as const;
export type VendorId = (typeof VENDOR_IDS)[number];

export interface VendorMark {
  readonly id: VendorId;
  /** Nombre completo que acompaña al logotipo (exigido por las guías de marca). */
  readonly name: string;
  /** Archivo en color oficial (se muestra sobre placa clara). */
  readonly file: string;
  /** Variante para fondo oscuro (monocromo o la oficial «dark»). */
  readonly fileOnDark: string;
  /** Color oficial principal (borde/acento del distintivo). */
  readonly color: string;
}

export const VENDORS: Readonly<Record<VendorId, VendorMark>> = {
  wazuh: {
    id: 'wazuh',
    name: 'Wazuh',
    file: 'wazuh.svg',
    fileOnDark: 'wazuh-on-dark.svg',
    color: '#007AFF',
  },
  office365: {
    id: 'office365',
    name: 'Microsoft Entra ID',
    file: 'microsoft-entra-id.svg',
    fileOnDark: 'microsoft-entra-id-on-dark.svg',
    color: '#0294E4',
  },
  bitdefender: {
    id: 'bitdefender',
    name: 'Bitdefender',
    file: 'bitdefender.svg',
    fileOnDark: 'bitdefender-on-dark.svg',
    color: '#ED1C24',
  },
  snyk: {
    id: 'snyk',
    name: 'Snyk',
    file: 'snyk.svg',
    fileOnDark: 'snyk-on-dark.svg',
    color: '#4C4A73',
  },
  cloudflare: {
    id: 'cloudflare',
    name: 'Cloudflare',
    file: 'cloudflare.svg',
    fileOnDark: 'cloudflare-on-dark.svg',
    color: '#F38020',
  },
  aws: {
    id: 'aws',
    name: 'AWS',
    file: 'aws.svg',
    fileOnDark: 'aws-on-dark.svg',
    color: '#232F3E',
  },
};

export function isVendorId(value: unknown): value is VendorId {
  return typeof value === 'string' && (VENDOR_IDS as readonly string[]).includes(value);
}

/**
 * Logotipo para un proveedor del catálogo. SharePoint/OneDrive todavía no tiene marca propia en
 * `assets/svg/vendors/` (familia Microsoft 365): usa la de Microsoft hasta añadirla.
 */
export function vendorOfProvider(provider: string | null | undefined): VendorId {
  if (isVendorId(provider)) return provider;
  if (provider === 'sharepoint') return 'office365';
  return 'wazuh';
}

export function vendorLogoUrl(basePath: string, id: VendorId, onDark = false): string {
  const mark = VENDORS[id];
  return `${basePath}${VENDOR_ASSETS_PATH}/${onDark ? mark.fileOnDark : mark.file}`;
}

/** Proveedor de un documento de `wazuh-alerts-*` según `rule.groups` / `data.qapaq.vendor`. */
export function vendorOfGroups(groups: readonly unknown[], qapaqVendor?: unknown): VendorId {
  if (isVendorId(qapaqVendor)) return qapaqVendor;
  const values = groups.map(String);
  if (values.includes('office365') || values.includes('ms-graph') || values.includes('qapaq_sharepoint')) return 'office365';
  for (const id of ['bitdefender', 'snyk', 'cloudflare', 'aws'] as const) {
    if (values.includes(id)) return id;
  }
  return 'wazuh';
}

const TITLE_PATTERNS: ReadonlyArray<readonly [RegExp, VendorId]> = [
  [/\b(office ?365|microsoft 365|entra|exchange|sharepoint|m365)\b/iu, 'office365'],
  [/\bbitdefender\b|\bgravityzone\b/iu, 'bitdefender'],
  [/\bsnyk\b/iu, 'snyk'],
  [/\bcloudflare\b/iu, 'cloudflare'],
  [/\baws\b|\bamazon\b|\bcloudtrail\b|\biam\b/iu, 'aws'],
];

/**
 * Proveedor de una alerta QAPAQ a partir de su título («QAPAQ Cloudflare: …») cuando la API no
 * trae el grupo de la regla. Sin coincidencia, el origen es el propio SIEM (Wazuh).
 */
export function vendorOfTitle(title: string): VendorId {
  for (const [pattern, id] of TITLE_PATTERNS) if (pattern.test(title)) return id;
  return 'wazuh';
}

/** Regla de Wazuh citada en el título de una alerta QAPAQ: «… (wazuh 101503)». */
export function wazuhRuleIdOfTitle(title: string): string | null {
  return /\(wazuh (\d{1,7})\)\s*$/u.exec(title)?.[1] ?? null;
}
