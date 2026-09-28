import { expect, it } from 'vitest';
import { loadApiConfig, loadWorkerEntrypointConfig } from '../src/index.js';

it('requires a validated profile without resolving unused secrets', () => {
  expect(() => loadWorkerEntrypointConfig({})).toThrow();
  const config = loadWorkerEntrypointConfig({
    QAPAQ_PROFILE: 'test',
    SECRET_TOKEN: 'synthetic-sensitive',
  });
  expect(config).toEqual({ profile: 'test' });
  expect(Object.isFrozen(config)).toBe(true);
  expect(() =>
    loadWorkerEntrypointConfig({ QAPAQ_PROFILE: 'test', QAPAQ_UNKNOWN: 'value' }),
  ).toThrow();
});

it('allows atomic ephemeral HTTP ports exclusively in our test', () => {
  expect(loadApiConfig({ QAPAQ_PROFILE: 'test', QAPAQ_API_PORT: '0' }).port).toBe(0);
  expect(() => loadApiConfig({ QAPAQ_PROFILE: 'development', QAPAQ_API_PORT: '0' })).toThrow();
  expect(() =>
    loadApiConfig({
      QAPAQ_PROFILE: 'production',
      QAPAQ_API_HOST: '127.0.0.1',
      QAPAQ_API_PORT: '0',
    }),
  ).toThrow();
});
