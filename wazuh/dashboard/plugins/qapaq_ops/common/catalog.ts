/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type {
  AlertStatus,
  AlertVerdict,
  ApiErrorCode,
  IncidentSeverity,
  IncidentStatus,
  NotificationChannel,
  NotificationStatus,
  OperationsStatus,
  Priority,
  SessionState,
  SourceState,
  TaskStatus,
} from './api_contract';

/**
 * Catálogo de rótulos (doc 01 §3 de qapaq-secops). El valor crudo del backend solo se
 * muestra en mono en vistas técnicas; el resto de la UI usa estos textos.
 */

export const ALERT_STATUS_LABEL: Record<AlertStatus, string> = {
  new: 'Nueva',
  acknowledged: 'Reconocida',
  triaged: 'Triada',
  escalated: 'Escalada',
  closed: 'Cerrada',
};

export const VERDICT_LABEL: Record<AlertVerdict, string> = {
  true_positive: 'Verdadero positivo',
  false_positive: 'Falso positivo',
  benign: 'Benigna',
  duplicate: 'Duplicada',
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  open: 'Abierto',
  contained: 'Contenido',
  eradicated: 'Erradicado',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: 'Pendiente',
  in_progress: 'En curso',
  done: 'Hecha',
  cancelled: 'Cancelada',
};

export const SOURCE_STATE_LABEL: Record<SourceState, string> = {
  unknown: 'Sin dato',
  healthy: 'Operativa',
  degraded: 'Degradada',
  failed: 'Caída',
  disabled: 'Desactivada',
};

export const SOURCE_REASON_LABEL: Record<string, string> = {
  DISABLED: 'Fuente desactivada por configuración',
  NO_OBSERVATIONS: 'Todavía no hay intentos registrados',
  PERMANENT_ERROR: 'Error permanente del proveedor',
  NO_RECENT_SUCCESS: 'Sin lecturas correctas recientes',
  CONSECUTIVE_FAILURES: 'Fallos consecutivos',
  NEVER_SUCCEEDED: 'Nunca ha completado una lectura',
  RECENT_SUCCESS: 'Lectura correcta reciente',
};

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  active: 'Activa',
  expired: 'Expirada',
  revoked: 'Revocada',
  superseded: 'Reemplazada',
};

export const ROLE_LABEL: Record<string, string> = {
  'qapaq.soc.analyst': 'Analista SOC',
  'qapaq.soc.lead': 'Líder SOC',
  'qapaq.auditor': 'Auditor',
  'qapaq.platform.admin': 'Administrador de plataforma',
};

export const AUDIT_VIOLATION_LABEL: Record<string, string> = {
  TAMPERED: 'Evento alterado',
  FORKED: 'Cadena bifurcada',
  GAP: 'Hueco en la secuencia',
  OUT_OF_ORDER: 'Secuencia fuera de orden',
};

/** Mensajes públicos del catálogo de errores (packages/contracts de qapaq-secops). */
export const API_ERROR_MESSAGE: Record<ApiErrorCode, string> = {
  AUTH_REQUIRED: 'Inicie sesión para continuar.',
  AUTH_FAILED: 'No fue posible iniciar sesión con esas credenciales.',
  SESSION_EXPIRED: 'Su sesión terminó. Vuelva a iniciar sesión.',
  PASSKEY_REQUIRED: 'Fuera de la red QAPAQ se requiere una passkey registrada.',
  NETWORK_NOT_ALLOWED: 'No fue posible verificar el origen de la conexión.',
  REQUEST_NOT_VERIFIED:
    'No fue posible verificar la solicitud. Recargue la página e intente de nuevo.',
  RATE_LIMITED: 'Demasiados intentos. Vuelva a intentarlo más tarde.',
  RESOURCE_UNAVAILABLE: 'El recurso solicitado no está disponible para su cuenta.',
  STATE_CONFLICT: 'El elemento cambió mientras trabajaba en él. Vuelva a cargarlo.',
  VALIDATION_FAILED: 'Revise los datos ingresados y vuelva a enviarlos.',
  DEPENDENCY_DEGRADED: 'El servicio está degradado. Algunos datos pueden no estar actualizados.',
  INTERNAL_ERROR: 'Ocurrió un problema inesperado. El equipo ya fue notificado.',
};

