/**
 * C-18 — autorización contextual por recurso y por campo.
 *
 * Dos preguntas distintas que no se responden con el mismo permiso:
 *
 * - *¿puede ejecutar esta acción sobre este recurso?* — depende de la capability y del
 *   contexto del recurso (tenant, asignación, estado);
 * - *¿qué campos de la respuesta puede ver?* — depende de capabilities adicionales.
 *
 * Una denegación siempre lleva motivo auditable, y la decisión es completa: no existe
 * "permitido salvo que la UI lo oculte". La UI no sustituye esta función.
 */

import type { Capability } from './capabilities.js';

export const ACCESS_DECISION_REASONS = [
  'CAPABILITY_MISSING',
  'TENANT_MISMATCH',
  'SESSION_INVALID',
  'RESOURCE_NOT_ASSIGNED',
  'RESOURCE_CLOSED',
  'NETWORK_NOT_ALLOWED',
  'SCOPE_MISSING',
] as const;
export type AccessDecisionReason = (typeof ACCESS_DECISION_REASONS)[number];

export interface Actor {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly roles: readonly string[];
}

export interface ResourceContext {
  readonly type: string;
  readonly id: string;
  readonly tenantId: string;
  readonly assigneeId?: string | null;
  readonly closed?: boolean;
}

export interface AuthorizationRequestContext {
  readonly actor: Actor;
  readonly capability: Capability;
  readonly resource: ResourceContext;
  /** `true` para acciones que exigen ser la persona asignada (triaje de una alerta tomada). */
  readonly requiresAssignment?: boolean;
  /** `true` para escrituras que no tienen sentido sobre un recurso cerrado. */
  readonly rejectWhenClosed?: boolean;
}

export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AccessDecisionReason; readonly detail: string };

function deny(reason: AccessDecisionReason, detail: string): AccessDecision {
  return { allowed: false, reason, detail };
}

export function authorize(request: AuthorizationRequestContext): AccessDecision {
  const { actor, resource } = request;
  if (!actor.sessionId || !actor.subjectId) {
    return deny('SESSION_INVALID', 'La petición no lleva una sesión resuelta.');
  }
  // El tenant se comprueba antes que la capability: así una capability válida nunca
  // confirma la existencia de un recurso de otro tenant.
  if (actor.tenantId !== resource.tenantId) {
    return deny('TENANT_MISMATCH', `${resource.type} pertenece a otro tenant.`);
  }
  if (!actor.capabilities.has(request.capability)) {
    return deny('CAPABILITY_MISSING', `Falta ${request.capability}.`);
  }
  if (request.rejectWhenClosed && resource.closed) {
    return deny('RESOURCE_CLOSED', `${resource.type} ${resource.id} está cerrado.`);
  }
  if (request.requiresAssignment && resource.assigneeId !== actor.subjectId) {
    return deny('RESOURCE_NOT_ASSIGNED', `${resource.type} ${resource.id} no está asignado.`);
  }
  return { allowed: true };
}

/** Campos que solo se proyectan con una capability adicional explícita. */
export const FIELD_CAPABILITIES: Readonly<Record<string, Capability>> = Object.freeze({
  raw: 'events.read_raw',
  rawRef: 'events.read_raw',
  'actor.ip': 'audit.read_sensitive',
  'actor.sessionId': 'audit.read_sensitive',
});

export function visibleFields(
  fields: readonly string[],
  capabilities: ReadonlySet<Capability>,
): readonly string[] {
  return fields.filter((field) => {
    const required = FIELD_CAPABILITIES[field];
    return required === undefined || capabilities.has(required);
  });
}

/**
 * Proyecta un objeto dejando fuera los campos no autorizados. Omitir es deliberado
 * frente a enmascarar: en una respuesta de negocio, un `null` ya informa de que el campo
 * existe (C-27 trata la no enumeración en los errores).
 */
export function projectFields<T extends Record<string, unknown>>(
  value: T,
  capabilities: ReadonlySet<Capability>,
): Partial<T> {
  const allowed = new Set(visibleFields(Object.keys(value), capabilities));
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => allowed.has(key)),
  ) as Partial<T>;
}
