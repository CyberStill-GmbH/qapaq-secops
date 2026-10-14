import { expect, it, vi } from 'vitest';
import { buildWorker } from '../src/bootstrap.js';
import { WorkerRuntime } from '../src/lifecycle/worker-runtime.js';

it('starts without polling, emits readiness once, and closes idempotently', async () => {
  const emit = vi.fn();
  const timer = vi.spyOn(globalThis, 'setInterval');
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  const worker = new WorkerRuntime(emit);
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
    expect(emit.mock.calls.flat()).toEqual(['ready', 'draining', 'stopped']);
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

it('stops admission, waits for the BullMQ consumer, then closes shared resources', async () => {
  const order: string[] = [];
  const worker = new WorkerRuntime(() => {}, 100, {
    start: () => order.push('start'),
    stop: async () => {
      order.push('stop');
    },
    close: async () => {
      order.push('close');
    },
  });
  worker.start();
  await worker.stop();
  expect(order).toEqual(['start', 'stop', 'close']);
});

it.each(['timeout', 'error'])('fails closed on drain %s', async (kind) => {
  const resources = {
    start: () => undefined,
    stop: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const worker = new WorkerRuntime(() => {}, 10, resources);
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
  expect(resources.close).toHaveBeenCalledOnce();
  if (kind === 'timeout') reject(new Error('release-test-task'));
  await caughtTask;
});

it('invalid configuration prevents readiness', async () => {
  const emit = vi.fn();
  await expect(buildWorker({}, emit)).rejects.toThrow();
  expect(emit).not.toHaveBeenCalled();
});
