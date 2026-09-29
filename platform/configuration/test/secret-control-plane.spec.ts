import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SECRET_CAPABILITIES,
  SecretControlPlane,
  SecretFingerprintKey,
  SubmittedSecret,
  denyAllSecretAuthorizer,
  toPublicError,
  type SecretAuditEvent,
  type SecretAuditSink,
  type SecretAuthorizer,
  type SecretOperationContext,
} from '../src/index.js';
import { InMemorySecretStore } from '../src/testing/in-memory-secret-store.js';
import { RecordingSecretWriter } from '../src/testing/recording-secret-writer.js';
import { defineSecretControlPlaneContract } from '../src/testing/secret-control-plane.contract.js';

const REFERENCE = 'secret://test/wazuh-indexer-password';
/** Generada en ejecución: la suite no versiona material con forma de clave. */
const FINGERPRINT_KEY = randomBytes(32).toString('hex');
const NOW = new Date('2026-09-29T12:00:00.000Z');

class CollectingAuditSink implements SecretAuditSink {
  public readonly events: SecretAuditEvent[] = [];
  public async record(event: SecretAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const allowAll: SecretAuthorizer = { authorize: async () => true };

function context(requestId: string, overrides: Partial<SecretOperationContext> = {}) {
  return {
    actor: { actorType: 'human' as const, actorId: 'platform-admin-01' },
    requestId,
    correlationId: `corr-${requestId}`,
    occurredAt: NOW,
    ...overrides,
  };
}

interface Harness {
  readonly controlPlane: SecretControlPlane;
  readonly store: InMemorySecretStore;
  readonly writer: RecordingSecretWriter;
  readonly sink: CollectingAuditSink;
}

function build(authorizer: SecretAuthorizer = allowAll): Harness {
  const store = new InMemorySecretStore();
  const writer = new RecordingSecretWriter();
  const sink = new CollectingAuditSink();
  return {
    controlPlane: new SecretControlPlane({
      writer,
      store,
      authorizer,
      auditSink: sink,
      fingerprintKey: new SecretFingerprintKey(FINGERPRINT_KEY),
    }),
    store,
    writer,
    sink,
  };
}

let counter = 0;
const nextSecret = (): string => `synthetic-secret-value-${(counter += 1)}`;

describe('C-24 control plane', () => {
  let contractStore = new InMemorySecretStore();
  let contractSink = new CollectingAuditSink();

  defineSecretControlPlaneContract({
    createControlPlane: () => {
      contractStore = new InMemorySecretStore();
      contractSink = new CollectingAuditSink();
      return new SecretControlPlane({
        writer: new RecordingSecretWriter(),
        store: contractStore,
        authorizer: allowAll,
        auditSink: contractSink,
        fingerprintKey: new SecretFingerprintKey(FINGERPRINT_KEY),
      });
    },
    reference: REFERENCE,
    nextSecret,
    context: (requestId) => context(requestId),
    persistedRecords: () => contractStore.dump(),
    auditTrail: () => contractStore.auditTrail,
  });

  describe('autorización', () => {
    it('deniega por defecto y no llama al proveedor', async () => {
      const harness = build(denyAllSecretAuthorizer);
      await expect(
        harness.controlPlane.createSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          context: context('req-denied-0001'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_AUTHORIZATION_DENIED' });
      expect(harness.writer.calls).toEqual([]);
      expect(harness.store.dump()).toEqual([]);
      expect(harness.sink.events.at(0)).toMatchObject({
        action: 'integration.secret.denied.v1',
        decision: 'deny',
        capability: SECRET_CAPABILITIES.create,
      });
    });

    it('trata un autorizador que lanza como denegación', async () => {
      const harness = build({
        authorize: async () => {
          throw new Error('policy backend down');
        },
      });
      await expect(
        harness.controlPlane.revokeSecret({
          reference: REFERENCE,
          context: context('req-denied-0002'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_AUTHORIZATION_DENIED' });
      expect(harness.writer.calls).toEqual([]);
    });

    it('exige la capability específica de cada operación', async () => {
      const seen: string[] = [];
      const harness = build({
        authorize: async (request) => {
          seen.push(request.capability);
          return true;
        },
      });
      await harness.controlPlane.createSecret({
        reference: REFERENCE,
        secret: new SubmittedSecret(nextSecret()),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: context('req-caps-0001'),
      });
      await harness.controlPlane.rotateSecret({
        reference: REFERENCE,
        secret: new SubmittedSecret(nextSecret()),
        context: context('req-caps-0002'),
      });
      await harness.controlPlane.readMetadata({
        reference: REFERENCE,
        context: context('req-caps-0003'),
      });
      await harness.controlPlane.revokeSecret({
        reference: REFERENCE,
        context: context('req-caps-0004'),
      });
      expect(seen).toEqual([
        'integration.secret.create',
        'integration.secret.rotate',
        'integration.secret.metadata.read',
        'integration.secret.revoke',
      ]);
    });
  });

  describe('validación de entrada', () => {
    it('rechaza referencias fuera del formato y con path traversal', async () => {
      const harness = build();
      for (const reference of [
        'https://vault/secret',
        'secret://test/../escape',
        'secret://TEST/upper-namespace',
        '',
      ])
        await expect(
          harness.controlPlane.readMetadata({ reference, context: context('req-ref-00001') }),
        ).rejects.toMatchObject({ code: 'SECRET_REQUEST_INVALID' });
    });

    it('rechaza etiquetas con nombre sensible o valor sobredimensionado', async () => {
      const harness = build();
      const create = (labels: Record<string, string>) =>
        harness.controlPlane.createSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          labels,
          context: context(`req-labels-${Math.random().toString(36).slice(2, 10)}`),
        });
      await expect(create({ password: 'x' })).rejects.toMatchObject({
        code: 'SECRET_REQUEST_INVALID',
      });
      await expect(create({ 'api-key': 'x' })).rejects.toMatchObject({
        code: 'SECRET_REQUEST_INVALID',
      });
      await expect(create({ env: 'a'.repeat(200) })).rejects.toMatchObject({
        code: 'SECRET_REQUEST_INVALID',
      });
      await expect(create({ env: 'line\nbreak' })).rejects.toMatchObject({
        code: 'SECRET_REQUEST_INVALID',
      });
    });

    it('rechaza material vacío o desmedido antes de contactar al proveedor', () => {
      expect(() => new SubmittedSecret('short')).toThrowError();
      expect(() => new SubmittedSecret('a'.repeat(8_193))).toThrowError();
    });

    it('rechaza una expiración ya vencida', async () => {
      const harness = build();
      await expect(
        harness.controlPlane.createSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          expiresAt: new Date(NOW.getTime() - 1),
          context: context('req-expiry-0001'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_REQUEST_INVALID' });
    });
  });

  describe('ciclo de vida', () => {
    it('presenta como expirado un secreto activo cuya expiración pasó', async () => {
      const harness = build();
      await harness.controlPlane.createSecret({
        reference: REFERENCE,
        secret: new SubmittedSecret(nextSecret()),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        expiresAt: new Date(NOW.getTime() + 60_000),
        context: context('req-expiry-0002'),
      });
      const later = context('req-expiry-0003', { occurredAt: new Date(NOW.getTime() + 120_000) });
      const view = await harness.controlPlane.readMetadata({
        reference: REFERENCE,
        context: later,
      });
      expect(view.status).toBe('expired');
      await expect(
        harness.controlPlane.rotateSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          context: context('req-expiry-0004', { occurredAt: later.occurredAt }),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_NOT_ACTIVE' });
    });

    it('permite revocar un secreto expirado', async () => {
      const harness = build();
      await harness.controlPlane.createSecret({
        reference: REFERENCE,
        secret: new SubmittedSecret(nextSecret()),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        expiresAt: new Date(NOW.getTime() + 60_000),
        context: context('req-expiry-0005'),
      });
      const view = await harness.controlPlane.revokeSecret({
        reference: REFERENCE,
        context: context('req-expiry-0006', { occurredAt: new Date(NOW.getTime() + 120_000) }),
      });
      expect(view.status).toBe('revoked');
    });
  });

  describe('fronteras y fallos parciales', () => {
    it('no persiste metadata cuando el proveedor rechaza la credencial', async () => {
      const harness = build();
      harness.writer.failNextWith = 'WRITER_REJECTED';
      await expect(
        harness.controlPlane.createSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          context: context('req-writer-0001'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_PROVIDER_REJECTED', retryable: false });
      expect(harness.store.dump()).toEqual([]);
    });

    it('marca el resultado como reconciliable cuando el proveedor no confirma', async () => {
      const harness = build();
      harness.writer.failNextWith = 'WRITER_OUTCOME_UNKNOWN';
      await expect(
        harness.controlPlane.createSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          context: context('req-writer-0002'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_RECONCILIATION_REQUIRED' });
      expect(harness.store.dump()).toEqual([]);
    });

    it('reporta reconciliación cuando el proveedor escribió y la metadata no', async () => {
      const harness = build();
      harness.store.failStoreOnce = true;
      await expect(
        harness.controlPlane.createSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          context: context('req-store-0001'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_RECONCILIATION_REQUIRED' });
      expect(harness.writer.calls).toHaveLength(1);
      expect(harness.store.dump()).toEqual([]);
    });

    it('revierte la mutación si la auditoría no puede escribirse', async () => {
      const harness = build();
      harness.store.failAuditOnce = true;
      await expect(
        harness.controlPlane.createSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          context: context('req-audit-0001'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_AUDIT_WRITE_REQUIRED', retryable: true });
      expect(harness.store.dump()).toEqual([]);
      expect(harness.store.auditTrail).toEqual([]);
    });

    it('quema el material aunque el proveedor falle, sin dejarlo disponible para un reintento', async () => {
      const harness = build();
      harness.writer.failNextWith = 'WRITER_UNREACHABLE';
      const secret = new SubmittedSecret(nextSecret());
      await expect(
        harness.controlPlane.createSecret({
          reference: REFERENCE,
          secret,
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          context: context('req-burn-0001'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_PROVIDER_UNREACHABLE', retryable: true });
      expect(secret.consumed).toBe(true);
      await expect(
        harness.controlPlane.createSecret({
          reference: REFERENCE,
          secret,
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          context: context('req-burn-0002'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_ALREADY_CONSUMED' });
      expect(harness.store.dump()).toEqual([]);
    });

    it('detecta conflicto de rotación concurrente por revisión', async () => {
      const harness = build();
      await harness.controlPlane.createSecret({
        reference: REFERENCE,
        secret: new SubmittedSecret(nextSecret()),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: context('req-conc-0001'),
      });
      const results = await Promise.allSettled([
        harness.controlPlane.rotateSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          context: context('req-conc-0002'),
        }),
        harness.controlPlane.rotateSecret({
          reference: REFERENCE,
          secret: new SubmittedSecret(nextSecret()),
          context: context('req-conc-0003'),
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ code: 'SECRET_ROTATION_CONFLICT' });
      expect(harness.store.dump().at(0)?.version).toBe(2);
    });
  });

  describe('catálogo público de errores', () => {
    it('mapea cada código interno a un código publicado de docs/error-catalog.md', () => {
      expect(toPublicError('SECRET_PROVIDER_REJECTED')).toEqual({
        code: 'INTEGRATION_CREDENTIAL_REJECTED',
        status: 422,
        helpRef: 'ERR-SECRET-001',
        retryable: false,
      });
      expect(toPublicError('SECRET_AUTHORIZATION_DENIED').code).toBe('ACCESS_DENIED');
      expect(toPublicError('SECRET_AUDIT_WRITE_REQUIRED').code).toBe('AUDIT_WRITE_REQUIRED');
      expect(toPublicError('SECRET_ROTATION_CONFLICT').status).toBe(409);
    });
  });
});
