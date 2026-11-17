/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * «Tu revisión» y la «Bandeja de revisión» del Analista IA. Cuando un expediente pide revisión
 * humana, la persona decide aquí sobre la alerta con las acciones de alertas que ya existen
 * (asignar, triar y cerrar, abrir incidente, reconocer): mismos endpoints, mismas capacidades,
 * compare-and-set, auditoría y outbox del backend. Nada de esto cambia la lógica del analista.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFormRow,
  EuiLoadingContent,
  EuiTextArea,
} from '@elastic/eui';
import {
  AiRunAlert,
  AiRunDetail,
  AiRunPage,
  AiRunSummary,
  Alert,
  ALERT_STATUS_LABEL,
  CAPABILITIES,
  mergeRuns,
  NO_DATA,
  VERDICT_LABEL,
} from '../../common';
import { AlertStepError, getAlert, runAlertCommand, runAlertSteps } from '../api/alert_review';
import { getAiRun, listAiRuns } from '../api/ai_investigations';
import { QapaqApiError } from '../api/client';
import { alertHref } from './ai_analyst_case_file';
import {
  alertStateText,
  falsePositiveNote,
  falsePositivePlan,
  isPendingReview,
  REVIEW_DONE_TEXT,
  REVIEW_NOTE_MAX,
  REVIEW_NOTE_MIN,
  reviewActions,
  ReviewActionId,
  reviewInbox,
  reviewNoteValid,
  ReviewViewer,
  threatSummary,
} from './ai_analyst_model';
import { ConfidenceMeter, VerdictBadge } from './ai_analyst_parts';
import { openInPlace, runHref, RunTime } from './ai_analyst_runs';
import { OpenIncidentForm } from './alerts_view';
import { useChanges, useConsole } from './console_context';
import { ErrorCallout, Mono, PriorityMark } from './primitives';

/** Cuenta de servicio del analista (`apps/api/src/assistant/analyst-actions.ts`). */
const ANALYST_ACTOR = 'svc:qapaq-ai-analyst';

/** Alerta que se revisa: la del sujeto o la única vinculada. */
export function reviewAlertId(run: Pick<AiRunSummary, 'subject'> & { alertIds?: readonly string[] }): string | null {
  if (run.subject.kind === 'alert' && run.subject.id) return run.subject.id;
  return run.alertIds && run.alertIds.length === 1 ? run.alertIds[0] : null;
}

function Assignee({ id, viewerId }: { id: string | null; viewerId: string }) {
  if (!id) return <span className="qapaqMuted">Sin asignar</span>;
  if (id === viewerId) return <strong>Tú</strong>;
  if (id === ANALYST_ACTOR) return <span>Analista IA</span>;
  return <Mono>{id}</Mono>;
}

export type ReviewMode = 'idle' | 'close' | 'incident';

const ACTION_LABEL: Readonly<Record<ReviewActionId, string>> = {
  assign: 'Asignármela',
  close_false_positive: 'Confirmar: falso positivo y cerrar',
  open_incident: 'Confirmar amenaza: abrir incidente',
  acknowledge: 'Marcar revisada sin cambios',
};

const ACTION_ORDER: readonly ReviewActionId[] = [
  'close_false_positive',
  'open_incident',
  'assign',
  'acknowledge',
];

/**
 * Vista del panel (sin estado ni red, para poder probarla): estado actual de la alerta, acciones
 * según capacidades y estado, el formulario de nota y la confirmación de lo hecho.
 */
