import { describe, expect, it } from 'vitest';

import { loadApiConfig, loadWorkerConfig } from '../src/index.js';

describe('runtime configuration', () => {
  it('applies the documented local API defaults', () => {
    expect(loadApiConfig({})).toEqual({ host: '127.0.0.1', port: 3000 });
  });

  it('rejects an invalid API port', () => {
    expect(() => loadApiConfig({ API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  it('rejects a worker without an explicit Redis endpoint', () => {
    expect(() => loadWorkerConfig({})).toThrow(/REDIS_URL/);
  });

  it('rejects a Redis endpoint with an unsafe protocol', () => {
    expect(() => loadWorkerConfig({ REDIS_URL: 'http://localhost:6379' })).toThrow(/redis:/);
  });
});
