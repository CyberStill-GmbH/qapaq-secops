/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contrato de la API de QAPAQ SecOps tal como la proyecta el BFF (qapaq-secops,
 * `apps/api/src/soc/*.controller.ts`). Sin sobre `{data}`: cada respuesta es plana e incluye
 * `correlationId`. La autorización vive en el backend; la UI solo omite lo que no aplica.
 */

export const ALERT_STATUSES = ['new', 'acknowledged', 'triaged', 'escalated', 'closed'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_VERDICTS = ['true_positive', 'false_positive', 'benign', 'duplicate'] as const;
export type AlertVerdict = (typeof ALERT_VERDICTS)[number];

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type AlertCommandName =
  'acknowledge' | 'assign' | 'triage' | 'escalate' | 'close' | 'reopen';

export interface AlertEntity {
  readonly ref: string | null;
  readonly kind: string;
  readonly label: string;
}

export interface Alert {
  readonly id: string;
  readonly title: string;
  readonly priority: Priority;
  readonly score: number;
  readonly status: AlertStatus;
  readonly assigneeId: string | null;
  readonly verdict: AlertVerdict | null;
  readonly incidentId: string | null;
  readonly occurredAt: string;
  readonly revision: number;
  readonly reasons: ReadonlyArray<{ readonly code: string; readonly detail: string }>;
  readonly entities: readonly AlertEntity[];
  readonly signal?: unknown;
  readonly relatedAlertIds?: readonly string[];
  readonly rawRef?: string;
}

export const INCIDENT_STATUSES = ['open', 'contained', 'eradicated', 'resolved', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export type IncidentCommandName =
  'contain' | 'eradicate' | 'resolve' | 'close' | 'reopen' | 'reassign';

export interface Incident {
  readonly id: string;
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly ownerId: string | null;
  readonly alertIds: readonly string[];
  readonly summary: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly revision: number;
}

export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskCommandName = 'start' | 'complete' | 'reopen' | 'cancel' | 'assign';

export interface IncidentTask {
  readonly id: string;
  readonly incidentId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly required: boolean;
  readonly assigneeId: string | null;
  readonly dueAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly cancellationReason: string | null;
  readonly revision: number;
}

export interface IncidentNote {
  readonly id: string;
  readonly incidentId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly correctsNoteId: string | null;
}

export type TimelineKind =
  | 'incident.opened'
  | 'incident.transition'
  | 'incident.closed'
  | 'alert.linked'
  | 'task.created'
  | 'task.completed'
  | 'task.cancelled'
  | 'note.added';

export interface TimelineEntry {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly at: string;
  readonly timeSource: 'provider' | 'recorded';
  readonly recordedAt?: string;
  readonly actorId: string | null;
  readonly summary: string;
  readonly ref: { readonly type: string; readonly id: string };
}

export interface Timeline {
  readonly transitions: 'included' | 'partial' | 'requires_audit_read';
  readonly items: readonly TimelineEntry[];
  readonly nextCursor: string | null;
}

export const SOURCE_STATES = ['unknown', 'healthy', 'degraded', 'failed', 'disabled'] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

export interface SourceHealth {
  readonly sourceId: string;
  readonly dataset: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly state: SourceState;
  readonly reason: string;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastEventAt: string | null;
  readonly consecutiveFailures: number;
  readonly lastErrorClass: string | null;
  readonly policy: {
    readonly intervalMs: number;
    readonly degradeAfterMs: number;
    readonly failAfterMs: number;
  };
  readonly subscriptions: {
    readonly measuredAt: string;
    readonly windowHours: number;
    readonly items: ReadonlyArray<{
      readonly stream: string;
      readonly lastEventAt: string | null;
      readonly eventsInWindow: number;
    }>;
  } | null;
  readonly transitions: ReadonlyArray<{
    readonly id: string;
    readonly fromState: SourceState;
    readonly toState: SourceState;
    readonly reason: string;
    readonly at: string;
  }>;
}

export type AuditOutcome = 'allowed' | 'denied' | 'succeeded' | 'failed';

export interface AuditEvent {
  readonly id: string;
  readonly sequence: string;
  readonly occurredAt: string;
  readonly actor: {
    readonly id: string;
    readonly type: string;
    readonly sessionId?: string;
    readonly ip?: string;
  };
  readonly action: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly outcome: AuditOutcome;
  readonly correlationId: string;
  readonly reason?: string;
  readonly hash: string;
  readonly previousHash: string;
}

export interface AuditVerification {
  readonly ok: boolean;
  readonly checked: number;
  readonly headSequence: string;
  readonly violations: ReadonlyArray<{
    readonly code: 'TAMPERED' | 'FORKED' | 'GAP' | 'OUT_OF_ORDER';
    readonly sequence: string;
    readonly detail: string;
  }>;
}

export const SESSION_STATES = ['active', 'expired', 'revoked', 'superseded'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface AdminSession {
  readonly ref: string;
  readonly current: boolean;
  readonly subjectId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly state: SessionState;
  readonly roles: readonly string[];
  readonly amr: readonly string[];
  readonly clientIp: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly revision: number;
}

/** Origen del rol (apps/api/src/runtime/role-grants.ts). */
export type RoleOrigin =
  'group_owner' | 'admin_group' | 'qapaq_assignment' | 'deploy_binding' | 'entra_app_role' | 'none';

export type RequestableRole =
  'qapaq.auditor' | 'qapaq.platform.admin' | 'qapaq.soc.analyst' | 'qapaq.soc.lead';
export type RoleRequestAction = 'grant' | 'revoke';
export type RoleRequestStatus =
  'pending_access' | 'pending_security' | 'approved' | 'rejected' | 'cancelled';

export interface RoleGrantView {
  readonly correlationId: string;
  readonly oid: string;
  readonly eligible: boolean;
  readonly grant: {
    readonly roles: readonly RequestableRole[];
    readonly revision: number;
    readonly updatedAt: string | null;
    readonly updatedBy: string | null;
  };
  readonly deployRoles: readonly string[];
  readonly groupOwnerRoles: readonly string[];
  readonly assignableRoles: readonly RequestableRole[];
}

export interface RoleRequestView {
  readonly id: string;
  readonly targetOid: string;
  readonly action: RoleRequestAction;
  readonly role: RequestableRole;
  readonly reason: string;
  readonly ticket: string | null;
  readonly status: RoleRequestStatus;
  readonly approvalStage: 'access' | 'security' | null;
  readonly requesterOid: string;
  readonly priorApproverOid: string | null;
  readonly securityApproverOid: string | null;
  readonly closure: { readonly at: string; readonly reason: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface RoleRequestPage {
  readonly correlationId: string;
  readonly items: readonly RoleRequestView[];
  readonly nextCursor: string | null;
}

export type RoleRequestListResponse = RoleRequestPage;

export interface DirectoryUser {
  readonly oid: string;
  readonly displayName: string | null;
  readonly upn: string | null;
  readonly accountEnabled: boolean | null;
  readonly membership: 'member' | 'removed' | null;
  readonly isOwner: boolean;
  readonly roles: readonly string[];
  readonly roleOrigin: RoleOrigin | string;
  readonly lastSeenAt: string | null;
  readonly activeSessions: number;
}

/** `GET /api/admin/users/:oid`. */
export interface DirectoryUserDetail {
  readonly user: DirectoryUser;
  readonly sessions: ReadonlyArray<{
    readonly ref: string;
    readonly current: boolean;
    readonly state: SessionState;
    readonly createdAt: string;
    readonly lastSeenAt: string;
    readonly revocationReason: string | null;
    readonly amr: readonly string[];
    readonly revision: number;
  }>;
}

export interface DirectorySync {
  /** `disabled`: sin Graph; solo se listan dueños y asignaciones del despliegue. */
  readonly mode: 'graph' | 'disabled' | string;
  readonly status: 'never' | 'ok' | 'failed' | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorClass: string | null;
  readonly stale: boolean;
}

export interface SessionInfo {
  readonly subjectId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly capabilities: readonly string[];
  readonly amr: readonly string[];
  readonly csrfToken: string;
  readonly correlationId: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly totalCount?: number;
}

export const NOTIFICATION_STATUSES = [
  'pending',
  'sending',
  'sent',
  'indeterminate',
  'failed',
  'fallback',
  'acknowledged',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export type NotificationChannel = 'teams' | 'fallback_email' | 'manual_console';

/** Estados en los que una persona puede acusar recibo (modules/soar/src/notification.ts). */
export const ACKNOWLEDGEABLE: readonly NotificationStatus[] = ['sent', 'indeterminate', 'fallback'];

export interface NotificationAttempt {
  readonly id: string;
  readonly status: NotificationStatus;
  readonly channel: NotificationChannel;
  readonly attemptCount: number;
  readonly sentAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly lastFailureClass: string | null;
}

/** `GET /api/changes`: qué cambió (tipo, id), nunca el contenido. */
export interface ChangeEvent {
  readonly seq: string;
  readonly resource: { readonly type: string; readonly id: string };
  readonly kind: 'created' | 'updated';
  readonly at: string;
}

export interface ChangesResponse {
  readonly cursor: string;
  readonly changes: readonly ChangeEvent[];
  readonly resync: boolean;
}

export type OperationsStatus = 'OK' | 'NO_DATA' | 'STALE' | 'DEGRADED';

export interface OperationsHealth {
  readonly generatedAt: string;
  readonly status: OperationsStatus;
  readonly sections: {
    readonly summary: {
      readonly status: OperationsStatus;
      readonly lastAlertAt: string | null;
      readonly alertFreshnessSeconds: number | null;
      readonly sourceCoverage: string;
    };
    readonly soc?: {
      readonly status: OperationsStatus;
      readonly degradedReasons: readonly string[];
      readonly persistence: 'memory' | 'postgres';
      readonly dispatcherRunning: boolean;
      readonly outbox: {
        readonly pending: number;
        readonly processing: number;
        readonly oldestPendingAgeSeconds: number | null;
      };
      readonly notifications: {
        readonly windowHours: number;
        readonly byStatus: Readonly<Record<string, number>>;
      };
    };
    readonly platform?: {
      readonly status: OperationsStatus;
      readonly degradedReasons: readonly string[];
      readonly uptimeSeconds: number | null;
      readonly memoryRssMb: number | null;
      readonly databaseLatencyMs: number | null;
      readonly nodeVersion: string | null;
    };
  };
}

export interface LinkedAlerts {
  readonly incidentId: string;
  readonly items: readonly Alert[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly unavailableCount: number;
  readonly truncated: boolean;
}

export const API_ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'SESSION_EXPIRED',
  'PASSKEY_REQUIRED',
  'STEP_UP_REQUIRED',
  'NETWORK_NOT_ALLOWED',
  'REQUEST_NOT_VERIFIED',
  'RATE_LIMITED',
  'RESOURCE_UNAVAILABLE',
  'STATE_CONFLICT',
  'VALIDATION_FAILED',
  'DEPENDENCY_DEGRADED',
  'INTEGRATION_NOT_CONFIGURED',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Reputación de archivos por hash (`POST /api/alerts/:id/enrichment/virustotal`), contrato 1.0.0
 * de `packages/contracts/src/enrichment`. El BFF elige el hash entre los que trae la alerta.
 */
export const FILE_HASH_KINDS = ['sha256', 'sha1', 'md5'] as const;
export type FileHashKind = (typeof FILE_HASH_KINDS)[number];

export interface FileReputationEnrichment {
  readonly correlationId: string;
  readonly alertId: string;
  readonly hash: { readonly algorithm: FileHashKind; readonly value: string };
  readonly status: 'found' | 'unknown';
  readonly reputation: {
    readonly detections: number;
    readonly engines: number;
    readonly firstSeenAt: string | null;
    readonly lastAnalysisAt: string | null;
    readonly threatLabels: readonly string[];
    readonly reportUrl: string;
  } | null;
  readonly cached: boolean;
  readonly checkedAt: string;
  readonly cacheTtlHours: number;
  readonly quota: {
    readonly minute: { readonly limit: number; readonly remaining: number };
    readonly day: { readonly limit: number; readonly remaining: number; readonly resetsAt: string };
  };
}

/** Entidades de hash de la alerta, en orden de preferencia (el BFF consulta la primera). */
export function fileHashEntities(entities: readonly AlertEntity[]): readonly AlertEntity[] {
  return FILE_HASH_KINDS.flatMap((kind) => entities.filter((entity) => entity.kind === kind));
}

/** Cuerpo de error del catálogo (plano, sin envoltorio). */
export interface ApiErrorBody {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly action: string;
  readonly helpRef: string;
  readonly retriable: boolean;
  readonly correlationId: string;
  readonly fields?: readonly string[];
}

/** Capacidades que la UI consulta para decidir qué acciones renderizar (no autoriza). */
export const CAPABILITIES = {
  alertsRead: 'alerts.read',
  alertsTriage: 'alerts.triage',
  alertsAssign: 'alerts.assign',
  incidentsRead: 'incidents.read',
  incidentsWrite: 'incidents.write',
  incidentsClose: 'incidents.close',
  tasksWrite: 'incidents.tasks.write',
  notesWrite: 'incidents.notes.write',
  sourcesRead: 'sources.health.read',
  auditRead: 'audit.read',
  auditVerify: 'audit.verify',
  usersRead: 'users.read',
  rolesRequest: 'roles.request',
  rolesApprove: 'roles.approve',
  rolesApprovePrivileged: 'roles.approve.privileged',
  sessionsRead: 'sessions.read',
  sessionsRevoke: 'sessions.revoke',
  notificationsRead: 'notifications.read',
  enrichmentVirusTotal: 'enrichment.virustotal',
  observabilitySoc: 'observability.read_soc',
  observabilityPlatform: 'observability.read_platform',
} as const;
