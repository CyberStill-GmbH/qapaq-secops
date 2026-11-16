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
import {
  BRAND_ASSETS_PATH,
  MONITORING_CATEGORY_NAME,
  NAV_CATEGORY_NAME,
  QAPAQ_APPS,
  RESPOND_APP,
} from '../common';
import type { PublicConfigSchema } from '../config';
import { ChangeFeed } from './api/change_feed';
import { QapaqApiClient } from './api/client';
import { mountP1Watch } from './p1_watch';
import { registerNavigation } from './navigation';
import { renderMountFailure } from './render_failure';
import { QapaqzitoState, mountQapaqzitoPanel, registerQapaqzitoLauncher } from './qapaqzito/qapaqzito_panel';

/**
 * Plugin público de QAPAQ SecOps para OSD 2.19.6.
 *
 * - Registra la categoría «QAPAQ SOC» primera en el menú.
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
  private fontStylesheet: HTMLLinkElement | null = null;
  private stopQapaqzito: (() => void) | null = null;

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
      label: NAV_CATEGORY_NAME,
      order: -1000,
      euiIconType: core.http.basePath.prepend(`${BRAND_ASSETS_PATH}/qapaq-observability.svg`),
    };
    // «Monitoreo» justo debajo de «QAPAQ SOC»: la vigilancia en vivo (cola de alertas) separada
    // del resumen, que es la portada tras iniciar sesión.
    const monitoring = {
      id: 'qapaq-monitoring',
      label: MONITORING_CATEGORY_NAME,
      order: -999,
      euiIconType: core.http.basePath.prepend(`${BRAND_ASSETS_PATH}/qapaq-alerts.svg`),
    };
    for (const app of QAPAQ_APPS) {
      core.application.register({
        id: app.id,
        title: app.title,
        category: app.category === 'monitoring' ? monitoring : category,
        order: app.order,
        euiIconType: core.http.basePath.prepend(`${BRAND_ASSETS_PATH}/${app.icon}`),
        mount: async (params: AppMountParameters) => {
          try {
            const [{ renderApp }, [coreStart]] = await Promise.all([
              import('./application'),
              core.getStartServices(),
            ]);
            // OSD ya añade el título de la aplicación («QAPAQ SecOps») al final del documento.
            coreStart.chrome.docTitle.change(app.title);
            coreStart.chrome.setBreadcrumbs([{ text: app.title }]);
            const { api, feed } = this.shared(coreStart.http.basePath.get());
            const unmount = renderApp(coreStart, params, app.view, api, feed);
            return () => {
              unmount();
              coreStart.chrome.docTitle.reset();
            };
          } catch (error) {
            return renderMountFailure(params.element, error);
          }
        },
      });
    }
    // Menú del SIEM en categorías en español, apps sin servicio ocultas y accesos por proveedor.
    registerNavigation(core);
    // Ankay (SOAR) embebido: iframe del mismo origen dentro del chrome del dashboard.
    core.application.register({
      id: RESPOND_APP.id,
      title: RESPOND_APP.title,
      category,
      order: RESPOND_APP.order,
      euiIconType: core.http.basePath.prepend(`${BRAND_ASSETS_PATH}/${RESPOND_APP.icon}`),
      mount: async (params: AppMountParameters) => {
        try {
          const [{ renderRespondApp }, [coreStart]] = await Promise.all([
            import('./respond_app'),
            core.getStartServices(),
          ]);
          coreStart.chrome.docTitle.change(RESPOND_APP.title);
          coreStart.chrome.setBreadcrumbs([{ text: RESPOND_APP.title }]);
          const { api } = this.shared(coreStart.http.basePath.get());
          const unmount = renderRespondApp(coreStart, params, api);
          return () => {
            unmount();
            coreStart.chrome.docTitle.reset();
          };
        } catch (error) {
          return renderMountFailure(params.element, error);
        }
      },
    });
  }

  public start(core: CoreStart) {
    this.fontStylesheet = document.createElement('link');
    this.fontStylesheet.rel = 'stylesheet';
    this.fontStylesheet.href = core.http.basePath.prepend('/ui/qapaq/fonts/satoshi.css');
    this.fontStylesheet.dataset.qapaqTypography = 'satoshi';
    document.head.appendChild(this.fontStylesheet);
    const { api, feed } = this.shared(core.http.basePath.get());
    this.startQapaqzito(core, api);
    if (this.config.p1Watch === false) return;
    // Aviso de P1 en la cabecera: visible en todo el dashboard (también en el SIEM).
    this.stopWatch = mountP1Watch(core, api, feed);
  }

  private startQapaqzito(core: CoreStart, api: QapaqApiClient) {
    const state = new QapaqzitoState();
    // Qapaqzito's frontend stays available even when the AI provider has not been configured.
    const stopLauncher = registerQapaqzitoLauncher(core, state);
    const stopPanel = mountQapaqzitoPanel(core, api, state);
    this.stopQapaqzito = () => {
      stopPanel();
      stopLauncher();
    };
  }

  public stop() {
    this.stopQapaqzito?.();
    this.stopQapaqzito = null;
    this.fontStylesheet?.remove();
    this.fontStylesheet = null;
    this.stopWatch?.();
    this.feed?.stop();
  }
}
