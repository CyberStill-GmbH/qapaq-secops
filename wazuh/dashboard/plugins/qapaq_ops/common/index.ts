/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

export const PLUGIN_ID = 'qapaqOps';
export const PLUGIN_NAME = 'QAPAQ SecOps';

/** Rutas propias del dashboard (servidas por este plugin, sin sesión de OSD). */
export const LOGIN_PATH = '/qapaq/login';
export const LOGOUT_PATH = '/qapaq/logout';
/** Login heredado del Security plugin / Wazuh que se sustituye por el de QAPAQ. */
export const LEGACY_LOGIN_PATHS = ['/app/login', '/login'];

/**
 * Activos de marca servidos por el core en `/ui/qapaq/` (build.sh los copia a
 * `src/core/server/core_app/assets/qapaq/`). `/ui/` es público en el edge, así el login
 * puede usarlos sin sesión.
 */
export const BRAND_ASSETS_PATH = '/ui/qapaq';

/** Atribución visible (NOTICE): QAPAQ SecOps es un trabajo derivado. */
export const ATTRIBUTION = 'Basado en Wazuh (GPLv2) y OpenSearch Dashboards (Apache-2.0).';

/**
 * Apps registradas en la navegación, en este orden, bajo la categoría «QAPAQ SecOps» (la
 * primera del menú). Cada una monta la misma consola en la vista indicada.
 */
export const QAPAQ_APPS = [
  { id: 'qapaq-alerts', view: 'alerts', title: 'Cola de alertas', order: 10 },
  { id: 'qapaq-incidents', view: 'incidents', title: 'Incidentes', order: 20 },
  { id: 'qapaq-notifications', view: 'notifications', title: 'Notificaciones', order: 30 },
  { id: 'qapaq-audit', view: 'audit', title: 'Auditoría e integridad', order: 40 },
  { id: 'qapaq-access', view: 'access', title: 'Usuarios y sesiones', order: 50 },
  { id: 'qapaq-sources', view: 'sources', title: 'Salud de fuentes', order: 60 },
  { id: 'qapaq-session', view: 'session', title: 'Mi sesión', order: 70 },
] as const;

export type QapaqView = (typeof QAPAQ_APPS)[number]['view'];

/** Destino por defecto tras iniciar sesión (y `uiSettings.overrides.defaultRoute`). */
export const DEFAULT_LANDING = '/app/qapaq-alerts';

export * from './api_contract';
export * from './catalog';
export * from './discover';
export * from './user_state';
export * from './audit_filters';
