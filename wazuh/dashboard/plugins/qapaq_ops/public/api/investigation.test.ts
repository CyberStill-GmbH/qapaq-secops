/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { fetchRelated } from './investigation';

describe('cliente de timeline paginada', () => {
  it('envía el cursor con los mismos filtros originales', async () => {
    let requested = '';
    const fetchImpl: typeof fetch = async (input) => {
      requested = String(input);
      return {
        ok: true,
        json: async () => ({
          access: 'ok',
          from: '',
          to: '',
          total: 1,
          events: [],
          perEntity: {},
          nextCursor: null,
          pageSize: 100,
        }),
      } as Response;
    };

    await fetchRelated(
      '/base',
      {
        entities: [{ kind: 'zone', value: 'qapaq.pe' }],
        at: '2026-11-08T12:00:00.000Z',
        window: '1h',
        exclude: 'source-1',
        cursor: 'opaque-cursor',
      },
      fetchImpl,
    );

    const url = new URL(requested, 'https://dashboard.example.test');
    expect(url.searchParams.getAll('e')).toEqual(['zone:qapaq.pe']);
    expect(url.searchParams.get('at')).toBe('2026-11-08T12:00:00.000Z');
    expect(url.searchParams.get('window')).toBe('1h');
    expect(url.searchParams.get('exclude')).toBe('source-1');
    expect(url.searchParams.get('cursor')).toBe('opaque-cursor');
  });

  it('pasa AbortSignal a la petición para que el usuario pueda cancelar la colección', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal ?? null;
      return {
        ok: true,
        json: async () => ({
          access: 'ok',
          from: '',
          to: '',
          total: 0,
          events: [],
          perEntity: {},
          nextCursor: null,
          pageSize: 100,
        }),
      } as Response;
    };
    await fetchRelated(
      '/base',
      {
        entities: [{ kind: 'user', value: 'analyst@example.test' }],
        at: '2026-11-08T12:00:00.000Z',
        window: '1h',
      },
      fetchImpl,
      controller.signal,
    );
    expect(signal).toBe(controller.signal);
  });
});
