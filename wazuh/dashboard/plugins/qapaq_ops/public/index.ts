/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { PluginInitializerContext } from '../../../src/core/public';
import type { PublicConfigSchema } from '../config';
import './theme.scss';
import './index.scss';
import './qapaqzito/qapaqzito.scss';
import './overview.scss';
import './investigation.scss';
import './investigation_activity_groups.scss';
import './ai_analyst.scss';
import { QapaqOpsPublicPlugin } from './plugin';

export function plugin(initializerContext: PluginInitializerContext<PublicConfigSchema>) {
  return new QapaqOpsPublicPlugin(initializerContext);
}
