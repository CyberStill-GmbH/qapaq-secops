/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Catálogo de integraciones QAPAQ y resumen de políticas aplicadas (docs/16-politicas.md,
 * wazuh/provider-ingestion). Es la única fuente de los textos que muestran «Resumen del SOC»,
 * «Integraciones» y «Políticas»: qué recoge cada servicio, cada cuánto, con qué reglas y qué
 * permiso falta. El estado vivo sale del Indexer (ruta `/api/qapaq_ops/overview`) y de la API QAPAQ;
 * el estado declarado (permiso bloqueado, servicio no contratado) sale de `qapaq_ops.integrations`
 * en `opensearch_dashboards.yml`.
 */

import type { PlatformHealth } from './platform_health';

export const OVERVIEW_ROUTE = '/api/qapaq_ops/overview';

/** Proveedores medidos en `wazuh-alerts-*` por su grupo de regla. */
export const PROVIDER_IDS = [
  'office365',
  'sharepoint',
  'bitdefender',
  'snyk',
  'cloudflare',
  'aws',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Servicios de la plataforma que no son proveedores de eventos. */
export type ServiceId = ProviderId | 'wazuh' | 'respond' | 'qapaqzito' | 'alertMail';

/** Estado declarado por configuración. `auto` = lo deciden los datos. */
export const DECLARED_STATES = ['auto', 'blocked', 'disabled', 'pending'] as const;
export type DeclaredState = (typeof DECLARED_STATES)[number];

export interface IntegrationConfig {
  readonly state: DeclaredState;
  /** Permisos que faltan (p. ej. `ActivityFeed.Read`). */
  readonly missingPermissions: readonly string[];
  /** Nota operativa visible (siguiente paso). */
  readonly note: string;
}

export type IntegrationsConfig = Readonly<Record<ServiceId, IntegrationConfig>>;

export interface IntegrationLink {
  readonly label: string;
  /** Ruta del dashboard (se antepone el basePath) o URL absoluta. */
  readonly href: string;
}

export interface IntegrationSpec {
  readonly id: ServiceId;
  readonly name: string;
  readonly vendor: string;
  /** Iniciales del distintivo de la tarjeta. */
  readonly monogram: string;
  readonly summary: string;
  readonly collects: readonly string[];
  readonly interval: string;
  readonly ruleRange: string | null;
  /** Grupo de regla en `wazuh-alerts-*` (solo proveedores). */
  readonly ruleGroup: string | null;
  readonly policy: string;
  /** Permisos que la integración necesita para funcionar completa. */
  readonly permissions: readonly string[];
  /** Qué hacer si está bloqueada o sin datos. */
  readonly nextSteps: readonly string[];
  readonly links: readonly IntegrationLink[];
}

/** Dashboards guardados QAPAQ (wazuh/dashboard/saved-objects/qapaq-provider-dashboards.ndjson). */
export const PROVIDER_DASHBOARDS: Readonly<Record<ProviderId, string>> = {
  office365: 'qapaq-dashboard-microsoft-365',
  sharepoint: 'qapaq-dashboard-sharepoint-onedrive',
  bitdefender: 'qapaq-dashboard-bitdefender',
  snyk: 'qapaq-dashboard-snyk',
  cloudflare: 'qapaq-dashboard-cloudflare',
  aws: 'qapaq-dashboard-aws',
};

export function dashboardHref(id: string): string {
  return `/app/dashboards#/view/${id}`;
}

const ALERT_MAIL_LEVEL = 8;

export const INTEGRATIONS: readonly IntegrationSpec[] = [
  {
    id: 'wazuh',
    name: 'Wazuh SIEM',
    vendor: 'Wazuh 4.14.8',
    monogram: 'WZ',
    summary: 'Manager, agentes e Indexer: la base de detección de todo el SOC.',
    collects: [
      'Logs de agentes (journald, Windows Event Log)',
      'Integridad de archivos (FIM) y rootcheck',
      'Evaluación de configuración (SCA, CIS)',
      'Inventario y vulnerabilidades',
    ],
    interval: 'Tiempo real (agentes); SCA cada 12 h; inventario cada 6 h',
    ruleRange: 'Ruleset oficial + reglas QAPAQ 100000–120000',
    ruleGroup: null,
    policy:
      'Grupos de agentes con FIM, SCA, inventario y rootcheck; detección de vulnerabilidades activa; Active Response desactivada por defecto.',
    permissions: ['Lectura de wazuh-alerts-* (todos los roles SOC)'],
    nextSteps: ['Enrolar agentes con WAZUH_AGENT_GROUP para que hereden la política de su grupo.'],
    links: [
      { label: 'Vulnerabilidades', href: '/app/vulnerability-detection' },
      { label: 'Configuración (SCA)', href: '/app/configuration-assessment' },
      { label: 'Integridad (FIM)', href: '/app/file-integrity-monitoring' },
      { label: 'Malware', href: '/app/malware-detection' },
      { label: 'Inventario', href: '/app/it-hygiene' },
    ],
  },
  {
    id: 'office365',
    name: 'Microsoft 365 / Entra ID',
    vendor: 'Microsoft',
    monogram: 'M365',
    summary: 'Auditoría unificada de Entra ID, Exchange, SharePoint y General.',
    collects: [
      'Audit.AzureActiveDirectory (inicios de sesión, cambios de rol, consentimientos)',
      'Audit.Exchange (reglas de bandeja, reenvíos, permisos de buzón)',
      'Audit.SharePoint y Audit.General',
    ],
    interval: 'Cada 1 min (módulo office365 de Wazuh)',
    ruleRange: '100502–100530',
    ruleGroup: 'office365',
    policy: 'Reglas QAPAQ de compromiso de cuenta y lista qapaq-break-glass; correo desde nivel 8.',
    permissions: ['ActivityFeed.Read (Office 365 Management APIs, permiso de aplicación)'],
    nextSteps: [
      'En Entra ID → Registros de aplicaciones → Permisos de API, agregar Office 365 Management APIs › ActivityFeed.Read (aplicación).',
      'Conceder consentimiento de administrador y esperar hasta 12 h a que Microsoft active las suscripciones.',
    ],
    links: [{ label: 'Módulo Office 365', href: '/app/office365' }],
  },
  {
    id: 'sharepoint',
    name: 'SharePoint y OneDrive',
    vendor: 'Microsoft 365',
    monogram: 'SP',
    summary: 'Auditoría de archivos y postura de uso compartido en SharePoint y OneDrive.',
    collects: [
      'Actividad por el módulo office365 o Purview Audit Search (Graph)',
      'Postura del tenant, sitios nuevos y enlaces anónimos/externos',
    ],
    interval: 'Auditoría cada 5 min; postura cada 60 min',
    ruleRange: '101900–101979',
    ruleGroup: 'qapaq_sharepoint',
    policy:
      'Doble vía de auditoría sin duplicación, allowlist de cuentas de servicio/sincronización y collector apagado hasta validar permisos.',
    permissions: [
      'ActivityFeed.Read (Management APIs) o AuditLogsQuery-SharePoint.Read.All (Graph)',
      'AuditLogsQuery-OneDrive.Read.All (Graph)',
      'SharePointTenantSettings.Read.All y Sites.Read.All para postura',
    ],
    nextSteps: [
      'Verificar permisos de aplicación y consentimiento de administrador en Entra ID.',
      'Activar QAPAQ_ENABLE_SHAREPOINT solo después de que el chequeo de acceso confirme HTTP 200 para la vía elegida.',
    ],
    links: [
      {
        label: 'Dashboard SharePoint y OneDrive',
        href: dashboardHref('qapaq-dashboard-sharepoint-onedrive'),
      },
    ],
  },
  {
    id: 'bitdefender',
    name: 'Bitdefender GravityZone',
    vendor: 'Bitdefender',
    monogram: 'BD',
    summary: 'Estado de protección de los endpoints y cuarentena.',
    collects: [
      'Estado de cada endpoint (infección, aislamiento, módulos deshabilitados)',
      'Firmas y agente desactualizados, política no aplicada',
      'Amenazas en cuarentena',
    ],
    interval: 'Cada 10 min (qapaq-collector-bitdefender.timer)',
    ruleRange: '101400–101411',
    ruleGroup: 'bitdefender',
    policy:
      'Monitor-only: QAPAQ no ejecuta acciones en GravityZone. Infección activa nivel 12; 3+ cuarentenas en 1 h nivel 13.',
    permissions: ['API key de GravityZone con Network y Quarantine (solo lectura)'],
    nextSteps: ['Si no hay eventos, revisar `journalctl -u qapaq-collector-bitdefender` en el nodo.'],
    links: [],
  },
  {
    id: 'snyk',
    name: 'Snyk',
    vendor: 'Snyk',
    monogram: 'SN',
    summary: 'Vulnerabilidades abiertas de dependencias y código de los proyectos.',
    collects: ['Issues por proyecto con severidad, paquete, CVE y madurez del exploit'],
    interval: 'Cada 15 min (qapaq-collector-snyk.timer)',
    ruleRange: '101450–101458',
    ruleGroup: 'snyk',
    policy:
      'Crítica nivel 12 (13 con exploit maduro), alta 10 (11), media 5, baja 3. Resueltos e ignorados en nivel 2.',
    permissions: ['Token de servicio Snyk con lectura de la organización'],
    nextSteps: ['Un evento por cambio de issue: si no cambia nada, no hay eventos nuevos.'],
    links: [],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    vendor: 'Cloudflare',
    monogram: 'CF',
    summary: 'Bloqueos del WAF por zona y auditoría de la cuenta.',
    collects: [
      'Eventos de firewall/WAF (bloqueos, desafíos, solo-log) por zona',
      'Audit logs de la cuenta (DNS, reglas de seguridad, credenciales)',
    ],
    interval: 'Cada 5 min (qapaq-collector-cloudflare.timer)',
    ruleRange: '101500–101513',
    ruleGroup: 'cloudflare',
    policy:
      'Eliminar o deshabilitar un control de seguridad nivel 10; 20+ bloqueos de una IP en 5 min nivel 10.',
    permissions: ['API token con Account Audit Logs:Read y Zone Analytics:Read'],
    nextSteps: ['Los bloqueos del WAF dependen del tráfico real: 0 eventos puede ser normal.'],
    links: [],
  },
  {
    id: 'aws',
    name: 'AWS (cuenta QAPAQ)',
    vendor: 'Amazon Web Services',
    monogram: 'AWS',
    summary:
      'Cuenta 061098277310: EventBridge → SNS → webhook (sin IAM). 17 regiones (us-east-1 + 16 centinelas).',
    collects: [
      'Consola y root, IAM y Organizations',
      'Red, S3 y KMS',
      'CloudTrail, GuardDuty, Security Hub y Config',
      'Actividad en regiones no habituales',
    ],
    interval:
      'Push casi en tiempo real: EventBridge → SNS → /hooks/aws-sns (contenedor aws-events) → /var/ossec/logs/qapaq-collectors/aws/aws-events.jsonl',
    ruleRange: '101600–101673',
    ruleGroup: 'aws',
    policy:
      'Activo: 17 suscripciones confirmadas. El módulo AWS nativo de Wazuh no se usa: requiere credenciales IAM que el nodo PowerUser no tiene.',
    permissions: [
      'Sin IAM: políticas de recurso SNS/KMS',
      'GuardDuty y Security Hub apagados (de pago, opcionales)',
    ],
    nextSteps: [
      'Si no hay eventos, revisar el contenedor aws-events y las suscripciones SNS confirmadas.',
    ],
    links: [],
  },
  {
    id: 'respond',
    name: 'Ankay (SOAR)',
    vendor: 'QAPAQ',
    monogram: 'SR',
    summary: 'Playbooks de respuesta con aprobación del Líder SOC.',
    collects: ['Ejecuciones de playbooks y aprobaciones'],
    interval: 'Bajo demanda',
    ruleRange: null,
    ruleGroup: null,
    policy: 'Toda acción con efectos pasa por aprobación; Active Response de Wazuh desactivada.',
    permissions: ['Sesión QAPAQ (SSO al abrir Respond)'],
    nextSteps: ['Si no responde, revisar el contenedor ankay-qapaq-frontend y Shuffle.'],
    links: [{ label: 'Abrir SOAR', href: '/app/ankay' }],
  },
  {
    id: 'qapaqzito',
    name: 'Qapaqzito (IA)',
    vendor: 'QAPAQ',
    monogram: 'IA',
    summary: 'Asistente del SOC: consulta alertas, incidentes, fuentes y eventos con tu sesión.',
    collects: ['Solo lee con los permisos de quien pregunta'],
    interval: 'Bajo demanda',
    ruleRange: null,
    ruleGroup: null,
    policy: 'Sin acciones de escritura; cada respuesta cita lo que consultó.',
    permissions: ['Proveedor de IA configurado en la API (QAPAQ_QAPAQZITO_*)'],
    nextSteps: ['Si está desactivado, configurar la clave del proveedor de IA en la API.'],
    links: [],
  },
  {
    id: 'alertMail',
    name: 'Correo de alertas',
    vendor: 'Microsoft Graph',
    monogram: '@',
    summary: `Aviso por correo de alertas desde nivel ${ALERT_MAIL_LEVEL} (alta y crítica).`,
    collects: ['Alertas Wazuh de nivel ≥ 8 y notificaciones P1 de QAPAQ'],
    interval: 'Tiempo real',
    ruleRange: `Nivel ≥ ${ALERT_MAIL_LEVEL}`,
    ruleGroup: null,
    policy: `Umbral de correo: nivel ${ALERT_MAIL_LEVEL} (escala QAPAQ: alta 8–11, crítica 12–15).`,
    permissions: ['Mail.Send (Microsoft Graph, permiso de aplicación) sobre el buzón remitente'],
    nextSteps: [
      'En Entra ID, agregar Microsoft Graph › Mail.Send (aplicación) y conceder consentimiento.',
      'Restringir el envío al buzón del SOC con una Application Access Policy de Exchange.',
    ],
    links: [{ label: 'Notificaciones', href: '/app/qapaq-notifications' }],
  },
];

export function integrationSpec(id: ServiceId): IntegrationSpec {
  const spec = INTEGRATIONS.find((item) => item.id === id);
  if (!spec) throw new Error(`Integración desconocida: ${id}`);
  return spec;
}

/* ------------------------------------------------------------------ Políticas */

export interface AgentGroupPolicy {
  readonly name: string;
  readonly fim: string;
  readonly sca: string;
  readonly inventory: string;
  readonly logs: string;
}

export const AGENT_GROUP_POLICIES: readonly AgentGroupPolicy[] = [
  {
    name: 'linux-servers',
    fim: 'Tiempo real en /etc/ssh, sudoers, pam.d, cron, systemd; /etc y binarios cada 12 h',
    sca: 'CIS de la distribución, cada 12 h',
    inventory: 'Cada 6 h con paquetes',
    logs: 'journald: sshd, sudo, su, login, gestión de usuarios',
  },
  {
    name: 'windows-servers',
    fim: 'Tiempo real en tareas programadas, Startup y GPO; registro Run/Services/LSA',
    sca: 'CIS de la versión de Windows, cada 12 h',
    inventory: 'Cada 6 h con paquetes y hotfixes',
    logs: 'Security, System, Application, Defender',
  },
  {
    name: 'windows-workstations',
    fim: 'Rutas reducidas, cada 24 h',
    sca: 'CIS, cada 24 h',
    inventory: 'Cada 12 h',
    logs: 'Igual que servidores',
  },
  {
    name: 'domain-controllers',
    fim: 'SYSVOL Policies/scripts; registro NTDS, Netlogon, KDC',
    sca: 'Hereda de windows-servers',
    inventory: 'Hereda de windows-servers',
    logs: 'Reglas AD 101300–101307',
  },
  {
    name: 'windows-telemetry-extended',
    fim: '—',
    sca: '—',
    inventory: '—',
    logs: 'Opt-in con aprobación de privacidad: Sysmon y PowerShell 4104',
  },
];

export interface PolicyFact {
  readonly title: string;
  readonly value: string;
  readonly detail: string;
}

export const MANAGER_POLICIES: readonly PolicyFact[] = [
  {
    title: 'Detección de vulnerabilidades',
    value: 'Activa',
    detail:
      'Feed cada 60 min a partir del inventario de paquetes (wazuh-states-vulnerabilities-*).',
  },
  {
    title: 'Evaluación de configuración (SCA)',
    value: 'CIS cada 12 h',
    detail: 'Benchmarks CIS que Wazuh trae para cada sistema operativo.',
  },
  {
    title: 'Active Response',
    value: 'Desactivada',
    detail:
      'Ninguna respuesta automática por defecto: las acciones pasan por Ankay con aprobación del Líder SOC.',
  },
  {
    title: 'Correo de alertas',
    value: `Nivel ≥ ${ALERT_MAIL_LEVEL}`,
    detail: 'Lo envía el notificador QAPAQ (no el correo de Wazuh).',
  },
  {
    title: 'Umbral de registro',
    value: 'Nivel ≥ 3',
    detail: 'log_alert_level 3 (default de Wazuh); QAPAQ promueve a la cola desde nivel 4.',
  },
];

export const RETENTION_POLICIES: readonly PolicyFact[] = [
  { title: 'Alertas', value: '90 días', detail: 'wazuh-alerts-* · qapaq-wazuh-alerts-90d' },
  {
    title: 'Monitoreo y estadísticas',
    value: '15 días',
    detail: 'wazuh-monitoring-*, wazuh-statistics-* · qapaq-wazuh-monitoring-15d',
  },
  {
    title: 'Archivos crudos',
    value: '7 días',
    detail: 'wazuh-archives-* (solo si se activa logall_json) · qapaq-wazuh-archives-7d',
  },
];

/* ---------------------------------------------------------- Respuesta overview */

export const LEVEL_BANDS = ['low', 'medium', 'high', 'critical'] as const;
export type LevelBand = (typeof LEVEL_BANDS)[number];
export type LevelCounts = Readonly<Record<LevelBand, number>>;

/** Escala QAPAQ sobre `rule.level` (modules/telemetry: baja 0–3, media 4–7, alta 8–11, crítica 12–15). */
export const LEVEL_BAND_RANGES: Readonly<Record<LevelBand, { from: number; to: number }>> = {
  low: { from: 0, to: 4 },
  medium: { from: 4, to: 8 },
  high: { from: 8, to: 12 },
  critical: { from: 12, to: 16 },
};

export const LEVEL_BAND_LABEL: Readonly<Record<LevelBand, string>> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  critical: 'Crítica',
};

