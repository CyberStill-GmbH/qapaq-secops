// El optimizer de OSD 2.19 (webpack 4 / acorn) no entiende separadores numéricos (`60_000`).
// Se quitan en la COPIA del plugin que compila build-plugins.sh; el código fuente no cambia.
//   node strip-numeric-separators.cjs <dir>
'use strict';
const fs = require('fs');
const path = require('path');
let changed = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'build', 'target'].includes(entry.name)) walk(p);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      const src = fs.readFileSync(p, 'utf8');
      // \b delante: no toca identificadores (v2_1); solo literales que empiezan por dígito.
      const out = src.replace(/\b\d+(?:_\d+)+\b/g, (m) => m.replace(/_/g, ''));
      if (out !== src) {
        fs.writeFileSync(p, out);
        changed++;
      }
    }
  }
})(process.argv[2]);
console.log(`separadores numéricos quitados en ${changed} ficheros de ${process.argv[2]}`);
