import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, apiFetch } from '../src/api/client.js';
import { ErrorBanner } from '../src/app/error-banner.js';
import { Console } from '../src/app/console.js';
import { EventsPage } from '../src/components/soc/EventsPage.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(implementation: typeof fetch) {
  vi.stubGlobal('fetch', implementation);
}

describe('C-27 · normalización de errores en el cliente', () => {
  it('devuelve el cuerpo del catálogo tal como lo emite la API', async () => {
    stubFetch((() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 'STATE_CONFLICT',
            message: 'El elemento cambió mientras trabajaba en él. Vuelva a cargarlo.',
            action: 'reload_resource',
            helpRef: 'https://docs.qapaq.pe/secops/errores#state-conflict',
            retriable: true,
            correlationId: 'corr-1',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch);

    const result = await apiFetch('/api/alerts');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('STATE_CONFLICT');
    expect(result.ok === false && result.error.correlationId).toBe('corr-1');
  });

  it('convierte una caída de red en estado degradado con referencia propia', async () => {
    stubFetch((() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch);

    const result = await apiFetch('/api/alerts');

    expect(result.ok === false && result.error.code).toBe('DEPENDENCY_DEGRADED');
    expect(result.ok === false && result.error.correlationId.length).toBeGreaterThan(0);
  });

  it('no confía en un cuerpo de error con código desconocido', async () => {
    stubFetch((() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'INVENTADO', message: 'detalle interno' }), {
          status: 500,
        }),
      )) as typeof fetch);

    const result = await apiFetch('/api/alerts');

    expect(result.ok === false && result.error.code).toBe('DEPENDENCY_DEGRADED');
    expect(JSON.stringify(result)).not.toContain('detalle interno');
  });

  it('envía el correlationId y no adjunta credenciales de otro origen', async () => {
    const calls: RequestInit[] = [];
    stubFetch(((_input: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch);

    await apiFetch('/api/alerts');

    const sent = calls[0];

    expect(sent?.credentials).toBe('same-origin');
    expect(
      (sent?.headers as Record<string, string> | undefined)?.['x-correlation-id'],
    ).toBeTruthy();
  });
});

describe('C-21/C-27 · presentación', () => {
  it('muestra mensaje, ayuda, referencia y acción del catálogo', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBanner, {
        error: {
          code: 'PASSKEY_REQUIRED',
          message: 'Fuera de la red QAPAQ se requiere una passkey registrada.',
          action: 'register_passkey',
          helpRef: 'https://docs.qapaq.pe/secops/errores#passkey-required',
          retriable: false,
          correlationId: 'corr-9',
        },
        onAction: () => {},
      }),
    );

    expect(html).toContain('passkey registrada');
    expect(html).toContain('Registrar passkey');
    expect(html).toContain('corr-9');
    expect(html).toContain('role="alert"');
  });

  it('abre en estado de carga sin afirmar nada del backend', () => {
    const html = renderToStaticMarkup(createElement(Console));

    expect(html).toContain('Cargando el panel');
    expect(html).not.toContain('Sesión activa');
  });
});

describe('B-01 · token CSRF en el cliente', () => {
  function recordingFetch(calls: { url: string; init: RequestInit }[]) {
    return ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body =
        url === '/api/auth/session'
          ? JSON.stringify({
              subjectId: 's',
              tenantId: 't',
              roles: [],
              capabilities: [],
              amr: [],
              csrfToken: 'token-de-la-sesion',
            })
          : '{}';
      return Promise.resolve(
        new Response(url === '/api/auth/logout' ? null : body, {
          status: url === '/api/auth/logout' ? 204 : 200,
        }),
      );
    }) as unknown as typeof fetch;
  }

  const headerOf = (call: { init: RequestInit } | undefined) =>
    (call?.init.headers as Record<string, string> | undefined)?.['x-csrf-token'];

  it('adjunta el token de la sesión solo a las mutaciones', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    stubFetch(recordingFetch(calls));

    await api.session();
    await api.alerts();
    await api.command('a-1', { name: 'acknowledge', expectedRevision: 1 });

    expect(headerOf(calls[1])).toBeUndefined();
    expect(headerOf(calls[2])).toBe('token-de-la-sesion');
  });

  it('descarta el token al cerrar sesión', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    stubFetch(recordingFetch(calls));

    await api.session();
    await api.logout();
    await api.command('a-1', { name: 'acknowledge', expectedRevision: 1 });

    expect(headerOf(calls[1])).toBe('token-de-la-sesion');
    expect(headerOf(calls[2])).toBeUndefined();
  });
});

describe('D-10b · pivote de correlación con referencia opaca', () => {
  it('envía la referencia opaca para el pivote de entidad', async () => {
    let requestedUrl = '';
    stubFetch(((url: string) => {
      requestedUrl = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({ correlationId: 'corr-entity', items: [], nextCursor: null }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    }) as typeof fetch);

    const entityRef = 'ent_AAAAAAAAAAAAAAAAAAAAAA';
    await api.alertsByStatus('open', undefined, '', undefined, entityRef);

    const query = new URLSearchParams(requestedUrl.split('?')[1] ?? '');
    expect(query.get('entity')).toBe(entityRef);
    expect(requestedUrl).not.toContain('user:');
    expect(requestedUrl).not.toContain('@');
  });
});

describe('Eventos · gramática segura de búsqueda', () => {
  it('envía q sin filtros tipados y conserva el texto solo en la petición', async () => {
    let requestedUrl = '';
    stubFetch(((url: string) => {
      requestedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
    }) as unknown as typeof fetch);

    await api.events({
      from: '2026-10-12T00:00:00.000Z',
      to: '2026-10-13T00:00:00.000Z',
      q: 'severity:high,critical AND outcome:failure',
      severity: ['low'],
      outcome: 'success',
    });

    const query = new URLSearchParams(requestedUrl.split('?')[1] ?? '');
    expect(query.get('q')).toBe('severity:high,critical AND outcome:failure');
    expect(query.has('severity')).toBe(false);
    expect(query.has('outcome')).toBe(false);
  });

  it('presenta ambos modos y mantiene los filtros visuales disponibles', () => {
    const html = renderToStaticMarkup(createElement(EventsPage, {
      session: { subjectId: 'analyst-1', tenantId: 'tenant-1', roles: [], capabilities: ['events.read'], amr: [], csrfToken: 'csrf' },
    }));

    expect(html).toContain('Filtros');
    expect(html).toContain('Consulta');
    expect(html).toContain('Rango de tiempo');
    expect(html).toContain('Severidad');
    expect(html).toContain('Categoría');
    expect(html).not.toContain('authentication_failed');
  });
});
