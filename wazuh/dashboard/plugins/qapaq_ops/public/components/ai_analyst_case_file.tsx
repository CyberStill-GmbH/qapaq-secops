/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { EuiButton, EuiButtonEmpty, EuiCallOut } from '@elastic/eui';
import {
  AI_ACTION_KIND_LABEL,
  AI_ACTION_STATE_LABEL,
  AI_ACTION_STATE_TONE,
  AI_CITATION_KIND_LABEL,
  AI_EVENT_KIND_LABEL,
  AI_INFERENCE_LABEL,
  AI_INVOCATION_STATE_LABEL,
  AI_INVOCATION_STATE_TONE,
  AI_RUN_STATUS_LABEL,
  AI_TRIGGER_LABEL,
  AiCitation,
  AiEvidence,
  AiResult,
  AiRunAction,
  AiRunDetail,
  AiStatement,
  buildProgressTimeline,
  canCancel,
  canRetry,
  changedAlert,
  confidenceLabel,
  elapsedMs,
  evidenceSourceStateLabel,
  executedActions,
  formatCount,
  formatDuration,
  formatMicroUsd,
  inferenceLabel,
  isActive,
  isTerminal,
  NO_DATA,
  parseMode,
  sanitizeErrorCode,
  SOURCE_STATES,
  SOURCE_TONE,
  SourceState,
  stageLabel,
  verdictLabel,
} from '../../common';
import { citationPath } from '../qapaqzito/chat_client';
import { describeDetail } from './ai_analyst_model';
import { ConfidenceMeter, ReasonTag, VerdictBadge } from './ai_analyst_parts';
import { runCostText } from './ai_analyst_runs';
import { DataZone, HealthMark, Mono, PriorityMark, Timestamp } from './primitives';

/** Alerta principal de la corrida (para «Abrir alerta»); `null` si no hay una sola. */
export function primaryAlertId(run: AiRunDetail): string | null {
  if (run.subject.kind === 'alert' && run.subject.id) return run.subject.id;
  return run.alertIds.length === 1 ? run.alertIds[0] : null;
}

export function alertHref(basePath: string, alertId: string): string {
  return `${basePath}/app/qapaq-alerts?id=${encodeURIComponent(alertId)}`;
}

/** Borrador para Qapaqzito: pide contrastar la recomendación, no ejecutarla. */
export function runQuestion(run: AiRunDetail): string {
  const lines = [
    `Revisa la investigación ${run.id} del Analista IA sobre «${run.subject.title || run.subject.id}».`,
  ];
  if (run.result) {
    lines.push(
      `Recomendación del analista: ${verdictLabel(run.result.verdict)} (${confidenceLabel(
        run.result.confidence,
      ).toLowerCase()}).`,
    );
  }
  lines.push(
    'Contrasta sus hechos e inferencias con la evidencia disponible, dime qué falta verificar y qué revisarías antes de decidir. No cambies la alerta.',
  );
  return lines.join('\n');
}

// ------------------------------------------------------------------ Avisos por estado

