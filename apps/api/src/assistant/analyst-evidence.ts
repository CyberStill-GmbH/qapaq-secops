/**
 * Lector de evidencia del Analista IA (puerto `EvidenceReader` de docs/27).
 *
 * Reúne de forma determinista, sin cookie humana y sin llamadas a modelos, el mismo alcance que
 * Qapaqzito consulta por herramientas: alerta y regla (MITRE, runbook, falsos positivos conocidos),
 * relacionadas, historial de 30 días de la misma regla y entidad, incidentes abiertos de la entidad
 * (conteos y títulos, nunca notas), candidato y riesgo de la entidad del correlador, eventos de
 * origen ±15 min y actividad de la entidad (alertas 7 d / eventos 24 h) con el lector del servidor,
 * salud de cada fuente involucrada, estado de los avisos de la alerta y auditoría reciente sobre la
 * alerta o su incidente. Todo va después en UNA sola llamada al modelo. Reglas:
 *
 * - Toda lectura usa el tenant del runtime; una alerta de otro tenant no existe para el lector.
 * - Lecturas acotadas: relacionadas ≤ 20, historial ≤ el tope del adapter (si el total supera lo
 *   leído se marca `truncated`), una consulta al correlador.
 * - Completitud honesta: una lectura que falla deja `complete: false` y su vacío; una lectura que
 *   no existe en el servidor (muestra de eventos por entidad) se declara como vacío informativo.
 * - Solo referencias opacas `ent_…` salen del API; nunca claves `user:`/`ip:`.
 */

import { createHash } from 'node:crypto';

import type {
  EvidenceAlert,
  EvidenceBundle,
  EvidenceCandidate,
  EvidenceHistory,
  EvidenceReader,
  EvidenceSourceHealth,
  InvestigationJob,
  InvestigationPriority,
} from '@qapaq/assistant';
import type { AuditStore } from '@qapaq/audit';
import type {
  EvidenceActivity,
  EvidenceAuditAction,
  EvidenceContext,
  EvidenceEntityRisk,
  EvidenceEvent,
  EvidenceEventSummary,
  EvidenceIncident,
  EvidenceSubject,
  EvidenceNotification,
  EvidenceRule,
} from '@qapaq/assistant';
import type { Alert, SocReadModel } from '@qapaq/soc';
import { maskText, type AttemptStore } from '@qapaq/soar';
import type { SecurityEvent } from '@qapaq/contracts';
import type { JsonObject } from '@qapaq/connectors';

import type { EventsReader } from '../runtime/events-reader.js';
import { providerOf } from './investigation-tools.js';
import { subjectFromRaw } from './analyst-subject.js';
import { ruleForAlert, ruleView, type SocKnowledge } from './soc-knowledge.js';

/**
 * Alcance de la recolección. Ya no son muestras: cada lectura pagina hasta agotar su alcance
 * declarado. Los topes de abajo son solo de seguridad (un trabajo patológico no puede leer sin
 * fin); si se alcanzan, el vacío se nombra y la investigación es honestamente parcial.
 * Lo que va al MODELO es otra cosa: `evidence-pack` elige una muestra y siempre adjunta los
 * agregados completos (`eventSummary`).
 */
export const EVIDENCE_LIMITS = Object.freeze({
  maxJobAlerts: 500,
  maxRelatedAlerts: 200,
  historyDays: 30,
  correlatorCandidates: 500,
  maxIncidents: 25,
  sourceWindowMs: 30 * 60_000,
  activityAlertDays: 7,
  /** Página del proveedor (su máximo). */
  eventPageSize: 200,
  /** Tope de seguridad por lectura de eventos (dirigida por entidad): 50 000 eventos. */
  maxEventPages: 250,
  /** Sin entidad la ventana es un barrido del tenant: tope menor. */
  maxUnscopedEventPages: 50,
  /** Eventos de la entidad conservados en el expediente (el resto queda en los agregados). */
  maxStoredEvents: 300,
  notificationScan: 1_000,
  auditActions: 50,
  /** Eventos sin normalizar tolerados antes de considerar la evidencia incompleta. */
  unparsedTolerance: 5,
});

