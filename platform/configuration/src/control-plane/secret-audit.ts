import type { SecretReference } from '../secrets/index.js';
import type { SecretFingerprint } from './secret-fingerprint.js';
import type {
  SecretControlPlaneErrorCode,
  SecretLifecycleOperation,
} from './secret-lifecycle.errors.js';
import type { SecretActor } from './secret-lifecycle.types.js';

export const SECRET_AUDIT_ACTIONS = [
  'integration.secret.created.v1',
  'integration.secret.rotated.v1',
  'integration.secret.revoked.v1',
  'integration.secret.denied.v1',
  'integration.secret.failed.v1',
] as const;

export type SecretAuditAction = (typeof SECRET_AUDIT_ACTIONS)[number];

/**
 * Evento de auditoría del ciclo de vida. Los campos siguen `docs/architecture/audit.md`.
 * `beforeFingerprint`/`afterFingerprint` sustituyen cualquier snapshot del valor: son
 * la única representación admitida de un cambio de material secreto.
 */
export interface SecretAuditEvent {
  readonly action: SecretAuditAction;
  readonly capability: string;
  readonly actorType: SecretActor['actorType'];
  readonly actorId: string;
  readonly resourceType: 'integration_secret';
  readonly resourceId: string;
  readonly reference: SecretReference;
  readonly decision: 'allow' | 'deny';
  readonly outcome: 'success' | 'failure';
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly correlationId: string;
  readonly version?: number;
  readonly beforeFingerprint?: SecretFingerprint;
  readonly afterFingerprint?: SecretFingerprint;
  readonly errorCode?: SecretControlPlaneErrorCode;
  readonly operation: SecretLifecycleOperation;
}

/**
 * Registro de intentos no persistentes: denegaciones y fallos que no mutan estado.
 * `docs/architecture/audit.md` los separa del trail transaccional, por lo que el
 * control plane los emite fuera de la transacción de metadata.
 */
export interface SecretAuditSink {
  record(event: SecretAuditEvent): Promise<void>;
}
