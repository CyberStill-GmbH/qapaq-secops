import type {
  AccessRequest,
  AccessRequestInput,
  AdminApi,
  AdminSession,
  AdminRole,
  AlertSummary,
  AuditEventSummary,
  IncidentSummary,
  NotificationDelivery,
  OperationReceipt,
  Page,
  PlatformOverview,
  ReplayRequestInput,
  ServiceHealth,
  SourceSummary,
} from './admin.js';

const DEMO_TIME = '2026-10-01T14:32:00-05:00';

export const mockSession: AdminSession = {
  mode: 'mock',
  actor: {
    id: 'demo-platform-admin-01',
    displayName: 'Valeria Ríos',
    email: 'valeria.rios@qapaq.demo',
    role: 'PLATFORM_ADMIN',
    scope: 'institution',
    capabilities: [
      'platform.health.read',
      'integrations.read',
      'integrations.manage',
      'platform.access.read',
      'platform.audit.read',
      'notifications.read',
    ],
  },
  auth: {
    provider: 'Microsoft Entra ID',
    flow: 'OIDC Authorization Code + PKCE',
    session: 'simulated in memory',
    tenantLabel: 'QAPAQ · tenant institucional de demostración',
  },
};

export const mockServices: readonly ServiceHealth[] = [
  {
    id: 'wazuh',
    name: 'Wazuh Manager',
    kind: 'source',
    status: 'healthy',
    detail: 'Conector de alertas en solo lectura',
    checkedAt: DEMO_TIME,
    latencyMs: 84,
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    kind: 'storage',
    status: 'healthy',
    detail: 'Manifiestos, inbox y estado operativo',
    checkedAt: DEMO_TIME,
    latencyMs: 7,
  },
  {
    id: 'redis',
    name: 'Redis / BullMQ',
    kind: 'queue',
    status: 'healthy',
    detail: 'Cola y entrega durable',
    checkedAt: DEMO_TIME,
    latencyMs: 3,
  },
  {
    id: 'opensearch',
    name: 'OpenSearch QAPAQ',
    kind: 'search',
    status: 'degraded',
    detail: 'Servicio propio · backlog de proyección simulado',
    checkedAt: DEMO_TIME,
    latencyMs: 242,
  },
  {
    id: 'entra',
    name: 'Microsoft Entra ID',
    kind: 'identity',
    status: 'unknown',
    detail: 'Federación real pendiente de configuración',
    checkedAt: DEMO_TIME,
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    kind: 'notification',
    status: 'blocked',
    detail: 'Workflow y credenciales de entrega pendientes',
    checkedAt: DEMO_TIME,
  },
];

const mockAlerts: AlertSummary[] = [
  {
    id: 'AL-4821',
    title: 'Inicio de sesión desde ubicación inusual',
    severity: 'CRITICAL',
    state: 'new',
    source: 'Microsoft 365 · Wazuh',
    occurredAt: '2026-10-01T14:26:11-05:00',
    ruleId: 'MS365-1037',
    eventUid: 'wazuh:demo-evt-4821',
    summary:
      'Actividad de acceso marcada para revisión prioritaria. Evento sintético; no contiene datos reales.',
  },
  {
    id: 'AL-4818',
    title: 'Múltiples errores de autenticación',
    severity: 'HIGH',
    state: 'investigating',
    source: 'Microsoft 365 · Wazuh',
    occurredAt: '2026-10-01T14:13:08-05:00',
    ruleId: 'MS365-1002',
    eventUid: 'wazuh:demo-evt-4818',
    incidentId: 'INC-219',
    summary: 'Secuencia de autenticación de demostración agrupada en un incidente.',
  },
  {
    id: 'AL-4812',
    title: 'Cambio de política de acceso',
    severity: 'MEDIUM',
    state: 'acknowledged',
    source: 'Microsoft 365 · Wazuh',
    occurredAt: '2026-10-01T13:55:42-05:00',
    ruleId: 'MS365-1110',
    eventUid: 'wazuh:demo-evt-4812',
    summary: 'Cambio sintético visible como SecurityEvent canónico de ejemplo.',
  },
  {
    id: 'AL-4809',
    title: 'Regla de reenvío creada',
    severity: 'LOW',
    state: 'resolved',
    source: 'Microsoft 365 · Wazuh',
    occurredAt: '2026-10-01T13:42:04-05:00',
    ruleId: 'MS365-1156',
    eventUid: 'wazuh:demo-evt-4809',
    summary: 'Alerta de baja prioridad usada únicamente para ilustrar el flujo.',
  },
];

