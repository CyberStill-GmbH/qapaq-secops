/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { ChangeEvent, ChangesResponse } from '../../common';
import { ChangeFeed, ChangeSource } from './change_feed';
import { QapaqApiError } from './client';

const change = (seq: number, type: string, id: string): ChangeEvent => ({
  seq: String(seq),
  resource: { type, id },
  kind: 'updated',
  at: '2026-10-13T00:00:00.000Z',
});

/** Fuente guionada: cada llamada devuelve el siguiente paso; al agotarse, cuelga. */
function scripted(steps: Array<ChangesResponse | Error>) {
  const calls: Array<string | undefined> = [];
  const source: ChangeSource = {
    get: async (_path, query) => {
      calls.push(query?.after);
      const step = steps.shift();
      if (!step) return new Promise<ChangesResponse>(() => undefined);
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { source, calls };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const visible = {
  isHidden: () => false,
  onVisible: () => () => undefined,
  sleep: async () => undefined,
};

describe('ChangeFeed', () => {
  it('la primera respuesta solo fija el cursor; después entrega por tipo de recurso', async () => {
    const { source, calls } = scripted([
      { cursor: '10', changes: [], resync: false },
      {
        cursor: '12',
        changes: [change(11, 'alert', 'a1'), change(12, 'incident', 'i1')],
        resync: false,
      },
    ]);
    const feed = new ChangeFeed(source, visible);
    const alerts = jest.fn();
    const incidents = jest.fn();
    feed.subscribe(['alert'], alerts);
    feed.subscribe(['incident', 'incident_task'], incidents);
    await flush();
    feed.stop();

    expect(calls).toEqual([undefined, '10', '12']);
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(alerts.mock.calls[0][0].map((c: ChangeEvent) => c.resource.id)).toEqual(['a1']);
    expect(incidents.mock.calls[0][0].map((c: ChangeEvent) => c.resource.id)).toEqual(['i1']);
  });

  it('un solo poller aunque haya varias suscripciones', async () => {
    const { source, calls } = scripted([{ cursor: '1', changes: [], resync: false }]);
    const feed = new ChangeFeed(source, visible);
    feed.subscribe(['alert'], jest.fn());
    feed.subscribe(['alert'], jest.fn());
    feed.subscribe(['incident'], jest.fn());
    await flush();
    feed.stop();
    // 1 inicial + 1 colgada: no una por suscripción.
    expect(calls.length).toBe(2);
  });

  it('resync avisa a todas las vistas para que recarguen', async () => {
    const { source } = scripted([
      { cursor: '1', changes: [], resync: false },
      { cursor: '900', changes: [], resync: true },
    ]);
    const feed = new ChangeFeed(source, visible);
    const listener = jest.fn();
    feed.subscribe(['notification'], listener);
    await flush();
    feed.stop();
    expect(listener).toHaveBeenCalledWith([], true);
  });

  it('sin sesión deja de consultar', async () => {
    const { source, calls } = scripted([
      { cursor: '1', changes: [], resync: false },
      new QapaqApiError('SESSION_EXPIRED', 401, null),
      { cursor: '2', changes: [], resync: false },
    ]);
    const feed = new ChangeFeed(source, visible);
    feed.subscribe(['alert'], jest.fn());
    await flush();
    expect(calls.length).toBe(2);
    feed.stop();
  });

  it('tras un fallo transitorio reintenta con el mismo cursor', async () => {
    const { source, calls } = scripted([
      { cursor: '5', changes: [], resync: false },
      new QapaqApiError('DEPENDENCY_DEGRADED', 503, null),
      { cursor: '6', changes: [change(6, 'alert', 'a9')], resync: false },
    ]);
    const feed = new ChangeFeed(source, visible);
    const listener = jest.fn();
    feed.subscribe(['alert'], listener);
    await flush();
    feed.stop();
    expect(calls.slice(0, 3)).toEqual([undefined, '5', '5']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('no consulta mientras la pestaña está oculta', async () => {
    let hidden = true;
    let resume: () => void = () => undefined;
    const { source, calls } = scripted([{ cursor: '1', changes: [], resync: false }]);
    const feed = new ChangeFeed(source, {
      isHidden: () => hidden,
      onVisible: (wake) => {
        resume = wake;
        return () => undefined;
      },
      sleep: () => new Promise(() => undefined),
    });
    feed.subscribe(['alert'], jest.fn());
    await flush();
    expect(calls.length).toBe(0);
    hidden = false;
    resume();
    await flush();
    expect(calls.length).toBeGreaterThan(0);
    feed.stop();
  });
});
