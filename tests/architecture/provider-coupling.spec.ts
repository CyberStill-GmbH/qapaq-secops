/**
 * C-23 — acoplamiento a proveedor y conformidad de la extensión.
 *
 * La afirmación que hay que sostener es que añadir un segundo proveedor no obliga a
 * tocar el dominio. En lugar de escribir un proveedor ficticio —que probaría que
 * nuestro propio doble encaja con nuestro propio puerto, y poco más—, estas specs
 * comprueban dos cosas sobre el código real:
 *
 * 1. **Dónde puede aparecer el vocabulario del proveedor.** Wazuh, OpenSearch o
 *    Microsoft pueden nombrarse en infraestructura, en el mapping versionado y en
 *    configuración. En el dominio SOC, de detección, de acceso o de auditoría, no.
 * 2. **Qué debe cumplir un adapter para considerarse conforme.** Las reglas están
 *    declaradas y se verifican contra el adapter Wazuh real, que es el único que
 *    existe.
 */

import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** Vocabulario que delata una decisión de proveedor incrustada en el código. */
const PROVIDER_VOCABULARY = [
  /\bwazuh\b/iu,
  /\bopensearch\b/iu,
  /\belasticsearch\b/iu,
  /\bmicrosoft\s*365\b/iu,
  /\bgraph\.microsoft\b/iu,
  /\bsophos\b/iu,
  /\bcato\b/iu,
];

/**
 * Inventario explícito de código que sí puede nombrar al proveedor, con el motivo.
 *
 * La lista es la regla: un archivo nuevo que nombre un proveedor falla hasta que alguien
 * decida conscientemente añadirlo aquí, y esa decisión queda en el historial.
 */
const PROVIDER_AWARE: Readonly<Record<string, string>> = {
  'modules/connectors/src/infrastructure/': 'Adapter del proveedor: su lugar natural.',
  'modules/connectors/src/public/index.ts': 'Expone la fábrica del adapter existente.',
  'modules/telemetry/src/wazuh-normalization.ts': 'Mapping versionado hacia el contrato.',
  'modules/telemetry/src/index.ts': 'Reexporta el mapping versionado.',
  'modules/telemetry/src/quarantine-reprocess.ts': 'Linaje de cuarentena del mapping.',
  'modules/telemetry/src/event-projection.ts': 'Proyección al índice de consulta elegido.',
  'modules/telemetry/src/ports.ts': 'Puerto del índice de consulta elegido.',
  'platform/gateway/': 'Configuración de la pasarela y su allowlist de rutas.',
  'platform/configuration/src/schema/': 'Esquema de configuración por proveedor.',
  'platform/configuration/src/configuration.types.ts': 'Tipos de configuración.',
  'platform/configuration/src/configuration-loader.ts': 'Carga de configuración.',
  'platform/configuration/src/profiles/': 'Valores por perfil.',
  'platform/testing/src/': 'Entorno de integración con servicios reales.',
};

/** Módulos que deben quedar completamente libres de vocabulario de proveedor. */
const PROVIDER_FREE_AREAS = [
  'modules/detection/src',
  'modules/soc/src',
  'modules/soar/src',
  'modules/access/src',
  'platform/audit/src',
  'packages/contracts/src/api-error',
];

async function sourceFiles(directory: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return ['node_modules', 'dist', 'generated'].includes(entry.name) ? [] : sourceFiles(path);
      }
      return /\.(?:ts|tsx|mjs)$/u.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

function isProviderAware(path: string): boolean {
  const relativePath = relative(ROOT, path).replaceAll('\\', '/');
  return Object.keys(PROVIDER_AWARE).some((allowed) => relativePath.startsWith(allowed));
}

