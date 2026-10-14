/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type {
  AppMountParameters,
  CoreSetup,
  CoreStart,
  Plugin,
  PluginInitializerContext,
} from '../../../src/core/public';
import { BRAND_ASSETS_PATH, PLUGIN_NAME, QAPAQ_APPS } from '../common';
import type { PublicConfigSchema } from '../config';
import { ChangeFeed } from './api/change_feed';
import { QapaqApiClient } from './api/client';
import { mountP1Watch } from './p1_watch';

/**
 * Plugin público de QAPAQ SecOps para OSD 2.19.6.
 *
 * - Registra la categoría «QAPAQ SecOps» primera en el menú (la de Wazuh empieza en 0).
 * - Un único cliente de API y un único long-poll de `/api/changes` por página del dashboard,
 *   compartidos por todas las apps QAPAQ y por el aviso de P1 de la cabecera.
 * - No importa valores del core en tiempo de ejecución (solo tipos): el plugin no depende de
 *   rutas internas de OSD y sobrevive a cambios de versión de Wazuh.
 */
export class QapaqOpsPublicPlugin implements Plugin<void, void> {
  private readonly config: PublicConfigSchema;
  private api: QapaqApiClient | null = null;
  private feed: ChangeFeed | null = null;
  private stopWatch: (() => void) | null = null;

  constructor(initializerContext: PluginInitializerContext<PublicConfigSchema>) {
    this.config = initializerContext.config.get();
  }

  private shared(basePath: string): { api: QapaqApiClient; feed: ChangeFeed } {
    if (!this.api || !this.feed) {
      this.api = new QapaqApiClient({
        apiPrefix: this.config.apiPrefix,
        basePath,
        redirect: (url) => window.location.assign(url),
      });
      this.feed = new ChangeFeed(this.api);
    }
    return { api: this.api, feed: this.feed };
  }

  public setup(core: CoreSetup) {
    const category = {
      id: 'qapaq-secops',
      label: PLUGIN_NAME,
      order: -1000,
      euiIconType: core.http.basePath.prepend(`${BRAND_ASSETS_PATH}/qapaq_mark_on_dark.svg`),
    };
    for (const app of QAPAQ_APPS) {
      core.application.register({
        id: app.id,
        title: app.title,
        category,
        order: app.order,
        mount: async (params: AppMountParameters) => {
          const [{ renderApp }, [coreStart]] = await Promise.all([
            import('./application'),
            core.getStartServices(),
          ]);
          coreStart.chrome.docTitle.change([app.title, PLUGIN_NAME]);
          const { api, feed } = this.shared(coreStart.http.basePath.get());
          const unmount = renderApp(coreStart, params, app.view, api, feed);
          return () => {
            unmount();
            coreStart.chrome.docTitle.reset();
          };
        },
      });
    }
  }

  public start(core: CoreStart) {
    if (this.config.p1Watch === false) return;
    const { api, feed } = this.shared(core.http.basePath.get());
    // Aviso de P1 en la cabecera: visible en todo el dashboard (también en el SIEM).
    this.stopWatch = mountP1Watch(core, api, feed);
  }

  public stop() {
    this.stopWatch?.();
    this.feed?.stop();
  }
}
