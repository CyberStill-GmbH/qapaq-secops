import type { SessionView } from '../../api/client.js';
import {
  AuditPage,
  IntegrityPage,
  IncidentPage,
  NotificationPage,
  OperationsHealthPage,
  SummaryPage,
} from './SocDataViews.js';
import { AlertQueuePage } from './AlertQueuePage.js';
import { SessionPage, UnavailablePage } from './SocUtilityViews.js';
import { UserAdministrationPage } from './UserAdministrationPage.js';
import { AdminSessionsPage } from './AdminSessionsPage.js';

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
    '/operations': 'alerts.read',
    '/incidents': 'incidents.read',
    '/notifications': 'notifications.read',
    '/audit': 'audit.read',
    '/audit/integrity': 'audit.verify',
    '/events': 'events.read',
    '/admin/users': 'users.read',
    '/admin/sessions': 'sessions.read',
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
  if (pathname === '/operations') return <OperationsHealthPage />;
  if (pathname === '/alerts' || pathname.startsWith('/alerts/'))
    return <AlertQueuePage session={session} path={path} onNavigate={onNavigate} />;
  if (pathname === '/incidents' || pathname.startsWith('/incidents/'))
    return <IncidentPage session={session} path={path} onNavigate={onNavigate} />;
  if (pathname === '/notifications') return <NotificationPage session={session} />;
  if (pathname === '/audit') return <AuditPage session={session} />;
  if (pathname === '/audit/integrity') return <IntegrityPage session={session} />;
  if (pathname === '/admin/users') return <UserAdministrationPage session={session} />;
  if (pathname === '/admin/sessions') return <AdminSessionsPage />;
  if (pathname === '/me') return <SessionPage session={session} onRefresh={onSessionRefresh} />;
  if (pathname === '/events')
    return (
      <UnavailablePage
        title="Eventos aún no disponible"
        message="El BFF todavía no expone la búsqueda normalizada de eventos. Puedes investigar las alertas correlacionadas disponibles."
        action={() => onNavigate('/alerts')}
        actionLabel="Abrir alertas"
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
