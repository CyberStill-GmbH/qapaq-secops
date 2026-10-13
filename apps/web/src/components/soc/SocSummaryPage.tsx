import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import {
  api,
  type AlertView,
  type AuditEventView,
  type AuditIntegrityView,
  type IncidentView,
  type NotificationView,
  type SessionView,
} from '../../api/client.js';
import {
  Button,
  EmptyState,
  ErrorState,
  RelativeTime,
  Severity,
  SocIcon,
  StatusChip,
} from './soc-ui.js';
import { PageHeader, Panel, StateCell, statusLabel } from './soc-data-ui.js';
import { useChanges } from './use-changes.js';

export function SummaryPage({
  session,
  onNavigate,
}: {
  readonly session: SessionView;
  readonly onNavigate: (path: string) => void;
}): React.JSX.Element {
  const [alerts, setAlerts] = useState<readonly AlertView[]>([]);
  const [openAlertsCount, setOpenAlertsCount] = useState<number | null>(null);
  const [incidents, setIncidents] = useState<readonly IncidentView[]>([]);
  const [activeIncidentsCount, setActiveIncidentsCount] = useState<number | null>(null);
  const [notifications, setNotifications] = useState<readonly NotificationView[]>([]);
  const [integrity, setIntegrity] = useState<AuditIntegrityView | null>(null);
  const [activity, setActivity] = useState<readonly AuditEventView[]>([]);
  const [errors, setErrors] = useState<Readonly<Record<string, ApiErrorBody>>>({});
  const [updated, setUpdated] = useState<string | null>(null);
  const [apiStatus, setApiStatus] = useState<'checking' | 'ready' | 'failed'>('checking');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setErrors({});
    let complete = true;
    const tasks: Promise<void>[] = [];
    tasks.push(
      api.health().then((result) => {
        const healthy = result.ok && result.data.status === 'ok';
        setApiStatus(healthy ? 'ready' : 'failed');
        if (!healthy) {
          complete = false;
          if (!result.ok) setErrors((value) => ({ ...value, health: result.error }));
        }
      }),
    );
    if (session.capabilities.includes('alerts.read'))
      tasks.push(
        api.alertsByStatus('open').then((result) => {
          if (result.ok) {
            setAlerts(result.data.items);
            setOpenAlertsCount(result.data.totalCount ?? result.data.items.length);
          } else {
            complete = false;
            setErrors((value) => ({ ...value, alerts: result.error }));
          }
        }),
      );
    if (session.capabilities.includes('incidents.read'))
      tasks.push(
        api.incidents(undefined, 'active').then((result) => {
          if (result.ok) {
            setIncidents(result.data.items);
            setActiveIncidentsCount(result.data.totalCount ?? result.data.items.length);
          } else {
            complete = false;
            setErrors((value) => ({ ...value, incidents: result.error }));
          }
        }),
      );
    if (session.capabilities.includes('notifications.read'))
      tasks.push(
        api.notifications().then((result) => {
          if (result.ok) setNotifications(result.data.items);
          else {
            complete = false;
            setErrors((value) => ({ ...value, notifications: result.error }));
          }
        }),
      );
    if (session.capabilities.includes('audit.verify'))
      tasks.push(
        api.verifyAudit().then((result) => {
          if (result.ok) setIntegrity(result.data);
          else {
            complete = false;
            setErrors((value) => ({ ...value, integrity: result.error }));
          }
        }),
      );
    if (session.capabilities.includes('audit.read')) {
      const to = new Date();
      const from = new Date(to.getTime() - 86_400_000);
      tasks.push(
        api.audit(from.toISOString(), to.toISOString()).then((result) => {
          if (result.ok) setActivity(result.data.items.slice(-8).reverse());
          else {
            complete = false;
            setErrors((value) => ({ ...value, activity: result.error }));
          }
        }),
      );
    }
    await Promise.all(tasks);
    if (complete) setUpdated(new Date().toISOString());
    setLoading(false);
  }, [session.capabilities]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useChanges({
    resourceTypes: ['alert', 'incident', 'notification'],
    onChange: () => void refresh(),
  });
  const openAlerts = alerts;
  const criticalNotAcked = notifications.filter((notification) =>
    ['sent', 'indeterminate', 'fallback'].includes(notification.status),
  );
  const title = session.capabilities.includes('alerts.read')
    ? 'Resumen de operación'
    : 'Estado de la operación';

  return (
    <div className="soc-page">
      <PageHeader
        title={title}
        description="Prioridades del turno y estado de la información disponible."
        updated={updated}
        action={
          <Button onClick={() => void refresh()} aria-label="Actualizar resumen">
            <SocIcon name="refresh" /> Actualizar
          </Button>
        }
      />
      <div className="soc-operation-strip">
        <div>
          <StatusChip
            state={apiStatus === 'ready' ? 'ok' : apiStatus === 'failed' ? 'fail' : 'neutral'}
          >
            {apiStatus === 'ready'
              ? 'API disponible'
              : apiStatus === 'failed'
                ? 'API sin respuesta'
                : 'Comprobando API'}
          </StatusChip>
          <span>
            {errors.health?.correlationId
              ? `No se pudo consultar · referencia ${errors.health.correlationId}`
              : apiStatus === 'failed'
                ? 'La comprobación de disponibilidad no fue exitosa.'
                : 'Estado de disponibilidad del BFF.'}
          </span>
        </div>
        <div>
          <StatusChip state="neutral">Ingesta sin datos de salud</StatusChip>
          <span>No hay una API de cobertura del pipeline.</span>
        </div>
        {integrity ? (
          <div>
            <StatusChip state={integrity.ok ? 'ok' : 'fail'}>
              {integrity.ok ? 'Cadena íntegra' : `${integrity.violations.length} violaciones`}
            </StatusChip>
            <span>{integrity.checked.toLocaleString('es-PE')} eventos verificados</span>
          </div>
        ) : null}
      </div>
      <div className="soc-summary-grid">
        {session.capabilities.includes('alerts.read') ? (
          <Panel
            title={`Alertas activas${openAlertsCount === null ? '' : ` · ${openAlertsCount}`}`}
            action={
              <button className="soc-text-link" onClick={() => onNavigate('/alerts')}>
                Ver alertas <SocIcon name="arrow" size={14} />
              </button>
            }
          >
            {errors.alerts ? (
              <ErrorState error={errors.alerts} onRetry={() => void refresh()} />
            ) : loading ? (
              <div className="soc-table-placeholder">Cargando alertas…</div>
            ) : openAlerts.length ? (
              <div className="soc-compact-list">
                {openAlerts.slice(0, 6).map((alert) => (
                  <button
                    key={alert.id}
                    type="button"
                    onClick={() => onNavigate(`/alerts/${encodeURIComponent(alert.id)}`)}
                  >
                    <Severity value={alert.priority} score={alert.score} />
                    <strong>{alert.title}</strong>
                    <StateCell value={alert.status} />
                    <RelativeTime value={alert.occurredAt} />
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState>No hay alertas activas en la consulta completa.</EmptyState>
            )}
          </Panel>
        ) : null}
        {session.capabilities.includes('notifications.read') ? (
          <Panel
            title="Notificaciones pendientes · página consultada"
            action={
              <button className="soc-text-link" onClick={() => onNavigate('/notifications')}>
                Ver notificaciones <SocIcon name="arrow" size={14} />
              </button>
            }
          >
            {errors.notifications ? (
              <ErrorState error={errors.notifications} onRetry={() => void refresh()} />
            ) : loading ? (
              <div className="soc-table-placeholder">Cargando notificaciones…</div>
            ) : criticalNotAcked.length ? (
              <div className="soc-compact-list soc-compact-list--notifications">
                {criticalNotAcked.slice(0, 5).map((item) => (
                  <div key={item.id}>
                    <StatusChip state={item.status === 'sent' ? 'warn' : 'fail'}>
                      {statusLabel(item.status)}
                    </StatusChip>
                    <span>
                      {item.channel === 'teams'
                        ? 'Microsoft Teams'
                        : item.channel === 'fallback_email'
                          ? 'Correo alterno'
                          : 'Consola'}
                    </span>
                    <RelativeTime value={item.sentAt} />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>
                No hay notificaciones pendientes de acuse en las entregas consultadas.
              </EmptyState>
            )}
          </Panel>
        ) : null}
        {session.capabilities.includes('incidents.read') ? (
          <Panel
            title={`Incidentes activos${activeIncidentsCount === null ? '' : ` · ${activeIncidentsCount}`}`}
            action={
              <button className="soc-text-link" onClick={() => onNavigate('/incidents')}>
                Ver incidentes <SocIcon name="arrow" size={14} />
              </button>
            }
          >
            {errors.incidents ? (
              <ErrorState error={errors.incidents} onRetry={() => void refresh()} />
            ) : loading ? (
              <div className="soc-table-placeholder">Cargando incidentes…</div>
            ) : incidents.length ? (
              <div className="soc-compact-list">
                {incidents.slice(0, 5).map((incident) => (
                  <button
                    key={incident.id}
                    type="button"
                    onClick={() => onNavigate(`/incidents/${encodeURIComponent(incident.id)}`)}
                  >
                    <Severity value={incident.severity} />
                    <strong>{incident.title}</strong>
                    <StateCell value={incident.status} />
                    <RelativeTime value={incident.openedAt} />
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState>No hay incidentes activos en la consulta completa.</EmptyState>
            )}
          </Panel>
        ) : null}
        {session.capabilities.includes('audit.verify') ? (
          <Panel
            title="Integridad de auditoría"
            action={
              <button className="soc-text-link" onClick={() => onNavigate('/audit/integrity')}>
                Ver integridad <SocIcon name="arrow" size={14} />
              </button>
            }
          >
            {errors.integrity ? (
              <ErrorState error={errors.integrity} onRetry={() => void refresh()} />
            ) : integrity ? (
              <div className="soc-integrity-summary">
                <StatusChip state={integrity.ok ? 'ok' : 'fail'}>
                  {integrity.ok ? 'Sin violaciones' : 'Se detectaron violaciones'}
                </StatusChip>
                <p>
                  {integrity.checked.toLocaleString('es-PE')} eventos revisados · secuencia{' '}
                  {integrity.headSequence}
                </p>
                <small>La verificación revisa hasta los primeros 1 000 eventos.</small>
              </div>
            ) : (
              <EmptyState>Verificación pendiente.</EmptyState>
            )}
          </Panel>
        ) : null}
        {session.capabilities.includes('audit.read') ? (
          <Panel
            title="Actividad de auditoría"
            action={
              <button className="soc-text-link" onClick={() => onNavigate('/audit')}>
                Ver auditoría <SocIcon name="arrow" size={14} />
              </button>
            }
          >
            {errors.activity ? (
              <ErrorState error={errors.activity} onRetry={() => void refresh()} />
            ) : loading ? (
              <div className="soc-table-placeholder">Cargando actividad…</div>
            ) : activity.length ? (
              <div className="soc-activity-list">
                {activity.map((event) => (
                  <div key={event.id}>
                    <RelativeTime value={event.occurredAt} />
                    <strong>{event.action}</strong>
                    <span>
                      {event.outcome === 'denied'
                        ? 'Denegado'
                        : event.outcome === 'failed'
                          ? 'Fallido'
                          : 'Permitido'}{' '}
                      · {event.actor.id}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>Sin actividad de auditoría en las últimas 24 horas.</EmptyState>
            )}
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
