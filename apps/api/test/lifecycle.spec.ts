import { describe, expect, it, vi } from 'vitest';
import { ApiLifecycle } from '../src/lifecycle.js';

describe('HTTP lifecycle', () => {
  it('rejects readiness during startup and draining; closes once', async () => {
    const emit = vi.fn();
    const lifecycle = new ApiLifecycle(emit);
    expect(lifecycle.ready).toBe(false);
    lifecycle.markReady();
    expect(lifecycle.ready).toBe(true);
    let finish!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = lifecycle.shutdown(close, 500);
    expect(lifecycle.ready).toBe(false);
    expect(lifecycle.state).toBe('draining');
    expect(lifecycle.shutdown(close, 500)).toBe(first);
    await Promise.resolve();
    finish();
    await first;
    expect(close).toHaveBeenCalledTimes(1);
    expect(lifecycle.state).toBe('stopped');
    expect(() => lifecycle.markReady()).toThrow();
    expect(emit.mock.calls.flat()).toEqual(['ready', 'draining', 'stopped']);
  });
  it('preserves a failed startup after cleanup', async () => {
    const lifecycle = new ApiLifecycle(() => {});
    lifecycle.fail();
    await lifecycle.shutdown(async () => {}, 500);
    expect(lifecycle.state).toBe('failed');
    expect(lifecycle.ready).toBe(false);
  });
  it.each(['timeout', 'rejection'])('fails on shutdown %s', async (kind) => {
    const lifecycle = new ApiLifecycle(() => {});
    lifecycle.markReady();
    const close =
      kind === 'timeout'
        ? () => new Promise<void>(() => {})
        : () => Promise.reject(new Error('synthetic-sensitive-error'));
    await expect(lifecycle.shutdown(close, 10)).rejects.toThrow();
    expect(lifecycle.state).toBe('failed');
    expect(lifecycle.ready).toBe(false);
  });
});
