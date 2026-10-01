export type ApiHealth = 'healthy' | 'degraded' | 'failed' | 'unavailable';

interface HealthResponse {
  readonly status?: unknown;
  readonly service?: unknown;
}

async function requestHealth(path: string, signal: AbortSignal): Promise<Response> {
  return fetch(`/api${path}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
}

async function isApiResponse(response: Response, signal: AbortSignal): Promise<boolean> {
  if (!response.ok) return false;
  const body: unknown = await response.json();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as HealthResponse).status === 'ok' &&
    (body as HealthResponse).service === 'qapaq-secops-api' &&
    !signal.aborted
  );
}

/** Checks only the public API liveness/readiness endpoints; it makes no claim about data services. */
export async function checkApiHealth(signal: AbortSignal): Promise<ApiHealth> {
  try {
    if (signal.aborted) return 'unavailable';
    const live = await requestHealth('/health/live', signal);
    if (signal.aborted) return 'unavailable';
    if (!(await isApiResponse(live, signal))) return 'failed';

    const ready = await requestHealth('/health/ready', signal);
    if (signal.aborted) return 'unavailable';
    return (await isApiResponse(ready, signal)) ? 'healthy' : 'degraded';
  } catch {
    return signal.aborted ? 'unavailable' : 'failed';
  }
}
