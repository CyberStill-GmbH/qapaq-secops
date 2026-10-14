/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Subconjunto de los tipos de `src/core/public` de OpenSearch Dashboards 2.19.6 que usa
 * qapaq_ops, copiado de las firmas reales (wazuh-dashboard v4.14.8). Solo para el typecheck
 * fuera del árbol de OSD (tools/typecheck.mjs); en el build real se usan los tipos del core.
 */

import type { ComponentType, ReactNode } from 'react';

export type MountPoint<T extends HTMLElement = HTMLElement> = (element: T) => UnmountCallback;
export type UnmountCallback = () => void;

export interface Location {
  pathname: string;
  search: string;
  hash: string;
}

export interface ScopedHistory {
  readonly location: Location;
  listen(listener: (location: Location, action: string) => void): () => void;
  push(path: string | { pathname?: string; search?: string; hash?: string }, state?: unknown): void;
  replace(
    path: string | { pathname?: string; search?: string; hash?: string },
    state?: unknown,
  ): void;
}

export interface AppMountParameters<HistoryLocationState = unknown> {
  element: HTMLElement;
  history: ScopedHistory;
  appBasePath: string;
  onAppLeave: (handler: unknown) => void;
  setHeaderActionMenu: (menuMount: MountPoint | undefined) => void;
}

export type AppUnmount = () => void;
export type AppMount<HistoryLocationState = unknown> = (
  params: AppMountParameters<HistoryLocationState>,
) => AppUnmount | Promise<AppUnmount>;

export interface AppCategory {
  id: string;
  label: string;
  ariaLabel?: string;
  order?: number;
  euiIconType?: string;
}

export enum AppNavLinkStatus {
  default = 0,
  visible = 1,
  disabled = 2,
  hidden = 3,
}

export interface App<HistoryLocationState = unknown> {
  id: string;
  title: string;
  category?: AppCategory;
  navLinkStatus?: AppNavLinkStatus;
  defaultPath?: string;
  order?: number;
  euiIconType?: string;
  icon?: string;
  appRoute?: string;
  exactRoute?: boolean;
  mount: AppMount<HistoryLocationState>;
}

export interface ApplicationSetup {
  register<HistoryLocationState = unknown>(app: App<HistoryLocationState>): void;
}

export interface ApplicationStart {
  navigateToApp(
    appId: string,
    options?: { path?: string; state?: unknown; replace?: boolean },
  ): Promise<void>;
  navigateToUrl(url: string): Promise<void>;
  getUrlForApp(appId: string, options?: { path?: string; absolute?: boolean }): string;
}

export interface IBasePath {
  get: () => string;
  prepend: (url: string) => string;
  remove: (url: string) => string;
  readonly serverBasePath: string;
}

export interface HttpSetup {
  basePath: IBasePath;
}
export type HttpStart = HttpSetup;

export interface ToastInputFields {
  id?: string;
  title?: string | MountPoint;
  text?: string | MountPoint;
  color?: string;
  iconType?: string;
  toastLifeTimeMs?: number;
  'data-test-subj'?: string;
}
export type ToastInput = string | ToastInputFields;

export interface IToasts {
  add(toastOrTitle: ToastInput): unknown;
  addSuccess(toastOrTitle: ToastInput): unknown;
  addWarning(toastOrTitle: ToastInput): unknown;
  addDanger(toastOrTitle: ToastInput): unknown;
  addInfo(toastOrTitle: ToastInput): unknown;
}

export interface NotificationsStart {
  toasts: IToasts;
}

export interface ChromeNavControl {
  order?: number;
  mount: MountPoint;
}

export interface ChromeStart {
  docTitle: {
    change(newTitle: string | string[]): void;
    reset(): void;
  };
  navControls: {
    registerLeft(navControl: ChromeNavControl): void;
    registerRight(navControl: ChromeNavControl): void;
    registerCenter(navControl: ChromeNavControl): void;
  };
}

export interface I18nStart {
  Context: ComponentType<{ children: ReactNode }>;
}

export interface CoreStart {
  application: ApplicationStart;
  chrome: ChromeStart;
  http: HttpStart;
  i18n: I18nStart;
  notifications: NotificationsStart;
}

export type StartServicesAccessor<
  TPluginsStart extends object = object,
  TStart = unknown,
> = () => Promise<[CoreStart, TPluginsStart, TStart]>;

export interface CoreSetup<TPluginsStart extends object = object, TStart = unknown> {
  application: ApplicationSetup;
  http: HttpSetup;
  getStartServices: StartServicesAccessor<TPluginsStart, TStart>;
}

export interface Plugin<
  TSetup = void,
  TStart = void,
  TPluginsSetup extends object = object,
  TPluginsStart extends object = object,
> {
  setup(core: CoreSetup<TPluginsStart, TStart>, plugins: TPluginsSetup): TSetup | Promise<TSetup>;
  start(core: CoreStart, plugins: TPluginsStart): TStart | Promise<TStart>;
  stop?(): void;
}

export interface PluginInitializerContext<ConfigSchema extends object = object> {
  readonly opaqueId: symbol;
  readonly env: { mode: { dev: boolean; prod: boolean } };
  readonly config: {
    get: <T extends object = ConfigSchema>() => T;
  };
}
