/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

export const PLUGIN_ID = 'qapaqOps';
export const PLUGIN_NAME = 'QAPAQ SecOps';
/** Nombre descriptivo del grupo de navegación en el menú lateral. */
export const NAV_CATEGORY_NAME = 'QAPAQ SOC';

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

/** Categoría del menú para la vigilancia en vivo (la cola de alertas). */
export const MONITORING_CATEGORY_NAME = 'Monitoreo';

/**
 * Apps registradas bajo «QAPAQ SOC» (primera categoría del menú) o «Monitoreo». Cada una monta
 * la misma consola en la vista indicada. El orden sigue `order` dentro de cada categoría.
 */
export const QAPAQ_APPS = [
  {
    id: 'qapaq-overview',
    view: 'overview',
    title: 'Resumen del SOC',
    icon: 'qapaq-observability.svg',
    order: 1,
    category: 'soc',
  },
  {
    id: 'qapaq-alerts',
    view: 'alerts',
    title: 'Cola de alertas',
    icon: 'qapaq-alerts.svg',
    order: 10,
    category: 'monitoring',
  },
  {
    id: 'qapaq-incidents',
    view: 'incidents',
    title: 'Incidentes',
    icon: 'qapaq-incidents.svg',
    order: 20,
    category: 'soc',
  },
  {
    id: 'qapaq-ai-analyst',
    view: 'ai_analyst',
    title: 'Analista IA',
    icon: 'qapaq-ai-analyst.svg',
    order: 25,
    category: 'soc',
  },
  {
    id: 'qapaq-notifications',
    view: 'notifications',
    title: 'Notificaciones',
    icon: 'qapaq-notifications.svg',
    order: 30,
    category: 'soc',
  },
  {
    id: 'qapaq-integrations',
    view: 'integrations',
    title: 'Integraciones',
    icon: 'qapaq-sources.svg',
    order: 35,
    category: 'soc',
  },
  {
    id: 'qapaq-policies',
    view: 'policies',
    title: 'Políticas',
    icon: 'qapaq-audit.svg',
    order: 37,
    category: 'soc',
  },
  {
    id: 'qapaq-audit',
    view: 'audit',
    title: 'Auditoría e integridad',
    icon: 'qapaq-audit.svg',
    order: 40,
    category: 'soc',
  },
  {
    id: 'qapaq-access',
    view: 'access',
    title: 'Usuarios y sesiones',
    icon: 'qapaq-access.svg',
    order: 50,
    category: 'soc',
  },
  {
    id: 'qapaq-sources',
    view: 'sources',
    title: 'Salud de fuentes',
    icon: 'qapaq-sources.svg',
    order: 60,
    category: 'soc',
  },
  {
    id: 'qapaq-session',
    view: 'session',
    title: 'Mi sesión',
    icon: 'qapaq-session.svg',
    order: 70,
    category: 'soc',
  },
] as const;

export type QapaqView = (typeof QAPAQ_APPS)[number]['view'];

/**
 * Ankay (SOAR) embebido: app propia del menú QAPAQ que enmarca `/ankay/` (mismo
 * origen, detrás de la sesión QAPAQ en el edge). No es una vista de la consola: no usa la API QAPAQ.
 */
export const RESPOND_APP = {
  id: 'ankay',
  /** Nombre de producto en el menú; «SOAR» queda como descripción (`tooltip`). */
  title: 'Ankay',
  subtitle: 'SOAR',
  icon: 'ankay.svg',
  order: 5,
} as const;
export const RESPOND_PATH = '/ankay/';

/** Destino por defecto tras iniciar sesión (y `uiSettings.overrides.defaultRoute`). */
export const DEFAULT_LANDING = '/app/qapaq-overview';
/** Cola de alertas (categoría «Monitoreo»): destino de los avisos P1. */
export const ALERTS_PATH = '/app/qapaq-alerts';

export * from './api_contract';
export * from './catalog';
export * from './discover';
export * from './user_state';
export * from './audit_filters';
export * from './integrations';
export * from './vendors';
export * from './investigation';
export * from './qapaqzito_bridge';
export * from './navigation';
export * from './platform_health';
export * from './ai_investigations';
export * from './ai_activity';
