/**
 * Acciones del Analista IA sobre el SOC (puerto `SocActions` de docs/27).
 *
 * Cada acción usa los casos de uso SOC existentes con la identidad de servicio
 * `svc:qapaq-ai-analyst` y un conjunto explícito de capacidades: autorización, compare-and-set,
 * auditoría append-only y outbox ocurren en la misma transacción que cualquier acción humana.
 * Nada aquí relaja una guarda: el plan (`planActions`) ya aplicó las del dominio y estas
 * comprobaciones son defensa en profundidad.
 *
 * - `escalate`: abre (o reutiliza) un incidente desde la alerta (`openIncidentFromAlert`).
 * - `acknowledge`: `executeAlertCommand('acknowledge')`; si la alerta ya no está `new`, no hace nada.
 * - `closeBenign`: reconocer → triar como `false_positive` con la nota fija → cerrar. Se niega si
 *   una persona tiene la alerta asignada, si está vinculada a un incidente o si es P1/P2.
 * - `requestReview`: `requestAlertReview` encola `soc.alert.review_requested` en el outbox; el
 *   despacho aplica ruteo, agrupación, ventanas, topes y el resumen (`digest`).
 * - `attachReport`: nota del incidente (bitácora existente) si lo hay; si no, no adjunta.
 *
 * Idempotencia por (trabajo, acción): repetir una acción tras una caída reutiliza el incidente,
 * encuentra la alerta ya cerrada/reconocida o el aviso ya encolado. Ningún texto del modelo va a
 * la auditoría: las notas son textos fijos con códigos y el id del expediente.
 */

import { randomUUID } from 'node:crypto';

import type { Actor, Capability } from '@qapaq/access';
import { recordAudit, type AuditStore } from '@qapaq/audit';
import type {
  InvestigationJob,
  InvestigationResult,
  ReviewRequest,
  SocActions,
} from '@qapaq/assistant';
import {
  addIncidentNote,
  attachAlertToIncident,
  executeAlertCommand,
  INCIDENT_WORK_LIMITS,
  openIncidentFromAlert,
  requestAlertReview,
  type Alert,
  type IncidentSeverity,
  type SocDependencies,
  type SocReadModel,
} from '@qapaq/soc';

export const ANALYST_SERVICE_ACTOR_ID = 'svc:qapaq-ai-analyst';

/**
 * Lecturas de la evidencia (el mismo alcance que Qapaqzito): sin `events.read_raw` (el documento crudo
 * nunca entra al paquete) ni `audit.read_sensitive`.
 */
export const ANALYST_SERVICE_READ_CAPABILITIES: readonly Capability[] = Object.freeze([
  'alerts.read',
  'incidents.read',
  'events.read',
  'sources.health.read',
  'notifications.read',
  'audit.read',
]);

/**
 * Conjunto explícito de la identidad de servicio: lecturas + lo mínimo para las acciones
 * permitidas. Nada de cierre de incidentes, respuesta/contención ni administración.
 */
export const ANALYST_SERVICE_CAPABILITIES: readonly Capability[] = Object.freeze([
  ...ANALYST_SERVICE_READ_CAPABILITIES,
  'alerts.triage',
  'incidents.write',
  'incidents.notes.write',
]);

export class AnalystActionError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'AnalystActionError';
  }
}

export interface AnalystActionsOptions {
  readonly tenantId: string;
  readonly soc: () => SocDependencies;
  readonly read: Pick<SocReadModel, 'alertById'> &
    Partial<Pick<SocReadModel, 'listAlerts' | 'incidentById'>>;
  /** Auditoría de la disposición de cada escalación (creado o asociado). */
  readonly audit?: Pick<AuditStore, 'head' | 'append'>;
  /** Ventana en que una escalación reutiliza un incidente abierto del mismo grupo (72 h). */
  readonly dedupeWindowMs?: number;
  /** Pide una pasada del despacho tras encolar un aviso. */
  readonly kickDispatch?: () => void;
}

const SEVERITY: Readonly<Record<string, IncidentSeverity>> = {
  P1: 'critical',
  P2: 'high',
  P3: 'medium',
  P4: 'low',
};

export function analystServiceActor(tenantId: string): Actor {
  return {
    subjectId: ANALYST_SERVICE_ACTOR_ID,
    tenantId,
    sessionId: 'service',
    capabilities: new Set(ANALYST_SERVICE_CAPABILITIES),
    roles: [],
  };
}

const correlationOf = (job: InvestigationJob) => `ai-investigation:${job.id}`;

export class RuntimeSocActions implements SocActions {
  private readonly actor: Actor;

  public constructor(private readonly options: AnalystActionsOptions) {
    this.actor = analystServiceActor(options.tenantId);
  }

