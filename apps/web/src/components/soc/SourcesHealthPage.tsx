import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type SourceHealthView } from '../../api/client.js';
import { Button, EmptyState, ErrorState, RelativeTime, StatusChip, SocIcon } from './soc-ui.js';
import { PageHeader } from './soc-data-ui.js';
import { useChanges } from './use-changes.js';

const sourceState: Readonly<
  Record<SourceHealthView['state'], { label: string; tone: 'ok' | 'warn' | 'fail' | 'neutral' }>
> = {
  healthy: { label: 'Saludable', tone: 'ok' },
  degraded: { label: 'Degradada', tone: 'warn' },
  failed: { label: 'Fallida', tone: 'fail' },
  disabled: { label: 'Deshabilitada', tone: 'neutral' },
  unknown: { label: 'Desconocida', tone: 'neutral' },
};
const reasonLabels: Readonly<Record<SourceHealthView['reason'], string>> = {
  DISABLED: 'La ingesta está deshabilitada.',
  NO_OBSERVATIONS: 'Sin pasadas registradas.',
  PERMANENT_ERROR: 'La última ejecución encontró un error permanente.',
  NO_RECENT_SUCCESS: 'No se registró un éxito dentro del umbral.',
  CONSECUTIVE_FAILURES: 'Se alcanzó el umbral de fallos consecutivos.',
  NEVER_SUCCEEDED: 'La fuente todavía no registra una ejecución exitosa.',
  RECENT_SUCCESS: 'La última ejecución terminó correctamente.',
};

function Fact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SourceCard({ source }: { readonly source: SourceHealthView }): React.JSX.Element {
  const state = sourceState[source.state];
  return (
    <article className="soc-source-card">
      <header>
        <div>
          <h2>{source.displayName}</h2>
          <p>
            {source.dataset} · {source.sourceId}
          </p>
        </div>
        <StatusChip state={state.tone}>{state.label}</StatusChip>
      </header>
      <p className="soc-source-reason">{reasonLabels[source.reason]}</p>
      <dl className="soc-health-facts">
        <Fact label="Último intento" value={<RelativeTime value={source.lastAttemptAt} />} />
        <Fact label="Último éxito" value={<RelativeTime value={source.lastSuccessAt} />} />
        <Fact label="Último evento recibido" value={<RelativeTime value={source.lastEventAt} />} />
        <Fact label="Fallos consecutivos" value={source.consecutiveFailures} />
        <Fact label="Último error" value={source.lastErrorClass ?? 'Sin dato'} />
        <Fact
          label="Intervalo configurado"
          value={`${Math.round(source.policy.intervalMs / 1000)} s`}
        />
        <Fact
          label="Umbral de degradación"
          value={`${Math.round(source.policy.degradeAfterMs / 1000)} s`}
        />
        <Fact label="Umbral de caída" value={`${Math.round(source.policy.failAfterMs / 1000)} s`} />
      </dl>
      {source.subscriptions === null ? (
        <p className="soc-page-note">Actividad de suscripción: no medido · no confirma salud.</p>
      ) : (
        <details className="soc-source-subscriptions">
          <summary>Actividad de suscripción · últimas {source.subscriptions.windowHours} h</summary>
          <p className="soc-page-note">
            Medida <RelativeTime value={source.subscriptions.measuredAt} />. Es contexto de
            investigación; no determina la salud de la fuente.
          </p>
          {source.subscriptions.items.length ? (
            <div className="soc-table-scroll">
              <table className="soc-table">
                <thead>
                  <tr>
                    <th scope="col">Stream</th>
                    <th scope="col">Último evento</th>
                    <th scope="col">Eventos en ventana</th>
                  </tr>
                </thead>
                <tbody>
                  {source.subscriptions.items.map((item) => (
                    <tr key={item.stream}>
                      <td>{item.stream}</td>
                      <td>
                        <RelativeTime value={item.lastEventAt} />
                      </td>
                      <td>{item.eventsInWindow}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="soc-page-note">Sin streams reportados en esta medición.</p>
          )}
        </details>
      )}
      {source.transitions.length ? (
        <details className="soc-source-history">
          <summary>Transiciones recientes ({source.transitions.length})</summary>
          <ol>
            {source.transitions.map((transition) => (
              <li key={transition.id}>
                <strong>
                  {sourceState[transition.toState as SourceHealthView['state']]?.label ??
                    transition.toState}
                </strong>
                <span>
                  {reasonLabels[transition.reason as SourceHealthView['reason']] ??
                    transition.reason}
                </span>
                <RelativeTime value={transition.at} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}

export function SourcesHealthPage(): React.JSX.Element {
  const [sources, setSources] = useState<readonly SourceHealthView[]>([]);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const result = await api.sourcesHealth();
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSources(result.data.sources);
    setCheckedAt(result.data.checkedAt);
    setUpdatedAt(new Date().toISOString());
    setError(null);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const liveChanges = useChanges({ resourceTypes: ['source'], onChange: () => void load() });
  return (
    <div className="soc-page">
      <PageHeader
        title="Salud de fuentes"
        description="Estado de ingesta y observaciones reales por fuente."
        updated={updatedAt}
        action={
          <Button onClick={() => void load()} disabled={loading}>
            <SocIcon name="refresh" /> Actualizar
          </Button>
        }
      />
      {checkedAt ? (
        <p className="soc-page-note">
          Evaluado por el servidor <RelativeTime value={checkedAt} />.
        </p>
      ) : null}
      {liveChanges.length ? (
        <p className="soc-live-announcement" role="status" aria-live="polite">
          Estado de fuente actualizado
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {sources.length ? (
        <div className="soc-source-grid">
          {sources.map((source) => (
            <SourceCard key={`${source.sourceId}:${source.dataset}`} source={source} />
          ))}
        </div>
      ) : !loading && !error ? (
        <EmptyState>No hay fuentes configuradas para este entorno.</EmptyState>
      ) : null}
      {loading && !sources.length ? (
        <p className="soc-table-placeholder" role="status">
          Consultando fuentes…
        </p>
      ) : null}
    </div>
  );
}
