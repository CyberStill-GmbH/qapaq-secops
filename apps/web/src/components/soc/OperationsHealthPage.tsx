import { useEffect, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import type { OperationsHealthStatus, OperationsHealthView } from '../../api/client.js';
import { api } from '../../api/client.js';
import { Button, ErrorState, RelativeTime, SocIcon, StatusChip } from './soc-ui.js';
import { PageHeader, statusLabel } from './soc-data-ui.js';

const statusCopy: Readonly<
  Record<
    OperationsHealthStatus,
    { readonly label: string; readonly tone: 'ok' | 'warn' | 'fail' | 'info' | 'neutral' }
  >
> = {
  OK: { label: 'Operativo', tone: 'ok' },
  NO_DATA: { label: 'Sin datos', tone: 'neutral' },
  STALE: { label: 'Atrasado', tone: 'warn' },
  DEGRADED: { label: 'Degradado', tone: 'fail' },
};

const reasonCopy: Readonly<Record<string, string>> = {
  DISPATCHER_STOPPED: 'Despachador detenido',
  OUTBOX_BACKLOG: 'Cola pendiente por más de 5 minutos',
  PERSISTENCE_EPHEMERAL: 'Persistencia en memoria; los datos no sobreviven un reinicio',
  DATABASE_UNAVAILABLE: 'Base de datos sin respuesta',
  DATABASE_SLOW: 'Base de datos sobre el umbral de latencia',
};

function HealthStatus({
  value,
  label,
  tone,
}: {
  readonly value: OperationsHealthStatus;
  readonly label?: string;
  readonly tone?: 'ok' | 'warn' | 'fail' | 'info' | 'neutral';
}): React.JSX.Element {
  const status = statusCopy[value];
  return <StatusChip state={tone ?? status.tone}>{label ?? status.label}</StatusChip>;
}

function ageLabel(seconds: number | null): string {
  if (seconds === null) return 'Sin actividad registrada';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

function reasonLabels(reasons: readonly string[]): string[] {
  return reasons.map((reason) => reasonCopy[reason] ?? 'Condición degradada');
}

export function OperationsHealthPage(): React.JSX.Element {
  const [result, setResult] = useState<OperationsHealthView | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async (initial = false): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      if (initial) setLoading(true);
      else setRefreshing(true);
      const response = await api.operationsHealth();
      if (active) {
        if (response.ok) {
          setResult(response.data);
          setError(null);
        } else {
          setError(response.error);
        }
        setLoading(false);
        setRefreshing(false);
      }
      inFlight = false;
    };
    void load(true);
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    const response = await api.operationsHealth();
    if (response.ok) {
      setResult(response.data);
      setError(null);
    } else {
      setError(response.error);
    }
    setLoading(false);
    setRefreshing(false);
  }

  const summary = result?.sections.summary;
  return (
    <div className="soc-page soc-operations-health">
      <PageHeader
        title="Salud operativa"
        description="Frescura de alertas y estado de los servicios que sostienen la operación."
        updated={result?.generatedAt ?? null}
        action={
          <Button onClick={() => void refresh()} disabled={loading || refreshing}>
            <SocIcon name="refresh" size={15} />
            {refreshing ? 'Actualizando' : 'Actualizar'}
          </Button>
        }
      />

      {loading && !result ? (
        <p className="soc-page-note" role="status">
          Consultando estado operativo…
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void refresh()} /> : null}

      {summary ? (
        <section className="soc-health-summary" aria-labelledby="soc-health-summary-title">
          <div>
            <h2 id="soc-health-summary-title">Señal de alertas</h2>
            <p>
              {summary.lastAlertAt ? (
                <>
                  Última alerta <RelativeTime value={summary.lastAlertAt} />
                </>
              ) : (
                'No hay alertas para calcular frescura.'
              )}
            </p>
          </div>
          {summary.status === 'OK' ? (
            <HealthStatus value={summary.status} label="Señal encontrada" tone="info" />
          ) : (
            <HealthStatus value={summary.status} />
          )}
          <dl>
            <div>
              <dt>Antigüedad de la última alerta</dt>
              <dd>{ageLabel(summary.alertFreshnessSeconds)}</dd>
            </div>
            <div>
              <dt>Cobertura de fuentes</dt>
              <dd>
                <HealthStatus value={summary.sourceCoverage} />
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {result?.sections.soc ? (
        <section className="soc-health-section" aria-labelledby="soc-health-soc-title">
          <header>
            <div>
              <h2 id="soc-health-soc-title">Flujo SOC</h2>
              <p>Persistencia, despacho y notificaciones.</p>
            </div>
            <HealthStatus value={result.sections.soc.status} />
          </header>
          <dl className="soc-health-facts">
            <div>
              <dt>Persistencia</dt>
              <dd>{result.sections.soc.persistence === 'postgres' ? 'PostgreSQL' : 'Memoria'}</dd>
            </div>
            <div>
              <dt>Despachador</dt>
              <dd>{result.sections.soc.dispatcherRunning ? 'En ejecución' : 'Detenido'}</dd>
            </div>
            <div>
              <dt>Outbox pendiente</dt>
              <dd>{result.sections.soc.outbox.pending}</dd>
            </div>
            <div>
              <dt>En procesamiento</dt>
              <dd>{result.sections.soc.outbox.processing}</dd>
            </div>
            <div>
              <dt>Antigüedad del pendiente más viejo</dt>
              <dd>{ageLabel(result.sections.soc.outbox.oldestPendingAgeSeconds)}</dd>
            </div>
          </dl>
          {result.sections.soc.degradedReasons.length > 0 ? (
            <ul className="soc-health-reasons">
              {reasonLabels(result.sections.soc.degradedReasons).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {Object.keys(result.sections.soc.notifications.byStatus).length > 0 ? (
            <div className="soc-health-counts" aria-label="Intentos de notificación por estado">
              <h3>
                Intentos por estado · últimas {result.sections.soc.notifications.windowHours} h
              </h3>
              <ul>
                {Object.entries(result.sections.soc.notifications.byStatus).map(
                  ([status, count]) => (
                    <li key={status}>
                      <span>{statusLabel(status)}</span>
                      <strong>{count}</strong>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {result?.sections.platform ? (
        <section className="soc-health-section" aria-labelledby="soc-health-platform-title">
          <header>
            <div>
              <h2 id="soc-health-platform-title">Plataforma</h2>
              <p>Runtime de QAPAQ y conexión de base de datos.</p>
            </div>
            <HealthStatus value={result.sections.platform.status} />
          </header>
          <dl className="soc-health-facts">
            <div>
              <dt>Base de datos</dt>
              <dd>
                {result.sections.platform.databaseLatencyMs === null
                  ? 'Sin respuesta'
                  : `${result.sections.platform.databaseLatencyMs} ms`}
              </dd>
            </div>
            <div>
              <dt>Memoria del proceso</dt>
              <dd>
                {result.sections.platform.memoryRssMb === null
                  ? 'Sin dato'
                  : `${result.sections.platform.memoryRssMb} MB`}
              </dd>
            </div>
            <div>
              <dt>Tiempo activo</dt>
              <dd>{ageLabel(result.sections.platform.uptimeSeconds)}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{result.sections.platform.nodeVersion ?? 'Sin dato'}</dd>
            </div>
          </dl>
          {result.sections.platform.degradedReasons.length > 0 ? (
            <ul className="soc-health-reasons">
              {reasonLabels(result.sections.platform.degradedReasons).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {result ? (
        <p className="soc-health-footnote">
          Vista agregada. Los eventos y registros de auditoría conservan sus permisos propios.
        </p>
      ) : null}
    </div>
  );
}
