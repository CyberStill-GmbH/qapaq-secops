/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { schema, TypeOf } from '@osd/config-schema';
import { DECLARED_STATES } from '../common/integrations';

/**
 * Estado declarado de una integración (`qapaq_ops.integrations.<id>`). `auto` deja que lo
 * decidan los datos; `blocked` exige `missingPermissions` o `note` con el siguiente paso.
 */
const integration = (
  defaults: {
    state?: (typeof DECLARED_STATES)[number];
    missingPermissions?: string[];
    note?: string;
  } = {},
) =>
  schema.object({
    state: schema.oneOf(
      [
        schema.literal('auto'),
        schema.literal('blocked'),
        schema.literal('disabled'),
        schema.literal('pending'),
      ],
      { defaultValue: defaults.state ?? 'auto' },
    ),
    missingPermissions: schema.arrayOf(schema.string({ maxLength: 120 }), {
      defaultValue: defaults.missingPermissions ?? [],
      maxSize: 10,
    }),
    note: schema.string({ defaultValue: defaults.note ?? '', maxLength: 500 }),
  });

/**
 * `qapaq_ops.*` en `opensearch_dashboards.yml`.
 *
 * El dashboard no tiene login propio: confía en la sesión de QAPAQ SecOps (BFF con
 * Microsoft Entra ID y admisión por el grupo Accesos_SOC). El proxy de borde valida esa
 * sesión con `GET {apiPrefix}/auth/introspect` y la entrega al Security plugin como
 * *proxy auth* (ver qapaq-secops-unified/wazuh/edge/qapaq-edge.conf).
 */
export const configSchema = schema.object({
  enabled: schema.boolean({ defaultValue: true }),
  /**
   * Prefijo público de la API de QAPAQ en el mismo origen que el dashboard. El navegador
   * llama a la API directamente (cookie `qapaq_session` + `x-csrf-token`), sin CORS.
   */
  apiPrefix: schema.string({
    defaultValue: '/api',
    validate: (value: string) =>
      /^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/u.test(value) && !value.includes('//')
        ? undefined
        : 'apiPrefix debe ser una ruta absoluta del mismo origen, sin barra final',
  }),
  /** Aviso de nuevas alertas P1 en la cabecera (todo el dashboard). */
  p1Watch: schema.boolean({ defaultValue: true }),
  /** Qapaqzito launcher is always visible; the API controls whether chat can answer. */
  qapaqzito: schema.object({ enabled: schema.boolean({ defaultValue: true }) }),
  login: schema.object({
    /** Sirve el login QAPAQ y sustituye `/app/login` del Security plugin / Wazuh. */
    enabled: schema.boolean({ defaultValue: true }),
    /** Destino tras iniciar sesión cuando no hay `nextUrl`. */
    defaultNextUrl: schema.string({ defaultValue: '/app/qapaq-overview' }),
    /** Muestra el formulario de usuario y contraseña junto al acceso con Entra. */
    passwordEnabled: schema.boolean({ defaultValue: true }),
    /**
     * Muestra «Continuar con Microsoft Entra». Desactivarlo cuando el despliegue no tiene un
     * tenant real: el formulario lleva directo al dashboard del SIEM sin pasos intermedios.
     */
    entraEnabled: schema.boolean({ defaultValue: true }),
    /** Texto de la barra superior del login («Estás iniciando sesión en …»). */
    destinationLabel: schema.string({ defaultValue: 'QAPAQ' }),
  }),
  /**
   * Estado declarado de las integraciones para «Resumen del SOC» e «Integraciones». Lo que no
   * se puede medir en el Indexer (un permiso de Entra que falta, un servicio no contratado) se
   * declara aquí; el resto lo deciden los datos (`auto`).
   */
  integrations: schema.object({
    wazuh: integration(),
    office365: integration(),
    sharepoint: integration(),
    bitdefender: integration(),
    snyk: integration(),
    cloudflare: integration(),
    aws: integration(),
    respond: integration(),
    qapaqzito: integration(),
    alertMail: integration(),
  }),
});

export type ConfigSchema = TypeOf<typeof configSchema>;
export type PublicConfigSchema = Pick<ConfigSchema, 'apiPrefix' | 'p1Watch' | 'qapaqzito'>;
