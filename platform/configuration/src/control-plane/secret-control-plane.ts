import { parseSecretReference } from '../secrets/secret-reference.js';
import type { SecretFingerprinter } from './secret-fingerprint.js';
import {
  SecretLifecycleProviderError,
  type ProviderSecretVersion,
  type SecretLifecycleProvider,
} from './secret-lifecycle-provider.port.js';
import {
  SecretMetadataStoreError,
  type SecretMetadataStore,
} from './secret-metadata-store.port.js';
import {
  SECRET_CAPABILITIES,
  SecretControlPlaneError,
  type CreateSecretCommand,
  type ManagedSecretMetadata,
  type ReadSecretMetadataQuery,
  type RevokeSecretCommand,
  type RotateSecretCommand,
  type SecretActor,
  type SecretAuditEvent,
  type SecretCapability,
  type SecretMetadataResponse,
  type SecretOperation,
  type SecretReconciliationRecord,
  type SecretSafeLogger,
  type SecretTelemetry,
  type SecretVersionMetadata,
} from './secret-lifecycle.types.js';

export interface SecretControlPlaneDependencies {
  readonly provider: SecretLifecycleProvider;
  readonly store: SecretMetadataStore;
  readonly fingerprinter: SecretFingerprinter;
  readonly telemetry?: SecretTelemetry;
  readonly logger?: SecretSafeLogger;
  readonly now?: () => number;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

function requireCapability(
  actor: SecretActor | undefined,
  capability: SecretCapability,
  operation: SecretOperation,
): asserts actor is SecretActor {
  if (!actor || !SAFE_ID.test(actor.id))
    throw new SecretControlPlaneError('SECRET_UNAUTHENTICATED', operation, false);
  if (!actor.capabilities.includes(capability))
    throw new SecretControlPlaneError('SECRET_FORBIDDEN', operation, false);
}

function validText(value: string, maximum = 128): boolean {
  return (
    value.length >= 1 &&
    value.length <= maximum &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    })
  );
}

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : fallback;
}

function validateCommon(
  input: { readonly id: string; readonly operationId: string; readonly correlationId: string },
  operation: SecretOperation,
): void {
  if (
    !UUID_V7.test(input.id) ||
    !SAFE_ID.test(input.operationId) ||
    !SAFE_ID.test(input.correlationId)
  )
    throw new SecretControlPlaneError('SECRET_REQUEST_INVALID', operation, false);
}

function response(secret: ManagedSecretMetadata): SecretMetadataResponse {
  const current = secret.versions.find((version) => version.version === secret.currentVersion);
  if (!current) throw new SecretControlPlaneError('SECRET_PERSISTENCE_FAILED', 'create', false);
  const { versions: _versions, ...metadata } = secret;
  return Object.freeze({ ...metadata, current: Object.freeze({ ...current }) });
}

function providerFailure(error: unknown, operation: SecretOperation): SecretControlPlaneError {
  if (error instanceof SecretControlPlaneError) return error;
  if (error instanceof SecretLifecycleProviderError) {
    const mapped = {
      PROVIDER_UNAVAILABLE: 'SECRET_PROVIDER_UNAVAILABLE',
      PROVIDER_TIMEOUT: 'SECRET_PROVIDER_TIMEOUT',
      PROVIDER_REJECTED: 'SECRET_PROVIDER_REJECTED',
      PROVIDER_CONFLICT: 'SECRET_ROTATION_CONFLICT',
    } as const;
    return new SecretControlPlaneError(
      mapped[error.code],
      operation,
      error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PROVIDER_TIMEOUT',
    );
  }
  return new SecretControlPlaneError('SECRET_PROVIDER_UNAVAILABLE', operation, true);
}

function storeFailure(error: unknown, operation: SecretOperation): SecretControlPlaneError {
  if (error instanceof SecretMetadataStoreError) {
    if (error.code === 'STORE_DUPLICATE')
      return new SecretControlPlaneError('SECRET_DUPLICATE', operation, false);
    if (error.code === 'STORE_NOT_FOUND')
      return new SecretControlPlaneError('SECRET_NOT_FOUND', operation, false);
    if (error.code === 'STORE_CONFLICT')
      return new SecretControlPlaneError(
        operation === 'rotate' ? 'SECRET_ROTATION_CONFLICT' : 'SECRET_REVOCATION_FAILED',
        operation,
        true,
      );
  }
  return new SecretControlPlaneError('SECRET_PERSISTENCE_FAILED', operation, true);
}

function normalizedFailure(error: unknown, operation: SecretOperation): SecretControlPlaneError {
  return error instanceof SecretControlPlaneError ? error : storeFailure(error, operation);
}

