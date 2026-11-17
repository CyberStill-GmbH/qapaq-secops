/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiConfirmModal,
  EuiFieldText,
  EuiFormRow,
  EuiLoadingContent,
  EuiSpacer,
  EuiTab,
  EuiTabs,
} from '@elastic/eui';
import {
  AI_MODE_LABEL,
  AI_MODE_SUMMARY,
  AI_TRIGGER_LABEL,
  AiBudget,
  AiRunDetail,
  AiRunSummary,
  CAPABILITIES,
  isActive,
  isValidAiRunId,
  isValidAlertId,
  mergeRuns,
  parseMode,
} from '../../common';
import {
  cancelAiRun,
  getAiBudget,
  getAiRun,
  getAiRunReport,
  isAnalystUnavailable,
  listAiRuns,
  retryAiRun,
  startAiRun,
} from '../api/ai_investigations';
import { QapaqApiError } from '../api/client';
import { askQapaqzito } from '../qapaqzito_bridge';
import { AiActivityTab } from './ai_analyst_activity';
import { AiCaseFile, AiCaseFileActions, primaryAlertId, runQuestion } from './ai_analyst_case_file';
import { openReportWindow, printAnalystReport } from './ai_analyst_download';
import {
  EMPTY_FILTERS,
  filterRuns,
  hasFilters,
  isFailedRun,
  isPendingReview,
  RunFilters,
  RunView,
} from './ai_analyst_model';
import { AiReviewInbox, AiReviewPanel, useReviewInbox } from './ai_analyst_review';
import { AiReportsTab } from './ai_analyst_reports';
import { AiRunFiltersBar, AiRunList, RunStatusMark, RunTime } from './ai_analyst_runs';
import { AiSettingsTab } from './ai_analyst_settings';
import { QapaqPage, useConsole } from './console_context';
import { ErrorCallout, Mono, PriorityMark, useAsync } from './primitives';

/** Refresco en vivo: solo con investigaciones activas a la vista y la pestaña visible. */
const POLL_MS = 5000;
/** Tope de investigaciones activas fuera de la primera página que se refrescan una a una. */
const STALE_REFRESH_MAX = 10;

const PAGE_DESCRIPTION =
  'Investiga alertas automáticamente: qué concluyó, qué hizo, qué necesita a una persona y cuánto costó.';

type AnalystTab = 'activity' | 'runs' | 'reports' | 'settings';

const TABS: ReadonlyArray<{ id: AnalystTab; label: string }> = [
  { id: 'activity', label: 'Resumen' },
  { id: 'runs', label: 'Investigaciones' },
  { id: 'reports', label: 'Informes' },
  { id: 'settings', label: 'Configuración' },
];

/** Qué hará el analista con una investigación nueva, según el modo vigente. */
function modeConsequence(mode: string | null): string {
  const known = parseMode(mode);
  if (!known) {
    return 'No se pudo confirmar el modo de operación vigente: revisa la pestaña «Configuración» antes de continuar.';
  }
  return `${AI_MODE_LABEL[known]}: el analista ${AI_MODE_SUMMARY[known]}.`;
}

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const listener = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, []);
  return visible;
}

function UnavailableCallout({ onRetry }: { onRetry: () => void }) {
  return (
    <EuiCallOut
      color="warning"
      iconType="offline"
      title="El analista no está habilitado o publicado en este entorno"
    >
      <p>
        El servicio respondió que el recurso no existe. No hay investigaciones que mostrar hasta que
        el Analista IA se publique y se habilite aquí.
      </p>
      <EuiButtonEmpty size="xs" flush="left" onClick={onRetry}>
        Volver a comprobar
      </EuiButtonEmpty>
    </EuiCallOut>
  );
}