/** Proveedores que pueden originar una alerta; los no medidos se nombran como vacío. */
const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  wazuh: 'Wazuh',
  m365: 'Microsoft 365 / Entra / SharePoint',
  aws: 'AWS',
  cloudflare: 'Cloudflare',
  bitdefender: 'Bitdefender GravityZone',
  snyk: 'Snyk',
};

export interface AnalystEvidenceSources {
  readonly tenantId: string;
  readonly soc: Pick<SocReadModel, 'alertById' | 'listAlerts'> &
    Partial<
      Pick<
        SocReadModel,
        'incidentById' | 'listIncidentTasks' | 'listIncidentNotes' | 'alertStats'
      >
    >;
  /** Conocimiento SOC versionado (reglas, MITRE, runbooks). */
  readonly knowledge?: SocKnowledge;
  /** Lector de eventos del servidor (el del explorador y de Qapaqzito); ausente si no hay ingesta. */
  readonly events?: EventsReader;
  /** Auditoría append-only (solo lectura de acciones recientes). */
  readonly audit?: Pick<AuditStore, 'read'>;
  /** Intentos de notificación (estado de los avisos de la alerta). */
  readonly notifications?: Pick<AttemptStore, 'listByTenant'>;
  /** GET al correlador privado (`/v1/...`); ausente si no está configurado. */
  readonly correlator?: (pathWithQuery: string) => Promise<{ status: number; body: unknown }>;
  /** Salud de fuentes del tenant; ausente si el despliegue no la mide. */
  readonly sourceHealth?: () => Promise<readonly EvidenceSourceHealth[]>;
  readonly now: () => Date;
}

const ENTITY_REF = /^ent_[A-Za-z0-9_-]{4,128}$/u;
const PRIORITIES: readonly InvestigationPriority[] = ['P1', 'P2', 'P3', 'P4'];

function abortIf(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('EVIDENCE_ABORTED');
}

