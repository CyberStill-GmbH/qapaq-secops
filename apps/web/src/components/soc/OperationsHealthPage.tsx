import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import type { OperationsHealthStatus, OperationsHealthView } from '../../api/client.js';
import { api } from '../../api/client.js';
import { Button, ErrorState, SocIcon, StatusChip } from './soc-ui.js';
import type { IconName } from './soc-ui.js';
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
  DEGRADED: { label: 'Degradado', tone: 'warn' },
};

const reasonCopy: Readonly<Record<string, string>> = {
  DISPATCHER_STOPPED: 'Despachador detenido',
  OUTBOX_BACKLOG: 'Cola pendiente por más de 5 minutos',
  PERSISTENCE_EPHEMERAL: 'Persistencia en memoria; los datos no sobreviven un reinicio',
  DATABASE_UNAVAILABLE: 'Base de datos sin respuesta',
  DATABASE_SLOW: 'Base de datos sobre el umbral de latencia',
  NOTIFICATION_FAILED: 'Notificación fallida',
  NOTIFICATION_INDETERMINATE: 'Entrega de notificación sin confirmar',
  NOTIFICATION_FALLBACK: 'Notificación enviada por canal alternativo',
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

function HealthMark({ value }: { readonly value: OperationsHealthStatus }): React.JSX.Element {
  const status = statusCopy[value];
  const mark =
    status.tone === 'ok'
      ? '✓'
      : status.tone === 'warn'
        ? '!'
        : status.tone === 'fail'
          ? '×'
          : status.tone === 'info'
            ? 'i'
            : '–';
  return (
    <span
      className={`soc-health-mark soc-health-mark--${status.tone}`}
      role="img"
      aria-label={status.label}
      title={status.label}
    >
      {mark}
    </span>
  );
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

function HealthMetric({
  icon,
  label,
  children,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="soc-health-metric">
      <SocIcon name={icon} size={20} />
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
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
        description="Estado general de los componentes del SOC."
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
        <section className="soc-health-signals" aria-label="Estado de alertas y fuentes">
          <article className="soc-health-signal">
            <SocIcon name="search" size={30} />
            <div>
              <span className="soc-health-signal__label">Señal encontrada</span>
              <span className="soc-health-signal__value-row">
                <strong className="soc-health-signal__value">
                  {summary.status === 'OK' ? 'Sí' : statusCopy[summary.status].label}
                </strong>
                <span
                  className="soc-health-signal__info"
                  role="img"
                  title="Se calcula con la fecha de la última alerta registrada."
                  aria-label="Se calcula con la fecha de la última alerta registrada."
                >
                  <SocIcon name="info" size={15} />
                </span>
              </span>
            </div>
            {summary.status !== 'OK' ? <HealthMark value={summary.status} /> : null}
          </article>
          <article className="soc-health-signal">
            <SocIcon name="clock" size={30} />
            <div>
              <span className="soc-health-signal__label">Antigüedad de la última alerta</span>
              <strong className="soc-health-signal__value">
                {ageLabel(summary.alertFreshnessSeconds)}
              </strong>
            </div>
          </article>
          <article className="soc-health-signal">
            <SocIcon name="database" size={30} />
            <div>
              <span className="soc-health-signal__label">Cobertura de fuentes</span>
              <span className="soc-health-signal__value-row">
                <strong className="soc-health-signal__value">
                  {statusCopy[summary.sourceCoverage].label}
                </strong>
                <HealthMark value={summary.sourceCoverage} />
              </span>
            </div>
          </article>
        </section>
      ) : null}

      {result?.sections.soc ? (
        <section className="soc-health-section" aria-labelledby="soc-health-soc-title">
          <header>
            <div className="soc-health-section__heading">
              <SocIcon name="flow" size={20} />
              <div>
                <h2 id="soc-health-soc-title">Flujo SOC</h2>
                <p>Estado de los componentes del flujo de procesamiento.</p>
              </div>
            </div>
            <HealthStatus value={result.sections.soc.status} />
          </header>
          <dl className="soc-health-flow">
            <HealthMetric icon="database" label="Persistencia">
              {result.sections.soc.persistence === 'postgres' ? 'PostgreSQL' : 'Memoria'}
            </HealthMetric>
            <HealthMetric icon="gear" label="Despachador">
              {result.sections.soc.dispatcherRunning ? 'En ejecución' : 'Detenido'}
            </HealthMetric>
            <HealthMetric icon="send" label="Outbox">
              <span className="soc-health-count-line">
                Pendientes <strong>{result.sections.soc.outbox.pending}</strong>
              </span>
              <span className="soc-health-count-line">
                Procesando <strong>{result.sections.soc.outbox.processing}</strong>
              </span>
            </HealthMetric>
            <HealthMetric icon="bell" label="Notificaciones">
              {Object.entries(result.sections.soc.notifications.byStatus).filter(
                ([, count]) => count > 0,
              ).length > 0 ? (
                Object.entries(result.sections.soc.notifications.byStatus)
                  .filter(([, count]) => count > 0)
                  .map(([status, count]) => (
                    <span className="soc-health-count-line" key={status}>
                      {statusLabel(status)} <strong>{count}</strong>
                    </span>
                  ))
              ) : (
                <span className="soc-health-count-line soc-health-count-line--muted">
                  Sin intentos registrados · últimas {result.sections.soc.notifications.windowHours}{' '}
                  h
                </span>
              )}
            </HealthMetric>
          </dl>
          {result.sections.soc.degradedReasons.length > 0 ? (
            <ul className="soc-health-reasons">
              {reasonLabels(result.sections.soc.degradedReasons).map((reason) => (
                <li key={reason}>
                  <span aria-hidden="true">!</span>
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {result?.sections.platform ? (
        <section className="soc-health-section" aria-labelledby="soc-health-platform-title">
          <header>
            <div className="soc-health-section__heading">
              <SocIcon name="server" size={20} />
              <div>
                <h2 id="soc-health-platform-title">Plataforma</h2>
                <p>Estado de ejecución y conexión de base de datos.</p>
              </div>
            </div>
            <HealthStatus value={result.sections.platform.status} />
          </header>
          <dl className="soc-health-platform">
            <HealthMetric icon="server" label="Base de datos">
              {result.sections.platform.databaseLatencyMs === null
                ? 'Sin respuesta'
                : `${result.sections.platform.databaseLatencyMs} ms`}
            </HealthMetric>
            <HealthMetric icon="gear" label="Memoria de proceso">
              {result.sections.platform.memoryRssMb === null
                ? 'Sin dato'
                : `${result.sections.platform.memoryRssMb} MB`}
            </HealthMetric>
            <HealthMetric icon="clock" label="Tiempo de actividad">
              {ageLabel(result.sections.platform.uptimeSeconds)}
            </HealthMetric>
          </dl>
          {result.sections.platform.degradedReasons.length > 0 ? (
            <ul className="soc-health-reasons">
              {reasonLabels(result.sections.platform.degradedReasons).map((reason) => (
                <li key={reason}>
                  <span aria-hidden="true">!</span>
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
