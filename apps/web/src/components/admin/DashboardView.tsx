import type { AlertSummary, IncidentSummary, PlatformOverview } from '../../api/admin.js';
import type { AdminRole } from '../../api/admin.js';
import { Icon, Metric, SectionHeader, Severity, Status, formatDate } from './admin-ui.js';
type Section = 'overview' | 'events' | 'alerts' | 'incidents' | 'cases' | 'rules' | 'sources' | 'services' | 'ingestion' | 'quarantine' | 'notifications' | 'access' | 'audit' | 'sessions';
export function OverviewView({
  overview,
  alerts,
  incidents,
  role,
  canReadAlertDetails,
  canReadAlertAggregate,
  canReadIncidents,
  canReadEvents,
  canReadAccess,
  onSelectAlert,
  onNavigate,
}: {
  overview: PlatformOverview;
  alerts: readonly AlertSummary[];
  incidents: readonly IncidentSummary[];
  role: AdminRole;
  canReadAlertDetails: boolean;
  canReadAlertAggregate: boolean;
  canReadIncidents: boolean;
  canReadEvents: boolean;
  canReadAccess: boolean;
  onSelectAlert: (alert: AlertSummary) => void;
  onNavigate: (section: Section) => void;
}) {
  const critical = canReadAlertDetails ? alerts.find((alert) => alert.severity === 'CRITICAL' && alert.state === 'new') : undefined;
  return (
    <div className="view-stack">
      <div className="metric-row">
        {role === 'PLATFORM_ADMIN' ? <>
          <Metric label="Dependencias" value={overview.services.length} note="Señales de plataforma de la demo" emphasis />
          <Metric label="Cobertura visible" value={overview.coverage.length} note="Fuentes representadas" />
          <Metric label="Señales degradadas" value={overview.services.filter((service) => service.status === 'degraded' || service.status === 'blocked').length} note="Requieren revisión operativa" />
        </> : <>
          {canReadAlertAggregate && <Metric label="Alertas abiertas" value={overview.metrics.openAlerts} note={`${overview.metrics.criticalAlerts} críticas`} emphasis />}
          {canReadIncidents && <Metric label="Incidentes activos" value={overview.metrics.activeIncidents} note="En seguimiento" />}
          {canReadEvents && <Metric label="Eventos · última hora" value={overview.metrics.eventsLastHour.toLocaleString('es-PE')} note="Conteo ilustrativo" />}
          {canReadAccess && <Metric label="Revisiones de acceso" value={overview.metrics.pendingAccessReviews} note="Pendientes de segundo aprobador" />}
        </>}
      </div>
      {critical && (
        <section className="priority-line">
          <div className="priority-icon">
            <Icon name="alerts" size={18} />
          </div>
          <div>
            <span className="priority-label">Prioridad inmediata</span>
            <strong>{critical.title}</strong>
            <small>
              {critical.id} · {critical.source} · {formatDate(critical.occurredAt)}
            </small>
          </div>
          <button type="button" className="text-button" onClick={() => onSelectAlert(critical)}>
            Revisar alerta <Icon name="arrow" size={15} />
          </button>
        </section>
      )}
      <div className="overview-columns">
        <section className="data-section">
          <SectionHeader
            title="Estado de servicios"
            action="Ver todos"
            onAction={() => onNavigate('services')}
          />
          <div className="service-list">
            {overview.services.slice(0, 5).map((service) => (
              <div className="service-row" key={service.id}>
                <span className={`service-mark mark-${service.status}`} />
                <span className="service-name">{service.name}</span>
                <span className="service-detail">{service.detail}</span>
                <Status value={service.status} />
              </div>
            ))}
          </div>
        </section>
        <section className="data-section">
          <SectionHeader
            title="Cobertura de fuentes"
            action="Ver fuentes"
            onAction={() => onNavigate('sources')}
          />
          <div className="coverage-list">
            {overview.coverage.map((source) => (
              <div className="coverage-row" key={source.id}>
                <div>
                  <strong>{source.name}</strong>
                  <small>{source.note}</small>
                  <small>Último evento: {formatDate(source.lastEventAt)}</small>
                </div>
                <Status value={source.state} />
              </div>
            ))}
          </div>
        </section>
      </div>
      {(canReadAlertDetails || (canReadIncidents && role !== 'VIEWER' && role !== 'AUDITOR')) && <div className="overview-columns lower-columns">
        {canReadAlertDetails && <section className="data-section">
          <SectionHeader
            title="Actividad de alertas"
            action="Abrir cola"
            onAction={() => onNavigate('alerts')}
          />
          <div className="activity-list">
            {alerts.slice(0, 3).map((alert) => (
              <button
                type="button"
                key={alert.id}
                className="activity-row"
                onClick={() => onSelectAlert(alert)}
              >
                <Severity value={alert.severity} />
                <span>
                  <strong>{alert.title}</strong>
                  <small>
                    {alert.id} · {alert.source}
                  </small>
                </span>
                <time>{formatDate(alert.occurredAt)}</time>
              </button>
            ))}
          </div>
        </section>}
        {canReadIncidents && role !== 'VIEWER' && role !== 'AUDITOR' && <section className="data-section">
          <SectionHeader
            title="Incidentes en curso"
            action="Ver incidentes"
            onAction={() => onNavigate('incidents')}
          />
          <div className="incident-peek">
            {incidents.slice(0, 2).map((incident) => (
              <div className="incident-row" key={incident.id}>
                <span className="incident-id">{incident.id}</span>
                <span>
                  <strong>{incident.title}</strong>
                  <small>
                    {incident.owner} · {incident.alertCount} alertas
                  </small>
                </span>
                <Status value={incident.state} />
              </div>
            ))}
          </div>
        </section>}
      </div>}
    </div>
  );
}
