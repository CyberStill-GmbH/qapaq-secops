/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Navegación del SIEM QAPAQ: categorías en español y qué apps del dashboard (QAPAQ, app de Wazuh y
 * núcleo de OSD) se muestran en el menú. Lo aplica `public/navigation.ts` con
 * `application.registerAppUpdater` (OSD 2.19 fusiona el resultado del updater con la app, así
 * que también cambia la categoría, el orden y el título). Ocultar del menú no bloquea la URL:
 * los permisos siguen en el Security plugin y en la API QAPAQ.
 *
 * Auditoría y motivos: docs/08-frontend-unificado.md § «Navegación del SIEM».
 */

export interface NavCategory {
  readonly id: string;
  readonly label: string;
  readonly order: number;
  /** Icono servido en `/ui/qapaq/` (solo lo muestra el menú expandido). */
  readonly icon: string;
}

export const NAV_CATEGORIES = {
  summary: { id: 'qapaq-nav-summary', label: 'Resumen', order: -1000, icon: 'qapaq-observability.svg' },
  monitoring: { id: 'qapaq-nav-monitoring', label: 'Monitoreo', order: -990, icon: 'qapaq-alerts.svg' },
  investigation: {
    id: 'qapaq-nav-investigation',
    label: 'Investigación',
    order: -980,
    icon: 'qapaq-incidents.svg',
  },
  detection: { id: 'qapaq-nav-detection', label: 'Detección', order: -970, icon: 'qapaq-sources.svg' },
  compliance: { id: 'qapaq-nav-compliance', label: 'Cumplimiento', order: -960, icon: 'qapaq-audit.svg' },
  integrations: {
    id: 'qapaq-nav-integrations',
    label: 'Integraciones',
    order: -950,
    icon: 'qapaq-sources.svg',
  },
  response: { id: 'qapaq-nav-response', label: 'Respuesta', order: -940, icon: 'ankay.svg' },
  admin: { id: 'qapaq-nav-admin', label: 'Administración', order: -930, icon: 'qapaq-access.svg' },
} as const;

export type NavCategoryKey = keyof typeof NAV_CATEGORIES;

export interface NavPlacement {
  readonly category: NavCategoryKey;
  readonly order: number;
  /** Título en el menú (en español y sin duplicados entre categorías). */
  readonly title?: string;
  readonly tooltip?: string;
}

