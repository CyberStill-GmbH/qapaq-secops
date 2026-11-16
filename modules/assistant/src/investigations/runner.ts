/**
 * Analista IA — ejecutor de una investigación (agnóstico del host).
 *
 * `runOnce` reclama un trabajo y lo lleva por etapas: evidencia → triaje determinista →
 * (modelo) → validación → escritura. Diseño de costo:
 *
 * - La mayoría de los trabajos termina en el triaje, sin llamar a ningún modelo.
 * - Como máximo UNA llamada por run, sin herramientas ni llamada de reparación: una salida
 *   inválida deja el trabajo en `requires_review`.
 * - El peor caso se reserva antes del envío; sin techo diario configurado no hay inferencia.
 * - Tras el envío, un error o timeout ambiguo deja la reserva en `usage_unknown` y el trabajo en
 *   `usage_unreconciled`: nunca se reinvoca a ciegas.
 *
 * Shadow mode: el runner solo escribe en su propio almacén. No cierra alertas, no cambia
 * prioridades y no notifica.
 */

import type { AssistantModel, Citation, ModelResponse } from '../ports.js';
import { Pseudonymizer } from '../pseudonymizer.js';
import {
  ACTION_KINDS,
  closeBenignNote,
  planActions,
  type InvestigationAction,
  type SocActions,
} from './actions.js';
import {
  ANALYST_SYSTEM_PROMPT,
  buildAnalystMessages,
  parseAnalystOutput,
} from './analyst-output.js';
import {
  buildEvidencePack,
  estimateTokens,
  fingerprintOf,
  type EvidencePack,
  type EvidencePackConfig,
} from './evidence-pack.js';
import {
  buildDeterministicResult,
  POLICY_VERSION,
  TRIAGE_CONFIG,
  triagePolicy,
  unhealthySources,
  type TriageConfig,
  type TriageDecision,
} from './policy.js';
import {
  InferenceNotSentError,
  type ActionMark,
  type Clock,
  type EvidenceReader,
  type InvestigationStore,
  type WorkerLease,
} from './ports.js';
import { estimateMicroUsd, worstCaseMicroUsd, type RateCard } from './rate-card.js';
import { buildRunReport } from './reports.js';
import {
  DEFAULT_ANALYST_SETTINGS,
  type AnalystSettings,
  type AnalystSettingsStore,
} from './settings.js';
import type {
  CitedStatement,
  EvidenceBundle,
  InferenceTier,
  InvestigationEventDetail,
  InvestigationEventKind,
  InvestigationEvidenceSummary,
  InvestigationInference,
  InvestigationInvocation,
  InvestigationJob,
  InvestigationResult,
  InvestigationStage,
  InvestigationTerminalStatus,
  InvocationUsage,
} from './types.js';

/** Tope duro: una sola llamada al modelo por run. */
export const MAX_MODEL_CALLS_PER_RUN = 1;

/**
 * Estado final de un expediente sin modelo: si la valoración por reglas concluye «probable
 * verdadero positivo», no se da por terminado en silencio: pasa a revisión humana.
 */
export function deterministicStatus(
  status: 'completed' | 'requires_review' | 'partial',
  result: InvestigationResult,
): 'completed' | 'requires_review' | 'partial' {
  // Solo con una señal de riesgo o urgencia (un hallazgo real de baja urgencia no molesta a nadie).
  return status === 'completed' &&
    result.verdict === 'likely_true_positive' &&
    result.deterministic.reasons.includes('RULE_ASSESSMENT_RISK')
    ? 'requires_review'
    : status;
}

export interface InvestigationRunnerLimits {
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  /** Reclamos antes de la cuarentena (`failed`). */
  readonly maxAttempts: number;
  /** Techo diario estimado por tenant; `null` deshabilita la inferencia. */
  readonly dailyCeilingMicroUsd: number | null;
  /** Tokens de entrada estimados (prompt + paquete) por llamada. */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** Reloj total del run; acota la lectura de evidencia y la llamada al modelo. */
  readonly deadlineMs: number;
}

export interface InvestigationModelBinding {
  /** Identificador del modelo o perfil; se guarda en el libro de invocaciones. */
  readonly id: string;
  /** Debe enviar sin reintentos automáticos del SDK (cada intento se contabiliza). */
  readonly model: AssistantModel;
}

