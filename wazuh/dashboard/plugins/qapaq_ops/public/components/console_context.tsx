/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useRef } from 'react';
import {
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiLoadingContent,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { NotificationsStart } from '../../../../src/core/public';
import { ChangeEvent, SessionInfo } from '../../common';
import { ChangeFeed } from '../api/change_feed';
import { QapaqApiClient } from '../api/client';
import { ErrorCallout, useAsync } from './primitives';

export interface ConsoleContextValue {
  readonly api: QapaqApiClient;
  readonly session: SessionInfo;
  readonly notifications: NotificationsStart;
  readonly can: (capability: string) => boolean;
  readonly feed: ChangeFeed | null;
  /** `server.basePath` de OSD (vacío en el despliegue actual). */
  readonly basePath: string;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error('useConsole fuera de ConsoleProvider');
  return value;
}

/**
 * Resuelve la sesión QAPAQ antes de pintar cualquier vista: sin sesión no hay consola
 * (el cliente ya redirige al login). Las capacidades solo deciden qué se renderiza;
 * la autorización real la hace el backend en cada llamada.
 */
export function ConsoleProvider({
  api,
  notifications,
  feed = null,
  basePath = '',
  children,
}: {
  api: QapaqApiClient;
  notifications: NotificationsStart;
  feed?: ChangeFeed | null;
  basePath?: string;
  children: React.ReactNode;
}) {
  const session = useAsync(() => api.session(), [api]);
  if (session.loading) return <EuiLoadingContent lines={4} />;
  if (!session.data) return <ErrorCallout error={session.error} onRetry={session.reload} />;
  const capabilities = new Set(session.data.capabilities);
  return (
    <ConsoleContext.Provider
      value={{
        api,
        session: session.data,
        notifications,
        can: (capability) => capabilities.has(capability),
        feed,
        basePath,
      }}
    >
      {children}
    </ConsoleContext.Provider>
  );
}

/** Marco de pantalla: título, línea de contexto y acciones; se apila en móvil. */
export function QapaqPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="qapaqPage">
      <EuiFlexGroup
        className="qapaqPage__header"
        alignItems="center"
        justifyContent="spaceBetween"
        gutterSize="m"
        responsive
        wrap
      >
        <EuiFlexItem grow>
          <EuiTitle size="m">
            <h1>{title}</h1>
          </EuiTitle>
          {description && (
            <EuiText size="s" color="subdued">
              <p>{description}</p>
            </EuiText>
          )}
        </EuiFlexItem>
        {actions && (
          <EuiFlexItem grow={false} className="qapaqPage__actions">
            {actions}
          </EuiFlexItem>
        )}
      </EuiFlexGroup>
      <EuiHorizontalRule margin="m" />
      {children}
      <EuiSpacer size="xl" />
    </main>
  );
}

/** Sección dentro de una página (p. ej. salud operativa bajo «Salud de fuentes»). */
export function QapaqSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="qapaqPage qapaqPage--section" aria-label={title}>
      <EuiFlexGroup
        alignItems="center"
        justifyContent="spaceBetween"
        gutterSize="m"
        responsive
        wrap
      >
        <EuiFlexItem grow>
          <EuiTitle size="s">
            <h2>{title}</h2>
          </EuiTitle>
          {description && (
            <EuiText size="s" color="subdued">
              <p>{description}</p>
            </EuiText>
          )}
        </EuiFlexItem>
        {actions && <EuiFlexItem grow={false}>{actions}</EuiFlexItem>}
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      {children}
    </section>
  );
}

/**
 * Recarga en vivo: llama a `onChange` cuando el feed compartido informa cambios de esos tipos
 * (o `resync`). Agrupa ráfagas en una sola recarga para no repetir peticiones.
 */
export function useChanges(
  types: readonly string[],
  onChange: (changes: readonly ChangeEvent[], resync: boolean) => void,
  debounceMs = 400,
): void {
  const { feed } = useConsole();
  const callback = useRef(onChange);
  callback.current = onChange;
  const key = types.join(',');
  useEffect(() => {
    if (!feed) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: ChangeEvent[] = [];
    let pendingResync = false;
    const unsubscribe = feed.subscribe(key.split(','), (changes, resync) => {
      pending = pending.concat(changes);
      pendingResync = pendingResync || resync;
      if (timer) return;
      timer = setTimeout(() => {
        const batch = pending;
        const wasResync = pendingResync;
        pending = [];
        pendingResync = false;
        timer = null;
        callback.current(batch, wasResync);
      }, debounceMs);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [feed, key, debounceMs]);
}
