/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Subconjunto de los tipos de `src/core/server` de OpenSearch Dashboards 2.19.6 que usa
 * qapaq_ops (firmas copiadas de wazuh-dashboard v4.14.8). Solo para tools/typecheck.mjs.
 */

import type { Observable } from 'rxjs';
import type { Type } from '@osd/config-schema';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string | Error): void;
  error(message: string | Error): void;
}

export interface OpenSearchDashboardsRequest<P = unknown, Q = unknown, B = unknown> {
  readonly url: URL;
  readonly route: { readonly path: string; readonly method: string; readonly options: unknown };
  readonly headers: Record<string, string | string[] | undefined>;
  readonly params: P;
  readonly query: Q;
  readonly body: B;
}

export interface OnPreRoutingToolkit {
  next: () => unknown;
  rewriteUrl: (url: string) => unknown;
}

export type OnPreRoutingHandler = (
  request: OpenSearchDashboardsRequest,
  response: unknown,
  toolkit: OnPreRoutingToolkit,
) => unknown;

export interface RouteConfigOptions {
  authRequired?: boolean | 'optional';
  xsrfRequired?: boolean;
  tags?: readonly string[];
}

export interface RouteConfig {
  path: string;
  validate: false | { params?: Type<unknown>; query?: Type<unknown>; body?: Type<unknown> };
  options?: RouteConfigOptions;
}

export interface HttpResponseOptions {
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

export interface OpenSearchDashboardsResponseFactory {
  ok(options?: HttpResponseOptions): unknown;
  redirected(options: HttpResponseOptions): unknown;
  notFound(options?: HttpResponseOptions): unknown;
}

export type RequestHandler = (
  context: unknown,
  request: OpenSearchDashboardsRequest,
  response: OpenSearchDashboardsResponseFactory,
) => unknown;

export interface IRouter {
  get(route: RouteConfig, handler: RequestHandler): void;
}

export interface CoreSetup {
  http: {
    basePath: {
      readonly serverBasePath: string;
      get(request: OpenSearchDashboardsRequest): string;
    };
    createRouter(): IRouter;
    registerOnPreRouting(handler: OnPreRoutingHandler): void;
    registerStaticDir(path: string, dirPath: string): void;
  };
}

export type CoreStart = object;

export interface Plugin<TSetup = void, TStart = void> {
  setup(core: CoreSetup, plugins: object): TSetup | Promise<TSetup>;
  start(core: CoreStart, plugins: object): TStart | Promise<TStart>;
  stop?(): void;
}

export interface PluginInitializerContext<ConfigSchema = unknown> {
  readonly logger: { get(...contextParts: string[]): Logger };
  readonly config: {
    create: <T = ConfigSchema>() => Observable<T>;
  };
}

export interface PluginConfigDescriptor<T = unknown> {
  schema: Type<T>;
  exposeToBrowser?: { [P in keyof T]?: boolean };
  deprecations?: unknown;
}