export type Readability = 'ok' | 'forbidden' | 'error';

export interface ProviderStats {
  readonly events24h: number;
  readonly lastEventAt: string | null;
  readonly levels24h: LevelCounts;
  /** Métricas propias del proveedor (p. ej. `endpoints`, `waf_blocks`). */
  readonly metrics: Readonly<Record<string, number>>;
}

export interface TrendBucket {
  readonly at: string;
  readonly levels: LevelCounts;
}

export interface TopEvent {
  readonly id: string;
  readonly at: string;
  readonly level: number;
  readonly ruleId: string;
  readonly description: string;
  readonly agent: string | null;
  readonly provider: ProviderId | null;
}

export interface AgentsSummary {
  readonly total: number;
  readonly active: number;
  readonly disconnected: number;
  readonly other: number;
  readonly groups: Readonly<Record<string, number>>;
  readonly measuredAt: string | null;
}

export interface ServiceAttention {
  readonly access: Readability;
  readonly total: number | null;
  readonly events: readonly TopEvent[];
}

export interface OverviewResponse {
  readonly generatedAt: string;
  readonly alertsAccess: Readability;
  readonly monitoringAccess: Readability;
  readonly siem: {
    readonly levels24h: LevelCounts;
    readonly total24h: number;
    readonly agentsWithAlerts24h: number;
    readonly trend24h: readonly TrendBucket[];
    readonly trend7d: readonly TrendBucket[];
  } | null;
  readonly providers: Readonly<Record<ProviderId, ProviderStats>> | null;
  readonly topEvents: readonly TopEvent[];
  readonly attention?: Readonly<Partial<Record<ServiceId, ServiceAttention>>>;
  readonly agents: AgentsSummary | null;
  readonly integrations: IntegrationsConfig;
  /** Monitor de plataforma (docs/20); ausente en respuestas de versiones anteriores. */
  readonly platformHealth?: PlatformHealth | null;
}

export function emptyLevels(): Record<LevelBand, number> {
  return { low: 0, medium: 0, high: 0, critical: 0 };
}

export function levelBand(level: number): LevelBand {
  if (level >= 12) return 'critical';
  if (level >= 8) return 'high';
  if (level >= 4) return 'medium';
  return 'low';
}
