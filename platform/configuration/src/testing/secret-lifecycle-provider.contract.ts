import { describe, expect, it } from 'vitest';
import type { SecretLifecycleProvider } from '../control-plane/secret-lifecycle-provider.port.js';

export interface SecretLifecycleProviderContractHarness {
  readonly createProvider: () => SecretLifecycleProvider;
  readonly material: () => Uint8Array;
}

/** Portable C-24 suite. Production adapters must run this same contract in Sprint 3. */
export function defineSecretLifecycleProviderContract(
  harness: SecretLifecycleProviderContractHarness,
): void {
  describe('SecretLifecycleProvider contract', () => {
    it('creates safe reference metadata without returning material', async () => {
      const provider = harness.createProvider();
      const result = await provider.create({
        secretId: '01890f47-7abc-7def-8abc-0123456789ab',
        logicalName: 'contract/test',
        material: harness.material(),
        operationId: 'contract-create',
      });
      expect(result.providerRef).toMatch(/^secret:\/\//u);
      expect(result.providerVersion).toBeTruthy();
      expect(Object.keys(result).sort()).toEqual(['providerRef', 'providerVersion']);
    });

    it('rotates to a new reference/version and revokes idempotently', async () => {
      const provider = harness.createProvider();
      const created = await provider.create({
        secretId: '01890f47-7abc-7def-8abc-0123456789ab',
        logicalName: 'contract/test',
        material: harness.material(),
        operationId: 'contract-create',
      });
      const rotated = await provider.rotate({
        secretId: '01890f47-7abc-7def-8abc-0123456789ab',
        currentRef: created.providerRef,
        material: harness.material(),
        operationId: 'contract-rotate',
      });
      expect(rotated.providerRef).not.toBe(created.providerRef);
      expect(rotated.providerVersion).not.toBe(created.providerVersion);
      const first = await provider.revoke({
        secretId: '01890f47-7abc-7def-8abc-0123456789ab',
        providerRef: rotated.providerRef,
        operationId: 'contract-revoke',
      });
      const repeated = await provider.revoke({
        secretId: '01890f47-7abc-7def-8abc-0123456789ab',
        providerRef: rotated.providerRef,
        operationId: 'contract-revoke',
      });
      expect(first).toEqual(repeated);
      expect(first).toEqual({ providerRef: rotated.providerRef, revoked: true });
    });

    it('never exposes plaintext in any provider result', async () => {
      const canary = new TextEncoder().encode('C24_TEST_SECRET_CANARY_CONTRACT');
      const result = await harness.createProvider().create({
        secretId: '01890f47-7abc-7def-8abc-0123456789ab',
        logicalName: 'contract/test',
        material: canary,
        operationId: 'contract-create',
      });
      expect(JSON.stringify(result)).not.toContain('C24_TEST_SECRET_CANARY_CONTRACT');
    });
  });
}
