import type { SecretReference } from '../secrets/index.js';
import type { SecretActor } from './secret-lifecycle.types.js';

/**
 * Catálogo completo de capabilities del ciclo de vida de secretos.
 * `integration.secret.rotate` ya estaba declarada como crítica en
 * `docs/architecture/identity-and-authorization.md`; las demás siguen su patrón y
 * quedan sujetas a la decisión abierta U-013.
 *
 * No existe una capability de lectura de valor y no debe añadirse: la operación que
 * autorizaría tampoco existe en ningún puerto.
 */
export const SECRET_CAPABILITIES = Object.freeze({
  create: 'integration.secret.create',
  rotate: 'integration.secret.rotate',
  revoke: 'integration.secret.revoke',
  readMetadata: 'integration.secret.metadata.read',
} as const);

export type SecretCapability = (typeof SECRET_CAPABILITIES)[keyof typeof SECRET_CAPABILITIES];

export interface SecretAuthorizationRequest {
  readonly actor: SecretActor;
  readonly capability: SecretCapability;
  readonly reference: SecretReference;
  readonly correlationId: string;
}

/**
 * Decisión de autorización. Es un puerto porque `modules/access` y su PolicyGuard
 * llegan en C-18: el control plane exige la decisión, no la implementa, y deniega
 * por defecto ante cualquier resultado que no sea una concesión explícita.
 */
export interface SecretAuthorizer {
  authorize(request: SecretAuthorizationRequest): Promise<boolean>;
}

/** Autorizador de último recurso: deniega todo. Es el valor por defecto seguro. */
export const denyAllSecretAuthorizer: SecretAuthorizer = Object.freeze({
  authorize: async (): Promise<boolean> => false,
});
