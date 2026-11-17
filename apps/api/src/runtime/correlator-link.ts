/**
 * Read link from the API to the private correlator (`services/qapaq-correlator`, `/v1/*`).
 *
 * The correlator has no published port: the API reaches it over the private Docker network and
 * re-exposes a projection as `/api/risk/*` with the person's session and capabilities. The URL
 * must be plain `http(s)://host[:port]` without credentials, query or fragment.
 */

import { ConfigurationError } from '@qapaq/configuration';

export function correlatorUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    url = new URL('invalid://');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new ConfigurationError({
      code: 'CONFIG_VALUE_INVALID',
      message: 'La URL del correlador no es válida.',
      path: 'QAPAQ_CORRELATOR_URL',
      profile: 'production',
    });
  }
  return `${url.protocol}//${url.host}`;
}

export interface CorrelatorReadResult {
  readonly status: number;
  readonly body: unknown;
}

/** GET against the correlator with the read token; never follows redirects. */
export async function correlatorGet(
  link: { readonly baseUrl: string; readonly token: string },
  pathWithQuery: string,
  timeoutMs = 5_000,
): Promise<CorrelatorReadResult> {
  const response = await fetch(`${link.baseUrl}${pathWithQuery}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${link.token}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
