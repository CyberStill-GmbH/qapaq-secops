import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  AccessRequest,
  AdminRole,
  AdminApi,
  AdminSession,
  AlertSummary,
  AuditEventSummary,
  CaseSummary,
  DetectionRuleSummary,
  IncidentSummary,
  NotificationDelivery,
  PlatformOverview,
  QuarantineRecord,
  SecurityEventSummary,
  ServiceHealth,
  SessionSummary,
  SourceSummary,
} from '../../api/admin.js';
import { OverviewView } from './DashboardView.js';
import { AccessView, AuditView } from './GovernanceViews.js';
import {
  IngestionView,
  NotificationsView,
  ReplayDialog,
  ServicesView,
  SourcesView,
} from './PlatformViews.js';
import { AlertDrawer, AlertsView, IncidentsView } from './SocViews.js';
import { EventSearchView, CasesView } from './InvestigationViews.js';
import { DetectionViews } from './DetectionViews.js';
import { QuarantineView, SessionsView } from './ControlViews.js';
import { Icon, formatDate, type IconName, type Section } from './admin-ui.js';

type AlertFilter = 'all' | 'open' | 'critical';
const nav: readonly {
  section: Section;
  label: string;
  group: string;
  icon: IconName;
  capability: string;
}[] = [
  {
    section: 'overview',
    label: 'Resumen',
    group: 'SOC',
    icon: 'overview',
    capability: 'dashboard.read',
  },
  {
    section: 'events',
    label: 'Eventos',
    group: 'SOC',
    icon: 'search',
    capability: 'events.search',
  },
  { section: 'alerts', label: 'Alertas', group: 'SOC', icon: 'alerts', capability: 'alerts.read' },
  {
    section: 'incidents',
    label: 'Incidentes',
    group: 'SOC',
    icon: 'incidents',
    capability: 'incidents.read',
  },
  { section: 'cases', label: 'Casos', group: 'SOC', icon: 'incidents', capability: 'cases.read' },
  {
    section: 'sources',
    label: 'Fuentes',
    group: 'SOC',
    icon: 'sources',
    capability: 'integrations.read',
  },
  {
    section: 'rules',
    label: 'Reglas',
    group: 'DETECCIÓN',
    icon: 'shield',
    capability: 'rules.read',
  },
  {
    section: 'services',
    label: 'Servicios',
    group: 'PLATAFORMA',
    icon: 'services',
    capability: 'platform.health.read',
  },
  {
    section: 'ingestion',
    label: 'Ingesta',
    group: 'PLATAFORMA',
    icon: 'ingestion',
    capability: 'integrations.read',
  },
  {
    section: 'quarantine',
    label: 'Cuarentena',
    group: 'PLATAFORMA',
    icon: 'shield',
    capability: 'quarantine.read',
  },
  {
    section: 'notifications',
    label: 'Notificaciones',
    group: 'PLATAFORMA',
    icon: 'notifications',
    capability: 'notifications.read',
  },
  {
    section: 'access',
    label: 'Accesos',
    group: 'GOBIERNO',
    icon: 'access',
    capability: 'platform.access.read',
  },
  {
    section: 'audit',
    label: 'Auditoría',
    group: 'GOBIERNO',
    icon: 'audit',
    capability: 'audit.read',
  },
  {
    section: 'sessions',
    label: 'Sesiones',
    group: 'GOBIERNO',
    icon: 'access',
    capability: 'sessions.read',
  },
];
const titles: Record<Section, { title: string; description: string }> = {
  overview: {
    title: 'Resumen de plataforma',
    description: 'Cobertura, actividad reciente y estado de operación.',
  },
  events: {
    title: 'Búsqueda de eventos',
    description: 'Consulta de telemetría normalizada por ventana, fuente y categoría.',
  },
  alerts: { title: 'Alertas', description: 'Cola de alertas con procedencia, estado y prioridad.' },
  incidents: {
    title: 'Incidentes',
    description: 'Investigaciones abiertas y responsables operativos.',
  },
  cases: { title: 'Casos', description: 'Casos operativos dentro del scope autorizado.' },
  rules: {
    title: 'Detección',
    description: 'Rendimiento y estado de reglas; la publicación sigue fuera de esta demo.',
  },
  sources: {
    title: 'Fuentes de telemetría',
    description: 'Conectores aprobados, datasets y continuidad de lectura.',
  },
  services: {
    title: 'Servicios',
    description: 'Dependencias propias y señales de disponibilidad.',
  },
  ingestion: {
    title: 'Ingesta y cobertura',
    description: 'Recorrido desde la fuente hasta la proyección.',
  },
  quarantine: {
    title: 'Cuarentena',
    description: 'Mensajes apartados, motivos y solicitudes controladas de reproceso.',
  },
  notifications: {
    title: 'Notificaciones',
    description: 'Entregas críticas y su estado en el destino configurado.',
  },
  access: {
    title: 'Gobierno de accesos',
    description: 'Solicitudes vigentes y separación de funciones.',
  },
  audit: {
    title: 'Auditoría',
    description: 'Registro de decisiones administrativas y operativas.',
  },
  sessions: { title: 'Sesiones', description: 'Sesiones humanas de muestra y su estado.' },
};
export interface SuperAdminConsoleProps {
  readonly api: AdminApi;
  readonly session: AdminSession;
  readonly onLogout: () => void;
  readonly basePath: string;
  readonly onSessionChange: (session: AdminSession) => void;
}

