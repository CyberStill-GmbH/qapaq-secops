import { SocIcon, type IconName } from './soc-ui.js';

export interface NavigationItem {
  readonly label: string;
  readonly path: string;
  readonly icon: IconName;
  readonly capability?: string;
}

export interface NavigationGroup {
  readonly label: string;
  readonly items: readonly NavigationItem[];
}

export function SocNavigationRail({
  groups,
  pathname,
  collapsed,
  mobileOpen,
  onNavigate,
  onToggleCollapse,
  onCloseMobile,
}: {
  readonly groups: readonly NavigationGroup[];
  readonly pathname: string;
  readonly collapsed: boolean;
  readonly mobileOpen: boolean;
  readonly onNavigate: (path: string) => void;
  readonly onToggleCollapse: () => void;
  readonly onCloseMobile: () => void;
}): React.JSX.Element {
  return (
    <>
      <a className="soc-skip-link" href="#soc-main">
        Saltar al contenido
      </a>
      <aside id="soc-navigation" className="soc-rail" aria-label="Navegación principal">
        <nav className="soc-nav">
          {groups.map((group) => (
            <div className="soc-nav__group" key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((item) => (
                <a
                  key={item.path}
                  href={item.path}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(item.path);
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
              onNavigate('/me');
            }}
            title={collapsed ? 'Mi sesión' : undefined}
          >
            <SocIcon name="user" />
            <span>Mi sesión</span>
          </a>
          <button
            className="soc-rail__collapse"
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expandir navegación' : 'Contraer navegación'}
            title={collapsed ? 'Expandir navegación' : 'Contraer navegación'}
          >
            <SocIcon name="menu" />
            <span>Contraer</span>
            <kbd>[</kbd>
          </button>
        </div>
      </aside>
      {mobileOpen ? (
        <button
          type="button"
          className="soc-mobile-nav-backdrop"
          aria-label="Cerrar menú de navegación"
          onClick={onCloseMobile}
        />
      ) : null}
    </>
  );
}
