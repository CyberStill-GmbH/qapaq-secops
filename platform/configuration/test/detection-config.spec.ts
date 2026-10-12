import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../src/configuration.errors.js';
import { loadDetectionContextConfig, loadEntityRefKey } from '../src/configuration-loader.js';
import { DETECTION_CONTEXT_LIMITS } from '../src/schema/detection.schema.js';

/** Valores sintéticos: ninguna cuenta ni activo de esta spec existe (R-20). */
function rejectedPath(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigurationError) return error.path;
    throw error;
  }
  throw new Error('Se esperaba un ConfigurationError.');
}

const BASE = { QAPAQ_PROFILE: 'test' } as const;

describe('C-16 · contexto de detección', () => {
  it('sin variables arranca con listas vacías: prioriza solo por severidad', () => {
    const config = loadDetectionContextConfig(BASE);

    expect(config).toEqual({
      privilegedIdentities: [],
      breakGlassIdentities: [],
      criticalAssets: [],
      internetFacingAssets: [],
      knownBenignRules: [],
    });
  });

  it('normaliza identidades a minúsculas y elimina duplicados', () => {
    const config = loadDetectionContextConfig({
      ...BASE,
      QAPAQ_DETECTION_PRIVILEGED_IDENTITIES:
        'Admin.Sintetico@qapaq-lab.example, admin.sintetico@qapaq-lab.example,,ops@qapaq-lab.example',
    });

    expect(config.privilegedIdentities).toEqual([
      'admin.sintetico@qapaq-lab.example',
      'ops@qapaq-lab.example',
    ]);
  });

  it('toda cuenta break-glass cuenta también como privilegiada', () => {
    const config = loadDetectionContextConfig({
      ...BASE,
      QAPAQ_DETECTION_BREAK_GLASS_IDENTITIES: 'BG-01@qapaq-lab.example',
    });

    expect(config.breakGlassIdentities).toEqual(['bg-01@qapaq-lab.example']);
    expect(config.privilegedIdentities).toContain('bg-01@qapaq-lab.example');
  });

  it('exige referencia documental para cada regla benigna', () => {
    const config = loadDetectionContextConfig({
      ...BASE,
      QAPAQ_DETECTION_KNOWN_BENIGN_RULES: '91532:CAB-2026-014,100520:ACTA-SOC-07',
    });

    expect(config.knownBenignRules).toEqual([
      { ruleId: '91532', reference: 'CAB-2026-014' },
      { ruleId: '100520', reference: 'ACTA-SOC-07' },
    ]);
    expect(
      rejectedPath(() =>
        loadDetectionContextConfig({ ...BASE, QAPAQ_DETECTION_KNOWN_BENIGN_RULES: '91532' }),
      ),
    ).toBe('QAPAQ_DETECTION_KNOWN_BENIGN_RULES');
    expect(
      rejectedPath(() =>
        loadDetectionContextConfig({ ...BASE, QAPAQ_DETECTION_KNOWN_BENIGN_RULES: '91532:' }),
      ),
    ).toBe('QAPAQ_DETECTION_KNOWN_BENIGN_RULES');
  });

  it('rechaza la misma regla benigna declarada dos veces', () => {
    expect(
      rejectedPath(() =>
        loadDetectionContextConfig({
          ...BASE,
          QAPAQ_DETECTION_KNOWN_BENIGN_RULES: '91532:CAB-1,91532:CAB-2',
        }),
      ),
    ).toBe('QAPAQ_DETECTION_KNOWN_BENIGN_RULES');
  });

  it.each(['admin con espacio@qapaq-lab.example', 'a;b', `${'x'.repeat(321)}`])(
    'rechaza la entrada mal formada %s en lugar de ignorarla',
    (entry) => {
      expect(
        rejectedPath(() =>
          loadDetectionContextConfig({ ...BASE, QAPAQ_DETECTION_CRITICAL_ASSETS: entry }),
        ),
      ).toBe('QAPAQ_DETECTION_CRITICAL_ASSETS');
    },
  );

  it('limita la cantidad de entradas por lista', () => {
    const tooMany = Array.from(
      { length: DETECTION_CONTEXT_LIMITS.maximumEntries + 1 },
      (_, index) => `activo-${index}`,
    ).join(',');

    expect(
      rejectedPath(() =>
        loadDetectionContextConfig({ ...BASE, QAPAQ_DETECTION_CRITICAL_ASSETS: tooMany }),
      ),
    ).toBe('QAPAQ_DETECTION_CRITICAL_ASSETS');
  });

  it('el resultado es inmutable', () => {
    const config = loadDetectionContextConfig({
      ...BASE,
      QAPAQ_DETECTION_CRITICAL_ASSETS: 'srv-core-01',
    });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.criticalAssets)).toBe(true);
  });
});

describe('D-10b/D-13 · clave de referencias de entidad', () => {
  const PRODUCTION = { QAPAQ_PROFILE: 'production' } as const;

  it('en memoria puede faltar: el API arranca sin pivote', () => {
    expect(loadEntityRefKey({ ...PRODUCTION, QAPAQ_SOC_PERSISTENCE: 'memory' })).toBeUndefined();
  });

  it('con persistencia postgres es obligatoria', () => {
    expect(
      rejectedPath(() => loadEntityRefKey({ ...PRODUCTION, QAPAQ_SOC_PERSISTENCE: 'postgres' })),
    ).toBe('QAPAQ_ENTITY_REF_KEY');
  });

  it('rechaza una clave corta en cualquier modo', () => {
    expect(
      rejectedPath(() =>
        loadEntityRefKey({
          ...PRODUCTION,
          QAPAQ_SOC_PERSISTENCE: 'memory',
          QAPAQ_ENTITY_REF_KEY: 'corta',
        }),
      ),
    ).toBe('QAPAQ_ENTITY_REF_KEY');
  });

  it('acepta una clave de 32 o más caracteres y no la expone al serializar', () => {
    const key = loadEntityRefKey({
      ...PRODUCTION,
      QAPAQ_SOC_PERSISTENCE: 'postgres',
      QAPAQ_ENTITY_REF_KEY: 'k'.repeat(48),
    });
    expect(key?.reveal()).toHaveLength(48);
    expect(JSON.stringify({ key })).not.toContain('kkkk');
  });
});
