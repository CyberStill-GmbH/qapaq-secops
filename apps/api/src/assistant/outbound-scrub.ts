/**
 * Última barrera de minimización hacia el proveedor del modelo (decisión N2).
 *
 * Correos e IPv4 ya salen seudonimizados por el dominio (`Pseudonymizer`, `QAPAQ_QAPAQZITO_REDACT_PII`).
 * Aquí se eliminan además credenciales evidentes que puedan venir en una pregunta o en datos de una
 * herramienta (logs, alertas): tokens Bearer/Basic, JWT, claves de AWS/GitHub/Slack/`sk-…`, bloques
 * de clave privada, credenciales en URL y pares `password=`/`token:`/`api_key=`… La sustitución es
 * irreversible a propósito: el modelo nunca necesita el valor de un secreto.
 */

const REDACTED = '[REDACTED]';

const CREDENTIAL_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, REDACTED],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, `$1${REDACTED}@`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/gu, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/gu, REDACTED],
  [
    /\b(password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/giu,
    `$1$2${REDACTED}`,
  ],
];

/** Elimina credenciales evidentes de un texto que va a salir hacia el proveedor. */
export function scrubCredentials(text: string): string {
  let output = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/** Igual que `scrubCredentials`, sobre cada cadena de una estructura JSON. */
export function scrubCredentialsJson(value: unknown): unknown {
  if (typeof value === 'string') return scrubCredentials(value);
  if (Array.isArray(value)) return value.map(scrubCredentialsJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubCredentialsJson(item)]),
    );
  }
  return value;
}
