import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationDispatcher } from '../src/runtime/notification-dispatcher.js';

/** C-20 / D-8 — bucle de despacho: un vuelo a la vez, ráfagas, errores y apagado. */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Deja correr temporizadores en 0 ms y microtareas pendientes. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((done) => setTimeout(done, 0));
}

describe('NotificationDispatcher', () => {
  let dispatcher: NotificationDispatcher | undefined;

  afterEach(async () => {
    await dispatcher?.stop();
    dispatcher = undefined;
  });

  it('kick no hace nada mientras el bucle no arrancó', async () => {
    const drain = vi.fn(async () => 0);
    dispatcher = new NotificationDispatcher({ drain, intervalMs: 60_000, onError: () => {} });

    dispatcher.kick();
    await settle();

    expect(drain).not.toHaveBeenCalled();
  });

  it('al arrancar vacía la cola en ráfagas hasta que un lote vuelve vacío', async () => {
    const batches = [20, 20, 3, 0];
    const drain = vi.fn(async () => batches.shift() ?? 0);
    dispatcher = new NotificationDispatcher({ drain, intervalMs: 60_000, onError: () => {} });

    dispatcher.start();
    await settle();

    expect(drain).toHaveBeenCalledTimes(4);
  });

  it('un fallo se reporta y el bucle sigue vivo para la siguiente pasada', async () => {
    const onError = vi.fn();
    const drain = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('TRANSPORT_DOWN'))
      .mockResolvedValue(0);
    dispatcher = new NotificationDispatcher({ drain, intervalMs: 60_000, onError });

    dispatcher.start();
    await settle();
    dispatcher.kick();
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('publica señales BullMQ best-effort y sigue drenando Postgres si Valkey falla', async () => {
    const onError = vi.fn();
    const enqueue = vi.fn(async () => {
      throw new Error('VALKEY_OFFLINE');
    });
    const drain = vi.fn(async () => 0);
    dispatcher = new NotificationDispatcher({ drain, enqueue, intervalMs: 60_000, onError });

    dispatcher.start();
    dispatcher.kick();
    await settle();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenCalled();
  });

  it('un kick durante una pasada no abre otra en paralelo, pero deja una pendiente', async () => {
    const gate = deferred();
    let concurrent = 0;
    let maximum = 0;
    const drain = vi.fn(async () => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      if (drain.mock.calls.length === 1) await gate.promise;
      concurrent -= 1;
      return 0;
    });
    dispatcher = new NotificationDispatcher({ drain, intervalMs: 60_000, onError: () => {} });

    dispatcher.start();
    await settle();
    dispatcher.kick();
    dispatcher.kick();
    gate.resolve();
    await settle();

    expect(maximum).toBe(1);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('stop espera la pasada en curso y después no vuelve a despachar', async () => {
    const gate = deferred();
    let finished = false;
    const drain = vi.fn(async () => {
      await gate.promise;
      finished = true;
      return 0;
    });
    dispatcher = new NotificationDispatcher({ drain, intervalMs: 1, onError: () => {} });

    dispatcher.start();
    await settle();
    const stopping = dispatcher.stop();
    gate.resolve();
    await stopping;
    const callsAtStop = drain.mock.calls.length;
    await settle();

    expect(finished).toBe(true);
    expect(dispatcher.started).toBe(false);
    expect(drain.mock.calls.length).toBe(callsAtStop);
  });
});
