/**
 * D-10b — referencias opacas de entidad.
 *
 * Una URL no debe llevar UPN ni IP: queda en el historial del navegador, en la barra de
 * direcciones y en cualquier proxy que registre la query. La consola pivota por
 * `ent_<22 caracteres>`, un HMAC-SHA256 con clave secreta y separado por tenant: la misma
 * entidad en dos tenants produce referencias distintas, y sin la clave no se puede
 * comprobar a qué UPN corresponde (el espacio de UPN es pequeño; un hash sin clave sí se
 * podría revertir por fuerza bruta).
 *
 * 22 caracteres base64url = 132 bits: colisión despreciable para el volumen de un tenant.
 */

import { createHmac } from 'node:crypto';

import type { EntityRefFactory } from '@qapaq/soc';

export const ENTITY_REF_PATTERN = /^ent_[A-Za-z0-9_-]{22}$/u;

export function entityRefFactory(key: string): EntityRefFactory {
  return (tenantId, entityKey) =>
    `ent_${createHmac('sha256', key)
      .update(`${tenantId}\u0000${entityKey}`, 'utf8')
      .digest('base64url')
      .slice(0, 22)}`;
}
