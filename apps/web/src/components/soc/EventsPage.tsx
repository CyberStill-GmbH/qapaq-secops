import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EVENTS_QUERY_GRAMMAR,
  formatEventsQuery,
  parseEventsQuery,
  type EventsQueryFilters,
} from '@qapaq/contracts';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type SecurityEventView, type SessionView } from '../../api/client.js';
import { Button, EmptyState, ErrorState, RelativeTime } from './soc-ui.js';
import { PageHeader } from './soc-data-ui.js';

type RangeHours = 24 | 168 | 744;
type FilterMode = 'filters' | 'query';
const rangeLabels: Readonly<Record<RangeHours, string>> = {
  24: 'Últimas 24 horas',
  168: 'Últimos 7 días',
  744: 'Últimos 31 días',
};
const severities = ['critical', 'high', 'medium', 'low', 'informational'] as const;
const severityLabels: Readonly<Record<string, string>> = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
  informational: 'Informativa',
  unknown: 'Desconocida',
};
const categoryLabels: Readonly<Record<string, string>> = {
  authentication: 'Autenticación',
  iam: 'Identidad y acceso',
  network: 'Red',
  intrusion_detection: 'Detección de intrusiones',
  malware: 'Malware',
  host: 'Host',
  file: 'Archivos',
  process: 'Procesos',
  configuration: 'Configuración',
  email: 'Correo',
  web: 'Web',
  vulnerability: 'Vulnerabilidades',
  database: 'Base de datos',
};
// These are the categories the current Wazuh adapter can actually compile.
const filterableCategories = [
  'authentication',
  'iam',
  'network',
  'intrusion_detection',
  'malware',
  'host',
  'file',
  'process',
  'configuration',
  'email',
  'web',
  'vulnerability',
  'database',
] as const;
const outcomeLabels: Readonly<Record<string, string>> = {
  success: 'Exitoso',
  failure: 'Fallido',
  unknown: 'Desconocido',
};

function eventSummary(event: SecurityEventView): string {
  return event.title || event.action || event.kind;
}
function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value))
    return (
      value
        .map(display)
        .filter((item) => item !== '—')
        .join(', ') || '—'
    );
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>;
    const preferred = ['displayName', 'name', 'userPrincipalName', 'address', 'ip', 'id', 'kind'];
    const selected = preferred
      .filter((key) => item[key] !== undefined && item[key] !== null)
      .map((key) => display(item[key]));
    return selected.join(' · ') || '—';
  }
  return '—';
}
function sourceLabel(source: SecurityEventView['source']): string {
  return (
    [source.vendor, source.product, source.dataset]
      .filter((part) => typeof part === 'string' && part.length)
      .join(' · ') || '—'
  );
}
function queryErrorText(code: string, position: number): string {
  const messages: Record<string, string> = {
    TOO_LONG: 'La consulta supera el límite de 512 caracteres.',
    INVALID_CHARACTER: 'Hay un carácter que no admite esta gramática.',
    UNEXPECTED_TOKEN: 'La consulta no sigue el formato esperado.',
    UNSUPPORTED_OPERATOR: 'Solo se permite AND; cada campo admite una lista separada por comas.',
    UNKNOWN_FIELD: 'Campo desconocido. Usa severity, category u outcome.',
    UNKNOWN_VALUE: 'Valor no permitido para ese campo.',
    DUPLICATE_FIELD: 'Cada campo puede aparecer una sola vez.',
    DUPLICATE_VALUE: 'Ese valor está repetido.',
    SINGLE_VALUE_FIELD: 'Outcome admite un solo valor.',
    TOO_MANY_PREDICATES: 'Se permiten hasta tres campos.',
    TOO_MANY_VALUES: 'Se permiten hasta 16 valores por campo.',
    TOO_MANY_TOKENS: 'La consulta tiene demasiados términos.',
    INCOMPLETE: 'La consulta quedó incompleta.',
  };
  return `${messages[code] ?? 'Consulta inválida'} Posición ${position + 1}.`;
}

