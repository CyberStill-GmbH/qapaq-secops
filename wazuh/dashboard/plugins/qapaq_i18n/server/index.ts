/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * `qapaq_i18n.*` en opensearch_dashboards.yml. `qapaq_i18n.enabled: false` desactiva el
 * plugin completo (OSD no lo carga); además se expone al navegador por claridad.
 */

import { schema, TypeOf } from '@osd/config-schema';

export const configSchema = schema.object({
  enabled: schema.boolean({ defaultValue: true }),
});

export type QapaqI18nConfig = TypeOf<typeof configSchema>;

export const config = {
  schema: configSchema,
  exposeToBrowser: { enabled: true },
};

class QapaqI18nServerPlugin {
  public setup() {
    return {};
  }
  public start() {
    return {};
  }
  public stop() {}
}

export function plugin() {
  return new QapaqI18nServerPlugin();
}
