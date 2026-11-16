// node --test ankay/frontend/i18n/qapaq-i18n.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Es un script clásico del navegador (no un módulo): se evalúa con un `module` de mentira.
const sandbox = { module: { exports: {} } };
runInNewContext(readFileSync(new URL('./qapaq-i18n.js', import.meta.url), 'utf8'), sandbox);
const { translate, DICT, HIDE } = sandbox.module.exports;

test('traduce coincidencias exactas y conserva los espacios', () => {
  assert.equal(translate('Create Workflow'), 'Crear flujo');
  assert.equal(translate('  Workflows '), '  Flujos ');
  assert.equal(translate('Download ALL workflows (12)'), 'Descargar todos los flujos (12)');
  assert.equal(translate('Workflows of the team'), null, 'solo coincidencias exactas');
  assert.equal(translate(''), null);
});

test('«Shuffle» visible pasa a Ankay salvo los nombres de apps del backend', () => {
  assert.equal(translate("Some of Shuffle's default usecases"), "Some of Ankay's default usecases");
  assert.equal(translate('Shuffle Tools'), null);
  assert.equal(translate('Shuffle AI'), null);
  assert.equal(translate('https://shuffler.io/docs'), null);
  assert.equal(translate('Welcome to Shuffle!'), 'Te damos la bienvenida a Ankay');
});

test('el diccionario no encadena traducciones (sin bucles en el observer)', () => {
  for (const [en, es] of Object.entries(DICT)) {
    assert.equal(translate(es), es === en ? null : translate(es), en);
    assert.ok(!(es in DICT) || DICT[es] === es, `«${es}» no debe ser clave de otra traducción`);
  }
  assert.ok(HIDE.Logout && HIDE['Book a Demo']);
});
