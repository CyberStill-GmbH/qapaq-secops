import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSafe, cleanup, events, exitedWithin, startApp, until } from './support.mjs';

for (const app of ['api', 'worker']) {
  for (const [fault, code] of [
    ['exception', 'UNCAUGHT_EXCEPTION'],
    ['rejection', 'UNHANDLED_REJECTION'],
    ['double-signal', undefined],
  ]) {
    test(`${app}: ${fault} closes once with safe process diagnostics`, async () => {
      const runtime = startApp(app, { QAPAQ_API_PORT: '0' });
      try {
        await until(() => runtime.output.includes('application.ready'), `${app} readiness`);
        runtime.child.send({ fault });
        assert.equal((await exitedWithin(runtime)).code, code ? 1 : 0);
        const output = events(runtime);
        if (code) {
          assert.equal(output.filter((item) => item.event === 'application.failed').length, 1);
          assert.equal(output.find((item) => item.event === 'application.failed').errorCode, code);
        } else {
          assert.equal(output.filter((item) => item.event === 'application.draining').length, 1);
          assert.equal(output.filter((item) => item.event === 'application.stopped').length, 1);
        }
        assertSafe(runtime);
      } finally {
        await cleanup(runtime);
      }
    });
  }
}
