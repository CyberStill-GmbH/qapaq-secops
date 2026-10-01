import { afterEach, expect, it, vi } from 'vitest';
import { checkApiHealth } from '../src/api/health.js';

afterEach(() => vi.unstubAllGlobals());

function healthResponse(status = 200): Response {
  return new Response(JSON.stringify({ status: 'ok', service: 'qapaq-secops-api' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

it('checks only the public liveness and readiness endpoints without sending credentials', async () => {
  const request = vi.fn().mockImplementation(() => Promise.resolve(healthResponse()));
  vi.stubGlobal('fetch', request);

  expect(await checkApiHealth(new AbortController().signal)).toBe('healthy');
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/health/live', '/api/health/ready']);
  expect(request.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', cache: 'no-store' });
});

it('reports degraded when liveness works but readiness fails', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(healthResponse())
    .mockResolvedValueOnce(healthResponse(503));
  vi.stubGlobal('fetch', request);

  expect(await checkApiHealth(new AbortController().signal)).toBe('degraded');
});

it('reports failure without probing readiness when liveness fails', async () => {
  const request = vi.fn().mockResolvedValue(healthResponse(503));
  vi.stubGlobal('fetch', request);

  expect(await checkApiHealth(new AbortController().signal)).toBe('failed');
  expect(request).toHaveBeenCalledTimes(1);
});

it('returns unavailable when a request is cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn();
  vi.stubGlobal('fetch', request);

  expect(await checkApiHealth(controller.signal)).toBe('unavailable');
  expect(request).not.toHaveBeenCalled();
});
