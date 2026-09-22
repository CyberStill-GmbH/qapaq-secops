import type { HealthResult } from './health-result.js';

export async function waitUntilHealthy(
  service: string,
  check: () => Promise<HealthResult>,
  options: { readonly timeoutMs: number; readonly pollMs: number; readonly signal?: AbortSignal },
): Promise<HealthResult> {
  const deadline = Date.now() + options.timeoutMs;
  let last: HealthResult | undefined;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error(`Health cancelado para ${service}`);
    last = await check();
    if (last.healthy) return last;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
  throw new Error(
    `${service} no alcanzó health en ${options.timeoutMs} ms: ${last?.detail ?? 'sin diagnóstico'}`,
  );
}
