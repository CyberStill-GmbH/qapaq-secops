/**
 * Analista IA — API de la consola (`/api/ai-investigations`, docs/27).
 *
 * - `GET  /`                lista paginada (`status`, `cursor`, `pageSize`)    investigations.read
 * - `GET  /budget`          presupuesto y consumo estimado del día            investigations.read
 * - `GET  /activity`        estado del host, cola, día de Lima, atraso y feed  investigations.read
 * - `GET  /settings`        ajustes y `canConfigure`                           investigations.read
 * - `PUT  /settings`        `{ settings, expectedRevision }`                   investigations.configure + step-up
 * - `GET  /digest`          resumen `from`/`to` (días de Lima, ambos incluidos) investigations.read
 * - `GET  /:id`             expediente                                         investigations.read
 * - `GET  /:id/report`      informe Markdown determinista                      investigations.read
 * - `POST /`                `{ alertId }` → investigación manual (idempotente)  investigations.run
 * - `POST /:id/cancel|retry` `{ expectedRevision }`                            investigations.run
 *
 * La lista y el expediente traen `alert`: el estado ACTUAL de la alerta revisada (estado,
 * asignación enmascarada, veredicto e incidente), leído del modelo de lectura del SOC solo para
 * quien tiene `alerts.read`; con él la consola sabe si una revisión sigue pendiente. Las acciones
 * sobre la alerta van por los endpoints de alertas existentes, no por aquí.
 *
 * Las rutas literales se declaran antes de `:id`. Mutaciones con sesión + CSRF, capacidad
 * (sin ella `RESOURCE_UNAVAILABLE`), compare-and-set (`STATE_CONFLICT`) y auditoría append-only
 * de cada intento; la auditoría de ajustes registra QUÉ claves cambiaron, nunca el texto de las
 * instrucciones. Las formas de respuesta son las de `common/ai_investigations.ts`.
 */

import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { Actor, Capability } from '@qapaq/access';
import {
  ACTIVITY_LIMITS,
  buildRunReport,
  INVESTIGATION_STATUSES,
  isInvestigationId,
  parseAnalystSettings,
  type AnalystSettings,
  type InvestigationJob,
  type InvestigationStatus,
} from '@qapaq/assistant';
import { recordAudit } from '@qapaq/audit';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest } from '../http/http-contracts.js';
import type { AnalystHost } from '../runtime/analyst-host.js';
import { limaClock, limaDayStart } from '../runtime/analyst-host.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';
import { needsRecentAuth } from '../soc/notification-channels.controller.js';
import { mutatingActor, readingActor } from '../soc/session-actor.js';
import { SECOPS_RUNTIME } from '../soc/tokens.js';
import {
  ACTIVITY_FEED_LIMIT,
  ACTIVITY_FEED_WINDOW_MS,
  activityView,
  budgetView,
  decodeCursor,
  digestView,
  encodeCursor,
  primaryAlertIdOf,
  reportView,
  runAlertView,
  runDetailView,
  type RunAlertView,
  runSummaryView,
  settingsView,
} from './ai-investigations.dto.js';

const ALERT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_DIGEST_DAYS = 31;

type Metadata = Readonly<Record<string, string | number | boolean | null>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectedRevisionOf(body: unknown, correlationId: string): number {
  const value = isRecord(body) ? body['expectedRevision'] : undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiError('VALIDATION_FAILED', correlationId, ['expectedRevision']);
  }
  return value;
}