/** Progreso inocuo para el host (despertar long-pollers, métricas). Sin contenido. */
export interface InvestigationProgress {
  readonly jobId: string;
  readonly tenantId: string;
  readonly at: Date;
  readonly stage: InvestigationStage;
  readonly kind: InvestigationEventKind;
  readonly detail: InvestigationEventDetail;
}

export interface InvestigationRunnerOptions {
  readonly store: InvestigationStore;
  readonly evidence: EvidenceReader;
  readonly models: {
    readonly economy?: InvestigationModelBinding;
    readonly advanced?: InvestigationModelBinding;
  };
  readonly rateCard: RateCard;
  readonly limits: InvestigationRunnerLimits;
  readonly clock: Clock;
  readonly onEvent?: (event: InvestigationProgress) => void;
  /**
   * Ajustes por tenant. Con este almacén, los ajustes gobiernan alcance, presupuesto, nivel
   * avanzado y acciones (sin fila ⇒ `DEFAULT_ANALYST_SETTINGS`: deshabilitado). Sin él, el runner
   * usa solo `limits` y no planifica acciones.
   */
  readonly settings?: AnalystSettingsStore;
  /** Ejecutor de acciones sobre el SOC. Sin él, las acciones planificadas quedan `skipped`. */
  readonly actions?: SocActions;
  /** Umbrales de la política (por defecto `TRIAGE_CONFIG`). */
  readonly triage?: TriageConfig;
  /** Topes del paquete; `maxInputTokens` lo fija el runner. */
  readonly pack?: Partial<Omit<EvidencePackConfig, 'maxInputTokens'>>;
  /** Seudonimizar correos e IPv4 antes del proveedor (por defecto, sí). */
  readonly pseudonymize?: boolean;
  /** Espera antes del reintento tras un fallo transitorio; recibe el intento (desde 1). */
  readonly retryDelayMs?: (attempt: number) => number;
  /** Margen sobre la estimación de entrada al reservar (por defecto 1,25). */
  readonly inputReservationMargin?: number;
}

class LeaseLostError extends Error {
  public constructor() {
    super('LEASE_LOST');
    this.name = 'LeaseLostError';
  }
}

const defaultRetryDelayMs = (attempt: number): number =>
  Math.min(300_000, 15_000 * 2 ** Math.max(0, attempt - 1));

function usageOf(response: ModelResponse): InvocationUsage {
  const count = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  return {
    inputTokens: count(response.usage.inputTokens),
    outputTokens: count(response.usage.outputTokens),
    cacheReadTokens: count(response.usage.cacheReadTokens),
    cacheWriteTokens: count(response.usage.cacheWriteTokens),
  };
}