export function AiAnalystView({
  selectedId,
  onSelect,
  basePath,
  initialAlertId,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  basePath: string;
  /** `?alertId=`: precarga el control «Investigar alerta» (desde el detalle de una alerta). */
  initialAlertId?: string | null;
}) {
  const { can } = useConsole();
  if (!can(CAPABILITIES.investigationsRead)) {
    return (
      <QapaqPage title="Analista IA" description={PAGE_DESCRIPTION}>
        <EuiCallOut
          color="warning"
          iconType="lock"
          title="Tu cuenta no tiene acceso al Analista IA"
        >
          <p>
            Falta la capacidad <Mono>{CAPABILITIES.investigationsRead}</Mono>. Pídela a quien
            administra los roles del SOC.
          </p>
        </EuiCallOut>
      </QapaqPage>
    );
  }
  return (
    <AiAnalystConsole
      selectedId={selectedId}
      onSelect={onSelect}
      basePath={basePath}
      initialAlertId={initialAlertId ?? null}
    />
  );
}

function AiAnalystConsole({
  selectedId,
  onSelect,
  basePath,
  initialAlertId,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  basePath: string;
  initialAlertId: string | null;
}) {
  const { api, can } = useConsole();
  const canRun = can(CAPABILITIES.investigationsRun);
  const visible = useTabVisible();
  const [filters, setFilters] = useState<RunFilters>(EMPTY_FILTERS);
  const status = filters.status;
  const [items, setItems] = useState<readonly AiRunSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [liveBudget, setLiveBudget] = useState<AiBudget | null>(null);
  // `?alertId=` precarga «Investigar alerta», que vive en «Investigaciones»: se abre ahí.
  const [tab, setTab] = useState<AnalystTab>(initialAlertId ? 'runs' : 'activity');

  const page = useAsync(() => listAiRuns(api, { status: status || null }), [api, status]);
  const budget = useAsync(() => getAiBudget(api), [api]);
  // La bandeja de revisión lee sus propias investigaciones: no depende de la primera página.
  const inbox = useReviewInbox(visible);
  const inboxUpsert = inbox.upsert;

  // Lo que el refresco silencioso necesita leer sin volver a crear el intervalo.
  const statusRef = useRef(status);
  statusRef.current = status;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const refreshing = useRef(false);

  useEffect(() => {
    if (page.data) {
      setItems(page.data.items);
      setCursor(page.data.nextCursor);
      setMoreError(null);
    }
  }, [page.data]);

  useEffect(() => {
    if (budget.data) setLiveBudget(budget.data);
  }, [budget.data]);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const requested = statusRef.current;
    try {
      const first = await listAiRuns(api, { status: requested || null });
      if (statusRef.current !== requested) return;
      // Una investigación activa que ya no está en la primera página (terminó y salió del filtro,
      // o quedó más abajo) se consulta por id: si no, seguiría «en curso» para siempre.
      const listed = new Set(first.items.map((run) => run.id));
      const stale = itemsRef.current
        .filter((run) => isActive(run.status) && !listed.has(run.id) && isValidAiRunId(run.id))
        .slice(0, STALE_REFRESH_MAX);
      const details = await Promise.all(
        stale.map((run) => getAiRun(api, run.id).catch(() => null)),
      );
      if (statusRef.current !== requested) return;
      const updates: AiRunSummary[] = [...first.items];
      for (const detail of details) if (detail) updates.push(detail);
      setItems((current) => mergeRuns(current, updates));
      const nextBudget = await getAiBudget(api).catch(() => null);
      if (nextBudget) setLiveBudget(nextBudget);
    } catch {
      // Se conserva lo visible; el siguiente ciclo vuelve a intentar.
    } finally {
      refreshing.current = false;
    }
  }, [api]);

  // El modo y el techo cambian al guardar la configuración: la franja debe reflejarlo.
  const refreshBudget = useCallback(async () => {
    const next = await getAiBudget(api).catch(() => null);
    if (next) setLiveBudget(next);
  }, [api]);

  const hasActive = items.some((run) => isActive(run.status));
  useEffect(() => {
    if (!hasActive || !visible) return undefined;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, visible, refresh]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const requested = status;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await listAiRuns(api, { status: requested || null, cursor });
      if (statusRef.current !== requested) return;
      setItems((current) => {
        const known = new Set(current.map((run) => run.id));
        return [...current, ...next.items.filter((run) => !known.has(run.id))];
      });
      setCursor(next.nextCursor);
    } catch (failure) {
      setMoreError(failure);
    } finally {
      setLoadingMore(false);
    }
  };

  const upsert = useCallback(
    (run: AiRunSummary) => {
      setItems((current) => mergeRuns(current, [run]));
      inboxUpsert(run);
    },
    [inboxUpsert],
  );

  /** Desde «Resumen»: abre la lista con el filtro de la cifra que se pulsó. */
  const openList = useCallback((patch: Partial<RunFilters>) => {
    setFilters({ ...EMPTY_FILTERS, ...patch });
    setTab('runs');
  }, []);

  const unavailable = page.error != null && isAnalystUnavailable(page.error);
  const mode = liveBudget ? liveBudget.mode : null;

  if (selectedId)
    return (
      <QapaqPage
        title="Expediente de investigación"
        description="Conclusión del analista, la evidencia que la respalda y lo que hizo, en un solo documento."
      >
        <RunDocument
          key={selectedId}
          runId={selectedId}
          basePath={basePath}
          mode={mode}
          canRun={canRun}
          visible={visible}
          onClose={() => onSelect(null)}
          onChanged={upsert}
        />
      </QapaqPage>
    );

  const reviewMode = filters.view === 'attention';
  const shown = filterRuns(items, filters);
  const inboxShown = filterRuns(inbox.pending, { ...filters, status: '' });
  const pendingReviews = inbox.runs ? inbox.pending.length : items.filter(isPendingReview).length;
  const counts: Record<RunView, number> = {
    all: items.length,
    attention: pendingReviews,
    failed: items.filter(isFailedRun).length,
    escalated: items.filter((run) => run.actionKinds.includes('escalate')).length,
    active: items.filter((run) => isActive(run.status)).length,
  };

  return (
    <QapaqPage title="Analista IA" description={PAGE_DESCRIPTION}>
      {unavailable ? (
        <UnavailableCallout onRetry={page.reload} />
      ) : (
        <>
          <EuiTabs size="s" className="qapaqTabs" aria-label="Secciones del Analista IA">
            {TABS.map((item) => (
              <EuiTab
                key={item.id}
                id={`qapaqAiTab-${item.id}`}
                aria-controls="qapaqAiTabPanel"
                isSelected={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                {item.id === 'runs' && counts.attention + counts.failed > 0 && (
                  <span
                    className="qapaqAiTabBadge qapaqTabular"
                    title={`Requieren atención: ${counts.attention} en revisión y ${counts.failed} fallidas`}
                  >
                    {counts.attention + counts.failed}
                  </span>
                )}
              </EuiTab>
            ))}
          </EuiTabs>
          <EuiSpacer size="m" />
          <div id="qapaqAiTabPanel" role="tabpanel" aria-labelledby={`qapaqAiTab-${tab}`}>
            {tab === 'activity' ? (
              <AiActivityTab
                basePath={basePath}
                visible={visible}
                onSelect={onSelect}
                budget={liveBudget}
                recentRuns={items}
                onFilter={openList}
              />
            ) : tab === 'reports' ? (
              <AiReportsTab />
            ) : tab === 'settings' ? (
              <AiSettingsTab onSaved={() => void refreshBudget()} />
            ) : (
              <div className="qapaqAiRunsTab">
                {canRun && (
                  <StartControl
                    initialAlertId={initialAlertId}
                    mode={mode}
                    onStarted={(run) => {
                      upsert(run);
                      onSelect(run.id);
                    }}
                  />
                )}
                <section className="qapaqPanel" aria-labelledby="qapaqAiRunsTitle">
                  <div className="qapaqPanel__header">
                    <h2 id="qapaqAiRunsTitle">
                      {reviewMode ? 'Bandeja de revisión' : 'Investigaciones'}
                    </h2>
                    <span className="qapaqPanel__meta" role="status">
                      {reviewMode
                        ? inbox.runs === null
                          ? 'Cargando…'
                          : `${inboxShown.length} pendientes · primero la mayor prioridad y la que más espera`
                        : page.loading && items.length === 0
                          ? 'Cargando…'
                          : `${shown.length} de ${items.length} cargadas${cursor ? ' · hay más' : ''}`}
                      {!reviewMode &&
                        hasActive &&
                        (visible
                          ? ' · se actualiza cada 5 s'
                          : ' · actualización en pausa (pestaña oculta)')}
                    </span>
                  </div>
                  <AiRunFiltersBar filters={filters} counts={counts} onChange={setFilters} />
                  <EuiSpacer size="m" />
                  {reviewMode ? (
                    <AiReviewInbox
                      items={inboxShown}
                      loading={inbox.loading}
                      error={inbox.error}
                      capped={inbox.capped}
                      basePath={basePath}
                      onSelect={onSelect}
                      onRetry={inbox.reload}
                      onChanged={() => {
                        inbox.reload();
                        void refresh();
                      }}
                      empty={
                        <ReviewInboxEmpty
                          filtered={hasFilters({ ...filters, view: 'all', status: '' })}
                          onClear={() => setFilters({ ...EMPTY_FILTERS, view: 'attention' })}
                        />
                      }
                    />
                  ) : page.error != null ? (
                    <ErrorCallout error={page.error} onRetry={page.reload} />
                  ) : (
                    <>
                      <AiRunList
                        items={shown}
                        loading={page.loading}
                        basePath={basePath}
                        selectedId={selectedId}
                        onSelect={onSelect}
                        empty={
                          <RunsEmpty
                            filtered={hasFilters(filters)}
                            loaded={items.length}
                            hasMore={cursor !== null}
                            canRun={canRun}
                            onClear={() => setFilters(EMPTY_FILTERS)}
                          />
                        }
                      />
                      {moreError != null && (
                        <>
                          <EuiSpacer size="s" />
                          <ErrorCallout error={moreError} onRetry={loadMore} />
                        </>
                      )}
                      {cursor && (
                        <div className="qapaqAiRuns__more">
                          <EuiButtonEmpty size="s" onClick={loadMore} isLoading={loadingMore}>
                            Cargar más investigaciones
                          </EuiButtonEmpty>
                        </div>
                      )}
                    </>
                  )}
                </section>
              </div>
            )}
          </div>
        </>
      )}
    </QapaqPage>
  );
}

