// QAPAQ frontend identity: immutable OSD asset URLs must change with their contents.
// Usage: node set-ui-build.cjs <package.json> <assets-dir> <plugins-dir>
'use strict';
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function hashDirectory(hash, directory, prefix, onlyZips = false) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const label = prefix + '/' + entry.name;
    if (entry.isDirectory()) {
      hashDirectory(hash, path, label, onlyZips);
    } else if (entry.isFile() && (!onlyZips || entry.name.toLowerCase().endsWith('.zip'))) {
      const content = readFileSync(path);
      hash.update(label + '\0' + content.length + '\0');
      hash.update(content);
      hash.update('\0');
    } else if (entry.isSymbolicLink()) {
      throw new Error('UI build inputs must not contain symbolic links: ' + label);
    }
  }
}

function uiBuildNumber(assetsDir, pluginsDir) {
  const hash = createHash('sha256').update('qapaq-ui-build-v1\0');
  hashDirectory(hash, assetsDir, 'assets');
  hashDirectory(hash, pluginsDir, 'plugins', true);
  // 48 bits fit exactly within JavaScript's safe-integer range.
  return Number.parseInt(hash.digest('hex').slice(0, 12), 16);
}

function setUiBuild(packagePath, assetsDir, pluginsDir) {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (!pkg.build || pkg.build.distributable !== true) {
    throw new Error('Expected a distributable OpenSearch Dashboards package');
  }
  const number = uiBuildNumber(assetsDir, pluginsDir);
  pkg.build.number = number;
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  return number;
}

if (require.main === module) {
  if (process.argv.length !== 5)
    throw new Error('Usage: set-ui-build.cjs <package.json> <assets-dir> <plugins-dir>');
  console.log('QAPAQ UI build.number=' + setUiBuild(...process.argv.slice(2)));
}
module.exports = { uiBuildNumber, setUiBuild };
