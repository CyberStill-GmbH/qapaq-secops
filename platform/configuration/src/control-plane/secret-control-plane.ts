import type { SecretReference } from '../secrets/index.js';
import {
  SECRET_CAPABILITIES,
  type SecretAuthorizer,
  type SecretCapability,
} from './secret-authorization.port.js';
import {
  namespaceOf,
  validateContext,
  validateExpiry,
  validateLabels,
  validateOwner,
  validatePurpose,
  validateReference,
} from './secret-command.validation.js';
import type { SecretAuditAction, SecretAuditEvent, SecretAuditSink } from './secret-audit.js';
import type { SecretFingerprint, SecretFingerprintKey } from './secret-fingerprint.js';
import { newSecretMetadataId } from './secret-id.js';
import {
  SecretControlPlaneError,
  secretControlPlaneError,
  type SecretControlPlaneErrorCode,
  type SecretLifecycleOperation,
} from './secret-lifecycle.errors.js';
import {
  deriveLifecycleView,
  toMetadataView,
  type SecretLabels,
  type SecretMetadata,
  type SecretMetadataView,
  type SecretOperationContext,
} from './secret-lifecycle.types.js';
import { SecretStoreError, type SecretMetadataStore } from './secret-metadata-store.port.js';
import { SecretWriterError, type SecretWriter } from './secret-writer.port.js';
import type { SubmittedSecret } from './submitted-secret.js';

export interface CreateSecretCommand {
  readonly reference: SecretReference | string;
  readonly secret: SubmittedSecret;
  readonly purpose: string;
  readonly owner: string;
  readonly labels?: SecretLabels;
  readonly expiresAt?: Date;
  readonly context: SecretOperationContext;
  readonly signal?: AbortSignal;
}

export interface RotateSecretCommand {
  readonly reference: SecretReference | string;
  readonly secret: SubmittedSecret;
  readonly expiresAt?: Date;
  readonly context: SecretOperationContext;
  readonly signal?: AbortSignal;
}

export interface RevokeSecretCommand {
  readonly reference: SecretReference | string;
  readonly context: SecretOperationContext;
  readonly signal?: AbortSignal;
}

export interface ReadSecretMetadataQuery {
  readonly reference: SecretReference | string;
  readonly context: SecretOperationContext;
}

export interface SecretControlPlaneDependencies {
  readonly writer: SecretWriter;
  readonly store: SecretMetadataStore;
  readonly authorizer: SecretAuthorizer;
  readonly auditSink: SecretAuditSink;
  readonly fingerprintKey: SecretFingerprintKey;
}

const WRITER_ERRORS: Readonly<Record<string, SecretControlPlaneErrorCode>> = Object.freeze({
  WRITER_REJECTED: 'SECRET_PROVIDER_REJECTED',
  WRITER_UNREACHABLE: 'SECRET_PROVIDER_UNREACHABLE',
  WRITER_VERSION_CONFLICT: 'SECRET_ROTATION_CONFLICT',
  WRITER_OUTCOME_UNKNOWN: 'SECRET_RECONCILIATION_REQUIRED',
});

const STORE_ERRORS: Readonly<Record<string, SecretControlPlaneErrorCode>> = Object.freeze({
  STORE_DUPLICATE: 'SECRET_ALREADY_REGISTERED',
  STORE_NOT_FOUND: 'SECRET_NOT_REGISTERED',
  STORE_REVISION_CONFLICT: 'SECRET_ROTATION_CONFLICT',
  STORE_AUDIT_UNAVAILABLE: 'SECRET_AUDIT_WRITE_REQUIRED',
  STORE_UNAVAILABLE: 'SECRET_RECONCILIATION_REQUIRED',
});

/**
 * Control plane write-only del ciclo de vida de credenciales de integración.
 *
 * Invariante estructural: no expone ninguna operación de lectura de valor y no
 * depende de `SecretProvider`, el puerto que sí resuelve material en runtime. El
 * material recibido se consume dentro de una única función y nunca se asigna a
 * metadata, evento de auditoría, error ni valor de retorno.
 */