export function AiReviewPanelView({
  run,
  alert,
  alertLoading = false,
  alertError = null,
  canReadAlert,
  viewer,
  basePath,
  headingId,
  mode = 'idle',
  note = '',
  busy = null,
  error = null,
  done = null,
  compact = false,
  incidentForm = null,
  onAction = () => undefined,
  onNoteChange = () => undefined,
  onCancelForm = () => undefined,
  onConfirmClose = () => undefined,
  onReloadAlert,
}: {
  run: AiRunSummary;
  alert: Alert | null;
  alertLoading?: boolean;
  alertError?: unknown;
  canReadAlert: boolean;
  viewer: ReviewViewer;
  basePath: string;
  headingId: string;
  mode?: ReviewMode;
  note?: string;
  busy?: ReviewActionId | null;
  error?: unknown;
  done?: string | null;
  compact?: boolean;
  incidentForm?: React.ReactNode;
  onAction?: (id: ReviewActionId) => void;
  onNoteChange?: (note: string) => void;
  onCancelForm?: () => void;
  onConfirmClose?: () => void;
  onReloadAlert?: () => void;
}) {
  const alertId = reviewAlertId(run);
  // El estado fresco de la alerta manda sobre el que trajo la lista.
  const current: AiRunAlert | null = alert
    ? {
        status: alert.status,
        assigneeId: alert.assigneeId,
        assignedToYou: alert.assigneeId === viewer.subjectId,
        verdict: alert.verdict,
        incidentId: alert.incidentId,
        incidentByAnalyst:
          run.alert !== null && run.alert.incidentByAnalyst && run.alert.incidentId === alert.incidentId,
      }
    : run.alert;
  const pending = isPendingReview({ status: run.status, alert: current });
  const actions = alert ? reviewActions(alert, viewer) : null;
  const noteLength = note.trim().length;
  const noteInvalid = note.length > 0 && !reviewNoteValid(note);
  return (
    <section
      className="qapaqPanel qapaqAiReview"
      data-pending={pending ? 'true' : 'false'}
      data-compact={compact ? 'true' : 'false'}
      aria-labelledby={headingId}
    >
      <div className="qapaqPanel__header">
        <h2 id={headingId} tabIndex={-1}>
          {pending ? 'Tu revisión' : 'Revisión resuelta'}
        </h2>
        <span className="qapaqAiReview__state" data-pending={pending ? 'true' : 'false'}>
          <span aria-hidden="true">{pending ? '●' : '✓'}</span>{' '}
          {pending ? 'Pendiente' : 'La alerta ya fue atendida'}
        </span>
      </div>
      {!compact && (
        <p className="qapaqAiReview__lead">
          {pending
            ? 'El analista no puede decidir solo esta alerta. Contrasta su conclusión con la evidencia y decide aquí: cada acción se aplica a la alerta con tus permisos y queda auditada.'
            : 'Una persona ya cerró la alerta o la vinculó a un incidente: esta revisión dejó de estar pendiente.'}
        </p>
      )}
      {done && (
        <div className="qapaqAiReview__feedback">
          <EuiCallOut size="s" color="success" iconType="check" title={done}>
            <p role="status">
              El expediente y la bandeja ya reflejan el cambio.
              {alertId && (
                <>
                  {' '}
                  <a href={alertHref(basePath, alertId)}>Ver la alerta</a>
                </>
              )}
            </p>
          </EuiCallOut>
        </div>
      )}
      {error != null && (
        <div className="qapaqAiReview__feedback">
          <ErrorCallout error={error} />
          {error instanceof AlertStepError && alert && (
            <p className="qapaqAi__note" role="status">
              Se aplicaron {error.completed} paso(s) antes del fallo: la alerta quedó «
              {ALERT_STATUS_LABEL[alert.status]}». Revisa su estado y vuelve a intentarlo.
            </p>
          )}
        </div>
      )}
      {!alertId ? (
        <p className="qapaqMuted">
          Esta investigación no tiene una sola alerta vinculada: revisa cada alerta desde su
          detalle.
        </p>
      ) : !canReadAlert ? (
        <p className="qapaqMuted">
          Tu cuenta no puede ver alertas (falta <Mono>{CAPABILITIES.alertsRead}</Mono>), así que
          no puede actuar sobre esta.
        </p>
      ) : !alert ? (
        alertError != null ? (
          <ErrorCallout error={alertError} onRetry={onReloadAlert} />
        ) : alertLoading ? (
          <EuiLoadingContent lines={3} />
        ) : null
      ) : (
        <>
          <dl className="qapaqAiFile qapaqAiReview__alert" aria-label="Estado actual de la alerta">
            <dt>Estado de la alerta</dt>
            <dd>{ALERT_STATUS_LABEL[alert.status] ?? <Mono>{alert.status}</Mono>}</dd>
            <dt>Asignada a</dt>
            <dd>
              <Assignee id={alert.assigneeId} viewerId={viewer.subjectId} />
            </dd>
            <dt>Veredicto</dt>
            <dd>{alert.verdict ? VERDICT_LABEL[alert.verdict] : <span className="qapaqMuted">Sin veredicto</span>}</dd>
            <dt>Incidente</dt>
            <dd>
              {alert.incidentId ? (
                <a href={`${basePath}/app/qapaq-incidents?id=${encodeURIComponent(alert.incidentId)}`}>
                  <Mono>{alert.incidentId}</Mono>
                </a>
              ) : (
                <span className="qapaqMuted">No vinculada</span>
              )}
            </dd>
          </dl>
          {mode === 'close' ? (
            <div className="qapaqAiReview__form">
              <EuiFormRow
                label="Nota de cierre"
                helpText={`${noteLength} de ${REVIEW_NOTE_MAX} caracteres · mínimo ${REVIEW_NOTE_MIN}. Precargada con la conclusión del analista: edítala con lo que verificaste.`}
                isInvalid={noteInvalid}
                error={noteInvalid ? `La nota debe tener entre ${REVIEW_NOTE_MIN} y ${REVIEW_NOTE_MAX} caracteres.` : undefined}
                fullWidth
              >
                <EuiTextArea
                  fullWidth
                  rows={compact ? 3 : 4}
                  value={note}
                  maxLength={REVIEW_NOTE_MAX}
                  isInvalid={noteInvalid}
                  aria-label="Nota de cierre como falso positivo"
                  onChange={(event) => onNoteChange(event.target.value)}
                />
              </EuiFormRow>
              <div className="qapaqAiReview__buttons">
                <EuiButtonEmpty size="s" onClick={onCancelForm} disabled={busy !== null}>
                  Cancelar
                </EuiButtonEmpty>
                <EuiButton
                  size="s"
                  fill
                  isLoading={busy === 'close_false_positive'}
                  isDisabled={!reviewNoteValid(note) || busy !== null}
                  onClick={onConfirmClose}
                  data-test-subj="qapaqAiReviewConfirmClose"
                >
                  Cerrar como falso positivo
                </EuiButton>
              </div>
            </div>
          ) : mode === 'incident' ? (
            <div className="qapaqAiReview__form">{incidentForm}</div>
          ) : (
            actions && (
              <ul className="qapaqAiReview__actions" aria-label="Acciones sobre la alerta">
                {ACTION_ORDER.filter((id) => actions[id].visible).map((id) => {
                  const action = actions[id];
                  const primary = id === 'close_false_positive' || id === 'open_incident';
                  return (
                    <li key={id} className="qapaqAiReview__action" data-action={id}>
                      {primary ? (
                        <EuiButton
                          size="s"
                          fill={id === 'close_false_positive'}
                          color={id === 'open_incident' ? 'danger' : 'primary'}
                          isDisabled={!action.enabled || busy !== null}
                          isLoading={busy === id}
                          onClick={() => onAction(id)}
                          data-test-subj={`qapaqAiReview-${id}`}
                        >
                          {ACTION_LABEL[id]}
                        </EuiButton>
                      ) : (
                        <EuiButton
                          size="s"
                          isDisabled={!action.enabled || busy !== null}
                          isLoading={busy === id}
                          onClick={() => onAction(id)}
                          data-test-subj={`qapaqAiReview-${id}`}
                        >
                          {ACTION_LABEL[id]}
                        </EuiButton>
                      )}
                      {action.reason && <span className="qapaqAiReview__reason">{action.reason}</span>}
                    </li>
                  );
                })}
                <li className="qapaqAiReview__action" data-action="open">
                  <EuiButtonEmpty
                    size="s"
                    iconType="popout"
                    href={alertHref(basePath, alert.id)}
                    data-test-subj="qapaqAiReview-open"
                  >
                    Abrir alerta
                  </EuiButtonEmpty>
                </li>
              </ul>
            )
          )}
          {actions && mode === 'idle' && ACTION_ORDER.every((id) => !actions[id].visible) && (
            <p className="qapaqAi__note">
              Tu cuenta solo puede ver esta alerta: las acciones de revisión exigen permisos de
              triaje, asignación o incidentes.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Panel con estado y red. Lee la alerta por `GET /alerts/:id` (revisión fresca para el
 * compare-and-set) y actúa por los endpoints de alertas existentes. `onChanged` recibe la
 * confirmación para que quien lo contiene recargue el expediente o la bandeja.
 */
export function AiReviewPanel({
  run,
  basePath,
  headingId = 'qapaqAiReviewTitle',
  compact = false,
  onChanged,
}: {
  run: AiRunSummary & Partial<Pick<AiRunDetail, 'result' | 'alertIds'>>;
  basePath: string;
  headingId?: string;
  compact?: boolean;
  onChanged?: (message: string, alert: Alert) => void;
}) {
  const { api, session, can } = useConsole();
  const viewer: ReviewViewer = { subjectId: session.subjectId, can };
  const canReadAlert = can(CAPABILITIES.alertsRead);
  const alertId = reviewAlertId(run);
  const [alert, setAlert] = useState<Alert | null>(null);
  const [alertError, setAlertError] = useState<unknown>(null);
  const [alertLoading, setAlertLoading] = useState(false);
  const [mode, setMode] = useState<ReviewMode>('idle');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<ReviewActionId | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const generation = useRef(0);

  const loadAlert = useCallback(async () => {
    if (!alertId || !canReadAlert) return;
    const mine = ++generation.current;
    setAlertLoading(true);
    try {
      const next = await getAlert(api, alertId);
      if (mine !== generation.current) return;
      setAlert(next);
      setAlertError(null);
    } catch (failure) {
      if (mine === generation.current) setAlertError(failure);
    } finally {
      if (mine === generation.current) setAlertLoading(false);
    }
  }, [api, alertId, canReadAlert]);

  useEffect(() => {
    void loadAlert();
  }, [loadAlert]);

  // Otra persona cambió la alerta: se recarga, salvo mientras se escribe o se actúa.
  useChanges(['alert'], (changes, resync) => {
    if (mode !== 'idle' || busy !== null) return;
    if (resync || changes.some((change) => change.resource.id === alertId)) void loadAlert();
  });

  const succeed = (id: ReviewActionId, next: Alert, message = REVIEW_DONE_TEXT[id]) => {
    setAlert(next);
    setMode('idle');
    setDone(message);
    setError(null);
    if (onChanged) onChanged(message, next);
  };

  const fail = (failure: unknown) => {
    setError(failure);
    if (failure instanceof AlertStepError) {
      setAlert(failure.partial);
      void loadAlert();
    } else if (failure instanceof QapaqApiError && failure.code === 'STATE_CONFLICT') {
      void loadAlert();
    }
  };

  const command = async (id: 'assign' | 'acknowledge') => {
    if (!alert) return;
    setBusy(id);
    setError(null);
    setDone(null);
    try {
      const next =
        id === 'assign'
          ? await runAlertCommand(api, alert, 'assign', { assigneeId: session.subjectId })
          : await runAlertCommand(api, alert, 'acknowledge');
      succeed(id, next);
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(null);
    }
  };

  const confirmClose = async () => {
    if (!alert || !reviewNoteValid(note)) return;
    const plan = falsePositivePlan(alert, viewer);
    if (plan.blocked) return;
    setBusy('close_false_positive');
    setError(null);
    setDone(null);
    try {
      const next = await runAlertSteps(api, alert, plan.steps, {
        subjectId: session.subjectId,
        verdict: 'false_positive',
        note,
      });
      succeed('close_false_positive', next);
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(null);
    }
  };

  const onAction = (id: ReviewActionId) => {
    setError(null);
    setDone(null);
    if (id === 'close_false_positive') {
      setNote(falsePositiveNote(run));
      setMode('close');
    } else if (id === 'open_incident') {
      setMode('incident');
    } else {
      void command(id);
    }
  };

  return (
    <AiReviewPanelView
      run={run}
      alert={alert}
      alertLoading={alertLoading}
      alertError={alertError}
      canReadAlert={canReadAlert}
      viewer={viewer}
      basePath={basePath}
      headingId={headingId}
      mode={mode}
      note={note}
      busy={busy}
      error={error}
      done={done}
      compact={compact}
      onAction={onAction}
      onNoteChange={setNote}
      onCancelForm={() => setMode('idle')}
      onConfirmClose={() => void confirmClose()}
      onReloadAlert={() => void loadAlert()}
      incidentForm={
        alert && mode === 'incident' ? (
          <OpenIncidentForm
            alert={alert}
            heading="Confirmar amenaza: abrir incidente"
            initialSummary={threatSummary(run)}
            onCancel={() => setMode('idle')}
            onOpened={(incidentId) => {
              const message = `${REVIEW_DONE_TEXT.open_incident} (${incidentId})`;
              // El incidente cambió la alerta (vínculo y revisión): se relee antes de confirmar.
              getAlert(api, alert.id).then(
                (next) => succeed('open_incident', next, message),
                () => succeed('open_incident', { ...alert, incidentId }, message),
              );
            }}
          />
        ) : null
      }
    />
  );
}

// ------------------------------------------------------------------ Bandeja de revisión

const INBOX_PAGE = 100;
const INBOX_MAX_PAGES = 3;
const INBOX_POLL_MS = 30000;

export interface ReviewInboxState {
  /** Todas las corridas `requires_review` leídas (pendientes o no); `null` antes de leer. */
  readonly runs: readonly AiRunSummary[] | null;
  /** Solo las pendientes, ordenadas para la bandeja. */
  readonly pending: readonly AiRunSummary[];
  /** Quedaron páginas sin leer: puede haber más pendientes. */
  readonly capped: boolean;
  readonly error: unknown;
  readonly loading: boolean;
  readonly reload: () => void;
  readonly upsert: (run: AiRunSummary) => void;
}

/** Lee las investigaciones en «Requiere revisión» (con el estado actual de su alerta). */
export function useReviewInbox(visible: boolean): ReviewInboxState {
  const { api } = useConsole();
  const [runs, setRuns] = useState<readonly AiRunSummary[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const all: AiRunSummary[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < INBOX_MAX_PAGES; page += 1) {
        const next: AiRunPage = await listAiRuns(api, {
          status: 'requires_review',
          pageSize: INBOX_PAGE,
          ...(cursor ? { cursor } : {}),
        });
        all.push(...next.items);
        cursor = next.nextCursor;
        if (!cursor) break;
      }
      if (!mounted.current) return;
      setRuns(all);
      setCapped(cursor !== null);
      setError(null);
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!visible) return undefined;
    void load();
    const timer = window.setInterval(() => void load(), INBOX_POLL_MS);
    return () => window.clearInterval(timer);
  }, [visible, load]);

  const upsert = useCallback((run: AiRunSummary) => {
    setRuns((current) => {
      if (!current) return current;
      if (run.status !== 'requires_review') return current.filter((item) => item.id !== run.id);
      return mergeRuns(current, [run]);
    });
  }, []);

  return {
    runs,
    pending: runs ? reviewInbox(runs) : [],
    capped,
    error,
    loading,
    reload: () => void load(),
    upsert,
  };
}

/** Revisión en línea dentro de la bandeja: lee el expediente para precargar la nota. */
function InboxReview({
  run,
  basePath,
  onChanged,
}: {
  run: AiRunSummary;
  basePath: string;
  onChanged: (message: string) => void;
}) {
  const { api } = useConsole();
  const [detail, setDetail] = useState<AiRunDetail | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAiRun(api, run.id).then(
      (next) => {
        if (!cancelled) setDetail(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, run.id]);
  return (
    <div className="qapaqAiInbox__review">
      <AiReviewPanel
        run={detail ?? run}
        basePath={basePath}
        headingId={`qapaqAiReviewTitle-${run.id}`}
        compact
        onChanged={(message) => onChanged(message)}
      />
    </div>
  );
}

export interface InboxOutcome {
  readonly jobId: string;
  readonly title: string;
  readonly message: string;
}

/** Fila de la bandeja (sin red): prioridad, alerta, conclusión, estado de la alerta y espera. */
export function AiReviewInboxRow({
  run,
  basePath,
  now,
  expanded,
  onToggle,
  onSelect,
  children,
}: {
  run: AiRunSummary;
  basePath: string;
  now?: number;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  children?: React.ReactNode;
}) {
  const panelId = `qapaqAiInboxReview-${run.id}`;
  return (
    <li className="qapaqAiInbox__item" data-expanded={expanded ? 'true' : 'false'}>
      <div className="qapaqAiInbox__row">
        <span className="qapaqAiInbox__priority">
          {run.priority ? <PriorityMark priority={run.priority} /> : <span className="qapaqMuted">{NO_DATA}</span>}
        </span>
        <span className="qapaqAiInbox__main">
          <span className="qapaqAiInbox__title" data-qapaq-no-translate="">
            {run.subject.title || 'Sin título'}
          </span>
          <span className="qapaqAiInbox__meta">
            <span>{alertStateText(run.alert)}</span>
            <span>
              Esperando desde <RunTime iso={run.finishedAt ?? run.updatedAt ?? run.createdAt} now={now} />
            </span>
          </span>
        </span>
        <span className="qapaqAiInbox__verdict">
          {run.verdict === null ? (
            <span className="qapaqMuted">Sin veredicto</span>
          ) : (
            <>
              <VerdictBadge verdict={run.verdict} />
              <ConfidenceMeter confidence={run.confidence} />
            </>
          )}
        </span>
        <span className="qapaqAiInbox__buttons">
          <EuiButton
            size="s"
            fill={!expanded}
            iconType={expanded ? 'arrowUp' : 'arrowDown'}
            iconSide="right"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={onToggle}
            data-test-subj="qapaqAiInboxToggle"
          >
            {expanded ? 'Ocultar' : 'Revisar aquí'}
          </EuiButton>
          <a
            className="qapaqAiInbox__open"
            href={runHref(basePath, run.id)}
            onClick={(event) => openInPlace(event, () => onSelect(run.id))}
            data-test-subj="qapaqAiInboxInvestigate"
          >
            Investigar
          </a>
        </span>
      </div>
      {expanded && <div id={panelId}>{children}</div>}
    </li>
  );
}

/**
 * Bandeja de revisión: solo revisiones pendientes, de mayor prioridad y más antiguas primero; cada
 * una se decide aquí mismo («Revisar aquí») o en su expediente («Investigar»).
 */
export function AiReviewInbox({
  items,
  loading,
  error,
  capped,
  basePath,
  now,
  onSelect,
  onRetry,
  onChanged,
  empty,
}: {
  items: readonly AiRunSummary[];
  loading: boolean;
  error: unknown;
  capped: boolean;
  basePath: string;
  now?: number;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onChanged: () => void;
  empty: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<InboxOutcome | null>(null);
  return (
    <div className="qapaqAiInbox">
      {outcome && (
        <div className="qapaqAiReview__feedback">
          <EuiCallOut size="s" color="success" iconType="check" title={outcome.message}>
            <p role="status">
              <span data-qapaq-no-translate="">{outcome.title || outcome.jobId}</span>
              {' · '}
              <a
                href={runHref(basePath, outcome.jobId)}
                onClick={(event) => openInPlace(event, () => onSelect(outcome.jobId))}
              >
                Ver el expediente
              </a>
            </p>
          </EuiCallOut>
        </div>
      )}
      {error != null && <ErrorCallout error={error} onRetry={onRetry} />}
      {items.length === 0 ? (
        loading ? (
          <EuiLoadingContent lines={4} />
        ) : (
          <div className="qapaqAiEmpty" role="status">
            {empty}
          </div>
        )
      ) : (
        <ul className="qapaqAiInbox__list" aria-label="Revisiones pendientes">
          {items.map((run) => (
            <AiReviewInboxRow
              key={run.id}
              run={run}
              basePath={basePath}
              now={now}
              expanded={expanded === run.id}
              onToggle={() => setExpanded((current) => (current === run.id ? null : run.id))}
              onSelect={onSelect}
            >
              <InboxReview
                run={run}
                basePath={basePath}
                onChanged={(message) => {
                  setOutcome({ jobId: run.id, title: run.subject.title, message });
                  onChanged();
                }}
              />
            </AiReviewInboxRow>
          ))}
        </ul>
      )}
      {capped && (
        <p className="qapaqAi__note">
          Se muestran las primeras {INBOX_PAGE * INBOX_MAX_PAGES} investigaciones en revisión: puede
          haber más pendientes.
        </p>
      )}
    </div>
  );
}
