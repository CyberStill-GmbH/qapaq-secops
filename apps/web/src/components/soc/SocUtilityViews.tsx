import type { SessionView } from '../../api/client.js';
import { Button, SocIcon } from './soc-ui.js';

const capabilityGroups: readonly { readonly name: string; readonly values: readonly string[] }[] = [
  {
    name: 'Alertas y telemetría',
    values: ['events.read', 'events.read_raw', 'alerts.read', 'alerts.triage', 'alerts.assign'],
  },
  {
    name: 'Incidentes y notificaciones',
    values: ['incidents.read', 'incidents.write', 'incidents.close', 'notifications.read'],
  },
  { name: 'Auditoría', values: ['audit.read', 'audit.read_sensitive', 'audit.verify'] },
  { name: 'Plataforma', values: ['secrets.write'] },
];

function capabilityLabel(value: string): string {
  return (
    {
      'events.read': 'Consultar eventos',
      'events.read_raw': 'Consultar contenido original',
      'alerts.read': 'Consultar alertas',
      'alerts.triage': 'Reconocer y triar alertas',
      'alerts.assign': 'Asignar alertas',
      'incidents.read': 'Consultar incidentes',
      'incidents.write': 'Operar incidentes',
      'incidents.close': 'Cerrar incidentes',
      'notifications.read': 'Consultar y acusar notificaciones',
      'audit.read': 'Consultar auditoría',
      'audit.read_sensitive': 'Consultar datos sensibles de auditoría',
      'audit.verify': 'Verificar integridad',
      'secrets.write': 'Administrar credenciales',
    }[value] ?? value
  );
}

function authMethod(amr: readonly string[]): string {
  if (amr.some((value) => ['fido', 'hwk', 'phr'].includes(value))) return 'Passkey (FIDO2)';
  if (amr.some((value) => ['mfa', 'ngcmfa', 'otp', 'rsa'].includes(value)))
    return 'Autenticación multifactor';
  return amr.length ? amr.join(' · ') : 'No informado';
}

export function SessionPage({
  session,
  onRefresh,
}: {
  readonly session: SessionView;
  readonly onRefresh: () => Promise<void>;
}): React.JSX.Element {
  return (
    <div className="soc-page">
      <div className="soc-page-heading">
        <div>
          <h1>Mi sesión</h1>
          <p>Identidad, autenticación y permisos vigentes.</p>
        </div>
        <Button onClick={() => void onRefresh()}>
          <SocIcon name="refresh" /> Actualizar permisos
        </Button>
      </div>
      <section className="soc-panel soc-session-panel">
        <header className="soc-panel__header">
          <h2>Identidad institucional</h2>
        </header>
        <dl className="soc-description-list">
          <dt>Identificador</dt>
          <dd>
            <code>{session.subjectId}</code>
          </dd>
          <dt>Tenant</dt>
          <dd>
            <code>{session.tenantId}</code>
          </dd>
          <dt>Autenticación</dt>
          <dd>{authMethod(session.amr)}</dd>
          <dt>Sesión</dt>
          <dd>Una sesión activa por persona. Iniciar sesión en otro navegador cerrará esta.</dd>
        </dl>
      </section>
      <section className="soc-panel soc-session-panel">
        <header className="soc-panel__header">
          <h2>Permisos vigentes</h2>
          <span>{session.capabilities.length} capabilities</span>
        </header>
        <div className="soc-capability-groups">
          {capabilityGroups.map((group) => {
            const values = group.values.filter((value) => session.capabilities.includes(value));
            return values.length ? (
              <section key={group.name}>
                <h3>{group.name}</h3>
                <ul>
                  {values.map((value) => (
                    <li key={value}>
                      <SocIcon name="check" size={15} />
                      <span>{capabilityLabel(value)}</span>
                      <code>{value}</code>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null;
          })}
        </div>
      </section>
    </div>
  );
}

export function UnavailablePage({
  title,
  message,
  action,
}: {
  readonly title: string;
  readonly message: string;
  readonly action?: () => void;
}): React.JSX.Element {
  return (
    <div className="soc-unavailable">
      <span className="soc-unavailable__icon">
        <SocIcon name="file" size={22} />
      </span>
      <h1>{title}</h1>
      <p>{message}</p>
      {action ? (
        <Button variant="primary" onClick={action}>
          Ir al resumen
        </Button>
      ) : null}
    </div>
  );
}