export class SecretControlPlane {
  readonly #writer: SecretWriter;
  readonly #store: SecretMetadataStore;
  readonly #authorizer: SecretAuthorizer;
  readonly #auditSink: SecretAuditSink;
  readonly #fingerprintKey: SecretFingerprintKey;

  public constructor(dependencies: SecretControlPlaneDependencies) {
    this.#writer = dependencies.writer;
    this.#store = dependencies.store;
    this.#authorizer = dependencies.authorizer;
    this.#auditSink = dependencies.auditSink;
    this.#fingerprintKey = dependencies.fingerprintKey;
  }

  public async createSecret(command: CreateSecretCommand): Promise<SecretMetadataView> {
    const context = validateContext(command.context);
    const reference = validateReference(command.reference);
    await this.#authorize(reference, SECRET_CAPABILITIES.create, context, 'create');

    const purpose = validatePurpose(command.purpose);
    const owner = validateOwner(command.owner);
    const labels = validateLabels(command.labels);
    const expiresAt = validateExpiry(command.expiresAt, context.occurredAt);

    const replay = await this.#replay(context, 'create');
    if (replay !== undefined) return replay;

    const existing = await this.#load(reference, 'create');
    if (existing !== undefined)
      throw await this.#fail('SECRET_ALREADY_REGISTERED', reference, context, 'create');

    const { receipt, fingerprint } = await this.#write(command.secret, (plaintext) =>
      this.#writer.create({
        reference,
        plaintext,
        idempotencyKey: context.requestId,
        ...(command.signal === undefined ? {} : { signal: command.signal }),
      }),
    ).catch(async (error: unknown) => {
      throw await this.#failFromWriter(error, reference, context, 'create');
    });

    const audit = this.#auditEvent({
      action: 'integration.secret.created.v1',
      capability: SECRET_CAPABILITIES.create,
      reference,
      context,
      operation: 'create',
      decision: 'allow',
      outcome: 'success',
      version: receipt.version,
      afterFingerprint: fingerprint,
    });

    const metadata = await this.#store
      .register(
        {
          id: newSecretMetadataId(context.occurredAt),
          reference,
          namespace: namespaceOf(reference),
          purpose,
          provider: this.#writer.providerId,
          owner,
          version: receipt.version,
          fingerprint,
          labels,
          createdAt: context.occurredAt,
          createdBy: context.actor.actorId,
          requestId: context.requestId,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        audit,
      )
      .catch(async (error: unknown) => {
        throw await this.#failFromStore(error, reference, context, 'create');
      });

    return toMetadataView(metadata, context.occurredAt);
  }

  public async rotateSecret(command: RotateSecretCommand): Promise<SecretMetadataView> {
    const context = validateContext(command.context);
    const reference = validateReference(command.reference);
    await this.#authorize(reference, SECRET_CAPABILITIES.rotate, context, 'rotate');
    const expiresAt = validateExpiry(command.expiresAt, context.occurredAt);

    const replay = await this.#replay(context, 'rotate');
    if (replay !== undefined) return replay;

    const current = await this.#require(reference, context, 'rotate');
    if (deriveLifecycleView(current, context.occurredAt) !== 'active')
      throw await this.#fail('SECRET_NOT_ACTIVE', reference, context, 'rotate');

    const { receipt, fingerprint } = await this.#write(command.secret, (plaintext) =>
      this.#writer.rotate({
        reference,
        plaintext,
        currentVersion: current.version,
        idempotencyKey: context.requestId,
        ...(command.signal === undefined ? {} : { signal: command.signal }),
      }),
    ).catch(async (error: unknown) => {
      throw await this.#failFromWriter(error, reference, context, 'rotate');
    });

    const audit = this.#auditEvent({
      action: 'integration.secret.rotated.v1',
      capability: SECRET_CAPABILITIES.rotate,
      reference,
      context,
      operation: 'rotate',
      decision: 'allow',
      outcome: 'success',
      version: receipt.version,
      beforeFingerprint: current.fingerprint,
      afterFingerprint: fingerprint,
    });

    const metadata = await this.#store
      .rotate(
        {
          reference,
          expectedRevision: current.revision,
          version: receipt.version,
          fingerprint,
          rotatedAt: context.occurredAt,
          rotatedBy: context.actor.actorId,
          requestId: context.requestId,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        audit,
      )
      .catch(async (error: unknown) => {
        throw await this.#failFromStore(error, reference, context, 'rotate');
      });

    return toMetadataView(metadata, context.occurredAt);
  }

  public async revokeSecret(command: RevokeSecretCommand): Promise<SecretMetadataView> {
    const context = validateContext(command.context);
    const reference = validateReference(command.reference);
    await this.#authorize(reference, SECRET_CAPABILITIES.revoke, context, 'revoke');

    const replay = await this.#replay(context, 'revoke');
    if (replay !== undefined) return replay;

    const current = await this.#require(reference, context, 'revoke');
    if (current.status !== 'active')
      throw await this.#fail('SECRET_NOT_ACTIVE', reference, context, 'revoke');

    await this.#writer
      .revoke({
        reference,
        version: current.version,
        idempotencyKey: context.requestId,
        ...(command.signal === undefined ? {} : { signal: command.signal }),
      })
      .catch(async (error: unknown) => {
        throw await this.#failFromWriter(error, reference, context, 'revoke');
      });

    const audit = this.#auditEvent({
      action: 'integration.secret.revoked.v1',
      capability: SECRET_CAPABILITIES.revoke,
      reference,
      context,
      operation: 'revoke',
      decision: 'allow',
      outcome: 'success',
      version: current.version,
      beforeFingerprint: current.fingerprint,
    });

    const metadata = await this.#store
      .revoke(
        {
          reference,
          expectedRevision: current.revision,
          revokedAt: context.occurredAt,
          revokedBy: context.actor.actorId,
          requestId: context.requestId,
        },
        audit,
      )
      .catch(async (error: unknown) => {
        throw await this.#failFromStore(error, reference, context, 'revoke');
      });

    return toMetadataView(metadata, context.occurredAt);
  }

  /** Devuelve metadata. No existe una variante que devuelva el valor. */
  public async readMetadata(query: ReadSecretMetadataQuery): Promise<SecretMetadataView> {
    const context = validateContext(query.context);
    const reference = validateReference(query.reference);
    await this.#authorize(reference, SECRET_CAPABILITIES.readMetadata, context, 'readMetadata');
    const metadata = await this.#require(reference, context, 'readMetadata');
    return toMetadataView(metadata, context.occurredAt);
  }

  /**
   * Único punto donde el material existe. Calcula el fingerprint y delega la
   * escritura dentro de la misma llamada a `use`, que quema el portador: el
   * plaintext no sobrevive al retorno ni queda accesible para un reintento.
   */
  async #write(
    secret: SubmittedSecret,
    write: (plaintext: string) => Promise<{ readonly version: number }>,
  ): Promise<{
    readonly receipt: { readonly version: number };
    readonly fingerprint: SecretFingerprint;
  }> {
    if (!(secret instanceof Object) || typeof secret.use !== 'function')
      throw secretControlPlaneError('SECRET_REQUEST_INVALID', 'secret');
    return secret.use(async (plaintext) => {
      const fingerprint = this.#fingerprintKey.compute(plaintext);
      const receipt = await write(plaintext);
      return { receipt, fingerprint };
    });
  }

  async #authorize(
    reference: SecretReference,
    capability: SecretCapability,
    context: SecretOperationContext,
    operation: SecretLifecycleOperation,
  ): Promise<void> {
    let granted = false;
    try {
      granted = await this.#authorizer.authorize({
        actor: context.actor,
        capability,
        reference,
        correlationId: context.correlationId,
      });
    } catch {
      granted = false;
    }
    if (granted === true) return;
    await this.#record(
      this.#auditEvent({
        action: 'integration.secret.denied.v1',
        capability,
        reference,
        context,
        operation,
        decision: 'deny',
        outcome: 'failure',
        errorCode: 'SECRET_AUTHORIZATION_DENIED',
      }),
    );
    throw secretControlPlaneError('SECRET_AUTHORIZATION_DENIED', 'actor');
  }

  async #replay(
    context: SecretOperationContext,
    operation: SecretLifecycleOperation,
  ): Promise<SecretMetadataView | undefined> {
    const previous = await this.#store.findByRequestId(context.requestId).catch(() => {
      throw secretControlPlaneError('SECRET_OPERATION_FAILED', operation);
    });
    return previous === undefined ? undefined : toMetadataView(previous, context.occurredAt);
  }

  async #load(
    reference: SecretReference,
    operation: SecretLifecycleOperation,
  ): Promise<SecretMetadata | undefined> {
    return this.#store.findByReference(reference).catch(() => {
      throw secretControlPlaneError('SECRET_OPERATION_FAILED', operation);
    });
  }

  async #require(
    reference: SecretReference,
    context: SecretOperationContext,
    operation: SecretLifecycleOperation,
  ): Promise<SecretMetadata> {
    const metadata = await this.#load(reference, operation);
    if (metadata === undefined)
      throw await this.#fail('SECRET_NOT_REGISTERED', reference, context, operation);
    return metadata;
  }

  #auditEvent(input: {
    readonly action: SecretAuditAction;
    readonly capability: string;
    readonly reference: SecretReference;
    readonly context: SecretOperationContext;
    readonly operation: SecretLifecycleOperation;
    readonly decision: 'allow' | 'deny';
    readonly outcome: 'success' | 'failure';
    readonly version?: number;
    readonly beforeFingerprint?: SecretFingerprint;
    readonly afterFingerprint?: SecretFingerprint;
    readonly errorCode?: SecretControlPlaneErrorCode;
  }): SecretAuditEvent {
    return Object.freeze({
      action: input.action,
      capability: input.capability,
      actorType: input.context.actor.actorType,
      actorId: input.context.actor.actorId,
      resourceType: 'integration_secret' as const,
      resourceId: input.reference,
      reference: input.reference,
      decision: input.decision,
      outcome: input.outcome,
      occurredAt: input.context.occurredAt,
      requestId: input.context.requestId,
      correlationId: input.context.correlationId,
      operation: input.operation,
      ...(input.version === undefined ? {} : { version: input.version }),
      ...(input.beforeFingerprint === undefined
        ? {}
        : { beforeFingerprint: input.beforeFingerprint }),
      ...(input.afterFingerprint === undefined ? {} : { afterFingerprint: input.afterFingerprint }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    });
  }

  /**
   * El registro de intentos no transaccionales no debe enmascarar la causa: si el
   * sink falla, la operación ya está fallando y se conserva el error de dominio.
   */
  async #record(event: SecretAuditEvent): Promise<void> {
    await this.#auditSink.record(event).catch(() => undefined);
  }

  async #fail(
    code: SecretControlPlaneErrorCode,
    reference: SecretReference,
    context: SecretOperationContext,
    operation: SecretLifecycleOperation,
  ): Promise<SecretControlPlaneError> {
    await this.#record(
      this.#auditEvent({
        action: 'integration.secret.failed.v1',
        capability: SECRET_CAPABILITIES[operation],
        reference,
        context,
        operation,
        decision: 'allow',
        outcome: 'failure',
        errorCode: code,
      }),
    );
    return secretControlPlaneError(code, operation);
  }

  async #failFromWriter(
    error: unknown,
    reference: SecretReference,
    context: SecretOperationContext,
    operation: SecretLifecycleOperation,
  ): Promise<SecretControlPlaneError> {
    if (error instanceof SecretControlPlaneError) return error;
    const code =
      error instanceof SecretWriterError
        ? (WRITER_ERRORS[error.code] ?? 'SECRET_OPERATION_FAILED')
        : 'SECRET_OPERATION_FAILED';
    return this.#fail(code, reference, context, operation);
  }

  async #failFromStore(
    error: unknown,
    reference: SecretReference,
    context: SecretOperationContext,
    operation: SecretLifecycleOperation,
  ): Promise<SecretControlPlaneError> {
    if (error instanceof SecretControlPlaneError) return error;
    const code =
      error instanceof SecretStoreError
        ? (STORE_ERRORS[error.code] ?? 'SECRET_OPERATION_FAILED')
        : 'SECRET_OPERATION_FAILED';
    return this.#fail(code, reference, context, operation);
  }
}
