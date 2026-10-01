import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from '../src/api/client.js';
import { ErrorBanner } from '../src/app/error-banner.js';
import { Console } from '../src/app/console.js';
import Application from '../src/app/application.js';
import { parsePublicConfig } from '../src/bootstrap/public-config.js';

const CONFIG = parsePublicConfig({ appName: 'QAPAQ SecOps', basePath: '/' });

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

  it('conserva el shell de C-02 con un único elemento de estado', () => {
    const html = renderToStaticMarkup(createElement(Application, { config: CONFIG }));

    expect(html).toContain('Interfaz disponible');
    expect(html.match(/role="status"/gu)).toHaveLength(1);
  });
});
