/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

// Public client-facing types remain available at the plugin root. The runtime schema
// lives beside the server entry point so OpenSearch Dashboards bundles it in the .deb.
export type { ConfigSchema, PublicConfigSchema } from './server/config';