function validateProviderResult(
  result: ProviderSecretVersion,
  operation: 'create' | 'rotate',
): ProviderSecretVersion {
  try {
    const providerRef = parseSecretReference(result.providerRef, 'providerRef');
    if (!validText(result.providerVersion, 128)) throw new Error('invalid');
    if (result.expiresAt && !Number.isFinite(Date.parse(result.expiresAt)))
      throw new Error('invalid');
    return { ...result, providerRef };
  } catch {
    throw new SecretControlPlaneError('SECRET_PROVIDER_REJECTED', operation, false);
  }
}

export class SecretControlPlane {
  readonly #now: () => number;

  public constructor(private readonly dependencies: SecretControlPlaneDependencies) {
    if (!SAFE_NAME.test(dependencies.provider.providerType))
      throw new SecretControlPlaneError('SECRET_REQUEST_INVALID', 'create', false);
    this.#now = dependencies.now ?? Date.now;
  }

  public async create(command: CreateSecretCommand): Promise<SecretMetadataResponse> {
    const started = this.#now();
    const operation: SecretOperation = 'create';
    try {
      requireCapability(command.actor, SECRET_CAPABILITIES.create, operation);
      validateCommon(command, operation);
      if (
        !SAFE_NAME.test(command.logicalName) ||
        !validText(command.purpose) ||
        !validText(command.owner) ||
        !validText(command.classification) ||
        (command.expiresAt !== undefined && !Number.isFinite(Date.parse(command.expiresAt)))
      )
        throw new SecretControlPlaneError('SECRET_REQUEST_INVALID', operation, false);
      const replay = await this.#replayed(command.operationId, command.id, operation);
      if (replay) return replay;
      if (await this.dependencies.store.findByLogicalName(command.logicalName))
        throw new SecretControlPlaneError('SECRET_DUPLICATE', operation, false);

      const createdAt = new Date(this.#now()).toISOString();
      let fingerprint = '';
      let providerResult: ProviderSecretVersion;
      const providerStarted = this.#now();
      try {
        providerResult = await command.material.consume(async (material) => {
          fingerprint = this.dependencies.fingerprinter.fingerprint(material);
          return this.dependencies.provider.create({
            secretId: command.id,
            logicalName: command.logicalName,
            material,
            operationId: command.operationId,
            ...(command.expiresAt ? { expiresAt: command.expiresAt } : {}),
            ...(command.signal ? { signal: command.signal } : {}),
          });
        });
        providerResult = validateProviderResult(providerResult, 'create');
        this.#providerObserved(operation, 'success', providerStarted);
      } catch (error) {
        const mapped = providerFailure(error, operation);
        this.#providerObserved(operation, 'failure', providerStarted, mapped.code);
        if (mapped.code === 'SECRET_PROVIDER_TIMEOUT')
          await this.#reconcile(
            command,
            operation,
            1,
            fingerprint,
            undefined,
            'PROVIDER_STATE_UNKNOWN',
          );
        throw mapped;
      }

      const version: SecretVersionMetadata = {
        version: 1,
        providerRef: providerResult.providerRef,
        providerVersion: providerResult.providerVersion,
        fingerprint,
        status: 'ACTIVE',
        createdAt,
        createdBy: command.actor.id,
        ...(providerResult.expiresAt ? { expiresAt: providerResult.expiresAt } : {}),
      };
      const secret: ManagedSecretMetadata = {
        id: command.id,
        logicalName: command.logicalName,
        purpose: command.purpose,
        owner: command.owner,
        classification: command.classification,
        provider: this.dependencies.provider.providerType,
        status: 'ACTIVE',
        currentVersion: 1,
        revision: 1,
        createdAt,
        createdBy: command.actor.id,
        updatedAt: createdAt,
        versions: [version],
      };
      const audit = this.#audit(command, operation, 'success', version);
      try {
        await this.dependencies.store.create({
          secret,
          receipt: {
            operationId: command.operationId,
            operation,
            secretId: command.id,
            version: 1,
            completedAt: createdAt,
          },
          audit,
        });
      } catch {
        await this.#reconcile(
          command,
          operation,
          1,
          fingerprint,
          providerResult.providerRef,
          'METADATA_PERSISTENCE_FAILED',
        );
        throw new SecretControlPlaneError('SECRET_EXTERNAL_STATE_INCONSISTENT', operation, false);
      }
      this.#observed(command, operation, 'success', started, 1);
      return response(secret);
    } catch (error) {
      const failure = normalizedFailure(error, operation);
      await this.#failedAudit(command, operation, failure);
      this.#observeFailure(command, operation, failure, started);
      throw failure;
    } finally {
      command.material.destroy();
    }
  }

  public async rotate(command: RotateSecretCommand): Promise<SecretMetadataResponse> {
    const started = this.#now();
    const operation: SecretOperation = 'rotate';
    let auditVersion: SecretVersionMetadata | undefined;
    try {
      requireCapability(command.actor, SECRET_CAPABILITIES.rotate, operation);
      validateCommon(command, operation);
      const replay = await this.#replayed(command.operationId, command.id, operation);
      if (replay) return replay;
      const existing = await this.dependencies.store.findById(command.id);
      if (!existing) throw new SecretControlPlaneError('SECRET_NOT_FOUND', operation, false);
      if (existing.status !== 'ACTIVE')
        throw new SecretControlPlaneError('SECRET_TRANSITION_INVALID', operation, false);
      const current = response(existing).current;
      auditVersion = current;
      const intendedVersion = existing.currentVersion + 1;
      const rotatedAt = new Date(this.#now()).toISOString();
      let fingerprint = '';
      let providerResult: ProviderSecretVersion;
      const providerStarted = this.#now();
      try {
        providerResult = await command.material.consume(async (material) => {
          fingerprint = this.dependencies.fingerprinter.fingerprint(material);
          return this.dependencies.provider.rotate({
            secretId: command.id,
            currentRef: current.providerRef,
            material,
            operationId: command.operationId,
            ...(command.expiresAt ? { expiresAt: command.expiresAt } : {}),
            ...(command.signal ? { signal: command.signal } : {}),
          });
        });
        providerResult = validateProviderResult(providerResult, 'rotate');
        this.#providerObserved(operation, 'success', providerStarted);
      } catch (error) {
        const mapped = providerFailure(error, operation);
        this.#providerObserved(operation, 'failure', providerStarted, mapped.code);
        if (mapped.code === 'SECRET_PROVIDER_TIMEOUT')
          await this.#reconcile(
            command,
            operation,
            intendedVersion,
            fingerprint,
            undefined,
            'PROVIDER_STATE_UNKNOWN',
            existing.logicalName,
          );
        throw mapped;
      }
      const version: SecretVersionMetadata = {
        version: intendedVersion,
        providerRef: providerResult.providerRef,
        providerVersion: providerResult.providerVersion,
        fingerprint,
        status: 'ACTIVE',
        createdAt: rotatedAt,
        createdBy: command.actor.id,
        ...(providerResult.expiresAt ? { expiresAt: providerResult.expiresAt } : {}),
      };
      try {
        await this.dependencies.store.rotate({
          secretId: command.id,
          expectedRevision: existing.revision,
          version,
          rotatedAt,
          rotatedBy: command.actor.id,
          receipt: {
            operationId: command.operationId,
            operation,
            secretId: command.id,
            version: intendedVersion,
            completedAt: rotatedAt,
          },
          audit: this.#audit(command, operation, 'success', version),
        });
      } catch (error) {
        const replayAfterRace = await this.#replayed(command.operationId, command.id, operation);
        if (replayAfterRace) return replayAfterRace;
        await this.#reconcile(
          command,
          operation,
          intendedVersion,
          fingerprint,
          providerResult.providerRef,
          error instanceof SecretMetadataStoreError && error.code === 'STORE_CONFLICT'
            ? 'CONCURRENT_STATE_CHANGE'
            : 'METADATA_PERSISTENCE_FAILED',
          existing.logicalName,
        );
        throw new SecretControlPlaneError('SECRET_EXTERNAL_STATE_INCONSISTENT', operation, false);
      }
      const saved = await this.dependencies.store.findById(command.id);
      if (!saved) throw storeFailure(new SecretMetadataStoreError('STORE_NOT_FOUND'), operation);
      this.#observed(command, operation, 'success', started, intendedVersion);
      return response(saved);
    } catch (error) {
      const failure = normalizedFailure(error, operation);
      await this.#failedAudit(command, operation, failure, auditVersion);
      this.#observeFailure(command, operation, failure, started);
      throw failure;
    } finally {
      command.material.destroy();
    }
  }

  public async revoke(command: RevokeSecretCommand): Promise<SecretMetadataResponse> {
    const started = this.#now();
    const operation: SecretOperation = 'revoke';
    let auditVersion: SecretVersionMetadata | undefined;
    try {
      requireCapability(command.actor, SECRET_CAPABILITIES.revoke, operation);
      validateCommon(command, operation);
      const replay = await this.#replayed(command.operationId, command.id, operation);
      if (replay) return replay;
      const existing = await this.dependencies.store.findById(command.id);
      if (!existing) throw new SecretControlPlaneError('SECRET_NOT_FOUND', operation, false);
      const current = response(existing).current;
      auditVersion = current;
      const revokedAt = new Date(this.#now()).toISOString();
      if (existing.status === 'REVOKED') {
        await this.dependencies.store.recordIdempotent({
          receipt: {
            operationId: command.operationId,
            operation,
            secretId: command.id,
            version: existing.currentVersion,
            completedAt: revokedAt,
          },
          audit: this.#audit(command, operation, 'success', current),
        });
        this.#observed(command, operation, 'success', started, existing.currentVersion);
        return response(existing);
      }
      if (existing.status !== 'ACTIVE')
        throw new SecretControlPlaneError('SECRET_TRANSITION_INVALID', operation, false);
      const providerStarted = this.#now();
      try {
        const result = await this.dependencies.provider.revoke({
          secretId: command.id,
          providerRef: current.providerRef,
          operationId: command.operationId,
          ...(command.signal ? { signal: command.signal } : {}),
        });
        if (result.revoked !== true || result.providerRef !== current.providerRef)
          throw new SecretLifecycleProviderError('PROVIDER_REJECTED');
        this.#providerObserved(operation, 'success', providerStarted);
      } catch (error) {
        const mapped = providerFailure(error, operation);
        this.#providerObserved(operation, 'failure', providerStarted, mapped.code);
        const revocationError =
          mapped.code === 'SECRET_PROVIDER_TIMEOUT'
            ? mapped
            : new SecretControlPlaneError('SECRET_REVOCATION_FAILED', operation, mapped.retryable);
        if (mapped.code === 'SECRET_PROVIDER_TIMEOUT')
          await this.#reconcile(
            command,
            operation,
            existing.currentVersion,
            current.fingerprint,
            current.providerRef,
            'PROVIDER_STATE_UNKNOWN',
            existing.logicalName,
          );
        throw revocationError;
      }
      try {
        await this.dependencies.store.revoke({
          secretId: command.id,
          expectedRevision: existing.revision,
          revokedAt,
          revokedBy: command.actor.id,
          receipt: {
            operationId: command.operationId,
            operation,
            secretId: command.id,
            version: existing.currentVersion,
            completedAt: revokedAt,
          },
          audit: this.#audit(command, operation, 'success', current),
        });
      } catch (error) {
        const replayAfterRace = await this.#replayed(command.operationId, command.id, operation);
        if (replayAfterRace) return replayAfterRace;
        await this.#reconcile(
          command,
          operation,
          existing.currentVersion,
          current.fingerprint,
          current.providerRef,
          error instanceof SecretMetadataStoreError && error.code === 'STORE_CONFLICT'
            ? 'CONCURRENT_STATE_CHANGE'
            : 'METADATA_PERSISTENCE_FAILED',
          existing.logicalName,
        );
        throw new SecretControlPlaneError('SECRET_EXTERNAL_STATE_INCONSISTENT', operation, false);
      }
      const saved = await this.dependencies.store.findById(command.id);
      if (!saved) throw storeFailure(new SecretMetadataStoreError('STORE_NOT_FOUND'), operation);
      this.#observed(command, operation, 'success', started, existing.currentVersion);
      return response(saved);
    } catch (error) {
      const failure = normalizedFailure(error, operation);
      await this.#failedAudit(command, operation, failure, auditVersion);
      this.#observeFailure(command, operation, failure, started);
      throw failure;
    }
  }

  public async readMetadata(query: ReadSecretMetadataQuery): Promise<SecretMetadataResponse> {
    requireCapability(query.actor, SECRET_CAPABILITIES.readMetadata, 'create');
    if (!UUID_V7.test(query.id))
      throw new SecretControlPlaneError('SECRET_REQUEST_INVALID', 'create', false);
    const secret = await this.dependencies.store.findById(query.id);
    if (!secret) throw new SecretControlPlaneError('SECRET_NOT_FOUND', 'create', false);
    return response(secret);
  }

  async #replayed(
    operationId: string,
    secretId: string,
    operation: SecretOperation,
  ): Promise<SecretMetadataResponse | undefined> {
    const receipt = await this.dependencies.store.findOperation(operationId);
    if (!receipt) return undefined;
    if (receipt.secretId !== secretId || receipt.operation !== operation)
      throw new SecretControlPlaneError('SECRET_REQUEST_INVALID', operation, false);
    const secret = await this.dependencies.store.findById(receipt.secretId);
    if (!secret)
      throw new SecretControlPlaneError('SECRET_PERSISTENCE_FAILED', receipt.operation, false);
    return response(secret);
  }

  #audit(
    command: CreateSecretCommand | RotateSecretCommand | RevokeSecretCommand,
    operation: SecretOperation,
    result: SecretAuditEvent['result'],
    version?: SecretVersionMetadata,
    failureClass?: string,
  ): SecretAuditEvent {
    return {
      actorId: safeIdentifier(command.actor?.id, 'unauthenticated'),
      action: `secret.${operation}`,
      targetSecretId: UUID_V7.test(command.id) ? command.id : NIL_UUID,
      provider: this.dependencies.provider.providerType,
      ...(version
        ? {
            providerRef: version.providerRef,
            version: version.version,
            fingerprint: version.fingerprint,
          }
        : {}),
      timestamp: new Date(this.#now()).toISOString(),
      result,
      correlationId: safeIdentifier(command.correlationId, 'invalid-correlation'),
      ...(failureClass ? { failureClass } : {}),
    };
  }

  async #failedAudit(
    command: CreateSecretCommand | RotateSecretCommand | RevokeSecretCommand,
    operation: SecretOperation,
    error: SecretControlPlaneError,
    version?: SecretVersionMetadata,
  ): Promise<void> {
    try {
      await this.dependencies.store.recordFailedAttempt(
        this.#audit(command, operation, 'failure', version, error.code),
      );
    } catch {
      // The safe logger and metric below remain available when durable audit storage is unavailable.
    }
  }

  async #reconcile(
    command: CreateSecretCommand | RotateSecretCommand | RevokeSecretCommand,
    operation: SecretOperation,
    intendedVersion: number,
    fingerprint: string,
    providerRef: SecretVersionMetadata['providerRef'] | undefined,
    reason: SecretReconciliationRecord['reason'],
    logicalName = 'unknown',
  ): Promise<void> {
    const createdAt = new Date(this.#now()).toISOString();
    const record: SecretReconciliationRecord = {
      operationId: command.operationId,
      operation,
      secretId: command.id,
      logicalName,
      provider: this.dependencies.provider.providerType,
      ...(providerRef ? { providerRef } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      intendedVersion,
      reason,
      actorId: safeIdentifier(command.actor?.id, 'unauthenticated'),
      correlationId: safeIdentifier(command.correlationId, 'invalid-correlation'),
      createdAt,
    };
    try {
      await this.dependencies.store.recordReconciliation({
        record,
        audit: {
          ...this.#audit(command, operation, 'reconciliation_required', undefined, reason),
          ...(providerRef ? { providerRef } : {}),
          ...(fingerprint ? { fingerprint } : {}),
          version: intendedVersion,
        },
      });
    } catch {
      // A total store outage is surfaced through the typed error, metric and safe log.
    }
    this.#observed(
      command,
      operation,
      'reconciliation_required',
      this.#now(),
      intendedVersion,
      reason,
    );
  }

  #observed(
    command: CreateSecretCommand | RotateSecretCommand | RevokeSecretCommand,
    operation: SecretOperation,
    result: 'success' | 'failure' | 'reconciliation_required',
    started: number,
    version?: number,
    failureClass?: string,
  ): void {
    this.dependencies.telemetry?.record({
      phase: 'operation',
      operation,
      provider: this.dependencies.provider.providerType,
      result,
      ...(failureClass ? { failureClass } : {}),
      durationMs: Math.max(0, this.#now() - started),
    });
    this.dependencies.logger?.write({
      operation: `secret.${operation}`,
      secretId: UUID_V7.test(command.id) ? command.id : NIL_UUID,
      ...(version === undefined ? {} : { version }),
      provider: this.dependencies.provider.providerType,
      result,
      ...(failureClass ? { failureClass } : {}),
      correlationId: safeIdentifier(command.correlationId, 'invalid-correlation'),
    });
  }

  #providerObserved(
    operation: SecretOperation,
    result: 'success' | 'failure',
    started: number,
    failureClass?: string,
  ): void {
    this.dependencies.telemetry?.record({
      phase: 'provider',
      operation,
      provider: this.dependencies.provider.providerType,
      result,
      ...(failureClass ? { failureClass } : {}),
      durationMs: Math.max(0, this.#now() - started),
    });
  }

  #observeFailure(
    command: CreateSecretCommand | RotateSecretCommand | RevokeSecretCommand,
    operation: SecretOperation,
    error: unknown,
    started: number,
  ): void {
    const failure =
      error instanceof SecretControlPlaneError ? error : storeFailure(error, operation);
    this.#observed(command, operation, 'failure', started, undefined, failure.code);
  }
}