const mockIncidents: IncidentSummary[] = [
  {
    id: 'INC-219',
    title: 'Actividad de autenticación atípica',
    severity: 'HIGH',
    state: 'investigating',
    owner: 'SOC L2 · Mateo Salas',
    alertCount: 3,
    updatedAt: '2026-10-01T14:18:00-05:00',
  },
  {
    id: 'INC-214',
    title: 'Revisión de política de acceso',
    severity: 'MEDIUM',
    state: 'open',
    owner: 'SOC L1 · Lucía Vega',
    alertCount: 1,
    updatedAt: '2026-10-01T13:59:00-05:00',
  },
  {
    id: 'INC-206',
    title: 'Actividad de correo para validar',
    severity: 'LOW',
    state: 'contained',
    owner: 'SOC L2 · Mateo Salas',
    alertCount: 2,
    updatedAt: '2026-10-01T12:40:00-05:00',
  },
];

const mockSources: readonly SourceSummary[] = [
  {
    id: 'm365-wazuh',
    name: 'Microsoft 365 vía Wazuh',
    provider: 'Wazuh · Office 365',
    status: 'degraded',
    datasets: ['audit.signin', 'audit.exchange'],
    lastSuccessfulRead: '2026-10-01T14:26:11-05:00',
    replayCapability: 'not_verified',
  },
  {
    id: 'qapaq-opensearch',
    name: 'Proyección de eventos',
    provider: 'OpenSearch QAPAQ',
    status: 'healthy',
    datasets: ['qapaq.security-event/1.0.0'],
    lastSuccessfulRead: '2026-10-01T14:24:00-05:00',
    replayCapability: 'bounded',
  },
];

const mockAccessRequests: AccessRequest[] = [
  {
    id: 'AR-0084',
    requester: 'Lucía Vega',
    target: 'diego.paredes@qapaq.demo',
    requestedBundle: 'SOC_L2',
    scope: 'Equipo de respuesta',
    reason: 'Cobertura de guardia del 1 al 7 de octubre.',
    state: 'pending_second_approver',
    submittedAt: '2026-10-01T13:51:00-05:00',
  },
  {
    id: 'AR-0081',
    requester: 'Mateo Salas',
    target: 'ana.torres@qapaq.demo',
    requestedBundle: 'SOC_L1',
    scope: 'Cola Microsoft 365',
    reason: 'Incorporación al equipo de triaje.',
    state: 'pending_second_approver',
    submittedAt: '2026-10-01T11:20:00-05:00',
  },
];

const mockAudit: AuditEventSummary[] = [
  {
    id: 'AU-9108',
    occurredAt: '2026-10-01T14:28:10-05:00',
    actor: 'Valeria Ríos',
    action: 'platform.services.read',
    resource: 'service/opensearch',
    outcome: 'allowed',
    correlationId: 'cor-demo-9108',
  },
  {
    id: 'AU-9107',
    occurredAt: '2026-10-01T14:11:33-05:00',
    actor: 'Cuenta demo · Plataforma',
    action: 'access.grant.requested',
    resource: 'request/AR-0084',
    outcome: 'pending',
    correlationId: 'cor-demo-9107',
  },
  {
    id: 'AU-9102',
    occurredAt: '2026-10-01T13:44:09-05:00',
    actor: 'Valeria Ríos',
    action: 'raw.evidence.read',
    resource: 'event/demo-evt-4791',
    outcome: 'denied',
    correlationId: 'cor-demo-9102',
  },
];

