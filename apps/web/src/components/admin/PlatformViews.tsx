import type { FormEvent } from 'react';
import type { NotificationDelivery, PlatformOverview, ServiceHealth, SourceSummary } from '../../api/admin.js';
import { Empty, Icon, SectionHeader, Severity, Status, TableFrame, formatDate } from './admin-ui.js';
export function SourcesView({
  sources,
  onReplay,
}: {
  sources: readonly SourceSummary[];
  onReplay: (source: SourceSummary) => void;
}) {
  return (
    <div className="view-stack">
      <div className="source-list">
        {sources.map((source) => (
          <article className="source-entry" key={source.id}>
            <div className="source-symbol">
              <Icon name={source.id.includes('wazuh') ? 'sources' : 'search'} size={20} />
            </div>
            <div className="source-main">
              <div className="source-title">
                <h2>{source.name}</h2>
                <Status value={source.status} />
              </div>
              <p>{source.provider}</p>
              <div className="dataset-tags">
                {source.datasets.map((dataset) => (
                  <span key={dataset}>{dataset}</span>
                ))}
              </div>
              <div className="source-meta">
                <span>Última lectura: {formatDate(source.lastSuccessfulRead)}</span>
                <span>
                  Replay:{' '}
                  {source.replayCapability === 'not_verified'
                    ? 'No verificado'
                    : source.replayCapability === 'bounded'
                      ? 'Acotado'
                      : 'Best effort'}
                </span>
              </div>
            </div>
            <button type="button" className="secondary-button" onClick={() => onReplay(source)}>
              Solicitar replay
            </button>
          </article>
        ))}
      </div>
      <p className="data-footnote">
        Un replay solo crea una solicitud simulada; capacidad y ventana deben validarse en el
        backend antes de ejecutar.
      </p>
    </div>
  );
}

export function ServicesView({ services }: { services: readonly ServiceHealth[] }) {
  return (
    <div className="view-stack">
      <div className="data-section table-section">
        <TableFrame>
          <thead>
            <tr>
              <th>Servicio</th>
              <th>Categoría</th>
              <th>Estado</th>
              <th>Latencia</th>
              <th>Verificado</th>
            </tr>
          </thead>
          <tbody>
            {services.map((service) => (
              <tr key={service.id}>
                <td>
                  <strong>{service.name}</strong>
                  <small>{service.detail}</small>
                </td>
                <td>{service.kind}</td>
                <td>
                  <Status value={service.status} />
                </td>
                <td>{service.latencyMs ? `${service.latencyMs} ms` : '—'}</td>
                <td>{formatDate(service.checkedAt)}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </div>
      <div className="inline-callout">
        <Icon name="shield" size={18} />
        <p>
          <strong>El estado de esta vista es ilustrativo.</strong> El endpoint público
          `/health/ready` solo comprueba el proceso API; esta matriz requerirá checks autorizados
          por dependencia.
        </p>
      </div>
    </div>
  );
}

export function IngestionView({
  overview,
  services,
}: {
  overview: PlatformOverview;
  services: readonly ServiceHealth[];
}) {
  const steps = [
    {
      name: 'Wazuh · consulta read-only',
      status: services.find((item) => item.id === 'wazuh')?.status ?? 'unknown',
      detail: 'Fuente y permiso real pendientes',
    },
    {
      name: 'Admisión durable · PostgreSQL + object storage',
      status: 'healthy',
      detail: 'Muestra de estado; no es medición de runtime',
    },
    {
      name: 'Normalización · SecurityEvent 1.0.0',
      status: 'healthy',
      detail: 'Contrato en desarrollo',
    },
    {
      name: 'Proyección · OpenSearch QAPAQ',
      status: services.find((item) => item.id === 'opensearch')?.status ?? 'unknown',
      detail: 'OpenSearch propio; consumidor worker pendiente',
    },
  ];
  return (
    <div className="view-stack">
      <div className="pipeline-list">
        {steps.map((step, index) => (
          <div className="pipeline-step" key={step.name}>
            <span className="pipeline-index">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>{step.name}</strong>
              <small>{step.detail}</small>
            </div>
            <Status value={step.status} />
          </div>
        ))}
      </div>
      <div className="overview-columns">
        <section className="data-section">
          <SectionHeader title="Cobertura por dataset" />
          <div className="coverage-list">
            {overview.coverage.map((item) => (
              <div className="coverage-row" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.note}</small>
                  <small>Último evento: {formatDate(item.lastEventAt)}</small>
                </div>
                <Status value={item.state} />
              </div>
            ))}
          </div>
        </section>
        <section className="data-section">
          <SectionHeader title="Límites de evidencia" />
          <ul className="plain-list">
            <li>Raw y hashes no se muestran en esta vista.</li>
            <li>Un checkpoint solo representa admisión durable.</li>
            <li>No se infiere ausencia de pérdida sin evidencia de continuidad.</li>
            <li>La consulta real requiere scope y capability verificados.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

export function NotificationsView({
  items,
  busyId,
  onRetry,
}: {
  items: readonly NotificationDelivery[];
  busyId: string;
  onRetry: (item: NotificationDelivery) => void;
}) {
  return (
    <div className="view-stack">
      <div className="data-section table-section">
        <TableFrame>
          <thead>
            <tr>
              <th>Entrega</th>
              <th>Destino</th>
              <th>Severidad</th>
              <th>Intentos</th>
              <th>Estado</th>
              <th>Actualizada</th>
              <th>
                <span className="sr-only">Acción</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.id}</strong>
                  <small>Alerta {item.alertId}</small>
                </td>
                <td>{item.destination}</td>
                <td>
                  <Severity value={item.severity} />
                </td>
                <td>{item.attempts}</td>
                <td>
                  <Status value={item.state} />
                </td>
                <td>{formatDate(item.updatedAt)}</td>
                <td>
                  {item.state === 'failed' && (
                    <button
                      type="button"
                      className="row-action"
                      disabled={busyId === item.id}
                      onClick={() => onRetry(item)}
                    >
                      {busyId === item.id ? 'Enviando…' : 'Reintentar'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </div>
      <p className="data-footnote">
        Los reintentos reales deben ser idempotentes, limitados y autorizados. La demo no envía
        mensajes a Teams.
      </p>
    </div>
  );
}


export function ReplayDialog({
  source,
  busy,
  onClose,
  onSubmit,
}: {
  source: SourceSummary;
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="replay-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-title"
      >
        <div className="drawer-head">
          <div>
            <span className="drawer-id">{source.id}</span>
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Cerrar solicitud"
            >
              <Icon name="close" />
            </button>
          </div>
          <h2 id="replay-title">Solicitar replay de fuente</h2>
          <p>{source.name}</p>
        </div>
        <form className="replay-form" onSubmit={onSubmit}>
          <label>
            Desde
            <input name="from" required type="datetime-local" />
          </label>
          <label>
            Hasta
            <input name="to" required type="datetime-local" />
          </label>
          <label>
            Motivo
            <textarea
              name="reason"
              required
              minLength={12}
              placeholder="Justifica la recuperación solicitada"
            />
          </label>
          <div className="inline-callout">
            <Icon name="clock" size={17} />
            <p>
              Se registrará una solicitud mock; no se iniciará un trabajo ni se moverá el
              checkpoint.
            </p>
          </div>
          <div className="form-actions">
            <button type="button" className="text-button" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? 'Registrando…' : 'Enviar solicitud'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
