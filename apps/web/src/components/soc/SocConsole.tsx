import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type SessionView } from '../../api/client.js';
import { SocWorkspaceViews } from './SocWorkspaceViews.js';
import { ErrorState, SocIcon } from './soc-ui.js';
import { SocNavigationRail, type NavigationGroup } from './SocNavigationRail.js';
import { SocTopbar } from './SocTopbar.js';
import { QapaqSplash } from '../login/QapaqSplash.js';
import { CookieNotice } from '../CookieNotice.js';

const navigation: readonly NavigationGroup[] = [
  {
    label: 'OPERACIÓN',
    items: [
      { label: 'Resumen', path: '/', icon: 'grid' },
      { label: 'Salud operativa', path: '/operations', icon: 'clock', capability: 'alerts.read' },
      { label: 'Alertas', path: '/alerts', icon: 'alert', capability: 'alerts.read' },
      { label: 'Incidentes', path: '/incidents', icon: 'shield', capability: 'incidents.read' },
      {
        label: 'Salud de fuentes',
        path: '/sources',
        icon: 'clock',
        capability: 'sources.health.read',
      },
      {
        label: 'Notificaciones',
        path: '/notifications',
        icon: 'bell',
        capability: 'notifications.read',
      },
    ],
  },
  {
    label: 'ANÁLISIS',
    items: [{ label: 'Eventos', path: '/events', icon: 'search', capability: 'events.read' }],
  },
  {
    label: 'PLATAFORMA',
    items: [
      {
        label: 'Avisos en dispositivos',
        path: '/settings/notifications',
        icon: 'bell',
        capability: 'notifications.read',
      },
    ],
  },
  {
    label: 'GOBIERNO',
    items: [
      { label: 'Usuarios', path: '/admin/users', icon: 'user', capability: 'users.read' },
      { label: 'Sesiones', path: '/admin/sessions', icon: 'history', capability: 'sessions.read' },
      { label: 'Auditoría', path: '/audit', icon: 'history', capability: 'audit.read' },
      { label: 'Integridad', path: '/audit/integrity', icon: 'lock', capability: 'audit.verify' },
    ],
  },
];

function pathFromLocation(basePath: '/' | '/secops/'): string {
  const prefix = basePath === '/' ? '' : basePath.slice(0, -1);
  const pathname = window.location.pathname.replace(/\/console\.html$/u, '/');
  const route =
    prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : pathname;
  return `${route}${window.location.search}`;
}