  private alertIdOf(job: InvestigationJob): string {
    return job.subject.kind === 'alert' ? job.subject.id : job.alertIds[0]!;
  }

  private async load(job: InvestigationJob): Promise<Alert> {
    if (job.tenantId !== this.options.tenantId) throw new AnalystActionError('TENANT_MISMATCH');
    const alert = await this.options.read.alertById(this.options.tenantId, this.alertIdOf(job));
    if (!alert) throw new AnalystActionError('ALERT_NOT_FOUND');
    return alert;
  }

  /**
   * Incidente ABIERTO del mismo grupo (misma regla y entidad principal opaca; para el correlador,
   * el mismo patrón) abierto dentro de la ventana. Evita un incidente por cada alerta repetida.
   */
  private async openIncidentOfGroup(alert: Alert): Promise<string | undefined> {
    const read = this.options.read;
    const entityRef = alert.entityRefs.find((ref) => ref.startsWith('ent_'));
    if (!read.listAlerts || !read.incidentById || !entityRef || !alert.ruleId) return undefined;
    const since = Date.now() - (this.options.dedupeWindowMs ?? 72 * 3_600_000);
    const page = await read.listAlerts({ tenantId: this.options.tenantId, entityRef });
    const candidates = page.items
      .filter(
        (other) =>
          other.id !== alert.id &&
          other.tenantId === this.options.tenantId &&
          other.ruleId === alert.ruleId &&
          other.incidentId !== null &&
          other.createdAt.getTime() >= since,
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    for (const incidentId of new Set(candidates.map((other) => other.incidentId!))) {
      const incident = await read.incidentById(this.options.tenantId, incidentId);
      if (incident && incident.status !== 'closed' && incident.openedAt.getTime() >= since) {
        return incident.id;
      }
    }
    return undefined;
  }

  private async auditDisposition(
    job: InvestigationJob,
    alert: Alert,
    incidentId: string,
    disposition: 'created' | 'attached',
  ): Promise<void> {
    if (!this.options.audit) return;
    await recordAudit(this.options.audit, {
      id: randomUUID(),
      tenantId: this.options.tenantId,
      occurredAt: new Date(),
      actor: { id: ANALYST_SERVICE_ACTOR_ID, type: 'service' },
      action: `ai.analyst.escalation.incident_${disposition}`,
      resource: { type: 'incident', id: incidentId },
      outcome: 'succeeded',
      correlationId: correlationOf(job),
      metadata: { alertId: alert.id, investigationId: job.id, disposition, priority: alert.priority },
    });
  }

  public async escalate(
    job: InvestigationJob,
    result: InvestigationResult,
  ): Promise<{ readonly incidentId?: string; readonly disposition?: 'created' | 'attached' }> {
    let alert = await this.load(job);
    if (alert.incidentId) return { incidentId: alert.incidentId };
    if (alert.status === 'closed') throw new AnalystActionError('ALERT_CHANGED');
    // Primero un incidente abierto del mismo grupo: nunca duplicar.
    const existing = await this.openIncidentOfGroup(alert);
    if (existing) {
      const attached = await attachAlertToIncident(this.options.soc(), {
        actor: this.actor,
        alertId: alert.id,
        incidentId: existing,
        correlationId: correlationOf(job),
        expectedAlertRevision: alert.revision,
      });
      if (attached.ok) {
        await this.auditDisposition(job, alert, existing, 'attached');
        return { incidentId: existing, disposition: 'attached' };
      }
      alert = await this.load(job);
      if (alert.incidentId) return { incidentId: alert.incidentId };
      throw new AnalystActionError(attached.reason);
    }
    // Título y resumen con campos estructurados (prioridad, regla, entidad opaca), sin texto libre
    // del modelo; el expediente completo llega como nota del incidente (`attachReport`).
    const entityRef = alert.entityRefs.find((ref) => ref.startsWith('ent_')) ?? 'sin entidad';
    const rule = alert.ruleId ?? 'sin regla';
    const opened = await openIncidentFromAlert(this.options.soc(), {
      actor: this.actor,
      alertId: alert.id,
      title: `Analista IA · ${alert.priority} · regla ${rule} · ${entityRef}`.slice(0, 200),
      severity: SEVERITY[alert.priority] ?? 'high',
      summary: `Escalado por el Analista IA (${job.policyVersion}). Alerta ${alert.id} (${alert.priority}, regla ${rule}, entidad ${entityRef}). Veredicto ${result.verdict}, confianza ${result.confidence}, citas verificadas: ${result.verified ? 'sí' : 'no'}. Expediente ${job.id}. Revisa el expediente antes de actuar.`,
      correlationId: correlationOf(job),
      expectedAlertRevision: alert.revision,
    });
    if (opened.ok) {
      await this.auditDisposition(job, alert, opened.value.id, 'created');
      this.options.kickDispatch?.();
      return { incidentId: opened.value.id, disposition: 'created' };
    }
    // Otro escritor vinculó la alerta entretanto: se reutiliza su incidente.
    alert = await this.load(job);
    if (alert.incidentId) return { incidentId: alert.incidentId };
    throw new AnalystActionError(opened.reason);
  }

  public async acknowledge(job: InvestigationJob): Promise<void> {
    const alert = await this.load(job);
    if (alert.status !== 'new') return;
    const done = await executeAlertCommand(this.options.soc(), {
      actor: this.actor,
      alertId: alert.id,
      correlationId: correlationOf(job),
      command: { name: 'acknowledge', expectedRevision: alert.revision },
    });
    if (!done.ok && (await this.load(job)).status === 'new') {
      throw new AnalystActionError(done.reason);
    }
  }

  public async closeBenign(job: InvestigationJob, note: string): Promise<void> {
    let alert = await this.load(job);
    if (alert.status === 'closed') return;
    // Defensa en profundidad sobre las guardas del dominio.
    if (alert.priority === 'P1' || alert.priority === 'P2') {
      throw new AnalystActionError('PRIORITY_NOT_ALLOWED');
    }
    if (alert.incidentId) throw new AnalystActionError('ALERT_LINKED');
    if (alert.assigneeId && alert.assigneeId !== ANALYST_SERVICE_ACTOR_ID) {
      throw new AnalystActionError('ALREADY_HANDLED');
    }
    if (alert.verdict !== null && alert.verdict !== 'false_positive') {
      throw new AnalystActionError('ALERT_CHANGED');
    }
    const step = async (command: Parameters<typeof executeAlertCommand>[1]['command']) => {
      const outcome = await executeAlertCommand(this.options.soc(), {
        actor: this.actor,
        alertId: alert.id,
        correlationId: correlationOf(job),
        command,
      });
      if (!outcome.ok) throw new AnalystActionError(outcome.reason);
      alert = outcome.value;
    };
    if (alert.status === 'new') {
      await step({ name: 'acknowledge', expectedRevision: alert.revision });
    }
    if (alert.status === 'acknowledged') {
      if (alert.assigneeId !== ANALYST_SERVICE_ACTOR_ID) {
        throw new AnalystActionError('ALREADY_HANDLED');
      }
      await step({
        name: 'triage',
        verdict: 'false_positive',
        note,
        expectedRevision: alert.revision,
      });
    }
    if (alert.status === 'triaged' && alert.verdict === 'false_positive') {
      await step({ name: 'close', note, expectedRevision: alert.revision });
      return;
    }
    throw new AnalystActionError('ALERT_CHANGED');
  }

  public async requestReview(
    job: InvestigationJob,
    _result: InvestigationResult | null,
    review: ReviewRequest,
  ): Promise<{ readonly notificationId?: string }> {
    if (job.tenantId !== this.options.tenantId) throw new AnalystActionError('TENANT_MISMATCH');
    const outcome = await requestAlertReview(this.options.soc(), {
      actor: this.actor,
      alertId: this.alertIdOf(job),
      correlationId: correlationOf(job),
      investigationId: job.id,
      urgency: review.urgency,
      groupKey: review.groupKey.replace(/[^A-Za-z0-9_:|.-]/gu, '_').slice(0, 200) || `job:${job.id}`,
      reason: review.reason,
    });
    if (!outcome.ok) throw new AnalystActionError(outcome.reason);
    if (outcome.value.enqueued) this.options.kickDispatch?.();
    return { notificationId: outcome.value.idempotencyKey };
  }

  public async attachReport(
    job: InvestigationJob,
    report: { readonly filename: string; readonly markdown: string },
  ): Promise<{ readonly reportId?: string }> {
    const alert = await this.load(job);
    // Sin incidente no hay bitácora donde adjuntar: el informe queda en el expediente.
    if (!alert.incidentId) return {};
    const footer = `\n\n_Informe completo: expediente ${job.id} en el Analista IA._`;
    const max = INCIDENT_WORK_LIMITS.noteMax - footer.length;
    const body =
      report.markdown.length > max
        ? `${report.markdown.slice(0, max - 2)}…${footer}`
        : `${report.markdown}${footer}`;
    const added = await addIncidentNote(this.options.soc(), {
      actor: this.actor,
      incidentId: alert.incidentId,
      correlationId: correlationOf(job),
      body,
    });
    if (!added.ok) throw new AnalystActionError(added.reason);
    return { reportId: added.value.id };
  }
}
