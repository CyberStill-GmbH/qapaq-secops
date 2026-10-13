import type { SessionView } from '../../api/client.js';
import { Button, SocIcon, StatusChip } from './soc-ui.js';

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

export function SocTopbar({
  profileLabel,
  session,
  notificationsEnabled,
  sectionLabel,
  pageLabel,
  apiStatus,
  mobileNavOpen,
  onOpenCommand,
  onNavigate,
  onToggleMobileNav,
  onLogout,
}: {
  readonly profileLabel: string;
  readonly session: SessionView;
  readonly notificationsEnabled: boolean;
  readonly sectionLabel: string;
  readonly pageLabel: string;
  readonly apiStatus: 'checking' | 'ready' | 'failed';
  readonly mobileNavOpen: boolean;
  readonly onOpenCommand: () => void;
  readonly onNavigate: (path: string) => void;
  readonly onToggleMobileNav: () => void;
  readonly onLogout: () => void;
}): React.JSX.Element {
  return (
    <header className="soc-topbar">
      <Button
        variant="ghost"
        className="soc-mobile-menu-button"
        onClick={onToggleMobileNav}
        aria-label={mobileNavOpen ? 'Cerrar menú' : 'Abrir menú'}
        aria-expanded={mobileNavOpen}
        aria-controls="soc-navigation"
      >
        <SocIcon name={mobileNavOpen ? 'close' : 'menu'} size={19} />
      </Button>
      <div className="soc-breadcrumb">
        <span>{sectionLabel}</span>
        <strong aria-hidden="true">/</strong>
        <strong className="soc-breadcrumb__current">{pageLabel}</strong>
      </div>
      <div className="soc-topbar__tools">
        <button
          className="soc-pipeline-pill"
          type="button"
          onClick={() => onNavigate('/operations')}
          aria-label={
            apiStatus === 'ready'
              ? 'API disponible. Abrir salud operativa.'
              : apiStatus === 'failed'
                ? 'API sin respuesta. Abrir salud operativa.'
                : 'Comprobando API. Abrir salud operativa.'
          }
        >
          <StatusChip
            state={apiStatus === 'ready' ? 'ok' : apiStatus === 'failed' ? 'fail' : 'neutral'}
          >
            {apiStatus === 'ready'
              ? 'API disponible'
              : apiStatus === 'failed'
                ? 'API sin respuesta'
                : 'Comprobando API'}
          </StatusChip>
        </button>
        <Button
          className="soc-command-button"
          onClick={onOpenCommand}
          aria-label="Buscar una pantalla (Ctrl K)"
          title="Buscar una pantalla (Ctrl K)"
        >
          <SocIcon name="search" size={15} />
          <span>Ir a</span>
          <kbd>Ctrl K</kbd>
        </Button>
        {notificationsEnabled ? (
          <Button
            className="soc-notifications-button"
            onClick={() => onNavigate('/notifications')}
            aria-label="Abrir notificaciones"
            title="Notificaciones"
          >
            <SocIcon name="bell" size={17} />
          </Button>
        ) : null}
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
            <Button variant="ghost" onClick={onLogout}>
              Cerrar sesión
            </Button>
          </div>
        </details>
      </div>
    </header>
  );
}
