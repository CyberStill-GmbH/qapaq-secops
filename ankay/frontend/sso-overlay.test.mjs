// node --test ankay/frontend/sso-overlay.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchApp, patchIndex } from './sso-overlay.mjs';

const APP = [
  '          //console.log("Cookies: ", cookies)',
  '          for (var key in responseJson["cookies"]) {',
  '            setCookie(',
  '              responseJson["cookies"][key].key,',
  '              responseJson["cookies"][key].value,',
  '              { path: "/" }',
  '            );',
  '          }',
  '          if (x) {}',
].join('\r\n');

test('App.jsx: quita la copia del token a cookie JS (CRLF o LF) y es idempotente', () => {
  for (const source of [APP, APP.replaceAll('\r\n', '\n')]) {
    const out = patchApp(source);
    assert.ok(!out.includes('setCookie('));
    assert.ok(out.includes('if (x) {}'));
    assert.equal(patchApp(out), out);
  }
  assert.throws(() => patchApp('nada'), /ANCHOR_MISSING/u);
});

test('index.html: botón Volver al SIEM con comillas simples y script de i18n', () => {
  const html = '<head>\r\n<title>Ankay</title>\r\n<style>a{}</style>\r\n</head><body>\r\n<div id="root"></div>\r\n</body>';
  const out = patchIndex(html);
  assert.ok(out.includes("href='/app/qapaq-alerts' target='_top'"));
  assert.ok(!out.includes('href="/app'), 'el sub_filter del edge no debe reescribirlo');
  assert.ok(out.includes("<script src='/ankay/qapaq-i18n.js' defer></script>"));
  assert.equal(patchIndex(out), out);
  assert.throws(() => patchIndex('<html></html>'), /ANCHOR_MISSING/u);
});