export function SocConsole({
  basePath = '/',
}: {
  readonly basePath?: '/' | '/secops/';
}): React.JSX.Element {
  const [session, setSession] = useState<SessionView | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState<ApiErrorBody | null>(null);
  const [path, setPath] = useState(() => pathFromLocation(basePath));
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem('qapaq.rail.collapsed') === 'true',
  );
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [apiStatus, setApiStatus] = useState<'checking' | 'ready' | 'failed'>('checking');

  const loadSession = useCallback(async () => {
    const result = await api.session();
    if (!result.ok) {
      const current = new URLSearchParams(window.location.search);
      const login = new URL(basePath, window.location.origin);
      const code = current.get('authError') ?? result.error.code;
      if (code !== 'AUTH_REQUIRED') {
        login.searchParams.set('authError', code);
        login.searchParams.set(
          'correlationId',
          current.get('correlationId') ?? result.error.correlationId,
        );
      }
      window.location.replace(login.pathname + login.search);
      return;
    }
    setSession(result.data);
    setSessionError(null);
    setCheckingSession(false);
  }, [basePath]);

  useEffect(() => {
    void loadSession();
    const onPop = () => setPath(pathFromLocation(basePath));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [basePath, loadSession]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      } else if (!editing && event.key === '[') setCollapsed((value) => !value);
      else if (event.key === 'Escape') {
        setCommandOpen(false);
        setMobileNavOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    window.localStorage.setItem('qapaq.rail.collapsed', String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const check = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const result = await api.health();
      if (active) setApiStatus(result.ok && result.data.status === 'ok' ? 'ready' : 'failed');
      inFlight = false;
    };
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const allowedGroups = useMemo(
    () =>
      navigation
        .map((group) => ({
          ...group,
          items: group.items.filter(
            (item) => !item.capability || session?.capabilities.includes(item.capability),
          ),
        }))
        .filter((group) => group.items.length > 0),
    [session],
  );

  function navigate(next: string): void {
    const [pathname, search = ''] = next.split('?');
    const prefix = basePath === '/' ? '' : basePath.slice(0, -1);
    window.history.pushState({}, '', `${prefix}${pathname}${search ? `?${search}` : ''}`);
    setPath(`${pathname}${search ? `?${search}` : ''}`);
    setCommandOpen(false);
    setMobileNavOpen(false);
  }

  async function logout(): Promise<void> {
    const result = await api.logout();
    if (result.ok) {
      window.location.assign(basePath);
      return;
    }
    setSessionError(result.error);
  }

  if (!session || checkingSession) return <QapaqSplash waiting />;

  const pathname = path.split('?')[0] || '/';
  const profileLabel = session.displayName || session.email || session.subjectId;
  const currentItem =
    allowedGroups
      .flatMap((group) => group.items.map((item) => ({ item, group: group.label })))
      .find(({ item }) => item.path === pathname) ??
    allowedGroups
      .flatMap((group) => group.items.map((item) => ({ item, group: group.label })))
      .find(({ item }) => item.path !== '/' && pathname.startsWith(`${item.path}/`));
  return (
    <>
      <div
        className={`soc-app${collapsed ? ' soc-app--collapsed' : ''}${mobileNavOpen ? ' soc-app--mobile-open' : ''}`}
      >
        <SocNavigationRail
          groups={allowedGroups}
          pathname={pathname}
          collapsed={collapsed}
          mobileOpen={mobileNavOpen}
          brandMarkUrl={`${basePath}qapaq-q-mask.png`}
          onNavigate={navigate}
          onToggleCollapse={() => setCollapsed((value) => !value)}
          onCloseMobile={() => setMobileNavOpen(false)}
        />
        <div className="soc-main-column">
          <SocTopbar
            profileLabel={profileLabel}
            session={session}
            notificationsEnabled={session.capabilities.includes('notifications.read')}
            sectionLabel={currentItem?.group ?? 'OPERACIÓN'}
            pageLabel={currentItem?.item.label ?? 'Resumen'}
            apiStatus={apiStatus}
            mobileNavOpen={mobileNavOpen}
            onOpenCommand={() => setCommandOpen(true)}
            onNavigate={navigate}
            onToggleMobileNav={() => setMobileNavOpen((open) => !open)}
            onLogout={() => void logout()}
          />
          <main id="soc-main" className="soc-workspace" tabIndex={-1}>
            {sessionError ? (
              <ErrorState error={sessionError} onRetry={() => void logout()} />
            ) : null}
            <SocWorkspaceViews
              pathname={pathname}
              path={path}
              session={session}
              onNavigate={navigate}
              onSessionRefresh={loadSession}
              basePath={basePath}
            />
          </main>
        </div>
        {commandOpen ? (
          <div
            className="soc-command-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setCommandOpen(false);
            }}
          >
            <section
              className="soc-command-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Ir a una pantalla"
            >
              <label htmlFor="soc-command-search">Ir a una pantalla</label>
              <input
                id="soc-command-search"
                autoFocus
                placeholder="Busca una pantalla…"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    const match = allowedGroups
                      .flatMap((group) => group.items)
                      .find((item) =>
                        item.label.toLowerCase().includes(event.currentTarget.value.toLowerCase()),
                      );
                    if (match) navigate(match.path);
                  }
                }}
              />
              <div>
                {[
                  ...allowedGroups.flatMap((group) => group.items),
                  { label: 'Mi sesión', path: '/me', icon: 'user' as const },
                ].map((item) => (
                  <button key={item.path} type="button" onClick={() => navigate(item.path)}>
                    <SocIcon name={item.icon} />
                    {item.label}
                    <SocIcon name="arrow" size={15} />
                  </button>
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </div>
      <CookieNotice />
    </>
  );
}
