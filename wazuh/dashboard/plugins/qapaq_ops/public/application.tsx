/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import type { AppMountParameters, CoreStart } from '../../../src/core/public';
import type { QapaqView } from '../common';
import type { ChangeFeed } from './api/change_feed';
import type { QapaqApiClient } from './api/client';
import { AccessView } from './components/access_view';
import { AlertsView } from './components/alerts_view';
import { AuditView } from './components/audit_view';
import { ConsoleProvider } from './components/console_context';
import { IncidentsView } from './components/incidents_view';
import { NotificationsView } from './components/notifications_view';
import { OperationsView } from './components/operations_view';
import { SessionView } from './components/session_view';
import { SourcesView } from './components/sources_view';

type History = AppMountParameters['history'];

/** El elemento abierto vive en `?id=`: se puede compartir y sobrevive a recargar. */
function useSelection(history: History) {
  const read = () => new URLSearchParams(history.location.search).get('id');
  const [selected, setSelected] = useState<string | null>(read);
  useEffect(() => history.listen(() => setSelected(read())), [history]); // eslint-disable-line react-hooks/exhaustive-deps
  const select = (id: string | null) => {
    const params = new URLSearchParams(history.location.search);
    if (id) params.set('id', id);
    else params.delete('id');
    const search = params.toString();
    history.push({ pathname: history.location.pathname, search: search ? `?${search}` : '' });
  };
  return [selected, select] as const;
}

function Console({
  view,
  history,
  basePath,
}: {
  view: QapaqView;
  history: History;
  basePath: string;
}) {
  const [selected, select] = useSelection(history);
  const params = new URLSearchParams(history.location.search);
  switch (view) {
    case 'alerts':
      return (
        <AlertsView
          selectedId={selected}
          onSelect={select}
          basePath={basePath}
          initialPriority={params.get('priority')}
        />
      );
    case 'incidents':
      return <IncidentsView selectedId={selected} onSelect={select} />;
    case 'notifications':
      return <NotificationsView />;
    case 'sources':
      // «Salud de fuentes» incluye la salud operativa de la plataforma (una sola entrada de menú).
      return (
        <>
          <SourcesView />
          <OperationsView embedded />
        </>
      );
    case 'audit':
      return <AuditView />;
    case 'access':
      return <AccessView />;
    case 'session':
      return <SessionView basePath={basePath} />;
  }
}

/** Monta una vista de la consola. React 16 (OSD 2.19): `ReactDOM.render`, no `createRoot`. */
export function renderApp(
  core: CoreStart,
  params: AppMountParameters,
  view: QapaqView,
  api: QapaqApiClient,
  feed: ChangeFeed,
) {
  const basePath = core.http.basePath.get();
  params.element.classList.add('qapaqApp');
  ReactDOM.render(
    <core.i18n.Context>
      <ConsoleProvider api={api} notifications={core.notifications} feed={feed} basePath={basePath}>
        <Console view={view} history={params.history} basePath={basePath} />
      </ConsoleProvider>
    </core.i18n.Context>,
    params.element,
  );
  return () => {
    ReactDOM.unmountComponentAtNode(params.element);
    params.element.classList.remove('qapaqApp');
  };
}
