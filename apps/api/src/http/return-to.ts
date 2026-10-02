/**
 * B-03 — destino del navegador al terminar el inicio de sesión.
 *
 * El callback de OIDC es una navegación de nivel superior: termina en una página, no en
 * un `fetch`. Por eso responde con un redirect a la consola en vez de con JSON.
 *
 * El destino lo pide el cliente en `/api/auth/start?returnTo=` y es la entrada clásica
 * de un *open redirect*. Solo se admite una ruta relativa del mismo origen; todo lo
 * demás —URL absoluta, `//host`, barras invertidas, caracteres de control o rutas de la
 * propia API— cae al inicio de la consola.
 */

export const DEFAULT_RETURN_TO = '/';

const MAX_RETURN_TO_LENGTH = 512;
const PROBE_ORIGIN = 'https://return-to.qapaq.invalid';

export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) {
    return DEFAULT_RETURN_TO;
  }
  const hasControl = [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControl) {
    return DEFAULT_RETURN_TO;
  }
  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return DEFAULT_RETURN_TO;
  }
  if (url.origin !== PROBE_ORIGIN || url.pathname.startsWith('/api/')) return DEFAULT_RETURN_TO;
  return `${url.pathname}${url.search}${url.hash}`;
}

function withParams(returnTo: string, params: Readonly<Record<string, string>>): string {
  const url = new URL(returnTo, PROBE_ORIGIN);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Un fallo vuelve al mismo destino con el código público del catálogo y la referencia de
 * correlación: la pantalla de acceso lo presenta sin que el motivo interno salga del BFF.
 */
export function withAuthError(returnTo: string, code: string, correlationId: string): string {
  return withParams(returnTo, { authError: code, correlationId });
}

/** Aviso de que la nueva sesión cerró otra abierta en otro navegador (C-25). */
export function withSupersededNotice(returnTo: string, superseded: number): string {
  return superseded > 0 ? withParams(returnTo, { sessionNotice: 'superseded' }) : returnTo;
}
