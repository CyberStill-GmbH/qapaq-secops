/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { PluginInitializerContext } from '../../../src/core/public';
import type { PublicConfigSchema } from '../config';
import './theme.scss';
import './index.scss';
import { QapaqOpsPublicPlugin } from './plugin';

export function plugin(initializerContext: PluginInitializerContext<PublicConfigSchema>) {
  return new QapaqOpsPublicPlugin(initializerContext);
}
