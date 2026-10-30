/**
 * Azure EUS2 — orquestación de roles y migración sin credencial DDL persistente. Los pasos de
 * base de datos son dobles: se prueba el orden, el cierre del migrator y que nada se registre.
 */

import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error — módulo JS del migrator, sin declaraciones de tipos.
import { AzureBootstrapError, runAzureBootstrap } from '../migrator/azure-bootstrap.mjs';

const RUNTIME_PASSWORD = 'r'.repeat(64);
const MIGRATOR_PASSWORD = 'm'.repeat(64);

function harness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const events: unknown[] = [];
  const input = {
    runtimePassword: RUNTIME_PASSWORD,
    generatePassword: () => MIGRATOR_PASSWORD,
    applyRoles: vi.fn(async () => {
      calls.push('applyRoles');
    }),
    migrate: vi.fn(async () => {
      calls.push('migrate');
    }),
    lockMigrator: vi.fn(async () => {
      calls.push('lockMigrator');
    }),
    log: (event: string, extra?: object) => events.push({ event, ...extra }),
    ...overrides,
  };
  return { input, calls, events };
}

describe('runAzureBootstrap', () => {
  it('applies roles with the vault runtime password, migrates with a one-time password and locks the migrator', async () => {
    const { input, calls, events } = harness();
    await runAzureBootstrap(input);

    expect(calls).toEqual(['applyRoles', 'migrate', 'lockMigrator']);
    expect(input.applyRoles).toHaveBeenCalledWith({
      qapaq_migrator: MIGRATOR_PASSWORD,
      qapaq_soc_runtime: RUNTIME_PASSWORD,
    });
    expect(input.migrate).toHaveBeenCalledWith(MIGRATOR_PASSWORD);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain(RUNTIME_PASSWORD);
    expect(logged).not.toContain(MIGRATOR_PASSWORD);
  });

  it('locks the migrator even when the migration fails', async () => {
    const { input, calls } = harness({
      migrate: vi.fn(async () => {
        throw new Error('PRISMA_MIGRATE_FAILED:1');
      }),
    });
    await expect(runAzureBootstrap(input)).rejects.toThrow('PRISMA_MIGRATE_FAILED');
    expect(input.lockMigrator).toHaveBeenCalledOnce();
    expect(calls).toEqual(['applyRoles', 'lockMigrator']);
  });

  it('does not touch the database when roles cannot be applied', async () => {
    const { input } = harness({
      applyRoles: vi.fn(async () => {
        throw new Error('ROLE_APPLY_FAILED');
      }),
    });
    await expect(runAzureBootstrap(input)).rejects.toThrow('ROLE_APPLY_FAILED');
    expect(input.migrate).not.toHaveBeenCalled();
    expect(input.lockMigrator).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', 'short'],
    ['shell metacharacters', `${'a'.repeat(40)}';--`],
    ['not a string', undefined],
  ])('rejects a runtime password that is %s before connecting', async (_label, runtimePassword) => {
    const { input } = harness({ runtimePassword });
    const error = await runAzureBootstrap(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AzureBootstrapError);
    expect(error).toMatchObject({ code: 'RUNTIME_PASSWORD_INVALID' });
    expect(input.applyRoles).not.toHaveBeenCalled();
  });

  it('refuses a migrator password equal to the runtime password', async () => {
    const { input } = harness({ generatePassword: () => RUNTIME_PASSWORD });
    await expect(runAzureBootstrap(input)).rejects.toMatchObject({
      code: 'MIGRATOR_PASSWORD_INVALID',
    });
    expect(input.applyRoles).not.toHaveBeenCalled();
  });
});
