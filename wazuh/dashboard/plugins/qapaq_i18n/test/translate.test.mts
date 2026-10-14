/*
 * Pruebas del núcleo puro. Ejecutar: node --test test/   (Node >= 22.18 / 24, type stripping)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compileGlossary,
  glossaryLookup,
  isDataLike,
  isEligibleForMachineTranslation,
  isExcluded,
  translateText,
  translateTitle,
} from '../common/translate.ts';
import type { ElementLike } from '../common/translate.ts';

const raw = readFileSync(new URL('../public/glossary.es.json', import.meta.url), 'utf8');
const file = JSON.parse(raw);
const g = compileGlossary(file);

test('glosario: JSON válido, sin claves duplicadas, valores no vacíos', () => {
  const body = raw.slice(raw.indexOf('"entries"'));
  const keys = [...body.matchAll(/^\s{4}("(?:[^"\\]|\\.)*")\s*:/gm)].map((m) => JSON.parse(m[1]));
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dup, []);
  assert.equal(keys.length, Object.keys(file.entries).length);
  for (const [k, v] of Object.entries(file.entries)) {
    assert.ok(typeof v === 'string' && v.length > 0, `vacío: ${k}`);
    assert.equal(k, k.trim(), `espacios en clave: "${k}"`);
  }
  assert.ok(Object.keys(file.entries).length >= 600, 'glosario demasiado pequeño');
});

test('términos clave de la terminología acordada', () => {
  const expected: Record<string, string> = {
    Alerts: 'Alertas',
    Agents: 'Agentes',
    Dashboard: 'Panel',
    Discover: 'Explorar',
    Visualize: 'Visualizar',
    'Index pattern': 'Patrón de índice',
    'Saved objects': 'Objetos guardados',
    Refresh: 'Actualizar',
    'Last 24 hours': 'Últimas 24 horas',
    'Threat Hunting': 'Búsqueda de amenazas',
    'Vulnerability Detection': 'Detección de vulnerabilidades',
    'File Integrity Monitoring': 'Monitoreo de integridad de archivos',
    'Security events': 'Eventos de seguridad',
    Compliance: 'Cumplimiento',
    Rules: 'Reglas',
    Decoders: 'Decodificadores',
  };
  for (const [en, es] of Object.entries(expected)) assert.equal(glossaryLookup(g, en), es, en);
});

test('lookup: mayúsculas, puntuación final y patrones', () => {
  assert.equal(glossaryLookup(g, 'LAST UPDATED'), 'Última actualización');
  assert.equal(glossaryLookup(g, 'filter'), 'filtrar');
  assert.equal(glossaryLookup(g, 'Server address:'), 'Dirección del servidor:');
  assert.equal(glossaryLookup(g, 'Loading...'), 'Cargando...');
  assert.equal(glossaryLookup(g, '1,234 hits'), '1,234 resultados');
  assert.equal(glossaryLookup(g, 'Last 15 minutes'), 'Últimos 15 minutos');
  assert.equal(glossaryLookup(g, 'Last 45 minutes'), 'Últimos 45 minutos');
  assert.equal(glossaryLookup(g, 'Page 2 of 9'), 'Página 2 de 9');
  assert.equal(glossaryLookup(g, 'MITRE ATT&CK'), null);
  assert.equal(glossaryLookup(g, 'Totally unknown phrase'), null);
});

test('translateText: preserva espacios y aplica marca', () => {
  assert.equal(translateText(g, '  Refresh '), '  Actualizar ');
  assert.equal(translateText(g, 'Welcome to Wazuh'), 'Welcome to QAPAQ SecOps');
  assert.equal(translateText(g, 'OpenSearch Dashboards'), 'QAPAQ SecOps');
  assert.equal(translateText(g, 'Actualizar'), null);
  assert.equal(translateText(g, '192.168.1.10'), null);
  assert.equal(translateText(g, '/var/ossec/wazuh/etc'), null);
  assert.equal(translateTitle(g, 'Discover - Wazuh'), 'Explorar - QAPAQ SecOps');
});

test('isDataLike: datos de seguridad no se tocan', () => {
  for (const d of [
    '10.0.0.1',
    'fe80::1ff:fe23:4567:890a',
    'd41d8cd98f00b204e9800998ecf8427e',
    '550e8400-e29b-41d4-a716-446655440000',
    'analyst@qapaq.pe',
    '/etc/passwd',
    'C:\\Windows\\System32',
    'agent.name',
    'rule.mitre.id',
    '{"a":1}',
    '5715',
    '2026-10-13 10:00:00',
    'CVE-2024-3094',
    'never_connected',
    'https://x.y/z',
  ])
    assert.equal(isDataLike(d), true, d);
  for (const ui of ['Add filter', 'Last 24 hours', 'Threat Hunting', 'Save query']) {
    assert.equal(isDataLike(ui), false, ui);
  }
});

test('elegibilidad para traducción on-device', () => {
  assert.equal(isEligibleForMachineTranslation(g, 'Check the agent configuration'), true);
  assert.equal(isEligibleForMachineTranslation(g, 'Agents'), false); // una palabra: solo glosario
  assert.equal(isEligibleForMachineTranslation(g, 'Revise la configuración'), false); // ya en español
  assert.equal(isEligibleForMachineTranslation(g, 'sshd failed from 10.0.0.5'), false);
  assert.equal(isEligibleForMachineTranslation(g, 'MITRE ATT&CK'), false);
  assert.equal(isEligibleForMachineTranslation(g, 'x'.repeat(130) + ' y'), false);
});

function el(
  tagName: string,
  attrs: Record<string, string> = {},
  parent: ElementLike | null = null,
) {
  return {
    tagName,
    className: attrs.class || '',
    parentElement: parent,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
  } as ElementLike;
}

test('exclusión de subárboles', () => {
  const body = el('BODY');
  const header = el('DIV', { class: 'euiHeader' }, body);
  assert.equal(isExcluded(el('SPAN', {}, header)), false);

  const grid = el('DIV', { class: 'euiDataGrid euiDataGrid--bordersAll' }, body);
  assert.equal(isExcluded(el('SPAN', {}, el('DIV', {}, grid))), true);

  const docTable = el('TABLE', { 'data-test-subj': 'docTable' }, body);
  assert.equal(isExcluded(el('TD', {}, docTable)), true);

  const tableHeader = el('TH', { class: 'euiTableHeaderCell' }, body);
  const tableCell = el('TD', { class: 'euiTableRowCell' }, body);
  assert.equal(isExcluded(el('SPAN', {}, tableHeader)), false);
  assert.equal(isExcluded(el('SPAN', {}, tableCell)), true);

  assert.equal(isExcluded(el('SPAN', {}, el('PRE', {}, body))), true);
  assert.equal(isExcluded(el('SPAN', {}, el('CODE', {}, body))), true);
  assert.equal(isExcluded(el('DIV', { 'data-qapaq-no-translate': '' }, body)), true);
  assert.equal(isExcluded(el('DIV', { translate: 'no' }, body)), true);
  assert.equal(isExcluded(el('DIV', { contenteditable: 'true' }, body)), true);
  assert.equal(isExcluded(el('DIV', { class: 'monaco-editor' }, body)), true);
  assert.equal(isExcluded(el('DIV', { class: 'euiCodeBlock' }, body)), true);

  const cache = new WeakMap<object, boolean>();
  const leaf = el('SPAN', {}, grid);
  assert.equal(isExcluded(leaf, cache), true);
  assert.equal(cache.get(grid), true);
  assert.equal(isExcluded(el('SPAN', {}, header), cache), false);
  assert.equal(cache.get(body), false);
});