const mockNotifications: NotificationDelivery[] = [
  {
    id: 'NT-3201',
    destination: 'Microsoft Teams · Canal SOC',
    severity: 'CRITICAL',
    state: 'failed',
    attempts: 3,
    updatedAt: '2026-10-01T14:20:00-05:00',
    alertId: 'AL-4821',
  },
  {
    id: 'NT-3198',
    destination: 'Microsoft Teams · Canal SOC',
    severity: 'HIGH',
    state: 'delivered',
    attempts: 1,
    updatedAt: '2026-10-01T14:10:00-05:00',
    alertId: 'AL-4818',
  },
  {
    id: 'NT-3192',
    destination: 'Microsoft Teams · Canal SOC',
    severity: 'CRITICAL',
    state: 'retrying',
    attempts: 2,
    updatedAt: '2026-10-01T13:58:00-05:00',
    alertId: 'AL-4791',
  },
];

const mockOverview: PlatformOverview = {
  mode: 'mock',
  asOf: DEMO_TIME,
  metrics: {
    openAlerts: 12,
    criticalAlerts: 2,
    activeIncidents: 3,
    eventsLastHour: 1842,
    pendingAccessReviews: 2,
  },
  services: mockServices,
  coverage: [
    {
      id: 'm365-audit',
      name: 'Microsoft 365 · auditoría',
      state: 'partial',
      lastEventAt: '2026-10-01T14:26:11-05:00',
      note: 'Muestra sintética · permiso de proveedor pendiente',
    },
    {
      id: 'wazuh-alerts',
      name: 'Wazuh · alertas',
      state: 'collecting',
      lastEventAt: '2026-10-01T14:26:11-05:00',
      note: 'Conector read-only representado en mock',
    },
  ],
};

const delay = () => new Promise<void>((resolve) => window.setTimeout(resolve, 90));
const page = <T>(items: readonly T[]): Page<T> => ({ items, nextCursor: null });

/** In-memory demo adapter; every mutation is volatile and visibly labelled mock. */
export class MockAdminApi implements AdminApi {
  private activeRole: AdminRole = 'PLATFORM_ADMIN';
  private alerts = [...mockAlerts];
  private accessRequests = [...mockAccessRequests];
  private notifications = [...mockNotifications];
  private audit = [...mockAudit];

  public setDemoRole(role: AdminRole): AdminSession {
    this.activeRole = role;
    const roleCapabilities: Record<AdminRole, readonly string[]> = {
      PLATFORM_ADMIN: ['platform.health.read', 'integrations.read', 'integrations.manage', 'notifications.read', 'notifications.retry'],
      SOC_L1: ['alerts.read', 'alerts.acknowledge', 'incidents.read', 'incidents.create', 'cases.read', 'events.search', 'integrations.read', 'notifications.read'],
      SOC_L2: ['alerts.read', 'alerts.acknowledge', 'incidents.read', 'incidents.create', 'incidents.manage', 'cases.read', 'cases.notes', 'events.search', 'events.raw.read', 'evidence.attach', 'integrations.read', 'notifications.read', 'notifications.retry'],
      SOC_MANAGER: ['alerts.read', 'alerts.acknowledge', 'incidents.read', 'incidents.create', 'incidents.manage', 'cases.read', 'cases.notes', 'events.search', 'events.raw.read', 'evidence.attach', 'platform.health.read', 'integrations.read', 'integrations.manage', 'notifications.read', 'notifications.retry', 'audit.read'],
      DETECTION_ENGINEER: ['integrations.read', 'rules.read', 'rules.manage', 'events.search'],
      AUDITOR: ['alerts.read', 'incidents.read', 'cases.read', 'events.search', 'events.raw.read', 'audit.read', 'integrations.read', 'platform.health.read'],
      VIEWER: ['alerts.read', 'incidents.read', 'events.search', 'integrations.read', 'platform.health.read'],
      ACCESS_ADMIN: ['platform.access.read', 'platform.access.manage', 'access.requests.create', 'audit.read'],
    };
    const roleNames: Record<AdminRole, string> = {
      PLATFORM_ADMIN: 'Platform Admin', SOC_L1: 'SOC L1', SOC_L2: 'SOC L2', SOC_MANAGER: 'SOC Manager',
      DETECTION_ENGINEER: 'Detection Engineer', AUDITOR: 'Auditor', VIEWER: 'Viewer', ACCESS_ADMIN: 'Access Admin',
    };
    return {
      ...mockSession,
      actor: { ...mockSession.actor, role, displayName: roleNames[role], capabilities: roleCapabilities[role] },
    };
  }

