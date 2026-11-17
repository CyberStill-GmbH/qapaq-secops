/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { AppMountParameters, CoreStart } from '../../../src/core/public';
import { CAPABILITIES, RESPOND_PATH } from '../common';
import type { QapaqApiClient } from './api/client';

/**
 * Ankay (SOAR) embebido en el SIEM: un iframe del mismo origen de `/ankay/` dentro
 * del chrome del dashboard (cabecera y menú visibles). El edge solo permite enmarcarlo desde el
 * propio origen (`frame-ancestors 'self'`) y lo protege con la sesión QAPAQ (auth_request).
 * La autenticación propia de Ankay sigue vigente dentro del iframe (docs/13).
 */

type State = 'checking' | 'forbidden' | 'loading' | 'ready' | 'unavailable';

/** Tiempo máximo para que el iframe cargue antes de mostrar «no disponible». */
const LOAD_TIMEOUT_MS = 20000;

function RespondView({ api, basePath }: { api: QapaqApiClient; basePath: string }) {
  const src = `${basePath}${RESPOND_PATH}`;
  const [state, setState] = useState<State>('checking');
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setState('checking');
    (async () => {
      try {
        const session = await api.session();
        if (!session.capabilities.includes(CAPABILITIES.incidentsWrite)) {
          if (!cancelled) setState('forbidden');
          return;
        }
        // Sondeo del mismo origen: el edge responde 502/504 si Ankay no está levantado.
        const probe = await fetch(src, { credentials: 'same-origin', redirect: 'manual' });
        if (cancelled) return;
        if (probe.status >= 500 || probe.status === 0) {
          setState('unavailable');
          return;
        }
        setState('loading');
        timer.current = window.setTimeout(() => {
          setState((current) => (current === 'loading' ? 'unavailable' : current));
        }, LOAD_TIMEOUT_MS);
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
    };
  }, [api, src, attempt]);

  const openInTab = (
    <a className="ankayLink" href={src} target="_blank" rel="noopener noreferrer">
      Abrir en pestaña
    </a>
  );

  if (state === 'forbidden') {
    return (
      <div className="ankayNotice" role="status">
        <h2>Ankay</h2>
        <p>Tu rol no incluye la respuesta a incidentes. Pide acceso a tu Líder SOC.</p>
      </div>
    );
  }

  return (
    <div className="ankay">
      <div className="ankayBar">
        <span className="ankayTitle">Ankay</span>
        <span className="ankayHint">Automatización y respuesta (SOAR)</span>
        {openInTab}
      </div>
      {(state === 'checking' || state === 'loading') && (
        <div className="ankayNotice" role="status" aria-live="polite">
          <span className="ankaySpinner" aria-hidden="true" />
          <p>Cargando Ankay…</p>
        </div>
      )}
      {state === 'unavailable' && (
        <div className="ankayNotice" role="alert">
          <h2>Ankay no está disponible</h2>
          <p>El servicio no respondió. Puedes reintentar o abrirlo en una pestaña aparte.</p>
          <p>
            <button type="button" className="ankayRetry" onClick={() => setAttempt((n) => n + 1)}>
              Reintentar
            </button>{' '}
            {openInTab}
          </p>
        </div>
      )}
      {(state === 'loading' || state === 'ready') && (
        <iframe
          key={attempt}
          className="ankayFrame"
          title="Ankay"
          src={src}
          style={{ visibility: state === 'ready' ? 'visible' : 'hidden' }}
          onLoad={() => {
            window.clearTimeout(timer.current);
            setState('ready');
          }}
        />
      )}
    </div>
  );
}

export function renderRespondApp(core: CoreStart, params: AppMountParameters, api: QapaqApiClient) {
  params.element.classList.add('qapaqApp', 'ankayApp');
  ReactDOM.render(
    <core.i18n.Context>
      <RespondView api={api} basePath={core.http.basePath.get()} />
    </core.i18n.Context>,
    params.element,
  );
  return () => {
    ReactDOM.unmountComponentAtNode(params.element);
    params.element.classList.remove('qapaqApp', 'ankayApp');
  };
}