/** Apps visibles: categoría, orden y título. Lo que no está aquí ni en `NAV_HIDDEN` no se toca. */
export const NAV_PLACEMENT: Readonly<Record<string, NavPlacement>> = {
  // Resumen
  'qapaq-overview': { category: 'summary', order: 10, title: 'Resumen del SOC' },
  'wz-home': { category: 'summary', order: 20, title: 'Resumen del SIEM' },
  dashboards: { category: 'summary', order: 30, title: 'Paneles' },
  reporting: { category: 'summary', order: 40, title: 'Informes PDF del SIEM' },
  'reports-dashboards': { category: 'summary', order: 50, title: 'Informes programados' },
  // Monitoreo
  'qapaq-alerts': { category: 'monitoring', order: 10, title: 'Cola de alertas' },
  'qapaq-notifications': { category: 'monitoring', order: 20, title: 'Notificaciones' },
  'endpoints-summary': { category: 'monitoring', order: 30, title: 'Agentes' },
  'qapaq-sources': { category: 'monitoring', order: 40, title: 'Salud de fuentes' },
  // Investigación
  'qapaq-incidents': { category: 'investigation', order: 10, title: 'Incidentes' },
  'qapaq-ai-analyst': {
    category: 'investigation',
    order: 15,
    title: 'Analista IA',
    tooltip: 'Investigación automática de alertas, con evidencia y costo estimado',
  },
  'threat-hunting': { category: 'investigation', order: 20, title: 'Threat Hunting' },
  'data-explorer': { category: 'investigation', order: 30, title: 'Discover' },
  discover: { category: 'investigation', order: 30, title: 'Discover' },
  'mitre-attack': { category: 'investigation', order: 40, title: 'MITRE ATT&CK' },
  // Detección
  'vulnerability-detection': {
    category: 'detection',
    order: 10,
    title: 'Vulnerabilidades',
  },
  'malware-detection': { category: 'detection', order: 20, title: 'Malware y rootcheck' },
  'file-integrity-monitoring': {
    category: 'detection',
    order: 30,
    title: 'Integridad de archivos (FIM)',
  },
  'configuration-assessment': {
    category: 'detection',
    order: 40,
    title: 'Configuración segura (SCA)',
  },
  'it-hygiene': { category: 'detection', order: 50, title: 'Inventario (higiene de TI)' },
  rules: { category: 'detection', order: 60, title: 'Reglas' },
  decoders: { category: 'detection', order: 70, title: 'Decodificadores' },
  'cdb-lists': { category: 'detection', order: 80, title: 'Listas CDB' },
  'ruleset-test': { category: 'detection', order: 90, title: 'Probar reglas' },
  // Cumplimiento
  'qapaq-policies': { category: 'compliance', order: 10, title: 'Políticas' },
  'qapaq-audit': { category: 'compliance', order: 20, title: 'Auditoría e integridad' },
  'pci-dss': { category: 'compliance', order: 30, title: 'PCI DSS' },
  gdpr: { category: 'compliance', order: 40, title: 'GDPR' },
  hipaa: { category: 'compliance', order: 50, title: 'HIPAA' },
  'nist-800-53': { category: 'compliance', order: 60, title: 'NIST 800-53' },
  tsc: { category: 'compliance', order: 70, title: 'TSC (SOC 2)' },
  // Integraciones
  'qapaq-integrations': { category: 'integrations', order: 10, title: 'Integraciones' },
  office365: { category: 'integrations', order: 70, title: 'Office 365 (módulo Wazuh)' },
  sharepoint: { category: 'integrations', order: 75, title: 'SharePoint y OneDrive' },
  docker: { category: 'integrations', order: 80, title: 'Docker' },
  // Respuesta
  'ankay': {
    category: 'response',
    order: 10,
    title: 'Ankay',
    tooltip: 'SOAR: playbooks y respuesta',
  },
  // Administración
  'qapaq-access': { category: 'admin', order: 10, title: 'Usuarios y sesiones' },
  'qapaq-session': { category: 'admin', order: 20, title: 'Mi sesión' },
  'endpoint-groups': { category: 'admin', order: 30, title: 'Grupos de agentes' },
  'server-status': { category: 'admin', order: 40, title: 'Estado del manager' },
  statistics: { category: 'admin', order: 50, title: 'Estadísticas del manager' },
  logs: { category: 'admin', order: 60, title: 'Logs del manager' },
  settings: { category: 'admin', order: 70, title: 'Configuración del manager' },
  'dashboards-settings': { category: 'admin', order: 70, title: 'Configuración del manager' },
  'app-settings': { category: 'admin', order: 80, title: 'Ajustes de la app SIEM' },
  'server-apis': { category: 'admin', order: 90, title: 'APIs del manager' },
  'dev-tools': { category: 'admin', order: 100, title: 'Consola API del manager' },
  security: { category: 'admin', order: 110, title: 'Roles del manager' },
  opensearch_index_management_dashboards: {
    category: 'admin',
    order: 120,
    title: 'Índices',
  },
  opensearch_snapshot_management_dashboards: {
    category: 'admin',
    order: 130,
    title: 'Instantáneas',
  },
  dev_tools: { category: 'admin', order: 140, title: 'Consola del Indexer' },
  visualize: { category: 'admin', order: 150, title: 'Editor de visualizaciones' },
  management: { category: 'admin', order: 160, title: 'Administración del dashboard' },
};

/**
 * Apps ocultas del menú, con el motivo (también en la auditoría de docs/08):
 * servicios que este despliegue no tiene o duplicados de vistas QAPAQ.
 */
export const NAV_HIDDEN: Readonly<Record<string, string>> = {
  'amazon-web-services':
    'El módulo filtra rule.groups: amazon y el receptor QAPAQ usa aws (siempre vacío): el menú abre el panel QAPAQ de AWS.',
  'google-cloud': 'Sin integración de Google Cloud en este despliegue.',
  github: 'Sin integración de GitHub (la de código es Snyk).',
  'microsoft-graph-api':
    'Microsoft 365 entra por el módulo office365; el módulo Graph de Wazuh no está configurado.',
  cluster: 'Manager de un solo nodo: no hay clúster que mostrar.',
  alerting: 'Los avisos los emite QAPAQ (notificaciones y P1); los monitores de OSD no se usan.',
  'anomaly-detection-dashboards': 'Sin detectores de anomalías configurados en el Indexer.',
  'maps-dashboards': 'Sin capas geográficas propias; duplicaba Paneles.',
  'notifications-dashboards':
    'Canales de OSD no usados; las notificaciones del SOC están en «Notificaciones» (QAPAQ).',
  'sample-data': 'Datos de ejemplo: no se cargan en un SOC real.',
  about: 'Versión del SIEM visible en «Ajustes de la app SIEM».',
  'observability-logs': 'Observability de OSD no se usa.',
  'observability-notebooks': 'Observability de OSD no se usa.',
  'observability-dashboards': 'Observability de OSD no se usa.',
  'observability-traces': 'Observability de OSD no se usa.',
  'observability-metrics': 'Observability de OSD no se usa.',
  'search-relevance': 'Herramienta de relevancia de búsqueda: no aplica a un SOC.',
  'query-workbench': 'Usar Discover o Threat Hunting.',
  'opensearch-query-workbench': 'Usar Discover o Threat Hunting.',
};
