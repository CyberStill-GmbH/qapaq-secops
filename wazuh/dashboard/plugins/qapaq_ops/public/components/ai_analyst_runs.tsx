/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { EuiButtonEmpty, EuiFieldText, EuiFormRow, EuiLoadingContent, EuiSelect } from '@elastic/eui';
import {
  actionKindShort,
  AI_RUN_STATUS_LABEL,
  AI_RUN_STATUS_TONE,
  AI_RUN_STATUSES,
  AI_TRIGGER_LABEL,
  AI_VERDICT_LABEL,
  AI_VERDICTS,
  AiRunStatusView,
  AiRunSummary,
  formatCount,
  formatMicroUsd,
  inferenceLabel,
  isActive,
  NO_DATA,
  PRIORITIES,
  stageLabel,
} from '../../common';
import {
  EMPTY_FILTERS,
  hasFilters,
  isPendingReview,
  needsAttention,
  parseRunStatus,
  parseVerdictFilter,
  RUN_VIEW_LABEL,
  RunFilters,
  RunView,
  togglePriority,
} from './ai_analyst_model';
import { ConfidenceMeter, VerdictBadge } from './ai_analyst_parts';
import { HealthMark, Mono, PriorityMark, relativeTime } from './primitives';

export function RunStatusMark({ status }: { status: AiRunStatusView }) {
  return <HealthMark tone={AI_RUN_STATUS_TONE[status]} label={AI_RUN_STATUS_LABEL[status]} />;
}

/**
 * Costo de una corrida. Sin llamada al modelo no hay costo que estimar (se dice así, no «US$ 0»);
 * con modelo y sin cifra queda «Sin dato».
 */
export function runCostText(
  run: Pick<AiRunSummary, 'inference' | 'estimatedCostMicroUsd'>,
): string {
  const cost = run.estimatedCostMicroUsd;
  if (run.inference === 'none' && (cost === null || cost === 0)) return 'Sin llamada al modelo';
  return formatMicroUsd(cost);
}

export function RunStage({ stage }: { stage: string | null }) {
  if (!stage) return null;
  const label = stageLabel(stage);
  return <span className="qapaqCellMeta">{label ?? <Mono>{stage}</Mono>}</span>;
}

export function runHref(basePath: string, jobId: string): string {
  return `${basePath}/app/qapaq-ai-analyst?id=${encodeURIComponent(jobId)}`;
}

/** Clic normal abre el expediente en la misma vista; con modificadores, el navegador decide. */
export function openInPlace(event: React.MouseEvent<HTMLAnchorElement>, open: () => void): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  open();
}

const ABSOLUTE = new Intl.DateTimeFormat('es-PE', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** Instante relativo sin elementos enfocables (va dentro de un enlace); el absoluto en `title`. */
export function RunTime({ iso, now }: { iso: string | null; now?: number }) {
  if (!iso) return <span className="qapaqMuted">{NO_DATA}</span>;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <span className="qapaqMuted">{NO_DATA}</span>;
  return (
    <time
      dateTime={iso}
      title={ABSOLUTE.format(date)}
      className="qapaqTabular"
      data-qapaq-no-translate=""
    >
      {relativeTime(iso, now)}
    </time>
  );
}

function RunMeta({ run }: { run: AiRunSummary }) {
  const parts: React.ReactNode[] = [AI_TRIGGER_LABEL[run.trigger]];
  if (run.alertCount !== null) {
    parts.push(`${formatCount(run.alertCount)} ${run.alertCount === 1 ? 'alerta' : 'alertas'}`);
  }
  if (run.inference === 'none') {
    parts.push(inferenceLabel('none'));
  } else if (run.inference !== null) {
    parts.push(`IA: ${inferenceLabel(run.inference).toLowerCase()} · ${runCostText(run)}`);
  }
  if (run.initiatedBy) {
    parts.push(
      <span key="by" data-qapaq-no-translate="">
        {run.initiatedBy}
      </span>,
    );
  }
  return (
    <span className="qapaqAiRun__meta">
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 && ' · '}
          {part}
        </React.Fragment>
      ))}
    </span>
  );
}

