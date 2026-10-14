/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { compileGlossary, GlossaryFile } from '../common/translate';
import { DomTranslator } from './dom_translator';
import glossaryJson from './glossary.es.json';

/** Interfaz mínima del contexto de OSD: sin importar el core (sin acoplamiento al árbol). */
export interface QapaqI18nInitializerContext {
  config: { get<T = { enabled?: boolean }>(): T };
}

export const LOCAL_OFF_FLAG = 'qapaq.i18n.off';

function disabledInThisBrowser(): boolean {
  try {
    return window.localStorage.getItem(LOCAL_OFF_FLAG) === '1';
  } catch {
    return false;
  }
}

export class QapaqI18nPlugin {
  private translator: DomTranslator | null = null;

  constructor(private readonly ctx: QapaqI18nInitializerContext) {}

  public setup(): Record<string, never> {
    return {};
  }

  public start(): Record<string, never> {
    let enabled = true;
    try {
      enabled = this.ctx.config.get<{ enabled?: boolean }>().enabled !== false;
    } catch {
      enabled = true;
    }
    if (!enabled || disabledInThisBrowser() || typeof document === 'undefined') return {};
    this.translator = new DomTranslator(compileGlossary(glossaryJson as unknown as GlossaryFile));
    this.translator.start();
    return {};
  }

  public stop(): void {
    // Vida de la página: no se restaura nada.
  }
}
