import { expect, it, vi } from 'vitest';
import { buildWorker } from '../src/bootstrap.js';
import { WorkerRuntime } from '../src/lifecycle/worker-runtime.js';

it('starts without polling, emits readiness once, and closes idempotently', async () => {
  const emit = vi.fn();
  const timer = vi.spyOn(globalThis, 'setInterval');
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  const worker = buildWorker({ QAPAQ_PROFILE: 'test' }, emit);
  try {
    expect(worker.ready).toBe(false);
    worker.start();
    expect(worker.ready).toBe(true);
    expect(timer).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(() => worker.start()).toThrow();
    const first = worker.stop();
    expect(worker.ready).toBe(false);
    expect(worker.stop()).toBe(first);
    await first;
    expect(worker.state).toBe('stopped');
    expect(emit.mock.calls.flat()).toEqual(['starting', 'ready', 'draining', 'stopped']);
  } finally {
    timer.mockRestore();
    timeout.mockRestore();
    await worker.stop();
  }
});

it('rejects new work while draining and waits for admitted work', async () => {
  const worker = new WorkerRuntime(() => {});
  worker.start();
  let complete!: () => void;
  const active = worker.run(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await Promise.resolve();
  const close = worker.stop();
  expect(worker.state).toBe('draining');
  await expect(worker.run(async () => 1)).rejects.toThrow('WORKER_NOT_READY');
  complete();
  await Promise.all([active, close]);
  expect(worker.state).toBe('stopped');
});

it.each(['timeout', 'error'])('fails closed on drain %s', async (kind) => {
  const worker = new WorkerRuntime(() => {}, 10);
  worker.start();
  let reject!: (error: Error) => void;
  const task = worker.run(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const caughtTask = task.catch(() => {});
  await Promise.resolve();
  const close = worker.stop();
  const assertion = expect(close).rejects.toThrow();
  if (kind === 'error') reject(new Error('synthetic-error'));
  await assertion;
  expect(worker.state).toBe('failed');
  if (kind === 'timeout') reject(new Error('release-test-task'));
  await caughtTask;
});

it('invalid configuration prevents readiness', () => {
  const emit = vi.fn();
  expect(() => buildWorker({}, emit)).toThrow();
  expect(emit).not.toHaveBeenCalled();
});