export default function SuperAdminConsole({
  api,
  session,
  onLogout,
  basePath,
  onSessionChange,
}: SuperAdminConsoleProps) {
  const [section, setSection] = useState<Section>('overview');
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [alerts, setAlerts] = useState<readonly AlertSummary[]>([]);
  const [incidents, setIncidents] = useState<readonly IncidentSummary[]>([]);
  const [sources, setSources] = useState<readonly SourceSummary[]>([]);
  const [services, setServices] = useState<readonly ServiceHealth[]>([]);
  const [requests, setRequests] = useState<readonly AccessRequest[]>([]);
  const [audit, setAudit] = useState<readonly AuditEventSummary[]>([]);
  const [notifications, setNotifications] = useState<readonly NotificationDelivery[]>([]);
  const [events, setEvents] = useState<readonly SecurityEventSummary[]>([]);
  const [cases, setCases] = useState<readonly CaseSummary[]>([]);
  const [rules, setRules] = useState<readonly DetectionRuleSummary[]>([]);
  const [quarantine, setQuarantine] = useState<readonly QuarantineRecord[]>([]);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [alertFilter, setAlertFilter] = useState<AlertFilter>('all');
  const [selectedAlert, setSelectedAlert] = useState<AlertSummary | null>(null);
  const [showAccessForm, setShowAccessForm] = useState(false);
  const [replaySource, setReplaySource] = useState<SourceSummary | null>(null);
  const [toast, setToast] = useState('');
  const [busyId, setBusyId] = useState('');
  const capabilities = useMemo(
    () => new Set(session.actor.capabilities),
    [session.actor.capabilities],
  );
  const can = (capability: string) => capabilities.has(capability);
  const visibleNav = nav.filter((item) =>
    item.section === 'overview'
      ? can('dashboard.read') || can('platform.health.read')
      : can(item.capability),
  );
  const visibleGroups = (['SOC', 'DETECCIÓN', 'PLATAFORMA', 'GOBIERNO'] as const).filter((group) =>
    visibleNav.some((item) => item.group === group),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const safeRead = <T,>(request: Promise<T>, fallback: T): Promise<T> =>
        request.catch(() => {
          setToast('Una sección no pudo actualizarse. El resto del panel sigue disponible.');
          return fallback;
        });
      const [
        nextOverview,
        nextAlerts,
        nextIncidents,
        nextSources,
        nextServices,
        nextRequests,
        nextAudit,
        nextNotifications,
        nextEvents,
        nextCases,
        nextRules,
        nextQuarantine,
        nextSessions,
      ] = await Promise.all([
        can('dashboard.read') || can('platform.health.read')
          ? safeRead(api.getOverview(), null)
          : Promise.resolve(null),
        can('alerts.read')
          ? safeRead(api.getAlerts(), { items: [], nextCursor: null })
          : Promise.resolve({ items: [], nextCursor: null }),
        can('incidents.read')
          ? safeRead(api.getIncidents(), { items: [], nextCursor: null })
          : Promise.resolve({ items: [], nextCursor: null }),
        can('integrations.read') ? safeRead(api.getSources(), []) : Promise.resolve([]),
        can('platform.health.read') ? safeRead(api.getServices(), []) : Promise.resolve([]),
        can('platform.access.read')
          ? safeRead(api.getAccessRequests(), { items: [], nextCursor: null })
          : Promise.resolve({ items: [], nextCursor: null }),
        can('audit.read')
          ? safeRead(api.getAuditEvents(), { items: [], nextCursor: null })
          : Promise.resolve({ items: [], nextCursor: null }),
        can('notifications.read') ? safeRead(api.getNotifications(), []) : Promise.resolve([]),
        can('events.search')
          ? safeRead(
              api.searchEvents({
                from: '2026-09-30T19:32:00.000Z',
                to: '2026-10-01T19:32:00.000Z',
              }),
              { items: [], nextCursor: null },
            )
          : Promise.resolve({ items: [], nextCursor: null }),
        can('cases.read')
          ? safeRead(api.getCases(), { items: [], nextCursor: null })
          : Promise.resolve({ items: [], nextCursor: null }),
        can('rules.read')
          ? safeRead(api.getDetectionRules(), { items: [], nextCursor: null })
          : Promise.resolve({ items: [], nextCursor: null }),
        can('quarantine.read') ? safeRead(api.getQuarantine(), []) : Promise.resolve([]),
        can('sessions.read') ? safeRead(api.getSessions(), []) : Promise.resolve([]),
      ]);
      setOverview(nextOverview);
      setAlerts(nextAlerts.items);
      setIncidents(nextIncidents.items);
      setSources(nextSources);
      setServices(nextServices);
      setRequests(nextRequests.items);
      setAudit(nextAudit.items);
      setNotifications(nextNotifications);
      setEvents(nextEvents.items);
      setCases(nextCases.items);
      setRules(nextRules.items);
      setQuarantine(nextQuarantine);
      setSessions(nextSessions);
    } finally {
      setLoading(false);
    }
  }, [api, session.actor.capabilities]);

  async function searchEvents(query: { q: string; from: string; to: string }) {
    try {
      const result = await api.searchEvents(query);
      setEvents(result.items);
    } catch {
      setToast('No se pudo consultar eventos. Revisa la ventana y vuelve a intentar.');
    }
  }

  async function reprocessQuarantine(id: string, reason: string) {
    if (!can('quarantine.reprocess')) return;
    setBusyId(id);
    try {
      const receipt = await api.reprocessQuarantine(id, reason);
      setQuarantine((items) =>
        items.map((item) =>
          item.id === id ? { ...item, state: 'reprocessing', attempts: item.attempts + 1 } : item,
        ),
      );
      setToast(`${receipt.message} Requiere revisión operativa.`);
    } catch {
      setToast('No se pudo registrar el reproceso. Verifica el motivo y estado.');
    } finally {
      setBusyId('');
    }
  }

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!visibleNav.some((item) => item.section === section) && visibleNav[0]) {
      setSection(visibleNav[0].section);
    }
  }, [session.actor.role]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const current = titles[section];
  const filteredAlerts = useMemo(
    () =>
      alerts.filter((item) =>
        `${item.id} ${item.title} ${item.source} ${item.ruleId}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
      ),
    [alerts, query],
  );
  const visibleAlerts = useMemo(
    () =>
      filteredAlerts.filter(
        (item) =>
          alertFilter === 'all' ||
          (alertFilter === 'open' ? item.state !== 'closed' : item.severity === 'CRITICAL'),
      ),
    [filteredAlerts, alertFilter],
  );
  const filteredAudit = useMemo(
    () =>
      audit.filter((item) =>
        `${item.id} ${item.actor} ${item.action} ${item.resource}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
      ),
    [audit, query],
  );

  async function acknowledge(alert: AlertSummary) {
    setBusyId(alert.id);
    try {
      const updated = await api.acknowledgeAlert(alert.id);
      setAlerts((currentAlerts) =>
        currentAlerts.map((item) => (item.id === alert.id ? updated : item)),
      );
      setSelectedAlert(updated);
      setToast(`Alerta ${alert.id} acusada en la simulación.`);
    } catch {
      setToast('No se pudo acusar la alerta. Intenta nuevamente.');
    } finally {
      setBusyId('');
    }
  }

  async function retryDelivery(delivery: NotificationDelivery) {
    setBusyId(delivery.id);
    try {
      const updated = await api.retryNotification(delivery.id);
      setNotifications((currentItems) =>
        currentItems.map((item) => (item.id === delivery.id ? updated : item)),
      );
      setToast(`Reintento simulado para ${delivery.id}. No se envió ningún mensaje real.`);
    } catch {
      setToast('No se pudo registrar el reintento.');
    } finally {
      setBusyId('');
    }
  }

  async function submitAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = String(form.get('target') ?? '').trim();
    if (target.toLocaleLowerCase() === session.actor.email.toLocaleLowerCase()) {
      setToast(
        'No puedes solicitar un grant para tu propia cuenta. Registra una solicitud con otro responsable.',
      );
      return;
    }
    const input = {
      target,
      requestedBundle: String(form.get('bundle') ?? 'SOC_L1') as AccessRequest['requestedBundle'],
      scope: String(form.get('scope') ?? '').trim(),
      reason: String(form.get('reason') ?? '').trim(),
    };
    setBusyId('access-form');
    try {
      const created = await api.submitAccessRequest(input);
      setRequests((currentRequests) => [created, ...currentRequests]);
      setShowAccessForm(false);
      setToast(`${created.id} creada en mock y enviada a doble aprobación.`);
    } catch {
      setToast('No se pudo registrar la solicitud.');
    } finally {
      setBusyId('');
    }
  }

  async function submitReplay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!replaySource) return;
    const form = new FormData(event.currentTarget);
    setBusyId('replay-form');
    try {
      const result = await api.requestReplay({
        sourceId: replaySource.id,
        from: String(form.get('from')),
        to: String(form.get('to')),
        reason: String(form.get('reason') ?? ''),
      });
      setReplaySource(null);
      setToast(`${result.message} (modo ${result.mode}).`);
    } catch {
      setToast('No se pudo registrar la solicitud de replay.');
    } finally {
      setBusyId('');
    }
  }

  return (
    <main className="admin-shell">
      <aside className="admin-rail" aria-label="Navegación principal">
        <a className="admin-brand" href="#console" aria-label="QAPAQ SecOps, consola">
          <img src={`${basePath}qapaq-mark-source.png`} alt="" />
          <span>
            QAPAQ<span>SECOPS</span>
          </span>
        </a>
        <div className="rail-workspace">
          <span className="workspace-dot" />
          Institución financiera<span className="rail-chevron">⌄</span>
        </div>
        <nav className="admin-nav">
          {visibleGroups.map((group) => (
            <div className="nav-group" key={group}>
              <span className="nav-group-label">{group}</span>
              {visibleNav
                .filter((item) => item.group === group)
                .map((item) => (
                  <button
                    key={item.section}
                    type="button"
                    className={`nav-item${section === item.section ? ' is-active' : ''}`}
                    aria-current={section === item.section ? 'page' : undefined}
                    onClick={() => {
                      setSection(item.section);
                      setQuery('');
                    }}
                  >
                    <Icon name={item.icon} size={17} />
                    <span>{item.label}</span>
                    {item.section === 'alerts' && <span className="nav-count">12</span>}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="rail-bottom">
          <div className="rail-environment">
            <span className="env-dot" />
            DEMO LOCAL
          </div>
          <div className="rail-user">
            <span className="user-avatar">VR</span>
            <span>
              <strong>{session.actor.displayName}</strong>
              <small>{session.actor.role.replaceAll('_', ' ')}</small>
            </span>
            <button
              type="button"
              className="icon-button logout-button"
              onClick={onLogout}
              aria-label="Cerrar sesión"
            >
              <Icon name="logout" size={17} />
            </button>
          </div>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div className="breadcrumbs">
            QAPAQ <span>/</span> Administración <span>/</span> <strong>{current.title}</strong>
          </div>
          <div className="topbar-actions">
            <span className="mock-chip">
              <span />
              Datos de demostración
            </span>
            <button
              type="button"
              className="icon-button refresh-button"
              onClick={() => void load()}
              aria-label="Actualizar datos"
              disabled={loading}
            >
              <Icon name="refresh" size={17} />
            </button>
            <button
              type="button"
              className="avatar-small"
              aria-label={`Sesión de ${session.actor.displayName}`}
            >
              VR
            </button>
            {session.mode === 'mock' && (
              <label className="demo-role-select">
                <span className="sr-only">Cambiar perfil de demostración</span>
                <select
                  aria-label="Perfil de demostración"
                  value={session.actor.role}
                  onChange={(event) => {
                    const role = event.currentTarget.value as AdminRole;
                    if ('setDemoRole' in api && typeof api.setDemoRole === 'function')
                      onSessionChange(api.setDemoRole(role));
                  }}
                >
                  {(
                    [
                      'PLATFORM_ADMIN',
                      'SOC_MANAGER',
                      'SOC_L1',
                      'SOC_L2',
                      'DETECTION_ENGINEER',
                      'AUDITOR',
                      'VIEWER',
                      'ACCESS_ADMIN',
                    ] as const
                  ).map((role) => (
                    <option key={role} value={role}>
                      {role.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </header>

        <section className="admin-content" aria-busy={loading}>
          <div className="page-heading">
            <div>
              <h1>{current.title}</h1>
              <p>{current.description}</p>
            </div>
            <time dateTime={overview?.asOf}>
              {overview ? `Actualizado ${formatDate(overview.asOf)}` : 'Cargando…'}
            </time>
          </div>
          <div className="demo-notice">
            <Icon name="shield" size={17} />
            <p>
              <strong>Vista de demostración.</strong> Todo el contenido es sintético; las acciones
              se guardan solo en memoria y no afectan sistemas reales.
            </p>
          </div>

          {loading && !overview && section === 'overview' ? (
            <div className="loading-state" role="status">
              Cargando vista de administración…
            </div>
          ) : (
            <>
              {section === 'overview' && overview && (
                <OverviewView
                  overview={overview}
                  alerts={alerts}
                  incidents={incidents}
                  role={session.actor.role}
                  canReadAlertDetails={
                    can('alerts.read') &&
                    session.actor.role !== 'VIEWER' &&
                    session.actor.role !== 'AUDITOR'
                  }
                  canReadAlertAggregate={can('alerts.read')}
                  canReadIncidents={can('incidents.read')}
                  canReadEvents={can('events.search')}
                  canReadAccess={can('platform.access.read')}
                  onSelectAlert={(item) => {
                    setSelectedAlert(item);
                    setSection('alerts');
                  }}
                  onNavigate={setSection}
                />
              )}
              {section === 'alerts' && (
                <AlertsView
                  alerts={visibleAlerts}
                  query={query}
                  setQuery={setQuery}
                  filter={alertFilter}
                  setFilter={setAlertFilter}
                  onSelect={setSelectedAlert}
                />
              )}
              {section === 'events' && (
                <EventSearchView events={events} onSearch={(params) => void searchEvents(params)} />
              )}
              {section === 'cases' && <CasesView items={cases} />}
              {section === 'rules' && <DetectionViews rules={rules} />}
              {section === 'quarantine' && (
                <QuarantineView
                  records={quarantine}
                  canReprocess={can('quarantine.reprocess')}
                  onReprocess={(id, reason) => void reprocessQuarantine(id, reason)}
                />
              )}
              {section === 'sessions' && <SessionsView sessions={sessions} />}
              {section === 'incidents' && <IncidentsView incidents={incidents} />}
              {section === 'sources' && (
                <SourcesView sources={sources} onReplay={setReplaySource} />
              )}
              {section === 'services' && <ServicesView services={services} />}
              {section === 'ingestion' && overview && (
                <IngestionView overview={overview} services={services} />
              )}
              {section === 'notifications' && (
                <NotificationsView
                  items={notifications}
                  busyId={busyId}
                  onRetry={(item) => void retryDelivery(item)}
                />
              )}
              {section === 'access' && (
                <AccessView
                  requests={requests}
                  showForm={showAccessForm}
                  setShowForm={setShowAccessForm}
                  onSubmit={(event) => void submitAccess(event)}
                  busy={busyId === 'access-form'}
                />
              )}
              {section === 'audit' && (
                <AuditView events={filteredAudit} query={query} setQuery={setQuery} />
              )}
            </>
          )}
        </section>
      </div>

      {selectedAlert && (
        <AlertDrawer
          alert={selectedAlert}
          busy={busyId === selectedAlert.id}
          onClose={() => setSelectedAlert(null)}
          onAcknowledge={() => void acknowledge(selectedAlert)}
        />
      )}
      {replaySource && (
        <ReplayDialog
          source={replaySource}
          busy={busyId === 'replay-form'}
          onClose={() => setReplaySource(null)}
          onSubmit={(event) => void submitReplay(event)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button type="button" onClick={() => setToast('')} aria-label="Cerrar aviso">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </main>
  );
}
