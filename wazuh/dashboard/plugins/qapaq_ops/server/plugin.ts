/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'crypto';
import { schema } from '@osd/config-schema';
import { first } from 'rxjs/operators';
import type {
  CoreSetup,
  CoreStart,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '../../../src/core/server';
import type { ConfigSchema } from '../config';
import { LEGACY_LOGIN_PATHS, LOGIN_PATH, LOGOUT_PATH } from '../common';
import {
  loginContentSecurityPolicy,
  logoutContentSecurityPolicy,
  rawNextUrl,
  readSignInNotice,
  renderLoginPage,
  renderLogoutPage,
} from './login_page';

const NO_STORE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export class QapaqOpsServerPlugin implements Plugin<void, void> {
  private readonly logger: Logger;

  constructor(private readonly initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
  }

  public async setup(core: CoreSetup) {
    const config = await this.initializerContext.config
      .create<ConfigSchema>()
      .pipe(first())
      .toPromise();
    if (!config.enabled || !config.login.enabled) return;

    const basePath = core.http.basePath.serverBasePath;
    const router = core.http.createRouter();

    // El login de Wazuh / Security plugin deja de existir: cualquier navegación a él
    // (redirect por sesión ausente, enlace antiguo, logout) llega al login QAPAQ.
    core.http.registerOnPreRouting((request, _response, toolkit) => {
      if (request.route.method !== 'get' || !LEGACY_LOGIN_PATHS.includes(request.url.pathname)) {
        return toolkit.next();
      }
      // Se conserva la query (`nextUrl`, `authError`…); `request.url` es un URL WHATWG en 2.19.
      return toolkit.rewriteUrl(`${LOGIN_PATH}${request.url.search}`);
    });

    router.get(
      {
        path: LOGIN_PATH,
        validate: { query: schema.object({}, { unknowns: 'allow' }) },
        options: { authRequired: false, xsrfRequired: false },
      },
      async (_context, request, response) => {
        const query = { ...(request.query as Record<string, unknown>) };
        const raw = rawNextUrl(request.url.search);
        if (raw !== undefined) query.nextUrl = raw;
        const { nextUrl, notice } = readSignInNotice(
          query,
          `${basePath}${config.login.defaultNextUrl}`,
          config.apiPrefix,
        );
        const nonce = randomBytes(16).toString('base64');
        return response.ok({
          body: renderLoginPage({
            basePath,
            apiPrefix: config.apiPrefix,
            nextUrl,
            notice,
            nonce,
            destinationLabel: config.login.destinationLabel,
          }),
          headers: {
            ...NO_STORE_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': loginContentSecurityPolicy(nonce),
          },
        });
      },
    );

    router.get(
      {
        path: LOGOUT_PATH,
        validate: false,
        options: { authRequired: false, xsrfRequired: false },
      },
      async (_context, _request, response) => {
        const nonce = randomBytes(16).toString('base64');
        return response.ok({
          body: renderLogoutPage({ basePath, apiPrefix: config.apiPrefix, nonce }),
          headers: {
            ...NO_STORE_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': logoutContentSecurityPolicy(nonce),
          },
        });
      },
    );

    this.logger.info(
      `Login QAPAQ activo en ${basePath}${LOGIN_PATH}; ${LEGACY_LOGIN_PATHS.join(', ')} redirigen aquí`,
    );
  }

  public start(_core: CoreStart) {}

  public stop() {}
}
