import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type SessionView } from '../../api/client.js';
import { SocWorkspaceViews } from './SocWorkspaceViews.js';
import { Button, ErrorState, SocIcon, StatusChip, type IconName } from './soc-ui.js';
import { QapaqSplash } from '../login/QapaqSplash.js';

interface NavigationItem {
  readonly label: string;
  readonly path: string;
  readonly icon: IconName;
  readonly capability?: string;
}
interface NavigationGroup {
  readonly label: string;
  readonly items: readonly NavigationItem[];
}

const navigation: readonly NavigationGroup[] = [
  {
    label: 'OPERACIÓN',
    items: [
      { label: 'Resumen', path: '/', icon: 'grid' },
      { label: 'Salud operativa', path: '/operations', icon: 'clock', capability: 'alerts.read' },
      { label: 'Alertas', path: '/alerts', icon: 'alert', capability: 'alerts.read' },
      { label: 'Incidentes', path: '/incidents', icon: 'shield', capability: 'incidents.read' },
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
    // La capability existe, pero el BFF todavía no publica GET /api/events.
    // No ofrecemos una entrada de navegación que termine en una pantalla no operativa.
    items: [],
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

function roleLabel(role: string): string {
  return (
    {
      'qapaq.soc.analyst': 'Analista SOC',
      'qapaq.soc.lead': 'Líder SOC',
      'qapaq.auditor': 'Auditor',
      'qapaq.platform.admin': 'Administrador de plataforma',
    }[role] ?? role
  );
}

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
  const [apiState, setApiState] = useState<'checking' | 'ready' | 'failed'>('checking');

  const loadSession = useCallback(async () => {
    const result = await api.session();
    if (!result.ok) {
      setSessionError(result.error);
      setCheckingSession(false);
      return;
    }
    setSession(result.data);
    setSessionError(null);
    setCheckingSession(false);
  }, []);

  useEffect(() => {
    void loadSession();
    const onPop = () => setPath(pathFromLocation(basePath));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [basePath, loadSession]);

  useEffect(() => {
    let active = true;
    void api.health().then((result) => {
      if (active) setApiState(result.ok ? 'ready' : 'failed');
    });
    return () => {
      active = false;
    };
  }, []);

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
      else if (event.key === 'Escape') setCommandOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    window.localStorage.setItem('qapaq.rail.collapsed', String(collapsed));
  }, [collapsed]);

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
  }

  async function logout(): Promise<void> {
    const result = await api.logout();
    if (result.ok) {
      window.location.assign(basePath);
      return;
    }
    setSessionError(result.error);
  }

  if (!session) {
    if (checkingSession) return <QapaqSplash waiting />;
    const authError = new URLSearchParams(window.location.search).get('authError');
    const route = path || '/';
    const prefix = basePath === '/' ? '' : basePath.slice(0, -1);
    const returnTo = route === '/' ? `${prefix}/console.html` : `${prefix}${route}`;
    const signInHref = `/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`;
    return (
      <main className="soc-auth-state">
        <div className="soc-auth-state__brand">
          <span>Q</span>
          <strong>QAPAQ SecOps</strong>
        </div>
        <h1>{sessionError ? 'No fue posible abrir la consola' : 'Acceso a la consola'}</h1>
        {sessionError ? (
          <ErrorState error={sessionError} onRetry={() => void loadSession()} />
        ) : authError ? (
          <p role="alert">Revisa el acceso institucional e intenta otra vez.</p>
        ) : null}
        <a className="soc-button soc-button--primary" href={signInHref}>
          Continuar con Microsoft Entra
        </a>
      </main>
    );
  }

  const pathname = path.split('?')[0] || '/';
  const profileLabel = session.displayName || session.email || session.subjectId;
  const currentItem = navigation
    .flatMap((group) => group.items)
    .find((item) => item.path === pathname);
  const pageTitle =
    pathname === '/'
      ? 'Resumen'
      : pathname === '/me'
        ? 'Mi sesión'
        : pathname === '/events'
          ? 'Eventos'
          : (currentItem?.label ?? 'No disponible');

  return (
    <div className={`soc-app${collapsed ? ' soc-app--collapsed' : ''}`}>
      <a className="soc-skip-link" href="#soc-main">
        Saltar al contenido
      </a>
      <aside className="soc-rail" aria-label="Navegación principal">
        <a
          className="soc-brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate('/');
          }}
          aria-label="QAPAQ SecOps, Resumen"
        >
          <span className="soc-brand__q">Q</span>
          <span className="soc-brand__name">SecOps</span>
        </a>
        <nav className="soc-nav">
          {allowedGroups.map((group) => (
            <div className="soc-nav__group" key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((item) => (
                <a
                  key={item.path}
                  href={item.path}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(item.path);
                  }}
                  className={`soc-nav__item${pathname === item.path ? ' is-active' : ''}`}
                  aria-current={pathname === item.path ? 'page' : undefined}
                  title={collapsed ? item.label : undefined}
                >
                  <SocIcon name={item.icon} />
                  <span>{item.label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="soc-rail__footer">
          <a
            className={`soc-nav__item${pathname === '/me' ? ' is-active' : ''}`}
            href="/me"
            onClick={(event) => {
              event.preventDefault();
              navigate('/me');
            }}
            title={collapsed ? 'Mi sesión' : undefined}
          >
            <SocIcon name="user" />
            <span>Mi sesión</span>
          </a>
          <button
            className="soc-rail__collapse"
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expandir navegación' : 'Contraer navegación'}
            title={collapsed ? 'Expandir navegación' : 'Contraer navegación'}
          >
            <SocIcon name="menu" />
            <span>Contraer</span>
            <kbd>[</kbd>
          </button>
        </div>
      </aside>
      <div className="soc-main-column">
        <header className="soc-topbar">
          <div className="soc-breadcrumb">
            <span>QAPAQ SecOps</span>
            <span aria-hidden="true">/</span>
            <strong>{pageTitle}</strong>
          </div>
          <div className="soc-topbar__tools">
            <StatusChip
              state={apiState === 'ready' ? 'ok' : apiState === 'failed' ? 'fail' : 'neutral'}
            >
              {apiState === 'ready'
                ? 'API disponible'
                : apiState === 'failed'
                  ? 'API sin respuesta'
                  : 'Conectando'}
            </StatusChip>
            <Button className="soc-command-button" onClick={() => setCommandOpen(true)}>
              <SocIcon name="search" size={15} />
              <span>Ir a</span>
              <kbd>Ctrl K</kbd>
            </Button>
            <details className="soc-profile">
              <summary>
                <span className="soc-profile__mark">{profileLabel.slice(0, 1).toUpperCase()}</span>
                <span className="soc-profile__name">
                  <strong>{profileLabel}</strong>
                  <small>{roleLabel(session.roles[0] ?? 'Sesión institucional')}</small>
                </span>
                <SocIcon name="chevron" size={15} />
              </summary>
              <div className="soc-profile__menu">
                <p>{session.tenantId}</p>
                {session.roles.map((role) => (
                  <span key={role}>{roleLabel(role)}</span>
                ))}
                <Button variant="ghost" onClick={() => void logout()}>
                  Cerrar sesión
                </Button>
              </div>
            </details>
          </div>
        </header>
        <main id="soc-main" className="soc-workspace" tabIndex={-1}>
          <SocWorkspaceViews
            pathname={pathname}
            path={path}
            session={session}
            onNavigate={navigate}
            onSessionRefresh={loadSession}
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
  );
}
