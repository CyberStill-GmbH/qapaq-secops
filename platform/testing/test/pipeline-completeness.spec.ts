import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type StageStatus = 'PASS' | 'BLOCKED' | 'NOT_RUN';

interface PipelineStage {
  readonly name: string;
  readonly status: StageStatus;
  readonly evidence: string;
}

const stages: readonly PipelineStage[] = [
  { name: 'source-and-preflight', status: 'PASS', evidence: 'IntegrationEnvironment.preflight' },
  {
    name: 'raw-object-storage',
    status: 'BLOCKED',
    evidence: 'Falta operación S3 CRUD con hash y metadata',
  },
  {
    name: 'postgres-admission',
    status: 'PASS',
    evidence: 'Migración C-04 y suite PostgreSQL real',
  },
  { name: 'redis-dispatch', status: 'PASS', evidence: 'PING y roundtrip Redis en suite real' },
  {
    name: 'normalization',
    status: 'NOT_RUN',
    evidence: 'No existe pipeline de normalización ejecutable',
  },
  {
    name: 'opensearch-qapaq',
    status: 'BLOCKED',
    evidence: 'TLS y cliente de integración pendientes',
  },
  {
    name: 'wazuh-manager-to-indexer',
    status: 'BLOCKED',
    evidence: 'Topología oficial y smoke E2E pendientes',
  },
];

describe('auditoría ejecutable del flujo C-06', () => {
  it('conserva el orden del flujo y no presenta el pipeline incompleto como PASS', () => {
    expect(stages.map((stage) => stage.name)).toEqual([
      'source-and-preflight',
      'raw-object-storage',
      'postgres-admission',
      'redis-dispatch',
      'normalization',
      'opensearch-qapaq',
      'wazuh-manager-to-indexer',
    ]);
    expect(stages.some((stage) => stage.status === 'BLOCKED')).toBe(true);
    expect(stages.every((stage) => stage.status === 'PASS')).toBe(false);
  });

  it('verifica que el harness mantiene bloqueados OpenSearch y Wazuh', async () => {
    const source = await readFile(
      new URL('../src/environment/integration-environment.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('OpenSearch requiere TLS');
    expect(source).toContain('topología Wazuh requiere el Compose oficial');
  });

  it('expone evidencia diagnóstica para cada tramo no aceptado', () => {
    for (const stage of stages.filter((item) => item.status !== 'PASS')) {
      expect(stage.evidence.length).toBeGreaterThan(10);
    }
  });
});
