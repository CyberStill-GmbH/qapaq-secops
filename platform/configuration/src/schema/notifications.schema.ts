/**
 * Sprint 5 — destino de las notificaciones en Teams.
 *
 * `QAPAQ_TEAMS_WORKFLOW_URL` es la URL del Teams Workflow («cuando se reciba una solicitud de
 * webhook, publicar tarjeta en un canal»). Es un secreto (quien la tiene publica en el canal):
 * llega al proceso desde Secrets Manager como secreto de ECS y nunca se registra.
 *
 * Solo se acepta HTTPS hacia hosts de Microsoft que emiten esas URL (Power Automate / Logic
 * Apps). Otro host es un error de despliegue: el proceso no enviaría tarjetas, con datos del
 * SOC, a un destino arbitrario.
 */

import { configurationError } from '../configuration.errors.js';
import type { EnvironmentInput } from '../configuration.types.js';
import type { ConfigurationProfile } from '../profiles/index.js';
import { optionalString } from './environment.schema.js';

const ALLOWED_HOST_SUFFIXES = ['.logic.azure.com', '.api.powerplatform.com'] as const;

export function parseTeamsWorkflowUrl(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): string | undefined {
  const raw = optionalString(environment, profile, 'QAPAQ_TEAMS_WORKFLOW_URL');
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configurationError('CONFIG_URL_INVALID', 'QAPAQ_TEAMS_WORKFLOW_URL', profile.name);
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    !ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw configurationError('CONFIG_URL_INVALID', 'QAPAQ_TEAMS_WORKFLOW_URL', profile.name);
  }
  return url.toString();
}

/**
 * Buzón remitente del respaldo por correo (`QAPAQ_ALERT_MAIL_SENDER`, UPN). Sin él, el respaldo
 * es solo la bandeja de la consola. No es secreto; el permiso `Mail.Send` es de la app de Entra.
 */
export function parseAlertMailSender(
  environment: EnvironmentInput,
  profile: ConfigurationProfile,
): string | undefined {
  const raw = optionalString(environment, profile, 'QAPAQ_ALERT_MAIL_SENDER');
  if (raw === undefined) return undefined;
  if (!/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/u.test(raw)) {
    throw configurationError('CONFIG_VALUE_INVALID', 'QAPAQ_ALERT_MAIL_SENDER', profile.name);
  }
  return raw.toLowerCase();
}