function EventDetail({
  event,
  canReadRaw,
  onClose,
}: {
  readonly event: SecurityEventView;
  readonly canReadRaw: boolean;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<'summary' | 'raw'>('summary');
  return (
    <aside className="soc-drawer" aria-label={`Detalle de ${eventSummary(event)}`}>
      <header>
        <div>
          <span className="soc-drawer__eyebrow">Evento · {event.recordId.slice(0, 8)}…</span>
          <h2>{eventSummary(event)}</h2>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Cerrar detalle">
          Cerrar
        </Button>
      </header>
      <div className="soc-drawer__body">
        <div className="soc-tabs" role="tablist" aria-label="Datos del evento">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'summary'}
            className={tab === 'summary' ? 'is-active' : ''}
            onClick={() => setTab('summary')}
          >
            Resumen
          </button>
          {canReadRaw ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'raw'}
              className={tab === 'raw' ? 'is-active' : ''}
              onClick={() => setTab('raw')}
            >
              Crudo
            </button>
          ) : null}
        </div>
        {tab === 'raw' && canReadRaw ? (
          <pre className="soc-event-raw">{JSON.stringify(event.raw ?? {}, null, 2)}</pre>
        ) : (
          <dl className="soc-description-list">
            <dt>Ocurrido</dt>
            <dd>
              <RelativeTime value={event.occurredAt} />
            </dd>
            <dt>Recibido</dt>
            <dd>
              <RelativeTime value={event.receivedAt} />
            </dd>
            <dt>Severidad</dt>
            <dd>{severityLabels[event.severity] ?? event.severity}</dd>
            <dt>Tipo</dt>
            <dd>{event.kind}</dd>
            <dt>Resultado</dt>
            <dd>{outcomeLabels[event.outcome] ?? 'Desconocido'}</dd>
            <dt>Regla</dt>
            <dd>
              {event.rule
                ? `${event.rule.id} · ${event.rule.groups.join(', ') || 'Sin grupo'}`
                : '—'}
            </dd>
            <dt>Identidades</dt>
            <dd>{display(event.identities)}</dd>
            <dt>Recursos</dt>
            <dd>{display(event.resources)}</dd>
            <dt>Fuente</dt>
            <dd>{sourceLabel(event.source)}</dd>
            <dt>Identificador</dt>
            <dd>
              <code>{event.eventUid}</code>
            </dd>
          </dl>
        )}
      </div>
    </aside>
  );
}

