/**
 * Catálogo `acción → clase de señal` de las fuentes conectadas al runtime (C-16).
 *
 * El dominio de detección no conoce nombres de operación de ningún proveedor (C-23). Este
 * archivo vive en el composition root porque aquí se decide qué fuentes están conectadas:
 * en el MVP, Microsoft 365 a través de Wazuh (ADR-024).
 *
 * Las claves son los slugs que produce el mapping Wazuh 1.1.0
 * (`office365ActionSlug` en modules/telemetry/src/wazuh-office365.ts): operación de la
 * Office 365 Management Activity API en minúsculas, con prefijo `office365.`. Si el mapping
 * cambia la forma del slug, este catálogo y su spec deben cambiar en el mismo PR.
 *
 * La clase de señal sigue tácticas MITRE ATT&CK y alimenta la cadena de compromiso de
 * cuenta: acceso (credential_access, initial_access) seguido de impacto (persistencia,
 * escalamiento, evasión, recolección o exfiltración) sobre el mismo usuario.
 */

import type { SignalCatalog } from '@qapaq/detection';

export const OFFICE365_SIGNAL_CATALOG: SignalCatalog = Object.freeze({
  // Acceso
  'office365.userloginfailed': 'credential_access',
  'office365.userloggedin': 'initial_access',
  // Persistencia: reglas de bandeja, reenvío, permisos de buzón, OAuth, credenciales, MFA
  'office365.new-inboxrule': 'persistence',
  'office365.set-inboxrule': 'persistence',
  'office365.updateinboxrules': 'persistence',
  'office365.set-mailbox': 'persistence',
  'office365.add-mailboxpermission': 'persistence',
  'office365.add-recipientpermission': 'persistence',
  'office365.consent-to-application': 'persistence',
  'office365.add-delegated-permission-grant': 'persistence',
  'office365.add-app-role-assignment-to-service-principal': 'persistence',
  'office365.add-service-principal-credentials': 'persistence',
  'office365.update-application-certificates-and-secrets-management': 'persistence',
  'office365.user-registered-security-info': 'persistence',
  'office365.user-changed-default-security-info': 'persistence',
  'office365.admin-registered-security-info': 'persistence',
  // Escalamiento
  'office365.add-member-to-role': 'privilege_escalation',
  'office365.add-eligible-member-to-role': 'privilege_escalation',
  // Variantes PIM documentadas en Entra (investigación C-4, pendientes de tenant).
  'office365.add-eligible-member-to-role-in-pim-completed-permanent': 'privilege_escalation',
  'office365.add-eligible-member-to-role-in-pim-completed-timebound': 'privilege_escalation',
  'office365.add-member-to-role-completed-pim-activation': 'privilege_escalation',
  // Evasión de defensas: federación, políticas, auditoría
  'office365.set-domain-authentication': 'defense_evasion',
  'office365.set-federation-settings-on-domain': 'defense_evasion',
  'office365.add-domain-to-company': 'defense_evasion',
  'office365.update-policy': 'defense_evasion',
  'office365.delete-policy': 'defense_evasion',
  'office365.add-conditional-access-policy': 'defense_evasion',
  'office365.update-conditional-access-policy': 'defense_evasion',
  'office365.delete-conditional-access-policy': 'defense_evasion',
  'office365.set-adminauditlogconfig': 'defense_evasion',
  'office365.set-mailboxauditbypassassociation': 'defense_evasion',
  // Recolección y exfiltración
  'office365.new-compliancesearch': 'collection',
  'office365.new-compliancesearchaction': 'collection',
  'office365.filedownloaded': 'collection',
  'office365.searchexported': 'exfiltration',
  'office365.searchexportdownloaded': 'exfiltration',
  'office365.new-transportrule': 'exfiltration',
  'office365.set-transportrule': 'exfiltration',
  'office365.anonymouslinkcreated': 'exfiltration',
});

/** Unión de los catálogos de todas las fuentes conectadas. Hoy, solo la del MVP. */
export const CONNECTED_SOURCE_SIGNAL_CATALOG: SignalCatalog = OFFICE365_SIGNAL_CATALOG;