function textOf(response: ModelResponse): string {
  return response.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

interface RunContext {
  readonly job: InvestigationJob;
  readonly lease: WorkerLease;
  readonly startedMs: number;
  readonly lost: AbortController;
  readonly hostSignal: AbortSignal | undefined;
  cancelled: boolean;
  settings: AnalystSettings | undefined;
  bundle: EvidenceBundle | null;
}

export class InvestigationRunner {
  private readonly options: InvestigationRunnerOptions;

  public constructor(options: InvestigationRunnerOptions) {
    this.options = options;
  }

  /** Procesa a lo sumo un trabajo. `idle`: no había nada reclamable. */
  public async runOnce(signal?: AbortSignal): Promise<'idle' | 'processed'> {
    if (signal?.aborted) return 'idle';
    const { store, limits, clock } = this.options;
    const job = await store.claim(clock.now(), limits.leaseMs, limits.maxAttempts);
    if (!job) return 'idle';

    const context: RunContext = {
      job,
      lease: { jobId: job.id, fencingToken: job.fencingToken },
      startedMs: clock.now().getTime(),
      lost: new AbortController(),
      hostSignal: signal,
      cancelled: false,
      settings: undefined,
      bundle: null,
    };
    const timer = setInterval(() => {
      void this.beat(context).catch(() => undefined);
    }, limits.heartbeatMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      await this.drive(context);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        // Fallo no previsto: reintento acotado. Una invocación en vuelo queda `usage_unknown`
        // en el almacén y el siguiente intento no la reenvía.
        await store
          .releaseForRetry(context.lease, {
            at: clock.now(),
            availableAt: this.retryAt(job.attempt),
            errorCode: 'INTERNAL_ERROR',
            maxAttempts: limits.maxAttempts,
          })
          .catch(() => undefined);
      }
    } finally {
      clearInterval(timer);
    }
    return 'processed';
  }

  private retryAt(attempt: number): Date {
    const delay = (this.options.retryDelayMs ?? defaultRetryDelayMs)(attempt);
    return new Date(this.options.clock.now().getTime() + Math.max(0, delay));
  }

  private async beat(context: RunContext): Promise<void> {
    if (context.lost.signal.aborted) return;
    const { store, limits, clock } = this.options;
    const outcome = await store.heartbeat(context.lease, clock.now(), limits.leaseMs);
    if (outcome === 'lost') context.lost.abort();
    else if (outcome === 'cancel_requested') context.cancelled = true;
  }

  /** Renueva el lease entre etapas. Lanza si se perdió; devuelve si hay cancelación pedida. */
  private async guard(context: RunContext): Promise<boolean> {
    await this.beat(context);
    if (context.lost.signal.aborted) throw new LeaseLostError();
    return context.cancelled;
  }

  private owned(written: boolean): void {
    if (!written) throw new LeaseLostError();
  }

  private emit(
    context: RunContext,
    stage: InvestigationStage,
    kind: InvestigationEventKind,
    detail: InvestigationEventDetail,
    at: Date,
  ): void {
    try {
      this.options.onEvent?.({
        jobId: context.job.id,
        tenantId: context.job.tenantId,
        at,
        stage,
        kind,
        detail,
      });
    } catch {
      // Un observador que falla no detiene la investigación.
    }
  }

  private async enter(
    context: RunContext,
    stage: InvestigationStage,
    extra: {
      readonly inference?: InvestigationInference;
      readonly evidence?: InvestigationEvidenceSummary;
      readonly detail?: InvestigationEventDetail;
    } = {},
  ): Promise<void> {
    const at = this.options.clock.now();
    const detail = extra.detail ?? {};
    this.owned(
      await this.options.store.checkpoint(context.lease, {
        at,
        stage,
        ...(extra.inference === undefined ? {} : { inference: extra.inference }),
        ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
        event: { kind: 'started', detail },
      }),
    );
    this.emit(context, stage, 'started', detail, at);
  }

  private async note(
    context: RunContext,
    stage: InvestigationStage,
    kind: InvestigationEventKind,
    detail: InvestigationEventDetail,
  ): Promise<void> {
    const at = this.options.clock.now();
    this.owned(await this.options.store.appendEvent(context.lease, { at, stage, kind, detail }));
    this.emit(context, stage, kind, detail, at);
  }

  private async finish(
    context: RunContext,
    input: {
      readonly status: InvestigationTerminalStatus;
      readonly result: InvestigationResult | null;
      readonly inference: InvestigationInference;
      readonly evidence?: InvestigationEvidenceSummary;
      readonly errorCode?: string;
    },
  ): Promise<void> {
    const { store, clock } = this.options;
    await this.enter(context, 'writing');
    if (input.status !== 'cancelled' && context.settings) {
      const planned = planActions(context.job, input.result, context.bundle, context.settings, {
        status: input.status,
        inference: input.inference,
        immediateReviewsLastHour: await store.countImmediateReviews(
          context.job.tenantId,
          new Date(clock.now().getTime() - 3_600_000),
        ),
      });
      if (planned.length > 0) {
        // Resultado y plan se guardan juntos: si el worker cae al actuar, el siguiente retoma.
        const rows = await store.planActions(context.lease, {
          at: clock.now(),
          status: input.status,
          result: input.result,
          inference: input.inference,
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
          errorCode: input.errorCode ?? null,
          actions: planned,
        });
        if (rows === null) throw new LeaseLostError();
        await this.act(context, rows, {
          ...context.job,
          result: input.result,
          inference: input.inference,
          plannedStatus: input.status,
          evidence: input.evidence ?? context.job.evidence,
        });
      }
    }
    return this.conclude(context, input);
  }

  /** Ejecuta las acciones `planned` por el puerto. Un fallo se registra y no detiene el run. */
  private async act(
    context: RunContext,
    rows: readonly InvestigationAction[],
    job: InvestigationJob,
  ): Promise<void> {
    const { store, clock } = this.options;
    const pending = rows
      .filter((row) => row.state === 'planned')
      .sort((left, right) => ACTION_KINDS.indexOf(left.kind) - ACTION_KINDS.indexOf(right.kind));
    if (pending.length === 0) return;
    await this.enter(context, 'acting', { detail: { actions: pending.length } });
    for (const action of pending) {
      await this.guard(context);
      let mark: Omit<ActionMark, 'at'> & { readonly detail?: Readonly<Record<string, string>> };
      try {
        mark = await this.execute(action, job);
      } catch {
        // El error del host puede traer datos del SOC: solo se registra el código.
        mark = { state: 'failed', errorCode: 'ACTION_FAILED' };
      }
      const { detail: markDetail, ...ledger } = mark;
      this.owned(
        await store.markAction(context.lease, action.kind, { ...ledger, at: clock.now() }),
      );
      await this.note(context, 'acting', mark.state === 'executed' ? 'completed' : mark.state, {
        action: action.kind,
        reason: action.reason,
        ...(mark.errorCode ? { code: mark.errorCode } : {}),
        ...markDetail,
      });
    }
  }

  private async execute(
    action: InvestigationAction,
    job: InvestigationJob,
  ): Promise<Omit<ActionMark, 'at'> & { readonly detail?: Readonly<Record<string, string>> }> {
    const port = this.options.actions;
    if (!port) return { state: 'skipped', errorCode: 'NO_ACTION_PORT' };
    const { store } = this.options;
    switch (action.kind) {
      case 'escalate': {
        if (!job.result) return { state: 'skipped', errorCode: 'NO_RESULT' };
        const { incidentId, disposition } = await port.escalate(job, job.result);
        return {
          state: 'executed',
          ref: incidentId ? { kind: 'incident', id: incidentId } : null,
          ...(disposition ? { detail: { incident: disposition } } : {}),
        };
      }
      case 'close_benign':
        await port.closeBenign(job, closeBenignNote(job));
        return { state: 'executed', ref: { kind: 'alert', id: job.subject.id } };
      case 'acknowledge':
        await port.acknowledge(job);
        return { state: 'executed', ref: { kind: 'alert', id: job.subject.id } };
      case 'report': {
        if (!port.attachReport) return { state: 'skipped', errorCode: 'NO_REPORT_PORT' };
        const report = buildRunReport(
          job,
          await store.events(job.tenantId, job.id),
          await store.invocations(job.tenantId, job.id),
          await store.actions(job.tenantId, job.id),
          job.evidence,
        );
        const { reportId } = await port.attachReport(job, report);
        return { state: 'executed', ref: reportId ? { kind: 'report', id: reportId } : null };
      }
      case 'request_review': {
        const { notificationId } = await port.requestReview(job, job.result, {
          reason: action.reason,
          urgency: action.urgency ?? 'digest',
          groupKey: action.groupKey ?? `job:${job.id}`,
        });
        return {
          state: 'executed',
          ref: notificationId ? { kind: 'notification', id: notificationId } : null,
        };
      }
    }
  }

  private async conclude(
    context: RunContext,
    input: {
      readonly status: InvestigationTerminalStatus;
      readonly result: InvestigationResult | null;
      readonly inference: InvestigationInference;
      readonly evidence?: InvestigationEvidenceSummary;
      readonly errorCode?: string;
    },
  ): Promise<void> {
    const at = this.options.clock.now();
    // El modo vigente al planificar queda en la bitácora: el expediente muestra con qué modo corrió.
    const detail = {
      status: input.status,
      inference: input.inference,
      ...(context.settings ? { mode: context.settings.mode } : {}),
    };
    const written = await this.options.store.finish(context.lease, {
      at,
      status: input.status,
      result: input.result,
      inference: input.inference,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      errorCode: input.errorCode ?? null,
      event: { at, stage: 'writing', kind: 'completed', detail },
    });
    if (written === null) throw new LeaseLostError();
    this.emit(context, 'writing', 'completed', { ...detail, status: written }, at);
  }

  private cancel(context: RunContext, inference: InvestigationInference): Promise<void> {
    return this.finish(context, { status: 'cancelled', result: null, inference });
  }

  private async drive(context: RunContext): Promise<void> {
    const { store, clock } = this.options;
    const { job, lease } = context;

    // Ajustes del administrador: restringen dentro de los límites del despliegue.
    const settings = this.options.settings
      ? ((await this.options.settings.get(job.tenantId))?.settings ?? DEFAULT_ANALYST_SETTINGS)
      : undefined;
    context.settings = settings;
    const base = this.options.limits;
    const limits: InvestigationRunnerLimits = settings
      ? {
          ...base,
          dailyCeilingMicroUsd:
            !settings.enabled || settings.budget.dailyCeilingMicroUsd === null
              ? null
              : base.dailyCeilingMicroUsd === null
                ? settings.budget.dailyCeilingMicroUsd
                : Math.min(base.dailyCeilingMicroUsd, settings.budget.dailyCeilingMicroUsd),
          maxOutputTokens: Math.min(base.maxOutputTokens, settings.budget.maxOutputTokens),
        }
      : base;
    const triageBase = this.options.triage ?? TRIAGE_CONFIG;
    const triageConfig: TriageConfig = settings
      ? { ...triageBase, knownBenignMinFalsePositives: settings.closeBenign.minHistory }
      : triageBase;
    const models = {
      economy: this.options.models.economy,
      advanced:
        settings && !settings.budget.advancedTierEnabled ? undefined : this.options.models.advanced,
    };

    // Retoma tras una caída en `acting`: el resultado ya está decidido y guardado.
    if (job.plannedStatus !== null) {
      await this.act(context, await store.actions(job.tenantId, job.id), job);
      return this.conclude(context, {
        status: job.plannedStatus,
        result: job.result,
        inference: job.inference ?? 'none',
        ...(job.lastErrorCode ? { errorCode: job.lastErrorCode } : {}),
      });
    }

    // ── 1. Evidencia ─────────────────────────────────────────────────────────────────────────
    await this.enter(context, 'fetching_evidence', { detail: { attempt: job.attempt } });
    let bundle: EvidenceBundle;
    try {
      bundle = await this.options.evidence.collect(
        job,
        AbortSignal.any([
          context.lost.signal,
          AbortSignal.timeout(Math.max(1, limits.deadlineMs)),
          ...(context.hostSignal ? [context.hostSignal] : []),
        ]),
      );
    } catch {
      if (context.lost.signal.aborted) throw new LeaseLostError();
      const shutdown = context.hostSignal?.aborted === true;
      const errorCode = shutdown ? 'HOST_SHUTDOWN' : 'EVIDENCE_UNAVAILABLE';
      // El error del lector puede traer datos del origen: solo se registra el código.
      await store.appendEvent(lease, {
        at: clock.now(),
        stage: 'fetching_evidence',
        kind: 'failed',
        detail: { code: errorCode },
      });
      const outcome = await store.releaseForRetry(lease, {
        at: clock.now(),
        availableAt: shutdown ? clock.now() : this.retryAt(job.attempt),
        errorCode,
        maxAttempts: limits.maxAttempts,
        refundAttempt: shutdown,
      });
      if (outcome === 'stale') throw new LeaseLostError();
      return;
    }
    context.bundle = bundle;
    const fingerprint = fingerprintOf(job.tenantId, job.alertIds, bundle.watermark, POLICY_VERSION);
    let evidence: InvestigationEvidenceSummary = {
      alertCount: bundle.alerts.length,
      relatedAlertCount: bundle.relatedAlerts.length,
      eventCount: bundle.events.length,
      sourceCount: bundle.sourceHealth.length,
      unhealthySourceCount: unhealthySources(bundle, triageConfig).length,
      complete: bundle.completeness.complete,
      truncated: bundle.completeness.truncated,
      gaps: bundle.completeness.gaps.slice(0, 12).map((gap) => gap.slice(0, 200)),
      watermark: bundle.watermark.slice(0, 200),
      fingerprint,
      estimatedInputTokens: null,
      packTruncated: false,
    };
    await this.note(context, 'fetching_evidence', 'completed', {
      alerts: evidence.alertCount,
      relatedAlerts: evidence.relatedAlertCount,
      events: evidence.eventCount,
      unhealthySources: evidence.unhealthySourceCount,
      complete: evidence.complete,
      truncated: evidence.truncated,
    });
    if (await this.guard(context)) return this.cancel(context, 'none');

    // ── 2. Triaje determinista ───────────────────────────────────────────────────────────────
    await this.enter(context, 'triage', { evidence });
    const decision = triagePolicy(
      { priority: job.priority, bundle, ...(settings ? { scope: settings.scope } : {}) },
      triageConfig,
    );
    await this.note(context, 'triage', 'completed', {
      decision: decision.decision,
      tier: decision.tier ?? 'none',
      reasons: decision.reasons.join(','),
      policyVersion: POLICY_VERSION,
    });
    const caseFile = (extraReasons: readonly string[] = []): InvestigationResult =>
      buildDeterministicResult({
        subject: job.subject,
        priority: job.priority,
        bundle,
        decision,
        extraReasons,
      });
    /** Expediente determinista como resultado final cuando la inferencia no ocurre o no sirve. */
    const fallback = (
      reason: string,
      extra: {
        readonly status?: InvestigationTerminalStatus;
        readonly inference?: InvestigationInference;
        readonly errorCode?: string;
        readonly reasons?: readonly string[];
      } = {},
    ): Promise<void> => {
      const result = caseFile([...(extra.reasons ?? []), reason]);
      return this.finish(context, {
        status: extra.status ?? deterministicStatus(decision.status, result),
        result,
        inference: extra.inference ?? 'none',
        evidence,
        ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
      });
    };

    if (decision.decision === 'deterministic' || decision.tier === undefined) {
      await this.note(context, 'model', 'skipped', { reason: decision.reasons[0] ?? 'POLICY' });
      const result = caseFile();
      return this.finish(context, {
        status: deterministicStatus(decision.status, result),
        result,
        inference: 'none',
        evidence,
      });
    }

    // ── 3. Modelo (una sola llamada) ─────────────────────────────────────────────────────────
    const skip = async (reason: string): Promise<void> =>
      this.note(context, 'model', 'skipped', { reason });
    if (limits.dailyCeilingMicroUsd === null) {
      const reason = settings && !settings.enabled ? 'ANALYST_DISABLED' : 'INFERENCE_DISABLED';
      await skip(reason);
      return fallback(reason);
    }
    const instructions = settings?.instructions ?? '';
    let tier: InferenceTier = decision.tier;
    let binding = models[tier];
    const routing: string[] = [];
    if (!binding && tier === 'advanced' && models.economy) {
      // Solo hacia abajo: nunca se sube de nivel por falta de un modelo.
      tier = 'economy';
      binding = models.economy;
      routing.push('TIER_DOWNGRADED');
    }
    if (!binding) {
      await skip('MODEL_UNAVAILABLE');
      return fallback('MODEL_UNAVAILABLE');
    }

    const pseudonymizer = new Pseudonymizer(this.options.pseudonymize ?? true);
    const charsPerToken = this.options.pack?.charsPerToken;
    const overheadTokens =
      estimateTokens(ANALYST_SYSTEM_PROMPT, charsPerToken) +
      estimateTokens(buildAnalystMessages('', instructions)[0]!.content as string, charsPerToken);
    const pack: EvidencePack = buildEvidencePack(bundle, {
      pseudonymizer,
      config: {
        ...this.options.pack,
        maxInputTokens: Math.max(0, limits.maxInputTokens - overheadTokens),
      },
    });
    const estimatedInputTokens = overheadTokens + pack.estimatedInputTokens;
    evidence = { ...evidence, estimatedInputTokens, packTruncated: pack.truncated };
    if (estimatedInputTokens > limits.maxInputTokens) {
      await skip('EVIDENCE_PACK_OVER_BUDGET');
      return fallback('EVIDENCE_PACK_OVER_BUDGET', { reasons: routing });
    }

    const prior = await store.findPriorInference(job.tenantId, fingerprint, job.id);
    if (prior) {
      const reusable =
        prior.result?.verified === true &&
        (prior.status === 'completed' || prior.status === 'partial');
      await skip(reusable ? 'REUSED_PRIOR_RESULT' : 'PRIOR_INFERENCE_SETTLED');
      if (!reusable || !prior.result) return fallback('PRIOR_INFERENCE_SETTLED');
      return this.finish(context, {
        status: decision.partial ? 'partial' : 'completed',
        result: {
          ...prior.result,
          deterministic: { reasons: [...decision.reasons, 'REUSED_PRIOR_RESULT'] },
        },
        inference: 'none',
        evidence,
      });
    }

    const maxOutputTokens = Math.max(
      1,
      Math.min(
        decision.maxOutputTokens,
        triageConfig.maxOutputTokens[tier],
        limits.maxOutputTokens,
      ),
    );
    const reservedInputTokens = Math.ceil(
      estimatedInputTokens * Math.max(1, this.options.inputReservationMargin ?? 1.25),
    );
    await this.enter(context, 'model', {
      evidence,
      detail: { tier, model: binding.id, estimatedInputTokens, maxOutputTokens },
    });
    if (await this.guard(context)) return this.cancel(context, 'none');

    const reservation = await store.reserveInvocation(lease, {
      at: clock.now(),
      phase: 'analysis',
      fingerprint,
      tier,
      model: binding.id,
      reservedInputTokens,
      reservedOutputTokens: maxOutputTokens,
      reservedMicroUsd: worstCaseMicroUsd(
        reservedInputTokens,
        maxOutputTokens,
        tier,
        this.options.rateCard,
      ),
      rateCardVersion: this.options.rateCard.version,
      dailyCeilingMicroUsd: limits.dailyCeilingMicroUsd,
      maxCallsPerRun: MAX_MODEL_CALLS_PER_RUN,
    });
    if (!reservation.ok) {
      if (reservation.reason === 'STALE_LEASE') throw new LeaseLostError();
      if (reservation.reason === 'CANCELLED') return this.cancel(context, 'none');
      await skip(reservation.reason);
      return reservation.reason === 'DAILY_CAP'
        ? fallback('DAILY_CAP', { status: 'budget_exhausted', reasons: routing })
        : fallback('RUN_CAP', { status: 'requires_review', reasons: routing });
    }
    const invocation: InvestigationInvocation = reservation.invocation;
    const unreconciled = (): Promise<void> =>
      fallback('USAGE_UNRECONCILED', {
        status: 'usage_unreconciled',
        inference: invocation.tier,
        errorCode: 'USAGE_UNRECONCILED',
        reasons: routing,
      });
    if (invocation.state !== 'reserved') {
      // Un intento anterior ya envió (o pudo enviar) esta llamada: no se repite.
      await skip(`PRIOR_INVOCATION_${invocation.state.toUpperCase()}`);
      if (invocation.state === 'dispatching') {
        this.owned(await store.markUsageUnknown(lease, invocation.id, clock.now()));
      }
      if (invocation.state === 'settled') {
        return fallback('PRIOR_INFERENCE_SETTLED', {
          status: 'requires_review',
          inference: invocation.tier,
        });
      }
      return unreconciled();
    }

    if (await this.guard(context)) {
      await store.releaseInvocation(lease, invocation.id, clock.now());
      return this.cancel(context, 'none');
    }
    const dispatch = await store.markDispatching(lease, invocation.id, clock.now());
    if (dispatch === 'stale') throw new LeaseLostError();
    if (dispatch === 'cancelled') {
      await store.releaseInvocation(lease, invocation.id, clock.now());
      return this.cancel(context, 'none');
    }

    let response: ModelResponse;
    try {
      const remaining = limits.deadlineMs - (clock.now().getTime() - context.startedMs);
      response = await binding.model.complete(
        {
          system: ANALYST_SYSTEM_PROMPT,
          messages: buildAnalystMessages(pack.text, instructions),
          tools: [],
          maxTokens: maxOutputTokens,
          allowTools: false,
        },
        AbortSignal.any([
          context.lost.signal,
          AbortSignal.timeout(Math.max(1, remaining)),
          ...(context.hostSignal ? [context.hostSignal] : []),
        ]),
      );
    } catch (error) {
      // Los errores del SDK pueden traer datos de la solicitud: solo se registran códigos.
      if (error instanceof InferenceNotSentError) {
        this.owned(await store.releaseInvocation(lease, invocation.id, clock.now()));
        await this.note(context, 'model', 'failed', { code: 'MODEL_NOT_SENT', sent: false });
        const outcome = await store.releaseForRetry(lease, {
          at: clock.now(),
          availableAt: this.retryAt(job.attempt),
          errorCode: 'MODEL_NOT_SENT',
          maxAttempts: limits.maxAttempts,
        });
        if (outcome === 'stale') throw new LeaseLostError();
        return;
      }
      this.owned(await store.markUsageUnknown(lease, invocation.id, clock.now()));
      await this.note(context, 'model', 'failed', { code: 'MODEL_OUTCOME_UNKNOWN', sent: true });
      return unreconciled();
    }

    const usage = usageOf(response);
    const estimatedMicroUsd = estimateMicroUsd(usage, tier, this.options.rateCard);
    this.owned(
      await store.settleInvocation(lease, invocation.id, {
        at: clock.now(),
        usage,
        estimatedMicroUsd,
      }),
    );
    await this.note(context, 'model', 'completed', {
      tier,
      model: binding.id,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      estimatedMicroUsd,
      stopReason: response.stopReason,
    });

    // ── 4. Validación ────────────────────────────────────────────────────────────────────────
    // Un resultado tardío conserva su uso, pero el trabajo cancelado sigue cancelado.
    if (await this.guard(context)) return this.cancel(context, tier);
    await this.enter(context, 'validating', { inference: tier });
    if (response.stopReason === 'refusal') {
      await this.note(context, 'validating', 'failed', { code: 'MODEL_REFUSED' });
      return fallback('MODEL_REFUSED', {
        status: 'requires_review',
        inference: tier,
        errorCode: 'MODEL_REFUSED',
        reasons: routing,
      });
    }
    const parsed = parseAnalystOutput(textOf(response), pack.citableIds);
    if (!parsed.ok) {
      await this.note(context, 'validating', 'failed', { code: parsed.code });
      return fallback('INVALID_MODEL_OUTPUT', {
        status: 'requires_review',
        inference: tier,
        errorCode: parsed.code,
        reasons: routing,
      });
    }
    const { output } = parsed;
    await this.note(context, 'validating', 'completed', {
      verified: output.verified,
      issues: output.issues.join(','),
      facts: output.facts.length,
      citations: output.citedIds.length,
    });

    const realId = (shown: string): string => pack.citations.get(shown)?.id ?? shown;
    const restore = (text: string): string => pseudonymizer.unmask(text);
    const statement = (entry: CitedStatement): CitedStatement => ({
      text: restore(entry.text),
      citations: entry.citations.map(realId),
    });
    const result: InvestigationResult = {
      summary: restore(output.summary),
      // Solo la evidencia faltante degrada el veredicto. Que el modelo vea una muestra (con los
      // agregados completos de `eventSummary`) no es evidencia faltante: queda como razón.
      verdict: decision.partial ? 'inconclusive' : output.verdict,
      confidence: decision.partial ? 'low' : output.confidence,
      recommendedPriority: output.recommendedPriority,
      facts: output.facts.map(statement),
      inferences: output.inferences.map(statement),
      gaps: output.gaps.map(restore),
      nextSteps: output.nextSteps.map(restore),
      citations: output.citedIds.flatMap((shown): Citation[] => {
        const citation = pack.citations.get(shown);
        return citation ? [citation] : [];
      }),
      verified: output.verified,
      deterministic: {
        reasons: [
          ...decision.reasons,
          ...routing,
          ...(pack.truncated ? ['EVIDENCE_SAMPLED_FOR_MODEL'] : []),
          ...(output.verified ? [] : ['UNVERIFIED_OUTPUT']),
        ],
      },
    };
    return this.finish(context, {
      status: !output.verified ? 'requires_review' : decision.partial ? 'partial' : 'completed',
      result,
      inference: tier,
      evidence,
    });
  }
}

export type { TriageDecision };
