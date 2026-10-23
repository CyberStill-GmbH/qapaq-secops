/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import type { DirectoryUser } from './api_contract';

const ONLINE_WINDOW_MS = 30 * 60 * 1000;

export const ROLE_ORIGIN_LABEL: Record<string, string> = {
  group_owner: 'Dueño del grupo',
  admin_group: 'Grupo administrador',
  qapaq_assignment: 'Asignación aprobada por QAPAQ',
  deploy_binding: 'Asignación del despliegue',
  entra_app_role: 'Rol de aplicación en Entra',
  none: 'Sin acceso asignado',
};

export interface UserState {
  readonly tone: 'ok' | 'warn' | 'fail' | 'neutral';
  readonly label: string;
}

/**
 * Estado operativo de una persona, del más grave al más leve: la cuenta deshabilitada en Entra
 * o la salida del grupo Accesos_SOC mandan sobre la actividad; luego la falta de rol; y por
 * último la actividad de sus sesiones (en línea = sesión activa vista en los últimos 30 min).
 */
export function userState(user: DirectoryUser, now: number = Date.now()): UserState {
  if (user.accountEnabled === false) return { tone: 'fail', label: 'Deshabilitada en Entra' };
  if (user.membership === 'removed') return { tone: 'fail', label: 'Fuera del grupo' };
  if (user.roleOrigin === 'none' || user.roles.length === 0)
    return { tone: 'warn', label: 'Sin rol' };
  if (user.activeSessions > 0) {
    const seen = user.lastSeenAt ? Date.parse(user.lastSeenAt) : NaN;
    if (!Number.isNaN(seen) && now - seen <= ONLINE_WINDOW_MS)
      return { tone: 'ok', label: 'En línea' };
    return { tone: 'neutral', label: 'Inactiva' };
  }
  return { tone: 'neutral', label: 'Sin sesión' };
}
