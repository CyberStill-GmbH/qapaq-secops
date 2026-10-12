/**
 * Contrato entre las reglas locales de Wazuh (infra/wazuh/office365) y QAPAQ.
 *
 * Las reglas se prueban contra un manager real con `tests/run-logtest.sh`. Esta spec
 * cubre lo que no necesita Wazuh y que se rompería en silencio si alguien edita un lado:
 *
 * - IDs dentro del rango reservado 100500-100549 y sin duplicados;
 * - toda regla operativa (nivel >= 7) declara técnica MITRE y un grupo `qapaq_<táctica>`
 *   que la correlación de C-16 reconoce;
 * - toda regla referencia como padre una regla oficial conocida o una local existente;
 * - los casos de logtest y sus expectativas están alineados y solo usan datos sintéticos.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { signalOf, SIGNAL_CLASSES } from '../../modules/detection/src/correlation.js';
import type { SecurityEvent } from '@qapaq/contracts';

const ROOT = resolve(import.meta.dirname, '../..');
const BASE = resolve(ROOT, 'infra/wazuh/office365');

/** Reglas oficiales de 0755-office365_rules.xml (Wazuh 4.14.x) usadas como padre. */
const OFFICIAL_PARENTS = new Set(['91532', '91540', '91545']);

interface ParsedRule {
  readonly id: string;
  readonly level: number;
  readonly body: string;
}

async function rules(): Promise<readonly ParsedRule[]> {
  const xml = await readFile(resolve(BASE, 'rules/qapaq_office365_rules.xml'), 'utf8');
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/gu, '');
  return [
    ...withoutComments.matchAll(/<rule id="(\d+)" level="(\d+)"[^>]*>([\s\S]*?)<\/rule>/gu),
  ].map((match) => ({ id: match[1]!, level: Number(match[2]), body: match[3]! }));
}

function groupsOf(rule: ParsedRule): readonly string[] {
  const declared = /<group>([^<]*)<\/group>/u.exec(rule.body)?.[1] ?? '';
  return ['office365', 'qapaq_m365', ...declared.split(',').map((group) => group.trim())].filter(
    (group) => group.length > 0,
  );
}

/** Evento mínimo: `signalOf` solo mira grupos, acción, categoría y resultado. */
function eventWithGroups(groups: readonly string[]): SecurityEvent {
  return {
    category: ['iam'],
    outcome: 'unknown',
    detection: { rule: { id: 'x', name: 'x', provider: 'x', groups: [...groups] } },
  } as unknown as SecurityEvent;
}

describe('Wazuh Office 365 · reglas locales', () => {
  it('usa IDs únicos dentro del rango reservado', async () => {
    const ids = (await rules()).map((rule) => Number(rule.id));

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id >= 100500 && id <= 100549)).toBe(true);
  });

  it('toda regla operativa declara técnica MITRE', async () => {
    const missing = (await rules())
      .filter((rule) => rule.level >= 7 && !/<mitre>\s*<id>T\d{4}/u.test(rule.body))
      .map((rule) => rule.id);

    expect(missing).toEqual([]);
  });

  it('cada regla clasifica a una señal conocida por la correlación de C-16', async () => {
    for (const rule of await rules()) {
      const signal = signalOf(eventWithGroups(groupsOf(rule)));
      expect(SIGNAL_CLASSES, `regla ${rule.id}`).toContain(signal);
      expect(signal, `regla ${rule.id} sin grupo qapaq_<táctica>`).not.toBe('other');
    }
  });

  it('solo cuelga de reglas oficiales conocidas o de reglas locales existentes', async () => {
    const parsed = await rules();
    const local = new Set(parsed.map((rule) => rule.id));
    for (const rule of parsed) {
      const parents = [
        ...rule.body.matchAll(/<if_(?:matched_)?sid>([^<]+)<\/if_(?:matched_)?sid>/gu),
      ].flatMap((match) => match[1]!.split(',').map((id) => id.trim()));
      expect(parents.length, `regla ${rule.id} sin padre`).toBeGreaterThan(0);
      for (const parent of parents) {
        expect(
          OFFICIAL_PARENTS.has(parent) || local.has(parent),
          `regla ${rule.id} cuelga de ${parent}`,
        ).toBe(true);
      }
    }
  });
});

describe('Wazuh Office 365 · casos de logtest', () => {
  it('cada caso tiene una expectativa y apunta a una regla existente u oficial', async () => {
    const cases = (await readFile(resolve(BASE, 'tests/logtest-cases.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const expected = (await readFile(resolve(BASE, 'tests/expected-rules.txt'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const local = new Set((await rules()).map((rule) => rule.id));

    expect(cases).toHaveLength(expected.length);
    for (const want of expected) {
      expect(local.has(want.replace(/^!/u, '')), `expectativa ${want}`).toBe(true);
    }
  });

  it('los casos solo contienen datos sintéticos', async () => {
    const cases = await readFile(resolve(BASE, 'tests/logtest-cases.jsonl'), 'utf8');
    const domains = [...cases.matchAll(/@([a-z0-9.-]+)/giu)].map((match) => match[1]!);
    const ips = [...cases.matchAll(/"ClientIP":"([^"]+)"/gu)].map((match) => match[1]!);

    expect(domains.every((domain) => domain.endsWith('.example'))).toBe(true);
    // RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24.
    expect(ips.every((ip) => /^(192\.0\.2|198\.51\.100|203\.0\.113)\./u.test(ip))).toBe(true);
  });
});
