import { expect, it, vi } from 'vitest';
import { buildApi } from '../src/bootstrap.js';

it('serves safe live/ready responses through the real Nest routing layer', async () => {
  const runtime = await buildApi({ QAPAQ_PROFILE: 'test', QAPAQ_API_PORT: '0' }, () => {});
  try {
    await runtime.application.init();
    const before = await runtime.application.inject({ method: 'GET', url: '/health/ready' });
    expect(before.statusCode).toBe(503);
    await runtime.start();
    for (const url of ['/health/live', '/health/ready']) {
      const response = await runtime.application.inject({
        method: 'GET',
        url,
        headers: { origin: 'https://example.test' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', service: 'qapaq-secops-api' });
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    // Mantener el drenado pendiente permite comprobar la disponibilidad mientras HTTP aún responde.
    let drained!: () => void;
    const shutdown = runtime.lifecycle.shutdown(
      () =>
        new Promise<void>((resolve) => {
          drained = resolve;
        }),
      1_000,
    );
    const during = await runtime.application.inject({ method: 'GET', url: '/health/ready' });
    expect(during.statusCode).toBe(503);
    expect(during.json()).toEqual({ status: 'unavailable', service: 'qapaq-secops-api' });
    expect((await runtime.application.inject('/health/live')).statusCode).toBe(200);
    drained();
    await shutdown;
  } finally {
    await runtime.application.close();
  }
});

it('does not construct a listener when configuration is invalid', async () => {
  await expect(buildApi({}, () => {})).rejects.toMatchObject({ code: 'CONFIG_PROFILE_INVALID' });
});

it('cleans up after a failed listen without reaching readiness', async () => {
  const emit = vi.fn();
  const runtime = await buildApi({ QAPAQ_PROFILE: 'test', QAPAQ_API_PORT: '0' }, emit);
  vi.spyOn(runtime.application, 'listen').mockRejectedValueOnce(
    new Error('synthetic-listen-failure'),
  );
  const close = vi.spyOn(runtime.application, 'close');
  await expect(runtime.start()).rejects.toThrow('synthetic-listen-failure');
  expect(runtime.lifecycle.state).toBe('failed');
  expect(emit.mock.calls.flat()).not.toContain('ready');
  await runtime.stop();
  expect(close).toHaveBeenCalledTimes(1);
});

it('a signal during listen drains the eventual listener without announcing readiness', async () => {
  const emit = vi.fn();
  const runtime = await buildApi({ QAPAQ_PROFILE: 'test', QAPAQ_API_PORT: '0' }, emit);
  try {
    const started = runtime.start();
    const stopped = runtime.stop();
    await Promise.all([started, stopped]);
    expect(runtime.lifecycle.state).toBe('stopped');
    expect(runtime.application.getHttpServer().listening).toBe(false);
    expect(emit.mock.calls.flat()).not.toContain('ready');
  } finally {
    await runtime.application.close();
  }
});
