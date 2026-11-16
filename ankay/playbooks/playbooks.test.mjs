// Ankay · contrato de los playbooks exportables (docs/detection-engineering/04-playbooks-ankay.md).
// node --test ankay/playbooks/playbooks.test.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const playbooks = readdirSync(here)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ name, raw: readFileSync(join(here, name), 'utf8') }))
  .map(({ name, raw }) => ({ name, raw, wf: JSON.parse(raw) }));

test('hay tres playbooks QAPAQ con nombre, etiquetas y metadatos de catálogo', () => {
  assert.equal(playbooks.length, 3);
  for (const { name, wf } of playbooks) {
    assert.match(wf.name, /^QAPAQ · /u, name);
    assert.ok(wf.tags.includes('qapaq') && wf.tags.includes('ankay'), name);
    assert.ok(wf.qapaq?.catalog_id?.startsWith('qapaq.'), name);
    assert.equal(wf.qapaq.status, 'exportable-no-importado', name);
    assert.ok(wf.actions.some((a) => a.id === wf.start), `${name}: start apunta a una acción`);
  }
});

test('ningún secreto ni token viaja en el JSON', () => {
  for (const { name, raw } of playbooks) {
    assert.doesNotMatch(raw, /Bearer\s+[A-Za-z0-9._-]{20,}/u, name);
    assert.doesNotMatch(raw, /"(password|client_secret|apikey|api_key)"\s*:/iu, name);
    assert.doesNotMatch(raw, /eyJ[A-Za-z0-9_-]{20,}/u, name);
  }
});

test('los webhooks se exportan detenidos', () => {
  for (const { name, wf } of playbooks) {
    for (const trigger of wf.triggers.filter((t) => t.trigger_type === 'WEBHOOK')) {
      assert.equal(trigger.status, 'stopped', name);
    }
  }
});

test('el triage es de solo lectura: sin contención ni aprobación', () => {
  const { wf } = playbooks.find(({ wf }) => wf.qapaq.catalog_id === 'qapaq.triage-enrichment');
  assert.equal(wf.qapaq.containment, false);
  const methods = wf.actions.filter((a) => a.app_name === 'http').map((a) => a.name);
  assert.ok(!methods.includes('PUT') && !methods.includes('PATCH') && !methods.includes('DELETE'));
  for (const action of wf.actions) {
    const url = action.parameters.find((p) => p.name === 'url')?.value ?? '';
    assert.doesNotMatch(url, /active-response|revokeSignInSessions/u);
  }
});

test('la contención exige aprobación humana y la compuerta apagada por defecto', () => {
  for (const { name, wf } of playbooks.filter(({ wf }) => wf.qapaq.containment)) {
    assert.equal(wf.qapaq.enabled_by_default, false, name);
    const gateVar = wf.workflow_variables.find((v) => v.name === 'qapaq_contencion_habilitada');
    assert.equal(gateVar?.value, 'false', name);
    const approval = wf.triggers.find((t) => t.trigger_type === 'USERINPUT');
    assert.ok(approval, `${name}: falta la aprobación (User Input)`);
    const gate = wf.actions.find((a) => a.label === 'verificar_compuerta');
    assert.ok(gate, `${name}: falta la compuerta`);
    assert.ok(
      wf.branches.some((b) => b.source_id === approval.id && b.destination_id === gate.id),
      `${name}: la aprobación debe llevar a la compuerta`,
    );
    const effectful = wf.actions.filter((a) => a.app_name === 'http' && a.label !== 'resultado_en_incidente_qapaq');
    assert.ok(effectful.length > 0, name);
    for (const action of effectful) {
      const incoming = wf.branches.filter((b) => b.destination_id === action.id);
      assert.equal(incoming.length, 1, `${name}/${action.label}: una sola entrada`);
      assert.equal(incoming[0].source_id, gate.id, `${name}/${action.label}: solo desde la compuerta`);
      assert.deepEqual(
        incoming[0].conditions.map((c) => [c.source.value, c.condition.value, c.destination.value]),
        [['$verificar_compuerta.message.proceed', 'equals', 'true']],
        `${name}/${action.label}: condicionada a proceed = true`,
      );
    }
  }
});
