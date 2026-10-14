/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  EuiHeaderSectionItemButton,
  EuiIcon,
  EuiNotificationBadge,
  EuiToolTip,
} from '@elastic/eui';
import type { CoreStart } from '../../../src/core/public';
import { Alert, CAPABILITIES, ChangeEvent, DEFAULT_LANDING } from '../common';
import type { ChangeFeed } from './api/change_feed';
import type { QapaqApiClient } from './api/client';

/** Máximo de alertas nuevas que se consultan por lote (una ráfaga no dispara N peticiones). */
const MAX_LOOKUPS_PER_BATCH = 10;

/**
 * Aviso de nuevas alertas P1 en la cabecera de todo el dashboard (también en el SIEM).
 *
 * Usa el feed compartido de `/api/changes` (no abre otro long-poll): ante una alerta *creada*,
 * la lee por su endpoint normal (que vuelve a autorizar) y, si es P1 y sigue «nueva», suma al
 * contador y muestra un aviso. Sin `alerts.read` no se pinta nada. El contador cuenta desde que
 * se abrió la página; no es un KPI ni sustituye a la cola.
 */
function P1Badge({ core, api, feed }: { core: CoreStart; api: QapaqApiClient; feed: ChangeFeed }) {
  const [enabled, setEnabled] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.session().then(
      (session) => {
        if (!cancelled) setEnabled(session.capabilities.includes(CAPABILITIES.alertsRead));
      },
      () => undefined, // Sin sesión el cliente ya llevó al login; con API degradada no hay aviso.
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!enabled) return undefined;
    const seen = new Set<string>();
    return feed.subscribe(['alert'], (changes: readonly ChangeEvent[], resync: boolean) => {
      if (resync) return; // Un resync no dice qué es nuevo: la cola lo mostrará al abrirla.
      const created = changes
        .filter((change) => change.kind === 'created' && !seen.has(change.resource.id))
        .slice(0, MAX_LOOKUPS_PER_BATCH);
      for (const change of created) {
        seen.add(change.resource.id);
        api.get<{ alert: Alert }>(`/alerts/${encodeURIComponent(change.resource.id)}`).then(
          ({ alert }) => {
            if (alert.priority !== 'P1' || alert.status !== 'new') return;
            setCount((value) => value + 1);
            core.notifications.toasts.addDanger({
              title: 'Nueva alerta P1',
              text: alert.title,
              'data-test-subj': 'qapaqP1Toast',
            });
          },
          () => undefined,
        );
      }
    });
  }, [enabled, api, feed, core]);

  if (!enabled || count === 0) return null;
  const label = count === 1 ? '1 alerta P1 nueva' : `${count} alertas P1 nuevas`;
  return (
    <EuiToolTip content={label} position="bottom">
      <EuiHeaderSectionItemButton
        aria-label={`${label}. Abrir la cola de alertas`}
        className="qapaqP1Badge"
        data-test-subj="qapaqP1Badge"
        notification={
          <EuiNotificationBadge color="accent">{count > 99 ? '99+' : count}</EuiNotificationBadge>
        }
        onClick={() => {
          setCount(0);
          core.application.navigateToUrl(
            core.http.basePath.prepend(`${DEFAULT_LANDING}?priority=P1`),
          );
        }}
      >
        <EuiIcon type="bell" size="m" />
      </EuiHeaderSectionItemButton>
    </EuiToolTip>
  );
}

export function mountP1Watch(core: CoreStart, api: QapaqApiClient, feed: ChangeFeed): () => void {
  let element: HTMLElement | null = null;
  core.chrome.navControls.registerRight({
    order: 1000,
    mount: (target: HTMLElement) => {
      element = target;
      ReactDOM.render(<P1Badge core={core} api={api} feed={feed} />, target);
      return () => {
        ReactDOM.unmountComponentAtNode(target);
        element = null;
      };
    },
  });
  return () => {
    if (element) ReactDOM.unmountComponentAtNode(element);
  };
}
