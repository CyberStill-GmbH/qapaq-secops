import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import {
  assertSafe,
  cleanup,
  events,
  exitedWithin,
  signal,
  startApp,
  startProcess,
  until,
  fixtureToken,
  startupTimeout,
} from './support.mjs';

for (const termination of ['SIGTERM', 'SIGINT']) {
  test(`compiled API health and ${termination}`, { timeout: startupTimeout + 10_000 }, async () => {
    const runtime = startApp('api', { QAPAQ_API_PORT: '0' });
    try {
      await until(
        () => runtime.port && runtime.output.includes('application.ready'),
        'API readiness',
      );
      const base = `http://127.0.0.1:${runtime.port}`;
      for (const endpoint of ['live', 'ready']) {
        const response = await fetch(`${base}/health/${endpoint}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok', service: 'qapaq-secops-api' });
        assert.equal(response.headers.get('x-powered-by'), null);
      }
      signal(runtime, termination);
      assert.deepEqual(await exitedWithin(runtime), { code: 0, signal: null });
      assert.deepEqual(
        events(runtime).map((item) => item.event),
        [
          'application.starting',
          'application.ready',
          'application.draining',
          'application.stopped',
        ],
      );
      await assert.rejects(fetch(`${base}/health/live`, { signal: AbortSignal.timeout(1_000) }));
      assertSafe(runtime);
    } finally {
      await cleanup(runtime);
    }
  });
}

test('invalid API config exits before listening without leaking input', async () => {
  const runtime = startApp('api', { QAPAQ_PROFILE: '', QAPAQ_API_HOST: fixtureToken });
  try {
    assert.equal((await exitedWithin(runtime)).code, 1);
    assert.equal(runtime.port, undefined);
    assert.equal(events(runtime)[0].errorCode, 'CONFIG_PROFILE_INVALID');
    assertSafe(runtime);
  } finally {
    await cleanup(runtime);
  }
});

test('occupied port fails safely without leaving a partial listener', async () => {
  const reserved = createServer();
  await new Promise((resolve) => reserved.listen(0, '127.0.0.1', resolve));
  const runtime = startApp('api', { QAPAQ_API_PORT: String(reserved.address().port) });
  try {
    assert.equal((await exitedWithin(runtime)).code, 1);
    assert.ok(events(runtime).some((item) => item.errorCode === 'PORT_IN_USE'));
    assertSafe(runtime);
  } finally {
    await cleanup(runtime);
    await new Promise((resolve, reject) =>
      reserved.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('importing compiled API main does not start a process or install handlers', async () => {
  const runtime = startProcess([
    '--input-type=module',
    '-e',
    `
    const before = process.listenerCount('SIGTERM');
    await import('./apps/api/dist/main.js');
    if (process.listenerCount('SIGTERM') !== before) throw Error('import installed handlers');
  `,
  ]);
  try {
    assert.equal((await exitedWithin(runtime)).code, 0);
    assert.equal(runtime.output, '');
  } finally {
    await cleanup(runtime);
  }
});
