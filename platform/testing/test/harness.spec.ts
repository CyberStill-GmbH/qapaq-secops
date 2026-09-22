import { describe, expect, it } from 'vitest';
import { IntegrationEnvironment } from '../src/index.js';
import { redactEvidence } from '../src/evidence/environment-evidence.js';
import { safeCleanup } from '../src/cleanup/safe-cleanup.js';

describe('harness de integración C-06', () => {
  it('crea identidades independientes y no inicia servicios al importar', () => {
    const first = new IntegrationEnvironment();
    const second = new IntegrationEnvironment();
    expect(first.runId).not.toBe(second.runId);
    expect(first.state).toBe('created');
  });

  it('informa BLOCKED cuando Docker no está disponible, sin falsear PASS', async () => {
    const environment = new IntegrationEnvironment({ timeouts: { preflightMs: 1000 } });
    const report = await environment.preflight();
    expect(['PASS', 'BLOCKED']).toContain(report.status);
    if (report.status === 'BLOCKED') expect(environment.state).toBe('blocked');
  });

  it('redacta credenciales antes de persistir evidencia', () => {
    const sanitized = redactEvidence({ password: 'synthetic', nested: { token: 'synthetic' } });
    expect(JSON.stringify(sanitized)).not.toContain('synthetic');
  });

  it('solo elimina recursos etiquetados con el run actual', async () => {
    const removed: string[] = [];
    const remaining = await safeCleanup(
      [
        {
          id: 'owned',
          labels: { 'qapaq.test': 'true', 'qapaq.test.run-id': 'run-a' },
          remove: async () => {
            removed.push('owned');
          },
        },
        {
          id: 'foreign',
          labels: { 'qapaq.test': 'false' },
          remove: async () => {
            removed.push('foreign');
          },
        },
      ],
      'run-a',
    );
    expect(removed).toEqual(['owned']);
    expect(remaining).toEqual(['foreign']);
  });
});
