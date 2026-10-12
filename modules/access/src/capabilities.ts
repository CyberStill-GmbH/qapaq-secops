/**
 * C-18 — capabilities, roles y scopes.
 *
 * El rol de Entra es un dato de entrada, no la autorización. QAPAQ traduce roles a
 * capabilities propias para que un cambio en el directorio no redefina en silencio lo
 * que alguien puede hacer, y para que la autorización sea revisable aquí.
 *
 * Deny por defecto (ADR-009): un rol desconocido no aporta capabilities, no las hereda
 * y no degrada a lectura.
 */

export const CAPABILITIES = [
  'events.read',
  'events.read_raw',
  'alerts.read',
  'alerts.triage',
  'alerts.assign',
  'incidents.read',
  'incidents.write',
  'incidents.close',
  'notifications.read',
  /**
   * Forzar una pasada del despacho de notificaciones. Es un efecto externo (Teams), así que
   * no basta con poder leer la bandeja: el despacho normal lo hace el bucle del runtime.
   */
  'notifications.dispatch',
  /** Salud del pipeline SOC (ingesta, cola de notificaciones, despacho). Agregado, sin PII. */
  'observability.read_soc',
  /** Salud del runtime de plataforma (proceso, base de datos). Solo administración. */
  'observability.read_platform',
  /** Ver sesiones del tenant (quién está dentro, desde dónde y con qué factor). */
  'sessions.read',
  /** Revocar una sesión ajena: acción administrativa auditada. */
  'sessions.revoke',
  'audit.read',
  'audit.read_sensitive',
  'audit.verify',
  'secrets.write',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Roles de aplicación publicados en el app registration de Entra. */
export const ROLE_CAPABILITIES: Readonly<Record<string, readonly Capability[]>> = Object.freeze({
  'qapaq.soc.analyst': [
    'events.read',
    'alerts.read',
    'alerts.triage',
    'alerts.assign',
    'incidents.read',
    'incidents.write',
    'notifications.read',
  ],
  'qapaq.soc.lead': [
    'events.read',
    'events.read_raw',
    'alerts.read',
    'alerts.triage',
    'alerts.assign',
    'incidents.read',
    'incidents.write',
    'incidents.close',
    'notifications.read',
    'notifications.dispatch',
    'observability.read_soc',
    'audit.read',
  ],
  'qapaq.auditor': ['audit.read', 'audit.read_sensitive', 'audit.verify', 'incidents.read'],
  // La solicitud del producto define al administrador de plataforma como el rol
  // operativo con acceso a todos los módulos actuales. El enforcement sigue siendo
  // capability-by-capability y queda limitado por los scopes que el BFF solicita.
  'qapaq.platform.admin': [
    'events.read',
    'events.read_raw',
    'alerts.read',
    'alerts.triage',
    'alerts.assign',
    'incidents.read',
    'incidents.write',
    'incidents.close',
    'notifications.read',
    'notifications.dispatch',
    'observability.read_soc',
    'observability.read_platform',
    'sessions.read',
    'sessions.revoke',
    'audit.read',
    'audit.read_sensitive',
    'audit.verify',
    'secrets.write',
  ],
});

/** Scopes OAuth del BFF. El scope acota al cliente; la capability acota a la persona. */
export const SCOPES = ['soc.read', 'soc.write', 'audit.read'] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_CAPABILITIES: Readonly<Record<Scope, readonly Capability[]>> = Object.freeze({
  'soc.read': [
    'events.read',
    'events.read_raw',
    'alerts.read',
    'incidents.read',
    'notifications.read',
    'observability.read_soc',
    'observability.read_platform',
    'sessions.read',
  ],
  'soc.write': [
    'alerts.triage',
    'alerts.assign',
    'incidents.write',
    'incidents.close',
    'notifications.dispatch',
    'sessions.revoke',
  ],
  'audit.read': ['audit.read', 'audit.read_sensitive', 'audit.verify'],
});

export function capabilitiesForRoles(roles: readonly string[]): ReadonlySet<Capability> {
  const granted = new Set<Capability>();
  for (const role of roles) {
    for (const capability of ROLE_CAPABILITIES[role] ?? []) granted.add(capability);
  }
  return granted;
}

export function capabilitiesForScopes(scopes: readonly string[]): ReadonlySet<Capability> {
  const granted = new Set<Capability>();
  for (const scope of scopes) {
    for (const capability of SCOPE_CAPABILITIES[scope as Scope] ?? []) granted.add(capability);
  }
  return granted;
}

/**
 * Capabilities efectivas: intersección de lo que la persona tiene por rol y lo que el
 * cliente pidió por scope. Un scope amplio no concede nada que el rol no tenga, y un rol
 * amplio no se ejerce por un cliente que no pidió ese scope.
 */
export function effectiveCapabilities(
  roles: readonly string[],
  scopes: readonly string[],
): ReadonlySet<Capability> {
  const byRole = capabilitiesForRoles(roles);
  const byScope = capabilitiesForScopes(scopes);
  return new Set([...byRole].filter((capability) => byScope.has(capability)));
}
