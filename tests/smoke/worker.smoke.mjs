import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
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
} from './support.mjs';

for (const termination of ['SIGTERM', 'SIGINT']) {
  test(`compiled worker readiness, idle wait and ${termination}`, { timeout: 20_000 }, async () => {
    const runtime = startApp('worker');
    try {
      await until(() => runtime.output.includes('application.ready'), 'worker readiness');
      await delay(250);
      assert.equal(runtime.child.exitCode, null);
      assert.equal(events(runtime).filter((item) => item.event === 'application.ready').length, 1);
      signal(runtime, termination);
      assert.deepEqual(await exitedWithin(runtime), { code: 0, signal: null });
      assert.deepEqual(
        events(runtime)
          .map((item) => item.event)
          .filter((event) =>
            [
              'application.starting',
              'application.ready',
              'application.draining',
              'application.stopped',
            ].includes(event),
          ),
        [
          'application.starting',
          'application.ready',
          'application.draining',
          'application.stopped',
        ],
      );
      assertSafe(runtime);
    } finally {
      await cleanup(runtime);
    }
  });
}

test('invalid worker configuration never reaches readiness', async () => {
  const runtime = startApp('worker', { QAPAQ_PROFILE: fixtureToken });
  try {
    assert.equal((await exitedWithin(runtime)).code, 1);
    assert.deepEqual(
      events(runtime).map((item) => item.event),
      ['application.failed'],
    );
    assertSafe(runtime);
  } finally {
    await cleanup(runtime);
  }
});

test('importing compiled worker has no process effects', async () => {
  const runtime = startProcess([
    '--input-type=module',
    '-e',
    `
    const before = process.listenerCount('SIGINT');
    await import('./apps/worker/dist/main.js');
    if (process.listenerCount('SIGINT') !== before) throw Error('import installed handlers');
  `,
  ]);
  try {
    assert.equal((await exitedWithin(runtime)).code, 0);
    assert.equal(runtime.output, '');
  } finally {
    await cleanup(runtime);
  }
});
