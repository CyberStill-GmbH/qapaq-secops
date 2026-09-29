import { describe, expect, it } from 'vitest';
import type { SecretControlPlane } from '../control-plane/secret-control-plane.js';
import type { SecretAuditEvent } from '../control-plane/secret-audit.js';
import type { SecretOperationContext } from '../control-plane/secret-lifecycle.types.js';
import { SubmittedSecret } from '../control-plane/submitted-secret.js';

export interface SecretControlPlaneContractHarness {
  /** Control plane recién construido, sin secretos registrados. */
  readonly createControlPlane: () => SecretControlPlane;
  /** Referencia válida para el proveedor bajo prueba. */
  readonly reference: string;
  /** Material sintético distinto en cada llamada; nunca una credencial real. */
  readonly nextSecret: () => string;
  readonly context: (requestId: string) => SecretOperationContext;
  /** Registros durables observados tras las operaciones. */
  readonly persistedRecords: () => readonly unknown[];
  readonly auditTrail: () => readonly SecretAuditEvent[];
}

/**
 * Suite de aceptación portable del contrato write-only. Cualquier implementación de
 * `SecretWriter`/`SecretMetadataStore` debe superarla antes de considerarse apta.
 */
export function defineSecretControlPlaneContract(harness: SecretControlPlaneContractHarness): void {
  const submit = (): SubmittedSecret => new SubmittedSecret(harness.nextSecret());

  describe('SecretControlPlane contract', () => {
    it('1. registers a secret and returns reference, fingerprint and status only', async () => {
      const view = await harness.createControlPlane().createSecret({
        reference: harness.reference,
        secret: submit(),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: harness.context('req-create-0001'),
      });
      expect(view.reference).toBe(harness.reference);
      expect(view.status).toBe('active');
      expect(view.version).toBe(1);
      expect(view.fingerprint).toMatch(/^hmac-sha256:v1:[0-9a-f]{8}:[A-Za-z0-9_-]{22}$/u);
      expect(Object.keys(view)).not.toContain('secret');
      expect(Object.keys(view)).not.toContain('plaintext');
    });

    it('2. exposes no operation able to return the submitted value', () => {
      const controlPlane = harness.createControlPlane();
      const surface = [
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(controlPlane) as object),
      ];
      const forbidden = /^(get|read|reveal|export|download|fetch|show|recover)Secret(Value)?$/u;
      expect(surface.filter((name) => forbidden.test(name))).toEqual([]);
      expect(surface).toContain('createSecret');
      expect(surface).toContain('rotateSecret');
      expect(surface).toContain('revokeSecret');
    });

    it('3. rejects a duplicate registration for the same reference', async () => {
      const controlPlane = harness.createControlPlane();
      await controlPlane.createSecret({
        reference: harness.reference,
        secret: submit(),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: harness.context('req-create-0002'),
      });
      await expect(
        controlPlane.createSecret({
          reference: harness.reference,
          secret: submit(),
          purpose: 'wazuh-indexer',
          owner: 'platform-admin',
          context: harness.context('req-create-0003'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_ALREADY_REGISTERED' });
    });

    it('4. rotates to a new version and a different fingerprint', async () => {
      const controlPlane = harness.createControlPlane();
      const created = await controlPlane.createSecret({
        reference: harness.reference,
        secret: submit(),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: harness.context('req-create-0004'),
      });
      const rotated = await controlPlane.rotateSecret({
        reference: harness.reference,
        secret: submit(),
        context: harness.context('req-rotate-0001'),
      });
      expect(rotated.version).toBe(created.version + 1);
      expect(rotated.fingerprint).not.toBe(created.fingerprint);
      expect(rotated.status).toBe('active');
      expect(rotated.rotatedAt).toBeDefined();
    });

    it('5. revokes and keeps the reference unusable as active', async () => {
      const controlPlane = harness.createControlPlane();
      await controlPlane.createSecret({
        reference: harness.reference,
        secret: submit(),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: harness.context('req-create-0005'),
      });
      const revoked = await controlPlane.revokeSecret({
        reference: harness.reference,
        context: harness.context('req-revoke-0001'),
      });
      expect(revoked.status).toBe('revoked');
      await expect(
        controlPlane.rotateSecret({
          reference: harness.reference,
          secret: submit(),
          context: harness.context('req-rotate-0002'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_NOT_ACTIVE' });
      await expect(
        controlPlane.revokeSecret({
          reference: harness.reference,
          context: harness.context('req-revoke-0003'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_NOT_ACTIVE' });
    });

    it('6. replays an identical request without creating a second secret', async () => {
      const controlPlane = harness.createControlPlane();
      const first = await controlPlane.createSecret({
        reference: harness.reference,
        secret: submit(),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: harness.context('req-create-0006'),
      });
      const replay = await controlPlane.createSecret({
        reference: harness.reference,
        secret: submit(),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: harness.context('req-create-0006'),
      });
      expect(replay).toEqual(first);
      expect(harness.persistedRecords()).toHaveLength(1);
    });

    it('7. rejects rotation and revocation of an unregistered reference', async () => {
      const controlPlane = harness.createControlPlane();
      await expect(
        controlPlane.rotateSecret({
          reference: harness.reference,
          secret: submit(),
          context: harness.context('req-rotate-0004'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_NOT_REGISTERED' });
      await expect(
        controlPlane.revokeSecret({
          reference: harness.reference,
          context: harness.context('req-revoke-0004'),
        }),
      ).rejects.toMatchObject({ code: 'SECRET_NOT_REGISTERED' });
    });

    it('8. burns the submitted material after a single use', async () => {
      const controlPlane = harness.createControlPlane();
      const secret = new SubmittedSecret(harness.nextSecret());
      await controlPlane.createSecret({
        reference: harness.reference,
        secret,
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: harness.context('req-create-0008'),
      });
      expect(secret.consumed).toBe(true);
      expect(() => secret.use((value) => value)).toThrowError();
    });

    it('9. emits one audit event per successful lifecycle mutation', async () => {
      const controlPlane = harness.createControlPlane();
      await controlPlane.createSecret({
        reference: harness.reference,
        secret: submit(),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: harness.context('req-create-0009'),
      });
      await controlPlane.rotateSecret({
        reference: harness.reference,
        secret: submit(),
        context: harness.context('req-rotate-0009'),
      });
      await controlPlane.revokeSecret({
        reference: harness.reference,
        context: harness.context('req-revoke-0009'),
      });
      expect(harness.auditTrail().map((event) => event.action)).toEqual([
        'integration.secret.created.v1',
        'integration.secret.rotated.v1',
        'integration.secret.revoked.v1',
      ]);
      for (const event of harness.auditTrail()) {
        expect(event.actorId).toBeTruthy();
        expect(event.decision).toBe('allow');
        expect(event.outcome).toBe('success');
      }
    });

    it('10. persists no property carrying submitted material', async () => {
      const controlPlane = harness.createControlPlane();
      await controlPlane.createSecret({
        reference: harness.reference,
        secret: submit(),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: harness.context('req-create-0010'),
      });
      const forbidden =
        /^(secret|secretValue|plaintext|password|token|credential|apiKey|clientSecret|privateKey|ciphertext|encryptedSecret)$/u;
      for (const record of harness.persistedRecords())
        expect(Object.keys(record as object).filter((key) => forbidden.test(key))).toEqual([]);
    });
  });
}