/** Un aviso distinto por cada estado que exige leer el expediente con cuidado. */
export function AiRunStatusCallout({ run }: { run: AiRunDetail }) {
  if (isActive(run.status)) {
    if (!run.cancelRequested) return null;
    return (
      <EuiCallOut size="s" color="warning" iconType="clock" title="Detención solicitada">
        <p>
          La investigación se detendrá al terminar el paso en curso. Una llamada que ya se envió al
          modelo puede cobrarse igualmente.
        </p>
      </EuiCallOut>
    );
  }
  switch (run.status) {
    case 'requires_review':
      return (
        <EuiCallOut size="s" color="warning" iconType="alert" title="Requiere revisión humana">
          <p>
            El resultado no superó la verificación automática. Trátalo como hipótesis y contrasta
            cada afirmación con la evidencia antes de actuar.
          </p>
        </EuiCallOut>
      );
    case 'budget_exhausted':
      return (
        <EuiCallOut size="s" color="warning" iconType="alert" title="Presupuesto diario agotado">
          <p>
            No se llamó al modelo porque el techo diario de inferencia ya estaba comprometido. Se
            puede reintentar cuando haya presupuesto.
          </p>
        </EuiCallOut>
      );
    case 'usage_unreconciled':
      return (
        <EuiCallOut size="s" color="warning" iconType="alert" title="Uso por conciliar">
          <p>
            Se envió una llamada al modelo y su consumo no se confirmó. El costo de esta
            investigación es desconocido hasta la conciliación; la consola no la reintenta para no
            duplicar el gasto.
          </p>
        </EuiCallOut>
      );
    case 'partial':
      return (
        <EuiCallOut size="s" color="warning" iconType="alert" title="Resultado parcial">
          <p>
            La investigación terminó sin cubrir toda la evidencia. Lo que aparece abajo está
            incompleto: revisa los vacíos antes de usarlo.
          </p>
        </EuiCallOut>
      );
    case 'failed': {
      const code = sanitizeErrorCode(run.lastErrorCode);
      return (
        <EuiCallOut size="s" color="danger" iconType="cross" title="La investigación falló">
          <p>
            No hay recomendación.{' '}
            {code ? (
              <>
                Causa: <ReasonTag code={code} />
              </>
            ) : (
              'El servicio no informó un código de error.'
            )}
          </p>
        </EuiCallOut>
      );
    }
    case 'cancelled':
      return (
        <EuiCallOut size="s" iconType="minusInCircle" title="Investigación detenida">
          <p>
            Se detuvo antes de terminar. Una llamada que ya se había enviado al modelo puede
            haberse cobrado igualmente.
          </p>
        </EuiCallOut>
      );
    case 'unknown':
      return (
        <EuiCallOut size="s" color="warning" iconType="questionInCircle" title="Estado no reconocido">
          <p>
            Esta versión de la consola no conoce el estado que informó el servicio. No se ofrecen
            acciones ni se asume que la investigación terminó.
          </p>
        </EuiCallOut>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ Piezas

function Section({
  id,
  title,
  count,
  hint,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="qapaqAiSection" aria-labelledby={id}>
      <h3 id={id} className="qapaqAiSection__title" tabIndex={-1}>
        {title}
        {count !== undefined && <span className="qapaqAiSection__count qapaqTabular">{count}</span>}
      </h3>
      {hint && <p className="qapaqAiSection__hint">{hint}</p>}
      {children}
    </section>
  );
}

function CitationChip({ citation, basePath }: { citation: AiCitation; basePath: string }) {
  const path = citation.kind === 'unknown' ? null : citationPath({ ...citation, kind: citation.kind });
  const body = (
    <>
      <span className="qapaqChip__kind">{AI_CITATION_KIND_LABEL[citation.kind]}</span>
      <span data-qapaq-no-translate="" translate="no">
        {citation.label}
      </span>
    </>
  );
  return path ? (
    <a className="qapaqChip qapaqAi__cite" href={`${basePath}${path}`} title={citation.id}>
      {body}
    </a>
  ) : (
    <span className="qapaqChip qapaqChip--static" title={citation.id}>
      {body}
    </span>
  );
}

/** Una referencia puede venir como `id` o como `tipo:id`; si no resuelve, se muestra cruda. */
function resolveCitation(ref: string, citations: readonly AiCitation[]): AiCitation | null {
  for (const citation of citations) {
    if (citation.id === ref || `${citation.kind}:${citation.id}` === ref) return citation;
  }
  return null;
}

function Statements({
  items,
  citations,
  basePath,
  variant,
}: {
  items: readonly AiStatement[];
  citations: readonly AiCitation[];
  basePath: string;
  variant: 'fact' | 'inference';
}) {
  const List = variant === 'fact' ? 'ol' : 'ul';
  return (
    <List className="qapaqAiStatements" data-variant={variant}>
      {items.map((item, index) => (
        <li key={index}>
          <DataZone className="qapaqProse">{item.text}</DataZone>
          {item.citations.length === 0 ? (
            <span className="qapaqAiStatements__nocite">Sin cita a la evidencia</span>
          ) : (
            <span className="qapaqChips">
              {item.citations.map((ref) => {
                const citation = resolveCitation(ref, citations);
                return citation ? (
                  <CitationChip key={ref} citation={citation} basePath={basePath} />
                ) : (
                  <span key={ref} className="qapaqChip qapaqChip--static" title="Cita sin resolver">
                    <Mono>{ref}</Mono>
                  </span>
                );
              })}
            </span>
          )}
        </li>
      ))}
    </List>
  );
}

function TextList({
  items,
  variant,
  ordered = false,
}: {
  items: readonly string[];
  variant: 'gap' | 'step';
  ordered?: boolean;
}) {
  const List = ordered ? 'ol' : 'ul';
  return (
    <List className="qapaqAiStatements" data-variant={variant}>
      {items.map((item, index) => (
        <li key={index}>
          <DataZone className="qapaqProse">{item}</DataZone>
        </li>
      ))}
    </List>
  );
}

// ------------------------------------------------------------------ Conclusión

/**
 * Lo primero del expediente: veredicto, confianza y prioridad sugerida, grandes y juntos.
 * Sin resultado dice por qué (en curso o terminó sin conclusión).
 */
export function AiConclusion({ run }: { run: AiRunDetail }) {
  const result = run.result;
  const active = isActive(run.status);
  if (!result) {
    const stage = stageLabel(run.stage);
    return (
      <section className="qapaqAiConclusion" data-tone="neutral" aria-labelledby="qapaqAiConclusion">
        <h3 id="qapaqAiConclusion" className="qapaqAiConclusion__eyebrow" tabIndex={-1}>
          Conclusión del analista
        </h3>
        <p className="qapaqAiConclusion__empty">
          {active
            ? `Aún no hay conclusión: la investigación sigue en curso${
                stage ? ` (${stage.toLowerCase()})` : ''
              }.`
            : 'Esta investigación no produjo una conclusión.'}
        </p>
      </section>
    );
  }
  const alertChanged = changedAlert(run.actions);
  return (
    <section
      className="qapaqAiConclusion"
      data-verdict={result.verdict ?? 'none'}
      aria-labelledby="qapaqAiConclusion"
    >
      <h3 id="qapaqAiConclusion" className="qapaqAiConclusion__eyebrow" tabIndex={-1}>
        Conclusión del analista{run.status === 'partial' ? ' (resultado parcial)' : ''}
      </h3>
      <div className="qapaqAiConclusion__grid">
        <div className="qapaqAiConclusion__verdict">
          <VerdictBadge verdict={result.verdict} size="l" />
        </div>
        <dl className="qapaqAiConclusion__facts">
          <div>
            <dt>Confianza</dt>
            <dd>
              <ConfidenceMeter confidence={result.confidence} />
            </dd>
          </div>
          <div>
            <dt>Prioridad sugerida</dt>
            <dd>
              {result.recommendedPriority ? (
                <PriorityMark priority={result.recommendedPriority} />
              ) : (
                <span className="qapaqMuted">Sin sugerencia</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Verificación</dt>
            <dd>
              {result.verified ? (
                <HealthMark tone="ok" label="Citas verificadas" />
              ) : (
                <HealthMark tone="warn" label="Sin verificar" />
              )}
            </dd>
          </div>
          <div>
            <dt>Análisis</dt>
            <dd>
              <span className="qapaqAi__tier" data-tier={run.inference ?? 'unknown'}>
                {run.inference === 'none' ? AI_INFERENCE_LABEL.none : `IA: ${inferenceLabel(run.inference).toLowerCase()}`}
              </span>
            </dd>
          </div>
        </dl>
      </div>
      <p className="qapaqAiConclusion__note">
        {alertChanged
          ? 'El analista actuó sobre esta alerta según la configuración vigente; el detalle está en «Acciones del analista». La prioridad sugerida es solo una recomendación.'
          : 'Es una recomendación: el analista no cambió la alerta.'}
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ Resultado

export function AiResultView({
  result,
  partial,
  basePath,
}: {
  result: AiResult;
  partial: boolean;
  basePath: string;
  /** Se conserva por compatibilidad: la nota de cambio vive ahora en la conclusión. */
  alertChanged?: boolean;
}) {
  return (
    <>
      {!result.verified && (
        <EuiCallOut
          size="s"
          color="warning"
          iconType="alert"
          title="Sin citas verificadas: requiere revisión humana"
        >
          <p>Las afirmaciones no se pudieron comprobar contra la evidencia citada.</p>
        </EuiCallOut>
      )}
      <Section id="qapaqAiSummary" title={partial ? 'Resumen (resultado parcial)' : 'Resumen'}>
        <DataZone className="qapaqProse qapaqAiSummary">
          {result.summary || <span className="qapaqMuted">Sin resumen.</span>}
        </DataZone>
      </Section>
      {result.deterministicReasons.length > 0 && (
        <Section id="qapaqAiDeterministic" title="Por qué decidió así">
          <ul className="qapaqAiReasons">
            {result.deterministicReasons.map((code) => (
              <li key={code}>
                <ReasonTag code={code} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section
        id="qapaqAiFacts"
        title="Hechos observados"
        count={result.facts.length}
        hint="Lo que consta en la evidencia, con su cita."
      >
        {result.facts.length === 0 ? (
          <p className="qapaqMuted">No se registraron hechos observados.</p>
        ) : (
          <Statements
            items={result.facts}
            citations={result.citations}
            basePath={basePath}
            variant="fact"
          />
        )}
      </Section>
      <Section
        id="qapaqAiInferences"
        title="Inferencias"
        count={result.inferences.length}
        hint="Hipótesis del analista a partir de los hechos: contrástalas antes de actuar."
      >
        {result.inferences.length === 0 ? (
          <p className="qapaqMuted">No se registraron inferencias.</p>
        ) : (
          <Statements
            items={result.inferences}
            citations={result.citations}
            basePath={basePath}
            variant="inference"
          />
        )}
      </Section>
      <Section
        id="qapaqAiGaps"
        title="Vacíos de evidencia"
        count={result.gaps.length}
        hint="Lo que el analista no pudo ver y podría cambiar la conclusión."
      >
        {result.gaps.length === 0 ? (
          <p className="qapaqMuted">El resultado no declara vacíos de evidencia.</p>
        ) : (
          <TextList items={result.gaps} variant="gap" />
        )}
      </Section>
      <Section id="qapaqAiNextSteps" title="Siguientes pasos" count={result.nextSteps.length}>
        {result.nextSteps.length === 0 ? (
          <p className="qapaqMuted">No se sugirieron pasos.</p>
        ) : (
          <TextList items={result.nextSteps} variant="step" ordered />
        )}
      </Section>
      {result.citations.length > 0 && (
        <Section id="qapaqAiCitations" title="Evidencia citada" count={result.citations.length}>
          <span className="qapaqChips">
            {result.citations.map((citation) => (
              <CitationChip
                key={`${citation.kind}:${citation.id}`}
                citation={citation}
                basePath={basePath}
              />
            ))}
          </span>
        </Section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Acciones del analista

type ActionRef = NonNullable<AiRunAction['ref']>;

function actionRefHref(basePath: string, ref: ActionRef): string | null {
  switch (ref.kind) {
    case 'alert':
      return alertHref(basePath, ref.id);
    case 'incident':
      return `${basePath}/app/qapaq-incidents?id=${encodeURIComponent(ref.id)}`;
    case 'notification':
      return `${basePath}/app/qapaq-notifications`;
    default:
      return null;
  }
}

const ACTION_REF_LABEL: Record<ActionRef['kind'], string> = {
  alert: 'Alerta',
  incident: 'Incidente',
  notification: 'Notificación',
  report: 'Informe',
  unknown: 'Referencia',
};

/**
 * Lo que el analista hizo, propuso u omitió. Solo «Ejecutada» significa que algo cambió: una
 * acción propuesta, omitida o fallida no modificó nada.
 */
export function AiRunActions({
  actions,
  basePath,
  mode = null,
  active = false,
}: {
  actions: readonly AiRunAction[];
  basePath: string;
  mode?: string | null;
  active?: boolean;
}) {
  const executed = executedActions(actions).length;
  const known = parseMode(mode);
  return (
    <Section id="qapaqAiActions" title="Acciones del analista" count={actions.length}>
      <p className="qapaqAiSection__hint" data-test-subj="qapaqAiActionsSummary">
        {executed > 0
          ? `El analista ejecutó ${formatCount(executed)} ${
              executed === 1 ? 'acción' : 'acciones'
            } en esta investigación.`
          : active
            ? 'El analista aún no ejecutó ninguna acción.'
            : 'El analista no ejecutó ninguna acción: no cambió alertas ni envió avisos por esta investigación.'}
        {executed === 0 &&
          known === 'shadow' &&
          ' En modo sombra las acciones solo quedan como propuesta.'}
        {executed === 0 &&
          known === 'assisted' &&
          ' En modo asistido solo puede pedir revisión humana; no cambia alertas.'}
      </p>
      {actions.length > 0 && (
        <ul className="qapaqAiActionList">
          {actions.map((action) => {
            const href = action.ref ? actionRefHref(basePath, action.ref) : null;
            const errorCode = sanitizeErrorCode(action.errorCode);
            return (
              <li key={action.id} className="qapaqAiAction" data-state={action.state}>
                <span className="qapaqAiAction__head">
                  <strong>
                    {action.kind === 'unknown' && action.rawKind ? (
                      <Mono>{action.rawKind}</Mono>
                    ) : (
                      AI_ACTION_KIND_LABEL[action.kind]
                    )}
                  </strong>
                  <HealthMark
                    tone={AI_ACTION_STATE_TONE[action.state]}
                    label={AI_ACTION_STATE_LABEL[action.state]}
                  />
                </span>
                <span className="qapaqAiAction__line">
                  <span className="qapaqMuted">Motivo: </span>
                  {action.reason ? <ReasonTag code={action.reason} /> : <span className="qapaqMuted">{NO_DATA}</span>}
                </span>
                {action.state === 'failed' && (
                  <span className="qapaqAiAction__line">
                    <span className="qapaqMuted">Error: </span>
                    {errorCode ? (
                      <ReasonTag code={errorCode} />
                    ) : (
                      'El servicio no informó un código de error.'
                    )}
                  </span>
                )}
                <span className="qapaqAiAction__line qapaqCellMeta">
                  <Timestamp iso={action.executedAt ?? action.at} />
                  {action.ref && (
                    <>
                      {' · '}
                      {ACTION_REF_LABEL[action.ref.kind]}:{' '}
                      {href ? (
                        <a href={href}>
                          <Mono>{action.ref.id}</Mono>
                        </a>
                      ) : (
                        <Mono>{action.ref.id}</Mono>
                      )}
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Progreso

export function AiProgress({ run, now }: { run: AiRunDetail; now: number }) {
  const active = isActive(run.status);
  const steps = buildProgressTimeline(run.events, active);
  const elapsed = active
    ? formatDuration(elapsedMs(run.createdAt, now))
    : formatDuration(elapsedMs(run.createdAt, run.finishedAt));
  return (
    <Section
      id="qapaqAiProgress"
      title="Cronología"
      hint={
        <>
          {active ? 'Tiempo transcurrido' : 'Duración'}:{' '}
          <span className="qapaqTabular">{elapsed ?? NO_DATA}</span>
          {run.attempt !== null && ` · intento ${formatCount(run.attempt)}`}. Solo se muestran las
          etapas que el servicio registró.
        </>
      }
    >
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Etapas registradas por el servicio"
      >
        {steps.length === 0 ? (
          <p className="qapaqMuted">
            {active
              ? 'El servicio aún no registró ninguna etapa.'
              : 'El servicio no registró etapas para esta investigación.'}
          </p>
        ) : (
          <ol className="qapaqAiSteps">
            {steps.map((step) => {
              const label = stageLabel(step.stage);
              const duration = formatDuration(step.durationMs);
              const entries = describeDetail(step.detail);
              const plain = entries.filter((entry) => entry.label !== null);
              const technical = entries.filter((entry) => entry.label === null);
              return (
                <li key={step.key} className="qapaqAiStep" data-status={step.status}>
                  <span className="qapaqAiStep__mark" aria-hidden="true" />
                  <span className="qapaqAiStep__body">
                    <strong>{label ?? <Mono>{step.stage}</Mono>}</strong>
                    <span className="qapaqCellMeta">
                      {AI_EVENT_KIND_LABEL[step.status]}
                      {duration && ` · ${duration}`}
                      {' · '}
                      <Timestamp iso={step.endedAt ?? step.startedAt} />
                    </span>
                    {plain.length > 0 && (
                      <span className="qapaqAiStep__detail">
                        {plain.map((entry) => (
                          <span key={entry.key}>
                            <span className="qapaqMuted">{entry.label}: </span>
                            {entry.text}
                            {entry.codes.map((code) => (
                              <React.Fragment key={code}>
                                {' '}
                                <ReasonTag code={code} />
                              </React.Fragment>
                            ))}
                          </span>
                        ))}
                      </span>
                    )}
                    {technical.length > 0 && (
                      <details className="qapaqAiDetails">
                        <summary>Detalles técnicos</summary>
                        <span className="qapaqAi__detail" data-qapaq-no-translate="" translate="no">
                          {technical.map((entry) => (
                            <code key={entry.key} className="qapaqMono">
                              {entry.key}={String(step.detail[entry.key])}
                            </code>
                          ))}
                        </span>
                      </details>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ Evidencia

function sourceTone(state: string) {
  return (SOURCE_STATES as readonly string[]).includes(state)
    ? SOURCE_TONE[state as SourceState]
    : 'neutral';
}

export function AiEvidenceCoverage({ evidence }: { evidence: AiEvidence | null }) {
  if (!evidence) {
    return (
      <Section id="qapaqAiEvidence" title="Evidencia examinada">
        <p className="qapaqMuted">Sin registro de evidencia para esta investigación.</p>
      </Section>
    );
  }
  return (
    <Section id="qapaqAiEvidence" title="Evidencia examinada">
      <div className="qapaqAiCoverage">
        {evidence.complete === true ? (
          <HealthMark tone="ok" label="Evidencia completa" />
        ) : evidence.complete === false ? (
          <HealthMark tone="warn" label="Evidencia parcial" />
        ) : (
          <HealthMark tone="neutral" label="Cobertura sin dato" />
        )}
        {evidence.truncated === true && (
          <HealthMark tone="warn" label="Truncada: quedó evidencia sin examinar" />
        )}
      </div>
      <dl className="qapaqAiCoverage__counts">
        <div>
          <dt>Alertas examinadas</dt>
          <dd className="qapaqTabular">{formatCount(evidence.alertsScanned)}</dd>
        </div>
        <div>
          <dt>Eventos examinados</dt>
          <dd className="qapaqTabular">{formatCount(evidence.eventsScanned)}</dd>
        </div>
        <div>
          <dt>Fuentes consultadas</dt>
          <dd className="qapaqTabular">{formatCount(evidence.sources.length)}</dd>
        </div>
      </dl>
      {evidence.sources.length === 0 ? (
        <p className="qapaqMuted">No se informó el estado de las fuentes consultadas.</p>
      ) : (
        <ul className="qapaqAiSources">
          {evidence.sources.map((source) => {
            const state = evidenceSourceStateLabel(source.state);
            return (
              <li key={source.id}>
                <span className="qapaqAiSources__name" data-qapaq-no-translate="">
                  {source.label}
                </span>
                <span className="qapaqAiSources__state">
                  {state ? (
                    <HealthMark tone={sourceTone(source.state)} label={state} />
                  ) : (
                    <Mono>{source.state}</Mono>
                  )}
                </span>
                <span className="qapaqCellMeta">
                  {source.fresh === true
                    ? 'datos al día'
                    : source.fresh === false
                      ? 'datos desactualizados'
                      : 'frescura sin dato'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {evidence.gaps.length > 0 && (
        <>
          <p className="qapaqAi__subhead">Vacíos detectados al recolectar</p>
          <TextList items={evidence.gaps} variant="gap" />
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Uso y costo

export function AiUsageView({ run }: { run: AiRunDetail }) {
  const unknownUsage = run.invocations.some((item) => item.state === 'usage_unknown');
  if (run.inference === 'none' && run.invocations.length === 0) {
    return (
      <Section id="qapaqAiUsage" title="Uso y costo">
        <p className="qapaqAiSection__hint">
          <span className="qapaqAi__tier" data-tier="none">
            {AI_INFERENCE_LABEL.none}
          </span>{' '}
          Resuelta con reglas deterministas, sin llamada al modelo: no generó costo de inferencia.
        </p>
      </Section>
    );
  }
  return (
    <Section id="qapaqAiUsage" title="Uso y costo">
      <dl className="qapaqAiFile">
        <dt>Costo</dt>
        <dd className="qapaqTabular">{runCostText(run)}</dd>
        <dt>Nivel de inferencia</dt>
        <dd>{inferenceLabel(run.inference)}</dd>
        <dt>Tokens (entrada / salida)</dt>
        <dd className="qapaqTabular">
          {formatCount(run.usage ? run.usage.inputTokens : null)} /{' '}
          {formatCount(run.usage ? run.usage.outputTokens : null)}
        </dd>
        <dt>Caché (lectura / escritura)</dt>
        <dd className="qapaqTabular">
          {formatCount(run.usage ? run.usage.cacheReadTokens : null)} /{' '}
          {formatCount(run.usage ? run.usage.cacheWriteTokens : null)}
        </dd>
      </dl>
      {run.invocations.length > 0 && (
        <ul className="qapaqAiInvocations" aria-label="Llamadas al modelo">
          {run.invocations.map((item, index) => (
            <li key={index}>
              <span className="qapaqAiInvocations__head">
                <strong>{stageLabel(item.phase) ?? <Mono>{item.phase}</Mono>}</strong>
                <span className="qapaqTabular">{formatMicroUsd(item.estimatedMicroUsd)}</span>
              </span>
              <span className="qapaqCellMeta">
                {AI_INFERENCE_LABEL[item.tier]} · <Mono>{item.model}</Mono>
              </span>
              <HealthMark
                tone={AI_INVOCATION_STATE_TONE[item.state]}
                label={AI_INVOCATION_STATE_LABEL[item.state]}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="qapaqAi__note">
        {unknownUsage && 'Hay llamadas con uso por conciliar: el costo real puede diferir. '}
        Costo estimado según el tarifario; facturación no conectada.
      </p>
    </Section>
  );
}

// ------------------------------------------------------------------ Ficha

export function AiCaseFacts({ run, basePath }: { run: AiRunDetail; basePath: string }) {
  const active = isActive(run.status);
  const stage = stageLabel(run.stage);
  return (
    <Section id="qapaqAiFile" title="Datos del expediente">
      <dl className="qapaqAiFile">
        <dt>Estado</dt>
        <dd>
          {AI_RUN_STATUS_LABEL[run.status]}
          {active && run.stage && <> · {stage ?? <Mono>{run.stage}</Mono>}</>}
        </dd>
        <dt>Prioridad de la alerta</dt>
        <dd>
          {run.priority ? (
            <PriorityMark priority={run.priority} />
          ) : (
            <span className="qapaqMuted">{NO_DATA}</span>
          )}
        </dd>
        <dt>Alertas</dt>
        <dd>
          {run.alertIds.length === 0 ? (
            <span className="qapaqMuted">
              {run.alertCount === null ? NO_DATA : formatCount(run.alertCount)}
            </span>
          ) : (
            <span className="qapaqIdList">
              {run.alertIds.map((id) => (
                <a key={id} href={alertHref(basePath, id)}>
                  <Mono>{id}</Mono>
                </a>
              ))}
            </span>
          )}
        </dd>
        <dt>Origen</dt>
        <dd>
          {AI_TRIGGER_LABEL[run.trigger]}
          {run.initiatedBy && (
            <>
              {' · '}
              <span data-qapaq-no-translate="">{run.initiatedBy}</span>
            </>
          )}
        </dd>
        <dt>Creada</dt>
        <dd>
          <Timestamp iso={run.createdAt} />
        </dd>
        <dt>Finalizada</dt>
        <dd>{active ? 'En curso' : <Timestamp iso={run.finishedAt} />}</dd>
        <dt>Política</dt>
        <dd>{run.policyVersion ? <Mono>{run.policyVersion}</Mono> : NO_DATA}</dd>
        <dt>Identificador</dt>
        <dd>
          <Mono>{run.id}</Mono>
        </dd>
      </dl>
    </Section>
  );
}

// ------------------------------------------------------------------ Expediente

export function AiCaseFile({
  run,
  basePath,
  now,
  mode = null,
}: {
  run: AiRunDetail;
  basePath: string;
  now: number;
  /** Modo vigente del analista (no el de la corrida, que el contrato no informa). */
  mode?: string | null;
}) {
  const active = isActive(run.status);
  return (
    <div className="qapaqAiCase">
      <AiRunStatusCallout run={run} />
      <AiConclusion run={run} />
      <div className="qapaqAiCase__layout">
        <div className="qapaqAiCase__main">
          {run.result ? (
            <AiResultView
              result={run.result}
              partial={run.status === 'partial'}
              basePath={basePath}
            />
          ) : (
            <Section id="qapaqAiSummary" title="Resultado">
              <p className="qapaqMuted">
                {active
                  ? 'Aún no hay resultado: la investigación sigue en curso.'
                  : 'Esta investigación no produjo un resultado.'}
              </p>
            </Section>
          )}
          <AiRunActions actions={run.actions} basePath={basePath} mode={mode} active={active} />
          <AiEvidenceCoverage evidence={run.evidence} />
          <AiProgress run={run} now={now} />
        </div>
        <aside className="qapaqAiCase__aside" aria-label="Ficha del expediente">
          <AiCaseFacts run={run} basePath={basePath} />
          <AiUsageView run={run} />
        </aside>
      </div>
    </div>
  );
}

/** Acciones del expediente. Detener y reintentar solo con `investigations.run`. */
export function AiCaseFileActions({
  run,
  basePath,
  canRun,
  busy,
  onCancel,
  onRetry,
  onAskQapaqzito,
  onDownloadReport,
  downloading = false,
}: {
  run: AiRunDetail;
  basePath: string;
  canRun: boolean;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onAskQapaqzito: () => void;
  onDownloadReport?: () => void;
  downloading?: boolean;
}) {
  const alertId = primaryAlertId(run);
  return (
    <div className="qapaqAi__actions">
      {alertId && (
        <EuiButtonEmpty
          size="s"
          iconType="popout"
          href={alertHref(basePath, alertId)}
          data-test-subj="qapaqAiOpenAlert"
        >
          Abrir alerta
        </EuiButtonEmpty>
      )}
      <EuiButtonEmpty size="s" iconType="discuss" onClick={onAskQapaqzito} data-test-subj="qapaqAiAskQapaqzito">
        Preguntar a Qapaqzito
      </EuiButtonEmpty>
      {onDownloadReport && isTerminal(run.status) && (
        <EuiButtonEmpty
          size="s"
          iconType="download"
          isLoading={downloading}
          onClick={onDownloadReport}
          data-test-subj="qapaqAiDownloadReport"
        >
          Guardar informe como PDF
        </EuiButtonEmpty>
      )}
      {canRun && canCancel(run) && (
        <EuiButton
          size="s"
          color="danger"
          isDisabled={busy}
          onClick={onCancel}
          data-test-subj="qapaqAiCancel"
        >
          Detener
        </EuiButton>
      )}
      {canRun && canRetry(run) && (
        <EuiButton size="s" fill isDisabled={busy} onClick={onRetry} data-test-subj="qapaqAiRetry">
          Reintentar
        </EuiButton>
      )}
    </div>
  );
}