/**
 * Severidad por forma + color + rótulo (doc 02 §2.5). P1 y `critical` comparten paso.
 * El glifo distingue el paso en escala de grises y daltonismo.
 */
export interface SeverityStep {
  readonly glyph: string;
  readonly color: string;
  readonly step: 1 | 2 | 3 | 4;
}

export const PRIORITY_STEP: Record<Priority, SeverityStep> = {
  P1: { glyph: '◆', color: '#ff5f57', step: 1 },
  P2: { glyph: '▲', color: '#f0904a', step: 2 },
  P3: { glyph: '■', color: '#d8c35c', step: 3 },
  P4: { glyph: '●', color: '#7f95aa', step: 4 },
};

export const SEVERITY_STEP: Record<IncidentSeverity, SeverityStep> = {
  critical: PRIORITY_STEP.P1,
  high: PRIORITY_STEP.P2,
  medium: PRIORITY_STEP.P3,
  low: PRIORITY_STEP.P4,
};

export type HealthTone = 'ok' | 'warn' | 'fail' | 'neutral' | 'info';

export const HEALTH_TONE: Record<HealthTone, { readonly glyph: string; readonly color: string }> = {
  ok: { glyph: '✓', color: '#5fb98a' },
  warn: { glyph: '!', color: '#d8c35c' },
  fail: { glyph: '×', color: '#ff5f57' },
  neutral: { glyph: '–', color: '#8f8f95' },
  info: { glyph: 'i', color: '#8fb3d9' },
};

export const SOURCE_TONE: Record<SourceState, HealthTone> = {
  unknown: 'neutral',
  healthy: 'ok',
  degraded: 'warn',
  failed: 'fail',
  disabled: 'neutral',
};

/** Entregado ≠ reconocido por una persona (patrón PagerDuty, doc 04 §6.1). */
export const NOTIFICATION_STATUS_LABEL: Record<NotificationStatus, string> = {
  pending: 'Pendiente',
  sending: 'Enviando',
  sent: 'Sin acuse',
  indeterminate: 'Entrega incierta',
  failed: 'Fallida',
  fallback: 'Por canal alternativo',
  acknowledged: 'Reconocida',
};

export const NOTIFICATION_TONE: Record<NotificationStatus, HealthTone> = {
  pending: 'neutral',
  sending: 'info',
  sent: 'warn',
  indeterminate: 'warn',
  failed: 'fail',
  fallback: 'warn',
  acknowledged: 'ok',
};

export const NOTIFICATION_CHANNEL_LABEL: Record<NotificationChannel, string> = {
  teams: 'Microsoft Teams',
  fallback_email: 'Correo (alternativo)',
  manual_console: 'Consola',
};

export const OPERATIONS_STATUS_LABEL: Record<OperationsStatus, string> = {
  OK: 'Operativo',
  NO_DATA: 'Sin dato',
  STALE: 'Desactualizado',
  DEGRADED: 'Degradado',
};

export const OPERATIONS_TONE: Record<OperationsStatus, HealthTone> = {
  OK: 'ok',
  NO_DATA: 'neutral',
  STALE: 'warn',
  DEGRADED: 'warn',
};

export const DEGRADED_REASON_LABEL: Record<string, string> = {
  DISPATCHER_STOPPED: 'El despachador de notificaciones está detenido',
  OUTBOX_BACKLOG: 'Hay notificaciones pendientes desde hace más de 5 min',
  PERSISTENCE_EPHEMERAL: 'La persistencia es en memoria (no durable)',
  NOTIFICATION_FAILED: 'Hubo notificaciones fallidas en la ventana',
  NOTIFICATION_INDETERMINATE: 'Hubo notificaciones con entrega incierta',
  NOTIFICATION_FALLBACK: 'Hubo notificaciones por el canal alternativo',
  DATABASE_UNAVAILABLE: 'La base de datos no respondió',
  DATABASE_SLOW: 'La base de datos responde lento (> 1 s)',
};
