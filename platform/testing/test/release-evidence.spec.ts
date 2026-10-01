import { describe, expect, it } from 'vitest';

import {
  buildReleaseEvidence,
  decideReadiness,
  renderMarkdown,
  validateMatrix,
  type EvidenceItem,
  type ReleaseContext,
} from '../src/evidence/release-evidence.js';

const CONTEXT: ReleaseContext = {
  commit: 'a'.repeat(40),
  environment: 'local-windows-docker',
  generatedAt: '2026-10-20T12:00:00.000Z',
  toolchain: { node: '24.21.0', pnpm: '12.4.2' },
};

function item(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: 'C-17-lifecycle',
    component: 'C-17',
    requirement: 'Lifecycle de alerta con transiciones inválidas rechazadas.',
    priority: 'P0',
    status: 'PASS',
    evidence: 'pnpm test:unit modules/soc/test',
    ...overrides,
  };
}

describe('C-22 · decisión de preparación', () => {
  it('declara MVP CANDIDATE solo si todo P0 está en PASS', () => {
    const outcome = decideReadiness([item(), item({ id: 'C-19-chain', component: 'C-19' })]);

    expect(outcome.decision).toBe('MVP_CANDIDATE');
    expect(outcome.blocked).toEqual([]);
  });

  it('un P0 en FAIL produce NOT READY aunque el resto pase', () => {
    const outcome = decideReadiness([
      item(),
      item({ id: 'C-20-teams', component: 'C-20', status: 'FAIL' }),
    ]);

    expect(outcome.decision).toBe('NOT_READY');
    expect(outcome.failing).toEqual(['C-20-teams']);
  });

  it('un P0 bloqueado impide la promoción y produce LIMITED', () => {
    const outcome = decideReadiness([
      item(),
      item({
        id: 'C-10-wazuh-real',
        component: 'C-10',
        status: 'BLOCKED',
        blockedBy: 'Sin acceso autorizado a Wazuh.',
        owner: 'Infraestructura',
        dueDate: '2026-10-31',
      }),
    ]);

    expect(outcome.decision).toBe('LIMITED');
    expect(outcome.blocked).toEqual(['C-10-wazuh-real']);
    expect(outcome.rationale).toContain('gate');
  });

  it('un P0 sin ejecutar no es un riesgo aceptado: es NOT READY', () => {
    const outcome = decideReadiness([item({ status: 'NOT_RUN' })]);

    expect(outcome.decision).toBe('NOT_READY');
    expect(outcome.notRun).toEqual(['C-17-lifecycle']);
  });

  it('un P1 bloqueado no degrada la decisión', () => {
    const outcome = decideReadiness([
      item(),
      item({
        id: 'C-23-provider',
        priority: 'P1',
        status: 'BLOCKED',
        owner: 'Plataforma',
        dueDate: '2026-11-15',
      }),
    ]);

    expect(outcome.decision).toBe('MVP_CANDIDATE');
  });

  it('FAIL pesa más que BLOCKED en la misma matriz', () => {
    const outcome = decideReadiness([
      item({ id: 'a', status: 'FAIL' }),
      item({ id: 'b', status: 'BLOCKED', owner: 'x', dueDate: 'y' }),
    ]);

    expect(outcome.decision).toBe('NOT_READY');
  });
});

describe('C-22 · validación de la propia matriz', () => {
  it('exige commit completo y ambiente', () => {
    const problems = validateMatrix({ ...CONTEXT, commit: 'abc', environment: ' ' }, [item()]);

    expect(problems.map((problem) => problem.code)).toEqual([
      'COMMIT_REQUIRED',
      'ENVIRONMENT_REQUIRED',
    ]);
  });

  it('rechaza un bloqueo sin dueño ni fecha', () => {
    const problems = validateMatrix(CONTEXT, [item({ status: 'BLOCKED' })]);

    expect(problems.map((problem) => problem.code)).toEqual([
      'BLOCKED_WITHOUT_OWNER',
      'BLOCKED_WITHOUT_DUE_DATE',
    ]);
  });

  it('rechaza estados sin evidencia repetible y identificadores duplicados', () => {
    const problems = validateMatrix(CONTEXT, [
      item({ evidence: '  ' }),
      item({ id: 'C-17-lifecycle' }),
    ]);

    expect(problems.map((problem) => problem.code)).toContain('EVIDENCE_REQUIRED');
    expect(problems.map((problem) => problem.code)).toContain('DUPLICATE_ID');
  });

  it('una matriz válida no reporta problemas', () => {
    expect(validateMatrix(CONTEXT, [item()])).toEqual([]);
  });
});

describe('C-22 · presentación', () => {
  it('ata la matriz al commit, al ambiente y al toolchain', () => {
    const markdown = renderMarkdown(buildReleaseEvidence(CONTEXT, [item()]));

    expect(markdown).toContain(CONTEXT.commit);
    expect(markdown).toContain('local-windows-docker');
    expect(markdown).toContain('node 24.21.0');
    expect(markdown).toContain('MVP_CANDIDATE');
  });

  it('muestra bloqueo, dueño y fecha en la fila bloqueada', () => {
    const markdown = renderMarkdown(
      buildReleaseEvidence(CONTEXT, [
        item({
          id: 'C-18-entra',
          status: 'BLOCKED',
          blockedBy: 'Tenant Entra no disponible',
          owner: 'Seguridad',
          dueDate: '2026-10-31',
        }),
      ]),
    );

    expect(markdown).toContain('Tenant Entra no disponible');
    expect(markdown).toContain('Seguridad');
    expect(markdown).toContain('2026-10-31');
    expect(markdown).toContain('LIMITED');
  });

  it('expone los problemas de la matriz en el propio documento', () => {
    const markdown = renderMarkdown(
      buildReleaseEvidence({ ...CONTEXT, commit: 'corto' }, [item()]),
    );

    expect(markdown).toContain('Problemas de la propia matriz');
    expect(markdown).toContain('COMMIT_REQUIRED');
  });
});