describe('C-23 · acoplamiento a proveedor', () => {
  it('ningún módulo de dominio nombra al proveedor', async () => {
    const offenders: string[] = [];
    for (const area of PROVIDER_FREE_AREAS) {
      for (const file of await sourceFiles(resolve(ROOT, area))) {
        const content = await readFile(file, 'utf8');
        for (const pattern of PROVIDER_VOCABULARY) {
          if (pattern.test(content)) {
            offenders.push(`${relative(ROOT, file).replaceAll('\\', '/')} ~ ${pattern.source}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('el vocabulario del proveedor vive solo en el inventario declarado', async () => {
    const areas = ['modules', 'platform', 'packages'];
    const unexpected: string[] = [];
    for (const area of areas) {
      for (const file of await sourceFiles(resolve(ROOT, area))) {
        const relativePath = relative(ROOT, file).replaceAll('\\', '/');
        // Las specs describen casos reales y citan al proveedor por necesidad; la regla
        // se aplica al código que se despliega.
        if (relativePath.includes('/test/') || isProviderAware(file)) continue;
        const content = await readFile(file, 'utf8');
        for (const pattern of PROVIDER_VOCABULARY) {
          if (pattern.test(content)) {
            unexpected.push(`${relative(ROOT, file).replaceAll('\\', '/')} ~ ${pattern.source}`);
          }
        }
      }
    }

    // Si esta lista crece, la decisión es consciente: o el archivo pertenece a
    // infraestructura, o el acoplamiento hay que quitarlo.
    expect(unexpected).toEqual([]);
  });

  it('el contrato canónico no privilegia a ningún proveedor', async () => {
    const schema = await readFile(
      resolve(ROOT, 'packages/contracts/src/security-event/security-event.schema.json'),
      'utf8',
    );

    for (const pattern of PROVIDER_VOCABULARY) {
      expect(schema, `el esquema menciona ${pattern.source}`).not.toMatch(pattern);
    }
  });

  it('el dominio SOC consume detección por contrato, no por tipos del proveedor', async () => {
    const socSources = await sourceFiles(resolve(ROOT, 'modules/soc/src'));
    const imports = (await Promise.all(socSources.map((file) => readFile(file, 'utf8')))).join(
      '\n',
    );

    expect(imports).not.toMatch(/from '@qapaq\/connectors/u);
    expect(imports).toMatch(/from '@qapaq\/detection/u);
  });
});

describe('C-23 · conformidad del adapter real', () => {
  it('existe una suite de conformidad portable e independiente del adapter', async () => {
    const suite = await readFile(
      resolve(ROOT, 'modules/connectors/src/testing/security-event-provider.contract.ts'),
      'utf8',
    );

    expect(suite).toContain('defineSecurityEventProviderContract');
    // La suite recibe el proveedor por parámetro: no construye ninguno.
    expect(suite).toContain('harness.createProvider()');
    for (const pattern of PROVIDER_VOCABULARY) {
      expect(suite, `la suite menciona ${pattern.source}`).not.toMatch(pattern);
    }
  });

  it('el adapter Wazuh real se somete a la suite de conformidad', async () => {
    const spec = await readFile(
      resolve(ROOT, 'modules/connectors/test/wazuh-security-event.provider.spec.ts'),
      'utf8',
    );

    expect(spec).toContain('defineSecurityEventProviderContract');
  });

  it('el adapter solo se expone por la superficie pública del módulo', async () => {
    const publicApi = await readFile(
      resolve(ROOT, 'modules/connectors/src/public/index.ts'),
      'utf8',
    );

    expect(publicApi).toContain('SecurityEventProvider');
    // Lo que sale del módulo es una fábrica, no el cliente HTTP ni sus tipos internos.
    expect(publicApi).not.toMatch(/gateway\.client/u);
    expect(publicApi).toMatch(/createWazuhSecurityEventProvider/u);
  });

  it('la guía de extensión documenta el procedimiento y las reglas verificadas', async () => {
    const guide = await readFile(
      resolve(ROOT, 'docs/development/provider-extension-guide.md'),
      'utf8',
    );

    for (const requirement of [
      'SecurityEventProvider',
      'defineSecurityEventProviderContract',
      'routes.json',
      'mappingVersion',
    ]) {
      expect(guide, `la guía no cubre ${requirement}`).toContain(requirement);
    }
  });
});
