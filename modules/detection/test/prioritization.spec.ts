import { describe, expect, it } from 'vitest';

import {
  prioritize,
  PRIORITY_THRESHOLDS,
  priorityForScore,
  PROMOTION_THRESHOLD,
  PROVIDER_CONTEXT_GROUPS,
  type PrioritizationContext,
} from '../src/prioritization.js';
import { securityEvent, withSeverity } from './support/events.js';

const EMPTY_CONTEXT: PrioritizationContext = {
  privilegedIdentities: new Set(),
  criticalAssets: new Set(),
};

function tagged(
  severity: Parameters<typeof withSeverity>[0],
  groups: readonly string[],
  ruleId = '101600',
) {
  return withSeverity(severity, {
    detection: {
      rule: {
        id: ruleId,
        name: 'Regla de prioridad QAPAQ',
        provider: 'wazuh',
        groups: [...groups],
      },
    },
  });
}

function reasonCodes(context: PrioritizationContext, event = securityEvent()) {
  return prioritize(event, context).reasons.map((reason) => reason.code);
}

describe('C-16 · priorización', () => {
  it('parte de la severidad normalizada y lo declara como razón', () => {
    const outcome = prioritize(withSeverity('high'), EMPTY_CONTEXT);

    expect(outcome.reasons[0]).toMatchObject({ code: 'BASE_SEVERITY', delta: 60 });
    // Sin contexto QAPAQ, una alerta alta de Wazuh entra como P3: la severidad del SIEM
    // por sí sola no reclama atención inmediata.
    expect(outcome.priority).toBe('P3');
  });

  it('ordena las severidades de forma monótona', () => {
    const scores = (['informational', 'low', 'medium', 'high', 'critical'] as const).map(
      (severity) => prioritize(withSeverity(severity), EMPTY_CONTEXT).score,
    );

    expect(scores).toEqual([...scores].sort((left, right) => left - right));
  });

  it('eleva la prioridad cuando participa una identidad privilegiada', () => {
    const context: PrioritizationContext = {
      ...EMPTY_CONTEXT,
      privilegedIdentities: new Set(['jperez@qapaq.pe']),
    };
    const base = prioritize(securityEvent(), EMPTY_CONTEXT);
    const elevated = prioritize(securityEvent(), context);

    expect(elevated.score).toBeGreaterThan(base.score);
    expect(reasonCodes(context)).toContain('PRIVILEGED_IDENTITY');
  });

  it('eleva la prioridad por activo crítico y por exposición a Internet', () => {
    const context: PrioritizationContext = {
      ...EMPTY_CONTEXT,
      criticalAssets: new Set(['host-1']),
      internetFacingAssets: new Set(['srv-app-01.qapaq.local']),
    };

    expect(reasonCodes(context)).toEqual(
      expect.arrayContaining(['CRITICAL_ASSET', 'EXTERNAL_EXPOSURE']),
    );
  });

  it('eleva la prioridad ante actividad ofensiva exitosa', () => {
    const event = securityEvent({ outcome: 'success', category: ['malware'] });

    expect(prioritize(event, EMPTY_CONTEXT).reasons.map((reason) => reason.code)).toContain(
      'SUCCESSFUL_INTRUSION',
    );
  });

  it('no eleva por repetición hasta alcanzar el umbral de la ventana', () => {
    expect(reasonCodes({ ...EMPTY_CONTEXT, recentSimilarCount: 4 })).not.toContain(
      'REPEATED_ACTIVITY',
    );
    expect(reasonCodes({ ...EMPTY_CONTEXT, recentSimilarCount: 5 })).toContain('REPEATED_ACTIVITY');
  });

  it('suprime una regla declarada benigna sin borrar la trazabilidad', () => {
    const outcome = prioritize(securityEvent(), {
      ...EMPTY_CONTEXT,
      knownBenignRuleIds: new Set(['5716']),
    });

    expect(outcome.suppressed).toBe(true);
    expect(outcome.score).toBe(0);
    expect(outcome.reasons.map((reason) => reason.code)).toEqual(['BASE_SEVERITY', 'KNOWN_BENIGN']);
  });

  it('suprime dentro de una ventana de mantenimiento y no fuera de ella', () => {
    const window = {
      from: new Date('2026-10-07T15:00:00.000Z'),
      to: new Date('2026-10-07T16:00:00.000Z'),
      reference: 'CHG-1042',
    };
    const outside = {
      ...window,
      from: new Date('2026-10-07T17:00:00.000Z'),
      to: new Date('2026-10-07T18:00:00.000Z'),
    };

    expect(
      prioritize(securityEvent(), { ...EMPTY_CONTEXT, maintenanceWindow: window }),
    ).toMatchObject({ suppressed: true });
    expect(
      prioritize(securityEvent(), { ...EMPTY_CONTEXT, maintenanceWindow: outside }),
    ).toMatchObject({ suppressed: false });
  });

  it('mantiene el evento informativo por debajo del umbral y lo explica', () => {
    const outcome = prioritize(withSeverity('informational'), EMPTY_CONTEXT);

    expect(outcome.priority).toBe('P4');
    expect(outcome.reasons.map((reason) => reason.code)).toContain('INFORMATIONAL_ONLY');
  });

  it('acota el puntaje al rango 0-100 aun acumulando todos los ajustes', () => {
    const outcome = prioritize(
      withSeverity('critical', { outcome: 'success', category: ['malware'] }),
      {
        privilegedIdentities: new Set(['jperez@qapaq.pe']),
        criticalAssets: new Set(['host-1']),
        internetFacingAssets: new Set(['host-1']),
        recentSimilarCount: 20,
      },
    );

    expect(outcome.score).toBe(100);
    expect(outcome.priority).toBe('P1');
  });

  it('es determinista: la misma entrada produce el mismo resultado', () => {
    const context: PrioritizationContext = {
      ...EMPTY_CONTEXT,
      privilegedIdentities: new Set(['jperez@qapaq.pe']),
    };

    expect(prioritize(securityEvent(), context)).toEqual(prioritize(securityEvent(), context));
  });

  it('mapea puntaje a prioridad en los bordes declarados', () => {
    expect(priorityForScore(PRIORITY_THRESHOLDS.P1)).toBe('P1');
    expect(priorityForScore(PRIORITY_THRESHOLDS.P1 - 1)).toBe('P2');
    expect(priorityForScore(PRIORITY_THRESHOLDS.P3)).toBe('P3');
    expect(priorityForScore(PRIORITY_THRESHOLDS.P3 - 1)).toBe('P4');
  });

  describe('1.2.0 · contexto declarado por el SIEM (infra/wazuh/priority)', () => {
    it('cuenta la etiqueta de activo crítico del SIEM como CRITICAL_ASSET', () => {
      const outcome = prioritize(
        tagged('critical', ['qapaq_priority', PROVIDER_CONTEXT_GROUPS.criticalAsset]),
        EMPTY_CONTEXT,
      );

      expect(outcome.reasons.map((reason) => reason.code)).toEqual([
        'BASE_SEVERITY',
        'CRITICAL_ASSET',
      ]);
      expect(outcome.reasons[1]?.detail).toContain('101600');
      expect(outcome.priority).toBe('P1');
    });

    it('no suma dos veces el mismo activo si lo marcan la lista propia y el SIEM', () => {
      const outcome = prioritize(tagged('critical', [PROVIDER_CONTEXT_GROUPS.criticalAsset]), {
        ...EMPTY_CONTEXT,
        criticalAssets: new Set(['HOST-1']),
      });

      const critical = outcome.reasons.filter((reason) => reason.code === 'CRITICAL_ASSET');
      expect(critical).toHaveLength(1);
      expect(critical[0]?.detail).toContain('host-1');
    });

    it('sube estaciones sensibles y horario no laboral, que solo conoce el SIEM', () => {
      const sensitive = prioritize(
        tagged('high', [PROVIDER_CONTEXT_GROUPS.sensitiveWorkstation]),
        EMPTY_CONTEXT,
      );
      const offHours = prioritize(
        tagged('high', [
          PROVIDER_CONTEXT_GROUPS.privilegedIdentity,
          PROVIDER_CONTEXT_GROUPS.offHours,
        ]),
        EMPTY_CONTEXT,
      );

      expect(sensitive.reasons.map((reason) => reason.code)).toContain('SENSITIVE_WORKSTATION');
      expect(sensitive.score).toBe(70);
      expect(offHours.reasons.map((reason) => reason.code)).toEqual([
        'BASE_SEVERITY',
        'PRIVILEGED_IDENTITY',
        'OFF_HOURS',
      ]);
      expect(offHours.score).toBe(80);
    });

    it('no re-eleva una regla que el SIEM rebajó por ruido conocido', () => {
      const outcome = prioritize(tagged('low', [PROVIDER_CONTEXT_GROUPS.tunedDown], '101604'), {
        ...EMPTY_CONTEXT,
        criticalAssets: new Set(['host-1']),
      });

      expect(outcome.reasons.map((reason) => reason.code)).toEqual([
        'BASE_SEVERITY',
        'PROVIDER_TUNED_DOWN',
      ]);
      expect(outcome.priority).toBe('P4');
      expect(outcome.score).toBeLessThan(PROMOTION_THRESHOLD);
    });

    it('una rebaja del SIEM no apaga una cuenta break-glass', () => {
      const outcome = prioritize(tagged('low', [PROVIDER_CONTEXT_GROUPS.tunedDown]), {
        ...EMPTY_CONTEXT,
        breakGlassIdentities: new Set(['jperez@qapaq.pe']),
      });

      expect(outcome.priority).toBe('P1');
      expect(outcome.reasons.map((reason) => reason.code)).toContain('BREAK_GLASS_IDENTITY');
    });

    // Matriz de docs/security/agents/03-matriz-priorizacion.md: nivel Wazuh → P del núcleo.
    it.each([
      ['critical', [], 'P2'],
      ['critical', [PROVIDER_CONTEXT_GROUPS.criticalAsset], 'P1'],
      ['critical', [PROVIDER_CONTEXT_GROUPS.privilegedIdentity], 'P1'],
      ['critical', [PROVIDER_CONTEXT_GROUPS.sensitiveWorkstation], 'P1'],
      ['critical', [PROVIDER_CONTEXT_GROUPS.internetFacing], 'P1'],
      ['high', [], 'P3'],
      ['high', [PROVIDER_CONTEXT_GROUPS.internetFacing], 'P2'],
      ['high', [PROVIDER_CONTEXT_GROUPS.criticalAsset], 'P2'],
      ['medium', [], 'P3'],
      ['medium', [PROVIDER_CONTEXT_GROUPS.criticalAsset], 'P3'],
      ['low', [], 'P4'],
      ['low', [PROVIDER_CONTEXT_GROUPS.tunedDown], 'P4'],
    ] as const)('nivel %s con %j queda en %s', (severity, groups, priority) => {
      expect(prioritize(tagged(severity, groups), EMPTY_CONTEXT).priority).toBe(priority);
    });

    it('publica la versión del ruleset que introduce el contexto del SIEM', () => {
      expect(prioritize(securityEvent(), EMPTY_CONTEXT).rulesetVersion).toBe('1.2.0');
    });
  });

  it('no inventa detección propia: la regla citada es la del proveedor', () => {
    const outcome = prioritize(securityEvent(), EMPTY_CONTEXT);

    expect(outcome.rulesetId).toBe('qapaq.detection.prioritization');
    expect(JSON.stringify(outcome.reasons)).not.toContain('qapaq.rule');
  });
});
