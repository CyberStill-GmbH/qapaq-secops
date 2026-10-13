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
import { EventsPage } from './EventsPage.js';
import { SourcesHealthPage } from './SourcesHealthPage.js';
import { PushNotificationSettingsPage } from './PushNotificationSettingsPage.js';

export function SocWorkspaceViews({
  pathname,
  path,
  session,
  onNavigate,
  onSessionRefresh,
  basePath,
}: {
  readonly pathname: string;
  readonly path: string;
  readonly session: SessionView;
  readonly onNavigate: (path: string) => void;
  readonly onSessionRefresh: () => Promise<void>;
  readonly basePath: '/' | '/secops/';
}): React.JSX.Element {
  const requiredCapability: Readonly<Record<string, string>> = {
    '/alerts': 'alerts.read',
    '/operations': 'alerts.read',
    '/incidents': 'incidents.read',
    '/notifications': 'notifications.read',
    '/settings/notifications': 'notifications.read',
    '/audit': 'audit.read',
    '/audit/integrity': 'audit.verify',
    '/events': 'events.read',
    '/sources': 'sources.health.read',
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
  if (pathname === '/settings/notifications')
    return <PushNotificationSettingsPage basePath={basePath} />;
  if (pathname === '/audit') return <AuditPage session={session} />;
  if (pathname === '/audit/integrity') return <IntegrityPage session={session} />;
  if (pathname === '/admin/users') return <UserAdministrationPage />;
  if (pathname === '/admin/sessions') return <AdminSessionsPage />;
  if (pathname === '/me') return <SessionPage session={session} onRefresh={onSessionRefresh} />;
  if (pathname === '/events') return <EventsPage session={session} />;
  if (pathname === '/sources') return <SourcesHealthPage />;
  return (
    <UnavailablePage
      title="No disponible"
      message="El recurso no existe o no está disponible para tu cuenta."
      action={() => onNavigate('/')}
    />
  );
}