  public async getSession() {
    await delay();
    return this.setDemoRole(this.activeRole);
  }
  public async getOverview() {
    await delay();
    return { ...mockOverview, services: mockServices };
  }
  public async getAlerts() {
    await delay();
    return page(this.alerts);
  }
  public async getIncidents() {
    await delay();
    return page(mockIncidents);
  }
  public async getSources() {
    await delay();
    return mockSources;
  }
  public async getServices() {
    await delay();
    return mockServices;
  }
  public async getAccessRequests() {
    await delay();
    return page(this.accessRequests);
  }
  public async getAuditEvents() {
    await delay();
    return page(this.audit);
  }
  public async getNotifications() {
    await delay();
    return this.notifications;
  }

  public async submitAccessRequest(input: AccessRequestInput) {
    await delay();
    const request: AccessRequest = {
      id: `AR-${String(85 + this.accessRequests.length).padStart(4, '0')}`,
      requester: mockSession.actor.displayName,
      ...input,
      state: 'pending_second_approver',
      submittedAt: new Date().toISOString(),
    };
    this.accessRequests = [request, ...this.accessRequests];
    this.record('access.grant.requested', `request/${request.id}`, 'pending');
    return request;
  }

  public async requestReplay(input: ReplayRequestInput): Promise<OperationReceipt> {
    await delay();
    const receipt: OperationReceipt = {
      id: `RP-DEMO-${Date.now()}`,
      state: 'accepted_for_review',
      message: `Solicitud de replay registrada para ${input.sourceId}; requiere revisión operativa.`,
      mode: 'mock',
    };
    this.record('integrations.replay.requested', `source/${input.sourceId}`, 'pending');
    return receipt;
  }

  public async acknowledgeAlert(alertId: string) {
    await delay();
    const index = this.alerts.findIndex((alert) => alert.id === alertId);
    if (index < 0) throw new Error('ALERT_NOT_FOUND');
    const current = this.alerts[index];
    if (!current) throw new Error('ALERT_NOT_FOUND');
    const updated = { ...current, state: 'acknowledged' as const };
    this.alerts[index] = updated;
    this.record('alerts.acknowledged', `alert/${alertId}`, 'allowed');
    return updated;
  }

  public async retryNotification(deliveryId: string) {
    await delay();
    const index = this.notifications.findIndex((item) => item.id === deliveryId);
    if (index < 0) throw new Error('NOTIFICATION_NOT_FOUND');
    const current = this.notifications[index];
    if (!current) throw new Error('NOTIFICATION_NOT_FOUND');
    const updated: NotificationDelivery = {
      ...current,
      state: 'retrying',
      attempts: current.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    this.notifications[index] = updated;
    this.record('notifications.retry.requested', `delivery/${deliveryId}`, 'pending');
    return updated;
  }

  public async logout() {
    await delay();
  }

  private record(action: string, resource: string, outcome: AuditEventSummary['outcome']) {
    this.audit = [
      {
        id: `AU-DEMO-${Date.now()}`,
        occurredAt: new Date().toISOString(),
        actor: mockSession.actor.displayName,
        action,
        resource,
        outcome,
        correlationId: `cor-demo-${Date.now()}`,
      },
      ...this.audit,
    ];
  }
}
