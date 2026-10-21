import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { summarizePlan } from './azure-tf-plan-summary.mjs';

test('plan-summary script usage fails closed without a plan path', () => {
  const result = spawnSync(process.execPath, ['scripts/ci/azure-tf-plan-summary.mjs'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/u);
});

test('summarizePlan keeps only address/actions and flags delete and replacement', () => {
  const result = summarizePlan({
    resource_changes: [
      {
        address: 'azurerm_storage_account.raw',
        change: { actions: ['no-op'], after: { token: 'sensitive' } },
      },
      {
        address: 'azurerm_key_vault.this',
        change: { actions: ['delete', 'create'], after: { secret: 'sensitive' } },
      },
      {
        address: 'azurerm_postgresql_flexible_server.this',
        change: { actions: ['update'], after: { password: 'sensitive' } },
      },
    ],
  });

  assert.deepEqual(result.changes, [
    { address: 'azurerm_key_vault.this', actions: ['delete', 'create'] },
    { address: 'azurerm_postgresql_flexible_server.this', actions: ['update'] },
  ]);
  assert.deepEqual(result.destructive, [
    { address: 'azurerm_key_vault.this', actions: ['delete', 'create'] },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /sensitive/u);
});

test('CLI rejects destructive plans and prints only resource addresses/actions', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'azure-plan-summary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const planPath = join(directory, 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({
      resource_changes: [
        {
          address: 'azurerm_key_vault.this',
          change: { actions: ['delete', 'create'], after: { secret: 'do-not-print' } },
        },
      ],
    }),
  );
  const blocked = spawnSync(process.execPath, ['scripts/ci/azure-tf-plan-summary.mjs', planPath], {
    encoding: 'utf8',
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /azurerm_key_vault\.this/u);
  assert.doesNotMatch(blocked.stderr, /do-not-print/u);
});