export function toEvidenceAlert(alert: Alert): EvidenceAlert {
  return {
    id: alert.id,
    title: alert.title,
    priority: PRIORITIES.includes(alert.priority as InvestigationPriority)
      ? (alert.priority as InvestigationPriority)
      : 'P4',
    status: alert.status,
    ruleId: alert.ruleId,
    signal: alert.signal,
    score: alert.score,
    reasonCodes: alert.reasons.map((reason) => reason.code),
    occurredAt: alert.occurredAt.toISOString(),
    // Solo referencias opacas; las claves internas nunca salen del API.
    entityRefs: alert.entityRefs.filter((ref) => ENTITY_REF.test(ref)),
    verdict: alert.verdict,
    relatedAlertIds: alert.relatedAlertIds,
    incidentId: alert.incidentId,
    source: providerOf(alert.title),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, max)
    : [];
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class RuntimeEvidenceReader implements EvidenceReader {
  public constructor(private readonly sources: AnalystEvidenceSources) {}

  public async collect(job: InvestigationJob, signal: AbortSignal): Promise<EvidenceBundle> {
    const { tenantId, soc } = this.sources;
    // Un trabajo de otro tenant no se lee (defensa en profundidad: el store ya filtra).
    if (job.tenantId !== tenantId) throw new Error('EVIDENCE_TENANT_MISMATCH');
    const gaps: string[] = [];
    let complete = true;
    let truncated = false;
    let alertsScanned = 0;

    // ── Alertas del trabajo ────────────────────────────────────────────────────────────────
    const alerts: Alert[] = [];
    for (const alertId of job.alertIds.slice(0, EVIDENCE_LIMITS.maxJobAlerts)) {
      abortIf(signal);
      const alert = await soc.alertById(tenantId, alertId);
      alertsScanned += 1;
      if (alert && alert.tenantId === tenantId) alerts.push(alert);
      else {
        complete = false;
        gaps.push(`Alerta ${alertId.slice(0, 64)} no disponible`);
      }
    }
    if (job.alertIds.length > EVIDENCE_LIMITS.maxJobAlerts) {
      truncated = true;
      gaps.push(
        `Se leyeron ${EVIDENCE_LIMITS.maxJobAlerts} de ${job.alertIds.length} alertas del trabajo`,
      );
    }
    const primary = alerts[0];

    // ── Relacionadas (correlación de C-16) ─────────────────────────────────────────────────
    const ownIds = new Set(alerts.map((alert) => alert.id));
    const relatedIds = [
      ...new Set(alerts.flatMap((alert) => alert.relatedAlertIds).filter((id) => !ownIds.has(id))),
    ];
    if (relatedIds.length > EVIDENCE_LIMITS.maxRelatedAlerts) {
      truncated = true;
      gaps.push(
        `Se leyeron ${EVIDENCE_LIMITS.maxRelatedAlerts} de ${relatedIds.length} alertas relacionadas`,
      );
    }
    const relatedAlerts: Alert[] = [];
    for (const relatedId of relatedIds.slice(0, EVIDENCE_LIMITS.maxRelatedAlerts)) {
      abortIf(signal);
      const related = await soc.alertById(tenantId, relatedId);
      alertsScanned += 1;
      if (related && related.tenantId === tenantId) relatedAlerts.push(related);
      else {
        complete = false;
        gaps.push(`Alerta relacionada ${relatedId.slice(0, 64)} no disponible`);
      }
    }

    // ── Historial: misma regla y entidad, 30 días ──────────────────────────────────────────
    let history: EvidenceHistory = { total: 0, falsePositive: 0, truePositive: 0, open: 0 };
    const entityRef = primary?.entityRefs.find((ref) => ENTITY_REF.test(ref));
    if (primary && entityRef && primary.ruleId) {
      abortIf(signal);
      const since = this.sources.now().getTime() - EVIDENCE_LIMITS.historyDays * 86_400_000;
      try {
        if (soc.alertStats) {
          // Conteo exacto en la base: sin tope de filas, el historial nunca queda truncado.
          const stats = await soc.alertStats({
            tenantId,
            entityRef,
            ruleId: primary.ruleId,
            since: new Date(since),
            excludeIds: [...ownIds],
          });
          alertsScanned += stats.total;
          history = {
            total: stats.total,
            // Estricto: solo cierres con veredicto «falso positivo» cuentan como benignos.
            falsePositive: stats.falsePositive,
            truePositive: stats.truePositive,
            open: stats.open,
          };
        } else {
          const result = await soc.listAlerts({ tenantId, entityRef });
          alertsScanned += result.items.length;
          if (result.total > result.items.length) {
            // No se vio todo el historial: podría haber verdaderos positivos sin contar.
            truncated = true;
            gaps.push(
              `Historial truncado: ${result.items.length} de ${result.total} alertas de la entidad`,
            );
          }
          const same = result.items.filter(
            (alert) =>
              alert.tenantId === tenantId &&
              !ownIds.has(alert.id) &&
              alert.ruleId === primary.ruleId &&
              alert.createdAt.getTime() >= since,
          );
          history = {
            total: same.length,
            falsePositive: same.filter((alert) => alert.verdict === 'false_positive').length,
            truePositive: same.filter((alert) => alert.verdict === 'true_positive').length,
            open: same.filter((alert) => alert.status !== 'closed').length,
          };
        }
      } catch {
        complete = false;
        gaps.push('Historial de la regla y entidad no disponible');
      }
    } else if (primary) {
      gaps.push('Sin regla o referencia de entidad: historial de 30 días no evaluado');
    }

    // ── Correlador (solo alertas que nacieron de él) ──────────────────────────────────────
    let candidate: EvidenceCandidate | null = null;
    if (primary?.ruleId?.startsWith('qapaq-correlator:')) {
      abortIf(signal);
      if (!this.sources.correlator) {
        gaps.push('Correlador no configurado: sin detalle del candidato');
      } else {
        try {
          const response = await this.sources.correlator(
            `/v1/candidates?limit=${EVIDENCE_LIMITS.correlatorCandidates}`,
          );
          if (response.status !== 200) throw new Error('CORRELATOR_UNAVAILABLE');
          const items = Array.isArray(record(response.body)['items'])
            ? (record(response.body)['items'] as unknown[])
            : [];
          const match = items
            .map(record)
            .find(
              (item) =>
                item['alertId'] === primary.id ||
                strings(item['qapaqAlertIds'], 200).includes(primary.id),
            );
          if (match) {
            const explanation = record(match['explanation']);
            const label =
              typeof explanation['patternTitle'] === 'string'
                ? explanation['patternTitle']
                : typeof match['title'] === 'string'
                  ? match['title']
                  : '';
            candidate = {
              id: String(match['id'] ?? '').slice(0, 128),
              patternId: String(match['patternId'] ?? '').slice(0, 100),
              score: finite(match['score']),
              riskScore: finite(match['riskScore']),
              memberCount: finite(match['memberCount']),
              sources: strings(match['sources'], 10),
              tactics: strings(match['tactics'], 10),
              stages: strings(match['stages'], 10),
              // Sin narrativa ni claves de entidad: solo el rótulo del patrón, enmascarado.
              explanation: maskText(label).slice(0, 300),
            };
          } else {
            gaps.push('El correlador no devolvió el candidato de esta alerta');
          }
        } catch {
          complete = false;
          gaps.push('Correlador no disponible');
        }
      }
    }

    // ── Salud de fuentes ──────────────────────────────────────────────────────────────────
    let sourceHealth: readonly EvidenceSourceHealth[] = [];
    if (this.sources.sourceHealth) {
      abortIf(signal);
      try {
        sourceHealth = await this.sources.sourceHealth();
      } catch {
        complete = false;
        gaps.push('Salud de fuentes no disponible');
      }
    } else {
      gaps.push('Salud de fuentes no medida en este despliegue');
    }

    // ── Contexto ampliado (mismo alcance que Qapaqzito, sin modelo) ───────────────────────────
    const extra = primary
      ? await this.context(primary, entityRef, alerts, signal, gaps)
      : {
          context: null,
          events: [] as EvidenceEvent[],
          eventSummary: null,
          subject: null,
          eventsScanned: 0,
          incomplete: false,
          unmeasured: [] as string[],
        };
    if (extra.incomplete) complete = false;
    for (const provider of extra.unmeasured) {
      gaps.push(`Salud de la fuente ${provider} no medida por QAPAQ`);
    }

    const watermark = createHash('sha256')
      .update(
        JSON.stringify([
          alerts.map((alert) => [alert.id, alert.revision, alert.status, alert.incidentId]),
          relatedAlerts.map((alert) => [alert.id, alert.revision]),
          history,
          candidate ? [candidate.id, candidate.score, candidate.memberCount] : null,
          sourceHealth.map((source) => [source.id, source.state, source.fresh]),
          extra.context
            ? [
                extra.context.incidents.map((incident) => [
                  incident.id,
                  incident.status,
                  incident.noteCount,
                ]),
                extra.context.entityRisk?.score ?? null,
                extra.context.activity?.alerts7d ?? null,
              ]
            : null,
          extra.events.map((event) => event.id),
          extra.eventSummary
            ? [extra.eventSummary.window.matching, extra.eventSummary.day?.matching ?? null]
            : null,
          complete,
          truncated,
        ]),
        'utf8',
      )
      .digest('hex');
    return {
      alerts: alerts.map(toEvidenceAlert),
      relatedAlerts: relatedAlerts.map(toEvidenceAlert),
      candidate,
      history,
      events: extra.events,
      eventSummary: extra.eventSummary,
      subject: extra.subject,
      sourceHealth,
      context: extra.context,
      completeness: {
        complete,
        truncated,
        alertsScanned,
        eventsScanned: extra.eventsScanned,
        gaps,
      },
      watermark: `w1:${watermark.slice(0, 48)}`,
    };
  }

  /** Lecturas de contexto; cada una que falla deja su vacío nombrado y nunca se omite en silencio. */
  private async context(
    primary: Alert,
    entityRef: string | undefined,
    alerts: readonly Alert[],
    signal: AbortSignal,
    gaps: string[],
  ): Promise<{
    readonly context: EvidenceContext;
    readonly events: EvidenceEvent[];
    readonly eventSummary: EvidenceEventSummary | null;
    readonly subject: EvidenceSubject;
    readonly eventsScanned: number;
    readonly incomplete: boolean;
    readonly unmeasured: string[];
  }> {
    const { tenantId, soc } = this.sources;
    const now = this.sources.now();
    let incomplete = false;

    // Regla y conocimiento SOC.
    let rule: EvidenceRule | null = null;
    let ruleGroups: readonly string[] = [];
    if (this.sources.knowledge) {
      const known = ruleForAlert(this.sources.knowledge, primary);
      if (known) {
        ruleGroups = known.groups;
        const view = ruleView(this.sources.knowledge, known);
        rule = {
          id: view.ruleId,
          level: typeof view.level === 'number' ? view.level : null,
          description: view.description,
          mitre: view.mitre.map((technique) => ({
            id: technique.id,
            name: technique.name ?? technique.id,
            tactics: technique.tactics.map((tactic) => tactic.name ?? tactic.id),
          })),
          runbooks: view.runbooks.map((runbook) => runbook.title),
          knownFalsePositives: view.useCases
            .flatMap((useCase) => [...useCase.falsePositives])
            .slice(0, 10),
          escalateWhen: view.useCases.flatMap((useCase) => [...useCase.escalateWhen]).slice(0, 10),
          priorityHint: view.useCases.find((useCase) => useCase.priorityHint)?.priorityHint ?? null,
        };
      } else {
        gaps.push('La regla de la alerta no figura en el conocimiento SOC versionado');
      }
    } else {
      gaps.push('Conocimiento SOC (MITRE/runbooks) no disponible');
    }

    // Alertas de la entidad: actividad de 7 días e incidentes abiertos vinculados.
    let entityAlerts: readonly Alert[] = [];
    let entityIncidentIds: readonly string[] = [];
    let activity: EvidenceActivity | null = null;
    if (entityRef) {
      abortIf(signal);
      try {
        const since = now.getTime() - EVIDENCE_LIMITS.activityAlertDays * 86_400_000;
        if (soc.alertStats) {
          // Exacto: alertas de 7 días e incidentes de la entidad sin el tope del listado.
          const [week, all] = await Promise.all([
            soc.alertStats({ tenantId, entityRef, since: new Date(since) }),
            soc.alertStats({ tenantId, entityRef }),
          ]);
          entityIncidentIds = all.incidentIds;
          activity = {
            entityRef,
            alerts7d: week.total,
            events24h: null,
            eventsScanned: 0,
            complete: true,
          };
        } else {
          const result = await soc.listAlerts({ tenantId, entityRef });
          entityAlerts = result.items.filter((alert) => alert.tenantId === tenantId);
          activity = {
            entityRef,
            alerts7d: entityAlerts.filter((alert) => alert.createdAt.getTime() >= since).length,
            events24h: null,
            eventsScanned: 0,
            complete: result.total <= result.items.length,
          };
        }
      } catch {
        incomplete = true;
        gaps.push('Alertas de la entidad no disponibles');
      }
    } else {
      gaps.push(
        'Sin referencia de entidad: actividad, incidentes y riesgo de la entidad no evaluados',
      );
    }

    const incidents: EvidenceIncident[] = [];
    const incidentIds = [
      ...new Set([
        ...[...alerts, ...entityAlerts]
          .map((alert) => alert.incidentId)
          .filter((id): id is string => typeof id === 'string'),
        ...entityIncidentIds,
      ]),
    ];
    if (incidentIds.length > 0 && soc.incidentById) {
      if (incidentIds.length > EVIDENCE_LIMITS.maxIncidents) {
        gaps.push(
          `Se leyeron ${EVIDENCE_LIMITS.maxIncidents} de ${incidentIds.length} incidentes de la entidad`,
        );
      }
      for (const incidentId of incidentIds.slice(0, EVIDENCE_LIMITS.maxIncidents)) {
        abortIf(signal);
        try {
          const incident = await soc.incidentById(tenantId, incidentId);
          if (!incident || incident.tenantId !== tenantId || incident.status === 'closed') continue;
          const [tasks, notes] = await Promise.all([
            soc.listIncidentTasks
              ? soc.listIncidentTasks(tenantId, incidentId)
              : Promise.resolve([]),
            soc.listIncidentNotes
              ? soc.listIncidentNotes(tenantId, incidentId)
              : Promise.resolve([]),
          ]);
          incidents.push({
            id: incident.id,
            title: maskText(incident.title),
            status: incident.status,
            severity: incident.severity,
            alertCount: incident.alertIds.length,
            taskCount: tasks.length,
            // Solo el conteo: el texto de las notas nunca entra al paquete.
            noteCount: notes.length,
            openedAt: incident.openedAt.toISOString(),
          });
        } catch {
          incomplete = true;
          gaps.push(`Incidente ${incidentId.slice(0, 64)} no disponible`);
        }
      }
    } else if (incidentIds.length > 0) {
      gaps.push('Lectura de incidentes no disponible');
    }

    // Riesgo de la entidad (correlador privado; la clave interna solo viaja a él).
    let entityRisk: EvidenceEntityRisk | null = null;
    const entityKey = primary.entityKeys[0];
    if (this.sources.correlator && entityKey && entityRef) {
      abortIf(signal);
      try {
        const response = await this.sources.correlator(
          `/v1/entity?key=${encodeURIComponent(entityKey)}`,
        );
        if (response.status === 200) {
          const detail = record(record(response.body)['entity']);
          entityRisk = {
            entityRef,
            score: finite(detail['score']),
            peak: finite(detail['peak']),
            observations: finite(detail['observations']),
            tactics: strings(detail['tactics'], 10),
            sources: strings(detail['sources'], 10),
          };
        } else if (response.status === 404) {
          gaps.push('El correlador no registra riesgo para la entidad');
        } else {
          throw new Error('CORRELATOR_UNAVAILABLE');
        }
      } catch {
        incomplete = true;
        gaps.push('Riesgo de la entidad no disponible (correlador)');
      }
    } else if (!this.sources.correlator) {
      gaps.push('Correlador no configurado: sin riesgo de la entidad');
    }

    // Eventos de origen (±30 min) y actividad de 24 h: lectura DIRIGIDA por entidad y paginada
    // hasta agotar el alcance. Todo lo leído entra en los agregados (`eventSummary`); se
    // conservan hasta `maxStoredEvents` ejemplares, el evento de la propia alerta primero.
    const events: EvidenceEvent[] = [];
    let eventsScanned = 0;
    let eventSummary: EvidenceEventSummary | null = null;
    const reader = this.sources.events;
    // Valores de entidad solo para comparar dentro del proceso; hacia afuera van referencias `ent_…`.
    const pairs = primary.entityKeys
      .map((key, index) => ({
        needle: key.slice(key.indexOf(':') + 1).toLocaleLowerCase('es'),
        ref: primary.entityRefs[index],
      }))
      .filter((pair) => pair.needle.length >= 3);
    const needles = pairs.map((pair) => pair.needle);
    const mentions = (event: SecurityEvent): boolean => {
      const text = JSON.stringify(event.entities).toLocaleLowerCase('es');
      return needles.some((needle) => text.includes(needle));
    };
    const refFor = (event: SecurityEvent): string[] => {
      const text = JSON.stringify(event.entities).toLocaleLowerCase('es');
      return pairs
        .filter((pair) => text.includes(pair.needle) && pair.ref && ENTITY_REF.test(pair.ref))
        .map((pair) => pair.ref!);
    };
    // Filtro por entidad que el proveedor compila a su consulta (usuario/IP, valor literal).
    const entityFilters = primary.entityKeys
      .flatMap((key) => {
        const separator = key.indexOf(':');
        const kind = key.slice(0, separator);
        const value = key.slice(separator + 1);
        return (kind === 'user' || kind === 'ip') && value.length >= 3 && value.length <= 256
          ? [{ kind: kind as 'user' | 'ip', value }]
          : [];
      })
      .slice(0, 10);
    const scoped = entityFilters.length > 0;
    let primaryRaw: JsonObject | null = null;
    const scan = async (from: Date, to: Date, maxPages: number) => {
      const read: SecurityEvent[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      let unparsed = 0;
      for (let page = 0; page < maxPages; page += 1) {
        abortIf(signal);
        const result = await reader!.read({
          from,
          to,
          filters: scoped ? { entities: entityFilters } : {},
          pageSize: EVIDENCE_LIMITS.eventPageSize,
          ...(cursor ? { cursor } : {}),
        });
        unparsed += result.unparsedCount;
        for (const item of result.items) {
          read.push(item.event);
          if (item.event.recordId === primary.eventRecordId) primaryRaw = item.raw as JsonObject;
        }
        if (!result.nextCursor) return { read, unparsed, exhausted: true };
        if (seenCursors.has(result.nextCursor)) return { read, unparsed, exhausted: false };
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      return { read, unparsed, exhausted: false };
    };
    if (reader) {
      try {
        const at = primary.occurredAt.getTime();
        const windowFrom = new Date(at - EVIDENCE_LIMITS.sourceWindowMs);
        const windowTo = new Date(Math.min(at + EVIDENCE_LIMITS.sourceWindowMs, now.getTime()));
        const window = await scan(
          windowFrom,
          windowTo,
          scoped ? EVIDENCE_LIMITS.maxEventPages : EVIDENCE_LIMITS.maxUnscopedEventPages,
        );
        eventsScanned += window.read.length;
        const minutes = Math.round(EVIDENCE_LIMITS.sourceWindowMs / 60_000);
        if (!window.exhausted) {
          incomplete = true;
          gaps.push(
            `Ventana de eventos ±${minutes} min sin agotar: ${window.read.length} eventos leídos (tope de seguridad)`,
          );
        }
        if (window.unparsed > 0 && scoped) {
          // Unos pocos eventos ilegibles no cambian la conclusión: se informan. Solo si son
          // significativos (más de 5 y más del 10 % de lo leído) la evidencia es incompleta.
          const total = window.read.length + window.unparsed;
          if (window.unparsed > EVIDENCE_LIMITS.unparsedTolerance && window.unparsed / total > 0.1) {
            incomplete = true;
            gaps.push(`${window.unparsed} de ${total} eventos de la entidad no se pudieron normalizar`);
          } else {
            gaps.push(`${window.unparsed} evento(s) de la entidad sin normalizar (no afecta la conclusión)`);
          }
        }
        // Con filtro por entidad el proveedor ya acotó; sin él, se compara en el proceso.
        const matching = window.read.filter(
          (event) => event.recordId === primary.eventRecordId || scoped || mentions(event),
        );
        let day: { read: SecurityEvent[]; unparsed: number; exhausted: boolean } | null = null;
        if (activity && scoped) {
          day = await scan(new Date(now.getTime() - 86_400_000), now, EVIDENCE_LIMITS.maxEventPages);
          eventsScanned += day.read.length;
          activity = {
            ...activity,
            events24h: day.read.length,
            eventsScanned: day.read.length,
            complete: activity.complete && day.exhausted,
          };
          if (!day.exhausted) {
            incomplete = true;
            gaps.push(
              `Actividad de 24 h de la entidad sin agotar: ${day.read.length} eventos leídos (tope de seguridad)`,
            );
          }
        } else if (activity) {
          gaps.push('La entidad no tiene usuario ni IP para leer su actividad de 24 h');
        }

        // Agregados sobre TODO lo leído de la entidad (ventana y 24 h, sin duplicar).
        const all = new Map<string, SecurityEvent>();
        for (const event of [...matching, ...(day?.read ?? [])]) all.set(event.recordId, event);
        const tally = (pick: (event: SecurityEvent) => string | null | undefined) => {
          const counts = new Map<string, number>();
          for (const event of all.values()) {
            const value = pick(event);
            if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          return [...counts.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 20)
            .map(([value, count]) => ({ value: maskText(value).slice(0, 80), count }));
        };
        const times = [...all.values()].map((event) => event.occurredAt).sort();
        eventSummary = {
          window: {
            from: windowFrom.toISOString(),
            to: windowTo.toISOString(),
            scanned: window.read.length,
            matching: matching.length,
          },
          day: day ? { scanned: day.read.length, matching: day.read.length } : null,
          bySource: tally((event) => event.source.product ?? event.source.vendor ?? null),
          byAction: tally((event) => event.action ?? null),
          byOutcome: tally((event) => event.outcome ?? null),
          byCategory: tally((event) => event.category[0] ?? null),
          firstAt: times[0] ?? null,
          lastAt: times[times.length - 1] ?? null,
          entityScoped: scoped,
        };

        // Ejemplares conservados: el evento de la alerta y luego los más cercanos a ella.
        const isPrimary = (event: SecurityEvent): number =>
          event.recordId === primary.eventRecordId ? 1 : 0;
        const distance = (event: SecurityEvent): number => Math.abs(Date.parse(event.occurredAt) - at);
        const kept = [...matching].sort(
          (left, right) => isPrimary(right) - isPrimary(left) || distance(left) - distance(right),
        );
        for (const event of kept.slice(0, EVIDENCE_LIMITS.maxStoredEvents)) {
          events.push({
            id: event.recordId,
            occurredAt: event.occurredAt,
            source: event.source.product ?? event.source.vendor ?? 'desconocida',
            category: event.category[0] ?? null,
            action: event.action ?? null,
            outcome: event.outcome ?? null,
            entityRefs: refFor(event),
          });
        }
      } catch {
        incomplete = true;
        gaps.push('Lector de eventos no disponible');
      }
    } else {
      gaps.push('Lector de eventos no configurado: sin eventos de origen ni actividad de 24 h');
    }

    // Estado de los avisos de la alerta (sin destinos ni contenido).
    const notifications: EvidenceNotification[] = [];
    if (this.sources.notifications) {
      abortIf(signal);
      try {
        const attempts = await this.sources.notifications.listByTenant(
          tenantId,
          EVIDENCE_LIMITS.notificationScan,
        );
        for (const attempt of attempts) {
          const context = attempt.context as Record<string, unknown> | null | undefined;
          if (context?.['alertId'] !== primary.id) continue;
          notifications.push({
            status: attempt.status,
            channel: attempt.channel,
            at: attempt.updatedAt.toISOString(),
          });
        }
        if (attempts.length >= EVIDENCE_LIMITS.notificationScan && notifications.length === 0) {
          gaps.push('Avisos: solo se revisaron los más recientes del tenant');
        }
      } catch {
        incomplete = true;
        gaps.push('Estado de los avisos no disponible');
      }
    } else {
      gaps.push('Estado de los avisos no disponible en este despliegue');
    }

    // Acciones auditadas recientes sobre la alerta y su incidente (solo acción, resultado y tipo).
    const audit: EvidenceAuditAction[] = [];
    if (this.sources.audit) {
      const resources: { type: string; id: string }[] = [
        { type: 'alert', id: primary.id },
        ...(primary.incidentId ? [{ type: 'incident', id: primary.incidentId }] : []),
      ];
      for (const resource of resources) {
        abortIf(signal);
        try {
          const page = await this.sources.audit.read({
            tenantId,
            from: new Date(primary.createdAt.getTime() - 60_000),
            to: now,
            pageSize: EVIDENCE_LIMITS.auditActions,
            cursor: null,
            action: null,
            actorId: null,
            resourceType: resource.type,
            resourceId: resource.id,
            outcome: [],
            includeSensitive: false,
          });
          for (const event of page.events) {
            audit.push({
              action: event.action,
              outcome: event.outcome,
              actorType: event.actor.type,
              at: event.occurredAt.toISOString(),
            });
          }
        } catch {
          incomplete = true;
          gaps.push('Auditoría reciente no disponible');
        }
      }
    } else {
      gaps.push('Auditoría reciente no disponible en este despliegue');
    }

    // Fuentes involucradas sin medición de salud propia.
    const measured = new Set(['wazuh']);
    const unmeasured = [
      ...new Set(alerts.map((alert) => providerOf(alert.title)).filter((id) => !measured.has(id))),
    ].map((id) => PROVIDER_LABEL[id] ?? id);

    return {
      context: {
        rule,
        incidents,
        entityRisk,
        activity,
        notifications: notifications.slice(0, 25),
        audit: audit.slice(0, 50),
      },
      events,
      eventSummary,
      subject: subjectFromRaw(primaryRaw, ruleGroups, primary.entityKeys.length > 0),
      eventsScanned,
      incomplete,
      unmeasured,
    };
  }
}
