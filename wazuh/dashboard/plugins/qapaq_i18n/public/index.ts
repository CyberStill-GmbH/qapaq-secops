/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { QapaqI18nInitializerContext, QapaqI18nPlugin } from './plugin';

export function plugin(initializerContext: QapaqI18nInitializerContext) {
  return new QapaqI18nPlugin(initializerContext);
}