/** Bandeja vacía: en positivo, o por qué con filtros. */
function ReviewInboxEmpty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  if (filtered) {
    return (
      <>
        <p>
          <strong>Ninguna revisión pendiente coincide con los filtros.</strong>
        </p>
        <EuiButtonEmpty size="s" flush="left" iconType="cross" onClick={onClear}>
          Quitar filtros
        </EuiButtonEmpty>
      </>
    );
  }
  return (
    <>
      <p>
        <strong>
          <span aria-hidden="true">✓</span> No hay revisiones pendientes.
        </strong>
      </p>
      <p className="qapaqCellMeta">
        Una revisión sale de la bandeja cuando su alerta se cierra o pasa a un incidente.
      </p>
    </>
  );
}

/** Lista vacía: por qué y qué hacer, según haya filtros o no. */
function RunsEmpty({
  filtered,
  loaded,
  hasMore,
  canRun,
  onClear,
}: {
  filtered: boolean;
  loaded: number;
  hasMore: boolean;
  canRun: boolean;
  onClear: () => void;
}) {
  if (filtered) {
    return (
      <>
        <p>
          <strong>Ninguna investigación coincide con los filtros.</strong>
        </p>
        <p className="qapaqCellMeta">
          {loaded > 0
            ? `Se revisaron las ${loaded} investigaciones cargadas${
                hasMore ? '; carga más para buscar entre las anteriores' : ''
              }.`
            : 'No hay investigaciones en este estado.'}
        </p>
        <EuiButtonEmpty size="s" flush="left" iconType="cross" onClick={onClear}>
          Quitar filtros
        </EuiButtonEmpty>
      </>
    );
  }
  return (
    <>
      <p>
        <strong>Aún no hay investigaciones.</strong>
      </p>
      <p className="qapaqCellMeta">
        El analista las crea solo, después de las reglas y la correlación, para las alertas dentro
        del alcance configurado.
        {canRun ? ' También puedes investigar una alerta concreta con su identificador.' : ''}
      </p>
    </>
  );
}

