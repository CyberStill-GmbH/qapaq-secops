'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, dirname, basename } = require('node:path');
const { uiBuildNumber, setUiBuild } = require('./set-ui-build.cjs');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'qapaq-ui-build-'));
  t.after(() => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('qapaq-ui-build-')) {
      throw new Error('Unsafe temporary test cleanup path');
    }
    rmSync(target, { recursive: true, force: true });
  });
  const assets = join(directory, 'assets');
  const plugins = join(directory, 'plugins');
  mkdirSync(join(assets, 'images'), { recursive: true });
  mkdirSync(plugins);
  writeFileSync(join(assets, 'images', 'rabbit.webp'), 'rabbit bytes');
  writeFileSync(join(assets, 'targets.tsv'), 'asset mapping');
  writeFileSync(join(plugins, 'qapaqOps.zip'), 'plugin bytes');
  return { directory, assets, plugins };
}

test('same UI inputs produce the same cache identity across directories and rebuilds', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const expected = uiBuildNumber(first.assets, first.plugins);
  assert.ok(Number.isSafeInteger(expected));
  assert.ok(expected >= 0 && expected < 2 ** 48);
  assert.equal(uiBuildNumber(first.assets, first.plugins), expected);
  assert.equal(uiBuildNumber(second.assets, second.plugins), expected);
  writeFileSync(join(first.plugins, 'README.txt'), 'not installed as a plugin');
  assert.equal(uiBuildNumber(first.assets, first.plugins), expected);
});

test('changed image or installed plugin invalidates immutable asset URLs', (t) => {
  const f = fixture(t);
  const initial = uiBuildNumber(f.assets, f.plugins);
  writeFileSync(join(f.assets, 'images', 'rabbit.webp'), 'updated rabbit bytes');
  const newImage = uiBuildNumber(f.assets, f.plugins);
  assert.notEqual(newImage, initial);
  writeFileSync(join(f.plugins, 'qapaqOps.zip'), 'updated plugin bytes');
  assert.notEqual(uiBuildNumber(f.assets, f.plugins), newImage);
});

test('setting the UI build preserves version and distributable compatibility metadata', (t) => {
  const f = fixture(t);
  const path = join(f.directory, 'package.json');
  const pkg = {
    version: '2.19.6',
    wazuh: { version: '4.14.8' },
    build: { number: '414802', sha: 'upstream-sha', distributable: true, release: true },
  };
  writeFileSync(path, JSON.stringify(pkg));
  const number = setUiBuild(path, f.assets, f.plugins);
  const actual = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(actual, { ...pkg, build: { ...pkg.build, number } });
  assert.equal(setUiBuild(path, f.assets, f.plugins), number);
});