function ToggleGroup({
  label,
  values,
  selected,
  onChange,
  labels = {},
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly selected: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
  readonly labels?: Readonly<Record<string, string>>;
}): React.JSX.Element {
  return (
    <fieldset className="soc-events-checkgroup">
      <legend>{label}</legend>
      <div>
        {values.map((value) => (
          <label key={value}>
            <input
              type="checkbox"
              checked={selected.includes(value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, value]
                    : selected.filter((item) => item !== value),
                )
              }
            />
            {labels[value] ?? value}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function EventsPage({ session }: { readonly session: SessionView }): React.JSX.Element {
  const [range, setRange] = useState<RangeHours>(24);
  const [windowEnd, setWindowEnd] = useState(() => new Date().toISOString());
  const [mode, setMode] = useState<FilterMode>('filters');
  const [draftFilters, setDraftFilters] = useState<EventsQueryFilters>({});
  const [queryDraft, setQueryDraft] = useState('');
  const [querySubmitted, setQuerySubmitted] = useState<string | undefined>();
  const [applied, setApplied] = useState<EventsQueryFilters>({});
  const [items, setItems] = useState<readonly SecurityEventView[]>([]);
  const [unparsedCount, setUnparsedCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<readonly (string | undefined)[]>([undefined]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [status, setStatus] = useState<'ok' | 'disabled' | null>(null);
  const [windowRange, setWindowRange] = useState<{ from: string; to: string } | null>(null);
  const [selected, setSelected] = useState<SecurityEventView | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [loading, setLoading] = useState(false);
  const canReadRaw = session.capabilities.includes('events.read_raw');
  const cursor = cursorStack[cursorIndex];
  const parsedDraft = useMemo(() => parseEventsQuery(queryDraft), [queryDraft]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      const to = new Date(windowEnd);
      const from = new Date(to.getTime() - range * 60 * 60 * 1000);
      const result = await api.events(
        {
          from: from.toISOString(),
          to: to.toISOString(),
          ...(querySubmitted !== undefined
            ? { q: querySubmitted }
            : {
                ...(applied.severity?.length ? { severity: applied.severity } : {}),
                ...(applied.category?.length ? { category: applied.category } : {}),
                ...(applied.outcome ? { outcome: applied.outcome as 'success' | 'failure' } : {}),
              }),
          ...(cursor ? { cursor } : {}),
        },
        signal,
      );
      if (signal.aborted) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatus(result.data.status);
      setWindowRange(result.data.window);
      setItems(result.data.items);
      setUnparsedCount(result.data.unparsedCount);
      setNextCursor(result.data.nextCursor);
      setError(null);
    },
    [applied, cursor, querySubmitted, range, windowEnd],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  function resetPaging(): void {
    setCursorStack([undefined]);
    setCursorIndex(0);
  }
  function applySearch(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setWindowEnd(new Date().toISOString());
    if (mode === 'query') {
      if (!parsedDraft.ok) return;
      setQuerySubmitted(parsedDraft.canonical);
      setApplied(parsedDraft.filters);
    } else {
      setQuerySubmitted(undefined);
      setApplied(draftFilters);
      setQueryDraft(formatEventsQuery(draftFilters));
    }
    resetPaging();
  }
  function changeMode(next: FilterMode): void {
    if (next === mode) return;
    if (next === 'query') {
      setQueryDraft(formatEventsQuery(draftFilters));
    } else {
      const parsed = parseEventsQuery(queryDraft);
      if (!parsed.ok) return;
      setDraftFilters(parsed.filters);
      setApplied(parsed.filters);
      setQuerySubmitted(undefined);
    }
    setMode(next);
    resetPaging();
  }
  function movePage(direction: -1 | 1): void {
    if (direction < 0) {
      setCursorIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (!nextCursor) return;
    setCursorStack((current) => [...current.slice(0, cursorIndex + 1), nextCursor]);
    setCursorIndex((current) => current + 1);
  }
  function setSeverity(values: readonly string[]): void {
    setDraftFilters((current) => ({ ...current, severity: values }));
  }
  function setCategories(values: readonly string[]): void {
    setDraftFilters((current) => ({ ...current, category: values }));
  }

  return (
    <div className="soc-page soc-events-page">
      <PageHeader
        title="Eventos de seguridad"
        description="Actividad normalizada de Wazuh. La telemetría permanece en su fuente."
      />
      <form className="soc-events-filters" onSubmit={applySearch}>
        <label>
          Rango de tiempo
          <select
            value={range}
            onChange={(event) => {
              setRange(Number(event.target.value) as RangeHours);
              setWindowEnd(new Date().toISOString());
              resetPaging();
            }}
          >
            {Object.entries(rangeLabels).map(([hours, label]) => (
              <option key={hours} value={hours}>
                {label}
              </option>
            ))}
          </select>
          <small>Máximo 31 días</small>
        </label>
        <fieldset className="soc-events-mode">
          <legend>Modo de búsqueda</legend>
          <label>
            <input
              type="radio"
              name="events-mode"
              checked={mode === 'filters'}
              onChange={() => changeMode('filters')}
            />
            Filtros
          </label>
          <label>
            <input
              type="radio"
              name="events-mode"
              checked={mode === 'query'}
              onChange={() => changeMode('query')}
            />
            Consulta
          </label>
        </fieldset>
        {mode === 'filters' ? (
          <div className="soc-events-filter-groups">
            <ToggleGroup
              label="Severidad"
              values={severities}
              selected={draftFilters.severity ?? []}
              onChange={setSeverity}
              labels={severityLabels}
            />
            <ToggleGroup
              label="Categoría"
              values={filterableCategories}
              selected={draftFilters.category ?? []}
              onChange={setCategories}
              labels={categoryLabels}
            />
            <label>
              Resultado
              <select
                value={draftFilters.outcome ?? ''}
                onChange={(event) =>
                  setDraftFilters((current) => {
                    const { outcome: _previous, ...rest } = current;
                    return event.target.value ? { ...rest, outcome: event.target.value } : rest;
                  })
                }
              >
                <option value="">Todos</option>
                <option value="success">Exitoso</option>
                <option value="failure">Fallido</option>
              </select>
            </label>
          </div>
        ) : (
          <div className="soc-events-query">
            <label htmlFor="events-query">Consulta de eventos</label>
            <textarea
              id="events-query"
              value={queryDraft}
              maxLength={512}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              onChange={(event) => setQueryDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && parsedDraft.ok) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              aria-invalid={!parsedDraft.ok}
              aria-describedby="events-query-help events-query-error"
              placeholder="severity:high,critical AND category:authentication AND outcome:failure"
            />
            <small id="events-query-help">
              Gramática {EVENTS_QUERY_GRAMMAR}. Campos: severity, category, outcome. Solo AND;
              listas con coma. No admite SQL ni DSL.
            </small>
            {!parsedDraft.ok ? (
              <p id="events-query-error" role="alert">
                {queryErrorText(parsedDraft.error.code, parsedDraft.error.position)}
              </p>
            ) : (
              <p id="events-query-error" aria-live="polite">
                {parsedDraft.canonical
                  ? `Consulta válida: ${parsedDraft.canonical}`
                  : 'Sin filtros adicionales.'}
              </p>
            )}
          </div>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={loading || (mode === 'query' && !parsedDraft.ok)}
        >
          Buscar
        </Button>
      </form>
      {querySubmitted !== undefined ? (
        <p className="soc-page-note">
          Consulta activa: <code>{querySubmitted || 'sin filtros'}</code>
        </p>
      ) : null}
      {windowRange ? (
        <p className="soc-page-note">
          Período consultado: {new Date(windowRange.from).toLocaleString('es-PE')} –{' '}
          {new Date(windowRange.to).toLocaleString('es-PE')}
        </p>
      ) : null}
      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            const controller = new AbortController();
            void load(controller.signal);
          }}
        />
      ) : null}
      {status === 'disabled' ? (
        <EmptyState>
          Fuente de eventos no configurada. No se puede consultar la telemetría en este entorno.
        </EmptyState>
      ) : status === 'ok' ? (
        <div className="soc-table-panel">
          {unparsedCount > 0 ? (
            <p className="soc-partial-banner">
              {unparsedCount} documento(s) de esta página no se pudieron normalizar.
            </p>
          ) : null}
          <div className="soc-table-scroll">
            <table className="soc-table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Severidad</th>
                  <th>Tipo</th>
                  <th>Resultado</th>
                  <th>Regla</th>
                  <th>Identidad</th>
                  <th>Fuente</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {items.map((event) => (
                  <tr key={event.recordId}>
                    <td data-label="Hora">
                      <RelativeTime value={event.occurredAt} />
                    </td>
                    <td data-label="Severidad">
                      {severityLabels[event.severity] ?? event.severity}
                    </td>
                    <td data-label="Tipo">{event.kind}</td>
                    <td data-label="Resultado">{outcomeLabels[event.outcome] ?? 'Desconocido'}</td>
                    <td data-label="Regla">
                      {event.rule
                        ? `${event.rule.id}${event.title ? ` · ${event.title}` : ''}`
                        : '—'}
                    </td>
                    <td data-label="Identidad">{display(event.identities[0])}</td>
                    <td data-label="Fuente">{sourceLabel(event.source)}</td>
                    <td data-label="Detalle">
                      <Button variant="ghost" onClick={() => setSelected(event)}>
                        Ver evento
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!items.length && !loading && !error ? (
            <EmptyState>Sin eventos para estos filtros en el período consultado.</EmptyState>
          ) : null}
          <div className="soc-table-footer soc-events-pagination">
            <Button
              variant="ghost"
              disabled={cursorIndex === 0 || loading}
              onClick={() => movePage(-1)}
            >
              Anterior
            </Button>
            <span>
              {loading
                ? 'Consultando Wazuh…'
                : 'Resultados ordenados del más reciente al más antiguo'}
            </span>
            <Button variant="ghost" disabled={!nextCursor || loading} onClick={() => movePage(1)}>
              Siguiente
            </Button>
          </div>
        </div>
      ) : null}
      {selected ? (
        <EventDetail event={selected} canReadRaw={canReadRaw} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}