/** Rutas de hojas que cambiaron (sin valores). `instructions` aparece solo como clave. */
export function changedSettingKeys(before: AnalystSettings, after: AnalystSettings): string[] {
  const out: string[] = [];
  const walk = (left: unknown, right: unknown, path: string) => {
    if (isRecord(left) && isRecord(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(left[key], right[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) out.push(path);
  };
  walk(before, after, '');
  return out.sort();
}

@Controller('api/ai-investigations')
export class AiInvestigationsController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  private host(correlationId: string): AnalystHost {
    const host = this.runtime.analyst;
    if (!host) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    return host;
  }

  private allowed(actor: Actor, capability: Capability, correlationId: string): void {
    if (!actor.capabilities.has(capability) || actor.tenantId !== this.runtime.tenantId) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
  }

  private async reader(request: IncomingRequest) {
    const resolved = await readingActor(this.runtime, request);
    this.allowed(resolved.actor, 'investigations.read', resolved.correlationId);
    return { ...resolved, host: this.host(resolved.correlationId) };
  }

  private async mutator(request: IncomingRequest, capability: Capability) {
    const resolved = await mutatingActor(this.runtime, request);
    this.allowed(resolved.actor, capability, resolved.correlationId);
    return { ...resolved, host: this.host(resolved.correlationId) };
  }

  private async audit(
    actor: Actor,
    correlationId: string,
    action: string,
    resource: { readonly type: string; readonly id: string },
    outcome: 'succeeded' | 'failed',
    metadata: Metadata,
    reason?: string,
  ): Promise<void> {
    await recordAudit(this.runtime.audit, {
      id: randomUUID(),
      tenantId: actor.tenantId,
      occurredAt: this.runtime.now(),
      actor: { id: actor.subjectId, type: 'user', sessionId: actor.sessionId },
      action,
      resource,
      outcome,
      correlationId,
      ...(reason ? { reason } : {}),
      metadata,
    });
  }

  private async extras(host: AnalystHost, job: InvestigationJob) {
    const [invocations, actions] = await Promise.all([
      host.store.invocations(job.tenantId, job.id),
      host.store.actions(job.tenantId, job.id),
    ]);
    return { invocations, actions };
  }

  /**
   * Estado actual de la alerta revisada, por el modelo de lectura del SOC. Sin `alerts.read` no
   * se lee (la consola lo trata como «sin dato», nunca como atendida).
   */
  private async alertOf(
    actor: Actor,
    job: InvestigationJob,
    actions: Parameters<typeof runAlertView>[1],
  ): Promise<RunAlertView | null> {
    if (!actor.capabilities.has('alerts.read')) return null;
    const alertId = primaryAlertIdOf(job);
    if (!alertId) return null;
    const alert = await this.runtime.soc.alertById(this.runtime.tenantId, alertId);
    if (!alert || alert.tenantId !== actor.tenantId) return null;
    return runAlertView(alert, actions, actor.subjectId);
  }

  private async extrasWithAlert(actor: Actor, host: AnalystHost, job: InvestigationJob) {
    const extras = await this.extras(host, job);
    return { ...extras, alert: await this.alertOf(actor, job, extras.actions) };
  }

  private async detail(actor: Actor, host: AnalystHost, job: InvestigationJob) {
    const [events, extras] = await Promise.all([
      host.store.events(job.tenantId, job.id),
      this.extrasWithAlert(actor, host, job),
    ]);
    return runDetailView(job, events, extras);
  }

  private async job(host: AnalystHost, id: string, correlationId: string): Promise<InvestigationJob> {
    if (!isInvestigationId(id)) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const job = await host.store.byId(this.runtime.tenantId, id);
    if (!job) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    return job;
  }

  // ── Rutas literales (antes de `:id`) ────────────────────────────────────────────────────

  @Get()
  public async list(
    @Req() request: IncomingRequest,
    @Query() query: { status?: string; cursor?: string; pageSize?: string },
  ) {
    const { actor, correlationId, host } = await this.reader(request);
    const status = query.status || undefined;
    if (status !== undefined && !(INVESTIGATION_STATUSES as readonly string[]).includes(status)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['status']);
    }
    const pageSize = query.pageSize === undefined || query.pageSize === '' ? 25 : Number(query.pageSize);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['pageSize']);
    }
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (query.cursor && !cursor) throw new ApiError('VALIDATION_FAILED', correlationId, ['cursor']);
    const page = await host.store.list(this.runtime.tenantId, {
      ...(status ? { status: status as InvestigationStatus } : {}),
      ...(cursor ? { cursor } : {}),
      pageSize,
    });
    const items = await Promise.all(
      page.items.map(async (job) => runSummaryView(job, await this.extrasWithAlert(actor, host, job))),
    );
    return { correlationId, items, nextCursor: encodeCursor(page.next) };
  }

  @Get('budget')
  public async budget(@Req() request: IncomingRequest) {
    const { correlationId, host } = await this.reader(request);
    const { settings } = await host.currentSettings();
    const limitMicroUsd = host.enabled ? host.effectiveCeiling(settings) : null;
    const snapshot = await host.store.budgetSnapshot(
      this.runtime.tenantId,
      this.runtime.now(),
      limitMicroUsd,
    );
    return {
      correlationId,
      ...budgetView({
        snapshot,
        settings,
        deploymentEnabled: host.enabled,
        limitMicroUsd,
        rateCardVersion: host.config.rateCard.version,
      }),
      deploymentCeilingMicroUsd: host.config.dailyCeilingMicroUsd,
    };
  }

  /**
   * Cómo está actuando el analista: estado del host (en memoria, de ESTE proceso), cola actual,
   * conteos del día de Lima en curso, atraso sin expediente y feed de las últimas 24 h. Solo
   * campos estructurados: ni texto del modelo ni evidencia; títulos enmascarados.
   */
  @Get('activity')
  public async activity(@Req() request: IncomingRequest) {
    const { correlationId, host } = await this.reader(request);
    const tenantId = this.runtime.tenantId;
    const now = this.runtime.now();
    const { day } = limaClock(now);
    const from = limaDayStart(day);
    const today = { day, from, to: new Date(from.getTime() + 86_400_000) };
    // La ventana del feed (24 h hacia atrás) contiene siempre el inicio del día de Lima.
    const since = new Date(now.getTime() - ACTIVITY_FEED_WINDOW_MS);
    const [{ settings }, counts, actions, escalations, recent, backlog] = await Promise.all([
      host.currentSettings(),
      host.store.activityCounts(tenantId, today.from, today.to),
      host.store.actionsBetween(tenantId, since, today.to),
      host.store.escalationOutcomes(tenantId, since, today.to),
      host.store.recentJobs(tenantId, since, ACTIVITY_LIMITS.recentJobs),
      host.backlog(),
    ]);
    const jobs = new Map(recent.map((job) => [job.id, job]));
    // Acciones de trabajos que no están entre los recientes: solo las del tope del feed.
    const missing = [
      ...new Set(
        [...actions]
          .sort((left, right) => (right.executedAt ?? right.at).getTime() - (left.executedAt ?? left.at).getTime())
          .slice(0, ACTIVITY_FEED_LIMIT)
          .map((action) => action.jobId)
          .filter((id) => !jobs.has(id)),
      ),
    ];
    for (const job of await Promise.all(missing.map((id) => host.store.byId(tenantId, id)))) {
      if (job) jobs.set(job.id, job);
    }
    return {
      correlationId,
      ...activityView({
        status: host.status(),
        settings,
        counts,
        actions,
        escalations,
        jobs,
        backlog,
        today,
        since,
        inferenceConfigured: host.config.dailyCeilingMicroUsd !== null,
      }),
    };
  }

  @Get('settings')
  public async getSettings(@Req() request: IncomingRequest) {
    const { actor, correlationId, host } = await this.reader(request);
    const { stored, settings } = await host.currentSettings();
    return {
      correlationId,
      settings: settingsView(stored, settings),
      canConfigure: actor.capabilities.has('investigations.configure'),
      deploymentEnabled: host.enabled,
    };
  }

  @Put('settings')
  public async putSettings(@Req() request: IncomingRequest, @Body() body: unknown) {
    const { actor, correlationId, session, host } = await this.mutator(
      request,
      'investigations.configure',
    );
    if (needsRecentAuth(actor, session, this.runtime.now())) {
      throw new ApiError('STEP_UP_REQUIRED', correlationId);
    }
    const expectedRevision = expectedRevisionOf(body, correlationId);
    const { stored, settings: current } = await host.currentSettings();
    const raw = isRecord(body) ? body['settings'] : undefined;
    // La consola no edita `review.maxImmediatePerHour`: se conserva el valor vigente.
    const candidate =
      isRecord(raw) && isRecord(raw['review']) && !('maxImmediatePerHour' in raw['review'])
        ? { ...raw, review: { ...raw['review'], maxImmediatePerHour: current.review.maxImmediatePerHour } }
        : raw;
    const parsed = parseAnalystSettings(candidate);
    const resource = { type: 'ai_analyst_settings', id: this.runtime.tenantId };
    if (!parsed.ok) {
      await this.audit(actor, correlationId, 'ai.analyst.settings.update_rejected', resource, 'failed', {
        code: 'VALIDATION_FAILED',
        field: parsed.field,
      }, 'VALIDATION_FAILED');
      throw new ApiError('VALIDATION_FAILED', correlationId, [parsed.field]);
    }
    const next = parsed.settings;
    // Los ajustes solo pueden bajar el techo del despliegue, nunca subirlo ni crearlo.
    const deployment = host.config.dailyCeilingMicroUsd;
    const ceiling = next.budget.dailyCeilingMicroUsd;
    if (ceiling !== null && (deployment === null || ceiling > deployment)) {
      await this.audit(actor, correlationId, 'ai.analyst.settings.update_rejected', resource, 'failed', {
        code: 'ABOVE_DEPLOYMENT_CEILING',
        field: 'budget.dailyCeilingMicroUsd',
      }, 'VALIDATION_FAILED');
      throw new ApiError('VALIDATION_FAILED', correlationId, ['budget.dailyCeilingMicroUsd']);
    }
    const changed = changedSettingKeys(current, next);
    const outcome = await host.settingsStore.put(
      this.runtime.tenantId,
      next,
      expectedRevision,
      actor.subjectId,
      this.runtime.now(),
    );
    if (outcome === 'conflict') {
      await this.audit(actor, correlationId, 'ai.analyst.settings.update_rejected', resource, 'failed', {
        code: 'STATE_CONFLICT',
        expectedRevision,
        revision: stored?.revision ?? 0,
      }, 'STATE_CONFLICT');
      throw new ApiError('STATE_CONFLICT', correlationId);
    }
    await this.audit(actor, correlationId, 'ai.analyst.settings.updated', resource, 'succeeded', {
      changed: changed.join(',').slice(0, 1_000),
      revision: expectedRevision + 1,
      enabled: next.enabled,
      mode: next.mode,
      closeBenign: next.actions.closeBenign,
    });
    const saved = await host.currentSettings();
    return {
      correlationId,
      settings: settingsView(saved.stored, saved.settings),
      canConfigure: true,
      deploymentEnabled: host.enabled,
    };
  }

  @Get('digest')
  public async digest(@Req() request: IncomingRequest, @Query() query: { from?: string; to?: string }) {
    const { correlationId, host } = await this.reader(request);
    const valid = (day: string | undefined): day is string =>
      typeof day === 'string' && DAY.test(day) && !Number.isNaN(limaDayStart(day).getTime());
    if (!valid(query.from)) throw new ApiError('VALIDATION_FAILED', correlationId, ['from']);
    if (!valid(query.to)) throw new ApiError('VALIDATION_FAILED', correlationId, ['to']);
    const from = limaDayStart(query.from);
    const to = new Date(limaDayStart(query.to).getTime() + 86_400_000);
    if (to <= from || to.getTime() - from.getTime() > MAX_DIGEST_DAYS * 86_400_000) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['to']);
    }
    return { correlationId, digest: digestView(await host.buildDigest(from, to)) };
  }

  @Post()
  public async start(@Req() request: IncomingRequest, @Body() body: unknown) {
    const { actor, correlationId, host } = await this.mutator(request, 'investigations.run');
    const alertId = isRecord(body) ? body['alertId'] : undefined;
    if (typeof alertId !== 'string' || !ALERT_ID.test(alertId)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['alertId']);
    }
    // La alerta debe existir en el tenant de quien pide; otra cosa no se distingue de «no existe».
    const alert = await this.runtime.soc.alertById(this.runtime.tenantId, alertId);
    if (!alert || alert.tenantId !== actor.tenantId) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    if (!host.enabled) {
      await this.audit(actor, correlationId, 'ai.analyst.investigation.request_rejected', {
        type: 'alert',
        id: alert.id,
      }, 'failed', { code: 'ANALYST_DISABLED' }, 'ANALYST_DISABLED');
      throw new ApiError('STATE_CONFLICT', correlationId, ['analyst']);
    }
    const { job, created } = await host.enqueueAlert(alert, {
      source: 'manual',
      initiatedBy: actor.subjectId,
    });
    await this.audit(actor, correlationId, 'ai.analyst.investigation.requested', {
      type: 'ai_investigation',
      id: job.id,
    }, 'succeeded', { alertId: alert.id, created, priority: job.priority });
    return { correlationId, run: await this.detail(actor, host, job), created };
  }

  // ── Rutas con `:id` ─────────────────────────────────────────────────────────────────────

  @Get(':id')
  public async get(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, correlationId, host } = await this.reader(request);
    const job = await this.job(host, id, correlationId);
    return { correlationId, run: await this.detail(actor, host, job) };
  }

  @Get(':id/report')
  public async report(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { correlationId, host } = await this.reader(request);
    const job = await this.job(host, id, correlationId);
    const [events, extras] = await Promise.all([
      host.store.events(job.tenantId, job.id),
      this.extras(host, job),
    ]);
    const report = buildRunReport(job, events, extras.invocations, extras.actions, job.evidence);
    return { correlationId, report: reportView(report, this.runtime.now()) };
  }

  @Post(':id/cancel')
  public cancel(@Req() request: IncomingRequest, @Param('id') id: string, @Body() body?: unknown) {
    return this.command(request, id, body, 'cancel');
  }

  @Post(':id/retry')
  public retry(@Req() request: IncomingRequest, @Param('id') id: string, @Body() body?: unknown) {
    return this.command(request, id, body, 'retry');
  }

  private async command(
    request: IncomingRequest,
    id: string,
    body: unknown,
    kind: 'cancel' | 'retry',
  ) {
    const { actor, correlationId, host } = await this.mutator(request, 'investigations.run');
    const expectedRevision = expectedRevisionOf(body, correlationId);
    const job = await this.job(host, id, correlationId);
    const at = this.runtime.now();
    const outcome =
      kind === 'cancel'
        ? await host.store.requestCancel(this.runtime.tenantId, job.id, expectedRevision, at)
        : await host.store.retry(this.runtime.tenantId, job.id, expectedRevision, at);
    const resource = { type: 'ai_investigation', id: job.id };
    if (outcome !== 'ok') {
      await this.audit(actor, correlationId, `ai.analyst.investigation.${kind}_rejected`, resource, 'failed', {
        code: outcome,
        expectedRevision,
        revision: job.revision,
      }, outcome.toUpperCase());
      if (outcome === 'not_found') throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
      throw new ApiError('STATE_CONFLICT', correlationId);
    }
    await this.audit(actor, correlationId, `ai.analyst.investigation.${kind === 'cancel' ? 'cancel_requested' : 'retried'}`, resource, 'succeeded', {
      from: job.status,
      expectedRevision,
    });
    if (kind === 'retry') host.kick();
    const updated = await this.job(host, job.id, correlationId);
    return { correlationId, run: await this.detail(actor, host, updated) };
  }
}