/** Una investigación por fila: prioridad, alerta, conclusión, estado y hora; sin scroll lateral. */
export function AiRunRow({
  run,
  basePath,
  now,
  selected = false,
  onSelect,
}: {
  run: AiRunSummary;
  basePath: string;
  now?: number;
  selected?: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <a
        className="qapaqAiRun"
        href={runHref(basePath, run.id)}
        data-priority={run.priority ? run.priority.toLowerCase() : 'none'}
        data-attention={needsAttention(run) ? 'true' : 'false'}
        aria-current={selected ? 'true' : undefined}
        onClick={(event) => openInPlace(event, () => onSelect(run.id))}
      >
        <span className="qapaqAiRun__priority">
          {run.priority ? (
            <PriorityMark priority={run.priority} />
          ) : (
            <span className="qapaqMuted">{NO_DATA}</span>
          )}
        </span>
        <span className="qapaqAiRun__main">
          <span className="qapaqAiRun__title" data-qapaq-no-translate="">
            {run.subject.title || 'Sin título'}
          </span>
          <RunMeta run={run} />
          {run.actionKinds.length > 0 && (
            <span className="qapaqAiRun__actions">
              <span className="qapaqAiSrOnly">Acciones ejecutadas: </span>
              {run.actionKinds.map((kind) => (
                <span key={kind} className="qapaqAiRun__action">
                  {actionKindShort(kind) ?? <Mono>{kind}</Mono>}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="qapaqAiRun__verdict">
          {run.verdict === null ? (
            <span className="qapaqMuted">
              {isActive(run.status) ? 'Analizando…' : 'Sin veredicto'}
            </span>
          ) : (
            <>
              <VerdictBadge verdict={run.verdict} />
              <ConfidenceMeter confidence={run.confidence} />
            </>
          )}
        </span>
        <span className="qapaqAiRun__status">
          <RunStatusMark status={run.status} />
          {isActive(run.status) && <RunStage stage={run.stage} />}
          {run.status === 'requires_review' && (
            <span className="qapaqCellMeta" data-review={isPendingReview(run) ? 'pending' : 'done'}>
              {isPendingReview(run) ? 'Revisión pendiente' : 'Alerta ya atendida'}
            </span>
          )}
        </span>
        <span className="qapaqAiRun__time">
          <RunTime iso={run.updatedAt ?? run.createdAt} now={now} />
        </span>
      </a>
    </li>
  );
}

export function AiRunList({
  items,
  loading,
  basePath,
  selectedId = null,
  now,
  onSelect,
  empty,
}: {
  items: readonly AiRunSummary[];
  loading: boolean;
  basePath: string;
  selectedId?: string | null;
  now?: number;
  onSelect: (id: string) => void;
  /** Estado vacío: qué pasó y qué hacer. */
  empty: React.ReactNode;
}) {
  if (items.length === 0) {
    if (loading) return <EuiLoadingContent lines={6} />;
    return (
      <div className="qapaqAiEmpty" role="status">
        {empty}
      </div>
    );
  }
  return (
    <div className="qapaqAiRuns">
      <div className="qapaqAiRuns__head" aria-hidden="true">
        <span>Prioridad</span>
        <span>Alerta investigada</span>
        <span>Conclusión</span>
        <span>Estado</span>
        <span>Actualizada</span>
      </div>
      <ul className="qapaqAiRuns__list" aria-label="Investigaciones" aria-busy={loading || undefined}>
        {items.map((run) => (
          <AiRunRow
            key={run.id}
            run={run}
            basePath={basePath}
            now={now}
            selected={run.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ Filtros

const VIEWS: readonly RunView[] = ['all', 'attention', 'failed', 'escalated', 'active'];

export function AiRunFiltersBar({
  filters,
  counts,
  onChange,
}: {
  filters: RunFilters;
  /** Cuántas de las cargadas caen en cada vista rápida. */
  counts: Readonly<Record<RunView, number>>;
  onChange: (next: RunFilters) => void;
}) {
  const set = (patch: Partial<RunFilters>) => onChange({ ...filters, ...patch });
  return (
    <div className="qapaqAiFilters" role="search" aria-label="Filtrar investigaciones">
      <div className="qapaqAiSegment" role="group" aria-label="Vista rápida">
        {VIEWS.map((view) => (
          <button
            key={view}
            type="button"
            className="qapaqAiSegment__item"
            aria-pressed={filters.view === view}
            // La bandeja lee sus propias investigaciones en revisión: el estado no aplica.
            onClick={() => set(view === 'attention' ? { view, status: '' } : { view })}
          >
            {RUN_VIEW_LABEL[view]}
            {view !== 'all' && (
              <span className="qapaqAiSegment__count qapaqTabular">{counts[view]}</span>
            )}
          </button>
        ))}
      </div>
      <div className="qapaqAiFilters__row">
        <div className="qapaqAiFilters__search">
          <EuiFormRow label="Buscar" display="rowCompressed" fullWidth>
            <EuiFieldText
              compressed
              fullWidth
              type="search"
              icon="search"
              value={filters.query}
              placeholder="Título de la alerta o identificador"
              aria-label="Buscar por título o identificador"
              onChange={(event) => set({ query: event.target.value })}
            />
          </EuiFormRow>
        </div>
        <EuiFormRow label="Estado" display="rowCompressed">
          <EuiSelect
            compressed
            aria-label="Filtrar por estado"
            value={filters.status}
            onChange={(event) =>
              set({
                status: parseRunStatus(event.target.value),
                ...(filters.view === 'attention' ? { view: 'all' as RunView } : {}),
              })
            }
            options={[
              { value: '', text: 'Todos los estados' },
              ...AI_RUN_STATUSES.map((status) => ({
                value: status,
                text: AI_RUN_STATUS_LABEL[status],
              })),
            ]}
          />
        </EuiFormRow>
        <EuiFormRow label="Conclusión" display="rowCompressed">
          <EuiSelect
            compressed
            aria-label="Filtrar por conclusión"
            value={filters.verdict}
            onChange={(event) => set({ verdict: parseVerdictFilter(event.target.value) })}
            options={[
              { value: '', text: 'Todas las conclusiones' },
              ...AI_VERDICTS.map((verdict) => ({
                value: verdict,
                text: AI_VERDICT_LABEL[verdict],
              })),
              { value: 'none', text: 'Sin veredicto' },
            ]}
          />
        </EuiFormRow>
        <fieldset className="qapaqAiFilters__priorities">
          <legend>Prioridad</legend>
          <span className="qapaqAiChips">
            {PRIORITIES.map((priority) => (
              <button
                key={priority}
                type="button"
                className="qapaqAiChip"
                aria-pressed={filters.priorities.includes(priority)}
                aria-label={`Prioridad ${priority}`}
                onClick={() => set({ priorities: togglePriority(filters.priorities, priority) })}
              >
                <PriorityMark priority={priority} />
              </button>
            ))}
          </span>
        </fieldset>
        {hasFilters(filters) && (
          <EuiButtonEmpty
            size="s"
            iconType="cross"
            className="qapaqAiFilters__clear"
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            Quitar filtros
          </EuiButtonEmpty>
        )}
      </div>
    </div>
  );
}
