import type { SessionView } from '../../api/client.js';
import {
  AuditPage,
  IntegrityPage,
  IncidentPage,
  NotificationPage,
  SummaryPage,
} from './SocDataViews.js';
import { AlertQueuePage } from './AlertQueuePage.js';
import { SessionPage, UnavailablePage } from './SocUtilityViews.js';

export function SocWorkspaceViews({
  pathname,
  path,
  session,
  onNavigate,
  onSessionRefresh,
}: {
  readonly pathname: string;
  readonly path: string;
  readonly session: SessionView;
  readonly onNavigate: (path: string) => void;
  readonly onSessionRefresh: () => Promise<void>;
}): React.JSX.Element {
  const requiredCapability: Readonly<Record<string, string>> = {
    '/alerts': 'alerts.read',
    '/incidents': 'incidents.read',
    '/notifications': 'notifications.read',
    '/audit': 'audit.read',
    '/audit/integrity': 'audit.verify',
    '/events': 'events.read',
  };
  const required = Object.entries(requiredCapability).find(
    ([route]) => pathname === route || pathname.startsWith(`${route}/`),
  )?.[1];
  if (required && !session.capabilities.includes(required)) {
    return (
      <UnavailablePage
        title="No disponible"
        message="El recurso no existe o no está disponible para tu cuenta."
        action={() => onNavigate('/')}
      />
    );
  }
  if (pathname === '/') return <SummaryPage session={session} onNavigate={onNavigate} />;
  if (pathname === '/alerts' || pathname.startsWith('/alerts/'))
    return <AlertQueuePage session={session} path={path} onNavigate={onNavigate} />;
  if (pathname === '/incidents' || pathname.startsWith('/incidents/'))
    return <IncidentPage session={session} path={path} onNavigate={onNavigate} />;
  if (pathname === '/notifications') return <NotificationPage />;
  if (pathname === '/audit') return <AuditPage session={session} />;
  if (pathname === '/audit/integrity') return <IntegrityPage session={session} />;
  if (pathname === '/me') return <SessionPage session={session} onRefresh={onSessionRefresh} />;
  if (pathname === '/events')
    return (
      <UnavailablePage
        title="Eventos"
        message="La búsqueda normalizada de eventos aún no cuenta con una ruta HTTP en el BFF. La vista se habilitará cuando exista un adaptador operativo."
      />
    );
  return (
    <UnavailablePage
      title="No disponible"
      message="El recurso no existe o no está disponible para tu cuenta."
      action={() => onNavigate('/')}
    />
  );
}
