/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { BehaviorSubject } from 'rxjs';
import type { AppMountParameters, CoreSetup } from '../../../src/core/public';
import {
  BRAND_ASSETS_PATH,
  dashboardHref,
  NAV_CATEGORIES,
  NAV_HIDDEN,
  NAV_PLACEMENT,
  PROVIDER_DASHBOARDS,
  ProviderId,
  VENDOR_ASSETS_PATH,
  VENDORS,
  vendorOfProvider,
} from '../common';

/** Valores de `AppNavLinkStatus` de OSD 2.19 (enum del core; aquí solo se usan los números). */
const NAV_LINK_HIDDEN = 3;

/**
 * Accesos directos a los paneles QAPAQ de cada proveedor, con su logotipo oficial en el menú
 * (categoría «Integraciones»). Sustituyen a los módulos de Wazuh que filtran por grupos que los
 * collectors QAPAQ no usan (p. ej. `rule.groups: amazon`) y por eso siempre salían vacíos.
 */
export const PROVIDER_APPS: ReadonlyArray<{
  readonly id: string;
  readonly provider: ProviderId;
  readonly title: string;
  readonly order: number;
}> = [
  { id: 'qapaq-provider-office365', provider: 'office365', title: 'Microsoft 365 / Entra ID', order: 20 },
  { id: 'qapaq-provider-bitdefender', provider: 'bitdefender', title: 'Bitdefender', order: 30 },
  { id: 'qapaq-provider-snyk', provider: 'snyk', title: 'Snyk', order: 40 },
  { id: 'qapaq-provider-cloudflare', provider: 'cloudflare', title: 'Cloudflare', order: 50 },
  { id: 'qapaq-provider-aws', provider: 'aws', title: 'AWS', order: 60 },
];

type AppLike = { id: string };
type Update = Record<string, unknown>;

/**
 * Updater de todas las apps: categoría, orden, título y visibilidad según la auditoría de
 * navegación (common/navigation.ts). OSD fusiona el objeto devuelto con la app.
 */
export function navUpdate(
  app: AppLike,
  categoryOf: (key: keyof typeof NAV_CATEGORIES) => Update,
): Update | undefined {
  if (NAV_HIDDEN[app.id] !== undefined) return { navLinkStatus: NAV_LINK_HIDDEN };
  const placement = NAV_PLACEMENT[app.id];
  if (!placement) return undefined;
  return {
    category: categoryOf(placement.category),
    order: placement.order,
    ...(placement.title ? { title: placement.title } : {}),
    ...(placement.tooltip ? { tooltip: placement.tooltip } : {}),
  };
}

export function registerNavigation(core: CoreSetup): void {
  const icon = (file: string) => core.http.basePath.prepend(`${BRAND_ASSETS_PATH}/${file}`);
  const categories = new Map<string, Update>();
  const categoryOf = (key: keyof typeof NAV_CATEGORIES): Update => {
    let category = categories.get(key);
    if (!category) {
      const spec = NAV_CATEGORIES[key];
      category = { id: spec.id, label: spec.label, order: spec.order, euiIconType: icon(spec.icon) };
      categories.set(key, category);
    }
    return category;
  };

  const extra: Record<string, { category: Update; order: number }> = {};
  for (const app of PROVIDER_APPS) {
    extra[app.id] = { category: categoryOf('integrations'), order: app.order };
    core.application.register({
      id: app.id,
      title: app.title,
      order: app.order,
      euiIconType: core.http.basePath.prepend(
        `${VENDOR_ASSETS_PATH}/${VENDORS[vendorOfProvider(app.provider)].file}`,
      ),
      mount: async (params: AppMountParameters) => {
        const [coreStart] = await core.getStartServices();
        // App puente: abre el panel guardado del proveedor (la navegación queda en el historial).
        params.element.textContent = `Abriendo el panel de ${app.title}…`;
        coreStart.application.navigateToUrl(
          coreStart.http.basePath.prepend(dashboardHref(PROVIDER_DASHBOARDS[app.provider])),
        );
        return () => undefined;
      },
    });
  }

  const updater = (app: AppLike) =>
    extra[app.id] !== undefined ? extra[app.id] : navUpdate(app, categoryOf);
  core.application.registerAppUpdater(new BehaviorSubject(updater) as never);
}