// ------------------------------------------------------------------ Iniciar

function StartControl({
  initialAlertId,
  mode,
  onStarted,
}: {
  initialAlertId: string | null;
  mode: string | null;
  onStarted: (run: AiRunDetail) => void;
}) {
  const { api } = useConsole();
  const [alertId, setAlertId] = useState(initialAlertId ?? '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<{ id: string; created: boolean | null } | null>(null);
  const trimmed = alertId.trim();
  const valid = isValidAlertId(trimmed);
  const invalid = trimmed.length > 0 && !valid;

  const start = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await startAiRun(api, trimmed);
      setOutcome({ id: result.run.id, created: result.created });
      setAlertId('');
      onStarted(result.run);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <section
      className="qapaqPanel qapaqAiStart"
      data-preloaded={initialAlertId ? 'true' : 'false'}
      aria-labelledby="qapaqAiStartTitle"
    >
      <div className="qapaqAiStart__intro">
        <h2 id="qapaqAiStartTitle">Investigar una alerta</h2>
        <p className="qapaqCellMeta">
          Pide al analista que investigue ahora una alerta concreta. Si ya existe una investigación
          idéntica, se reutiliza sin costo.
        </p>
      </div>
      <form
        className="qapaqAiStart__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) setConfirming(true);
        }}
      >
        <EuiFormRow
          label="Identificador de la alerta"
          display="rowCompressed"
          isInvalid={invalid}
          error={invalid ? 'Usa el identificador de la alerta, sin espacios.' : undefined}
          fullWidth
        >
          <EuiFieldText
            compressed
            fullWidth
            value={alertId}
            maxLength={128}
            isInvalid={invalid}
            placeholder="ID de la alerta"
            aria-label="Identificador de la alerta a investigar"
            data-qapaq-no-translate=""
            onChange={(event) => setAlertId(event.target.value)}
          />
        </EuiFormRow>
        <EuiButton size="s" fill type="submit" isDisabled={!valid} isLoading={busy}>
          Investigar
        </EuiButton>
      </form>
      {error != null && (
        <div className="qapaqAiStart__feedback">
          <ErrorCallout error={error} />
        </div>
      )}
      {outcome && (
        <div className="qapaqAiStart__feedback">
          <EuiCallOut
            size="s"
            color={outcome.created === false ? 'primary' : 'success'}
            iconType={outcome.created === false ? 'iInCircle' : 'check'}
            title={
              outcome.created === false
                ? 'Ya existía una investigación idéntica: se reutilizó'
                : outcome.created === true
                  ? 'Investigación creada'
                  : 'Investigación registrada'
            }
          >
            <p role="status">
              {outcome.created === false
                ? 'No se inició una corrida nueva ni se consumió presupuesto adicional. '
                : ''}
              Expediente <Mono>{outcome.id}</Mono>.
            </p>
          </EuiCallOut>
        </div>
      )}
      {confirming && (
        <EuiConfirmModal
          title="Investigar esta alerta"
          aria-label="Confirmar la investigación de la alerta"
          onCancel={() => setConfirming(false)}
          onConfirm={start}
          cancelButtonText="Cancelar"
          confirmButtonText="Investigar"
          confirmButtonDisabled={busy}
          defaultFocusedButton="confirm"
        >
          <p>
            Se investigará la alerta <Mono>{trimmed}</Mono>. {modeConsequence(mode)}
          </p>
          <p>
            Puede consumir presupuesto de inferencia del día si las reglas deterministas no la
            resuelven. Si ya existe una investigación idéntica, se reutiliza sin costo adicional.
          </p>
        </EuiConfirmModal>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ Expediente

const REVIEW_HEADING = 'qapaqAiReviewTitle';

/** Índice del expediente: salta a la sección y le pasa el foco (sin tocar la URL). */
function CaseNav({ run }: { run: AiRunDetail }) {
  const result = run.result;
  const links: Array<{ id: string; label: string; count?: number }> = [
    ...(run.status === 'requires_review' ? [{ id: REVIEW_HEADING, label: 'Tu revisión' }] : []),
    { id: 'qapaqAiConclusion', label: 'Conclusión' },
    { id: 'qapaqAiSummary', label: 'Resumen' },
  ];
  if (result) {
    links.push(
      { id: 'qapaqAiFacts', label: 'Hechos', count: result.facts.length },
      { id: 'qapaqAiInferences', label: 'Inferencias', count: result.inferences.length },
      { id: 'qapaqAiGaps', label: 'Vacíos', count: result.gaps.length },
      { id: 'qapaqAiNextSteps', label: 'Siguientes pasos', count: result.nextSteps.length },
    );
  }
  links.push(
    { id: 'qapaqAiActions', label: 'Acciones', count: run.actions.length },
    { id: 'qapaqAiEvidence', label: 'Evidencia' },
    { id: 'qapaqAiProgress', label: 'Cronología' },
    { id: 'qapaqAiUsage', label: 'Uso y costo' },
  );
  return (
    <nav className="qapaqAiDocument__navigation" aria-label="Secciones del expediente">
      {links.map((link) => (
        <a
          key={link.id}
          href={`#${link.id}`}
          onClick={(event) => {
            const target = document.getElementById(link.id);
            if (!target) return;
            event.preventDefault();
            target.scrollIntoView({ block: 'start' });
            if (target.hasAttribute('tabindex')) target.focus({ preventScroll: true });
          }}
        >
          {link.label}
          {link.count !== undefined && <span className="qapaqTabular"> {link.count}</span>}
        </a>
      ))}
    </nav>
  );
}

function RunDocument({
  runId,
  basePath,
  mode,
  canRun,
  visible,
  onClose,
  onChanged,
}: {
  runId: string;
  basePath: string;
  mode: string | null;
  canRun: boolean;
  visible: boolean;
  onClose: () => void;
  onChanged: (run: AiRunDetail) => void;
}) {
  const { api, notifications } = useConsole();
  const validId = isValidAiRunId(runId);
  useEffect(() => {
    const title = document.getElementById('qapaqAiRunTitle');
    if (title) title.focus();
  }, [runId]);
  const loaded = useAsync(
    () => (validId ? getAiRun(api, runId) : Promise.resolve(null)),
    [api, runId, validId],
  );
  const [run, setRun] = useState<AiRunDetail | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'retry' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  const [downloading, setDownloading] = useState(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    if (loaded.data) {
      setRun(loaded.data);
      changed.current(loaded.data);
    }
  }, [loaded.data]);

  const active = run !== null && isActive(run.status);

  // Reloj del tiempo transcurrido: solo corre mientras la investigación sigue activa.
  useEffect(() => {
    if (!active || !visible) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, visible]);

  // Progreso real: se vuelve a leer el expediente; no hay SSE ni pasos simulados.
  useEffect(() => {
    if (!active || !visible || confirm !== null || busy) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      getAiRun(api, runId).then(
        (next) => {
          if (cancelled) return;
          setRun(next);
          changed.current(next);
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, visible, confirm, busy, api, runId]);

  const command = async (kind: 'cancel' | 'retry') => {
    if (!run || run.revision === null) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        kind === 'cancel'
          ? await cancelAiRun(api, run.id, run.revision)
          : await retryAiRun(api, run.id, run.revision);
      setRun(result.run);
      changed.current(result.run);
    } catch (failure) {
      setError(failure);
      // Otra persona o el propio trabajador cambió la corrida: se recarga antes de reintentar.
      if (failure instanceof QapaqApiError && failure.code === 'STATE_CONFLICT') loaded.reload();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const downloadReport = async () => {
    if (!run || downloading) return;
    setDownloading(true);
    setError(null);
    let reportWindow: Window | undefined;
    try {
      reportWindow = openReportWindow();
      const report = await getAiRunReport(api, run.id);
      printAnalystReport(report.filename, report.markdown, basePath, reportWindow);
    } catch (failure) {
      if (reportWindow) reportWindow.close();
      setError(failure);
    } finally {
      setDownloading(false);
    }
  };

  const ask = () => {
    if (!run) return;
    const alertId = primaryAlertId(run);
    const opened = askQapaqzito({
      prompt: runQuestion(run),
      ...(alertId ? { context: { alertId } } : {}),
    });
    if (!opened) {
      notifications.toasts.addWarning({
        title: 'Qapaqzito no está disponible en esta página',
      });
    }
  };

  return (
    <article className="qapaqAiDocument" aria-labelledby="qapaqAiRunTitle">
      <div className="qapaqAiDocument__toolbar">
        <EuiButtonEmpty iconType="arrowLeft" flush="left" onClick={onClose}>
          Volver al Analista IA
        </EuiButtonEmpty>
        <div className="qapaqAiDocument__tools">
          <EuiButtonEmpty
            size="s"
            iconType="refresh"
            onClick={loaded.reload}
            isLoading={loaded.loading}
          >
            Actualizar
          </EuiButtonEmpty>
          {run && (
            <AiCaseFileActions
              run={run}
              basePath={basePath}
              canRun={canRun}
              busy={busy}
              onCancel={() => setConfirm('cancel')}
              onRetry={() => setConfirm('retry')}
              onAskQapaqzito={ask}
              onDownloadReport={() => void downloadReport()}
              downloading={downloading}
            />
          )}
        </div>
      </div>
      <header className="qapaqAiDocument__header">
        <p className="qapaqEyebrow">Expediente · Analista IA</p>
        <h2 id="qapaqAiRunTitle" className="qapaqAiDocument__title" tabIndex={-1} data-qapaq-no-translate="">
          {run ? run.subject.title || run.id : 'Investigación'}
        </h2>
        {run && (
          <p className="qapaqAiDocument__meta">
            <RunStatusMark status={run.status} />
            {run.priority && <PriorityMark priority={run.priority} />}
            <span>{AI_TRIGGER_LABEL[run.trigger]}</span>
            <span>
              Creada <RunTime iso={run.createdAt} />
            </span>
          </p>
        )}
      </header>
      {run && <CaseNav run={run} />}
      <div className="qapaqAiDocument__body">
        {!validId && (
          <EuiCallOut
            size="s"
            color="warning"
            iconType="alert"
            title="El identificador de la investigación no es válido"
          >
            <p>Abre el expediente desde la lista de investigaciones.</p>
            <EuiButtonEmpty size="xs" flush="left" onClick={onClose}>
              Ir a la lista
            </EuiButtonEmpty>
          </EuiCallOut>
        )}
        {validId && loaded.loading && !run && <EuiLoadingContent lines={8} />}
        {validId && loaded.error != null && !run && (
          <ErrorCallout error={loaded.error} onRetry={loaded.reload} />
        )}
        {error != null && (
          <>
            <ErrorCallout error={error} />
            <EuiSpacer size="m" />
          </>
        )}
        {run && run.status === 'requires_review' && (
          <>
            <AiReviewPanel
              run={run}
              basePath={basePath}
              headingId={REVIEW_HEADING}
              // Tras actuar se relee el expediente: trae el estado nuevo de la alerta.
              onChanged={() => loaded.reload()}
            />
            <EuiSpacer size="m" />
          </>
        )}
        {run && <AiCaseFile run={run} basePath={basePath} now={now} mode={mode} />}
      </div>
      {confirm === 'cancel' && (
        <EuiConfirmModal
          title="Detener la investigación"
          aria-label="Confirmar la detención de la investigación"
          onCancel={() => setConfirm(null)}
          onConfirm={() => command('cancel')}
          cancelButtonText="Seguir investigando"
          confirmButtonText="Detener"
          buttonColor="danger"
          confirmButtonDisabled={busy}
          defaultFocusedButton="cancel"
        >
          <p>
            La investigación se detiene al terminar el paso en curso y no produce recomendación. Las
            acciones que el analista ya ejecutó no se deshacen.
          </p>
          <p>
            Una llamada que ya se envió al modelo no se puede anular y puede cobrarse igualmente.
          </p>
        </EuiConfirmModal>
      )}
      {confirm === 'retry' && (
        <EuiConfirmModal
          title="Reintentar la investigación"
          aria-label="Confirmar el reintento de la investigación"
          onCancel={() => setConfirm(null)}
          onConfirm={() => command('retry')}
          cancelButtonText="Cancelar"
          confirmButtonText="Reintentar"
          confirmButtonDisabled={busy}
          defaultFocusedButton="confirm"
        >
          <p>
            El reintento es idempotente: retoma la misma investigación y no repite las fases que ya
            quedaron confirmadas.
          </p>
          <p>
            Las fases pendientes pueden consumir presupuesto de inferencia del día.{' '}
            {modeConsequence(mode)}
          </p>
        </EuiConfirmModal>
      )}
    </article>
  );
}
