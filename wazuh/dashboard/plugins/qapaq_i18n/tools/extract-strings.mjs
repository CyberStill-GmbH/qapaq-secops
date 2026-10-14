#!/usr/bin/env node
/**
 * Extrae cadenas candidatas visibles en la UI de un checkout de wazuh-dashboard
 * (OSD core) y wazuh-dashboard-plugins, y las compara contra el glosario.
 *
 * Uso:
 *   node tools/extract-strings.mjs --osd <wazuh-dashboard> --wazuh <wazuh-dashboard-plugins> \
 *        [--glossary public/glossary.es.json] [--min-score 2] [--json out.json] [--all]
 *
 * Con --glossary (y sin --all) imprime solo las cadenas que NO están en el glosario
 * (strings nuevas tras un upgrade de Wazuh), ordenadas por puntaje de visibilidad.
 * Sin dependencias npm. Ejemplo para un tag nuevo:
 *   git clone --depth 1 --branch vX.Y.Z --filter=blob:none https://github.com/wazuh/wazuh-dashboard
 *   git clone --depth 1 --branch vX.Y.Z --filter=blob:none https://github.com/wazuh/wazuh-dashboard-plugins
 *   node tools/extract-strings.mjs --osd wazuh-dashboard --wazuh wazuh-dashboard-plugins \
 *        --glossary public/glossary.es.json --min-score 3
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

// Áreas a escanear y peso de visibilidad (más alto = más visible para el analista).
export const AREAS = [
  ['osd', 'src/core/public/chrome', 5],
  ['osd', 'src/plugins/data/public/ui', 4],
  ['osd', 'src/plugins/data/public/query', 2],
  ['osd', 'src/plugins/discover/public', 4],
  ['osd', 'src/plugins/data_explorer/public', 3],
  ['osd', 'src/plugins/dashboard/public', 4],
  ['osd', 'src/plugins/visualize/public', 3],
  ['osd', 'src/plugins/home/public', 2],
  ['osd', 'src/plugins/management/public', 3],
  ['osd', 'src/plugins/advanced_settings/public', 2],
  ['osd', 'src/plugins/saved_objects_management/public', 2],
  ['osd', 'src/plugins/index_pattern_management/public', 2],
  ['osd', 'src/plugins/navigation/public', 3],
  ['osd', 'src/plugins/opensearch_dashboards_react/public', 2],
  ['osd', 'src/plugins/dev_tools/public', 2],
  ['osd', 'src/plugins/share/public', 2],
  ['osd', 'src/plugins/inspector/public', 1],
  ['wazuh', 'plugins/main/common/wazuh-modules.ts', 6],
  ['wazuh', 'plugins/main/public/utils/applications.ts', 6],
  ['wazuh', 'plugins/main/public/components/common', 3],
  ['wazuh', 'plugins/main/public/components/endpoints-summary', 4],
  ['wazuh', 'plugins/main/public/components/overview', 4],
  ['wazuh', 'plugins/main/public/components/agents', 3],
  ['wazuh', 'plugins/main/public/components/settings', 2],
  ['wazuh', 'plugins/main/public/components/management', 2],
  ['wazuh', 'plugins/main/public/components/wz-menu', 4],
  ['wazuh', 'plugins/main/public/controllers', 1],
  ['wazuh', 'plugins/main/public', 1],
];

const SKIP =
  /(\.test\.|\.mock|__snapshots__|__mocks__|fixtures|stories|\.d\.ts$|test_utils|\/test\/)/;
const EXT = /\.(tsx?|jsx?)$/;
const KEYS = [
  'title',
  'description',
  'label',
  'defaultMessage',
  'buttonLabel',
  'placeholder',
  'name',
  'text',
  'tooltip',
  'helpText',
  'emptyMessage',
  'confirmButtonText',
  'cancelButtonText',
  'ariaLabel',
  'aria-label',
  'tabName',
  'message',
  'subtitle',
  'content',
  'header',
  'prompt',
].join('|');
const RE_PROP = new RegExp(
  String.raw`(?:^|[\s{,(])(?:${KEYS})\s*[:=]\s*\{?\s*(['"\x60])((?:\\.|(?!\1).){2,160})\1`,
  'g',
);
const RE_JSX_TEXT = />\s*([A-Z][A-Za-z][^<>{}\n]{0,118}?)\s*</g;

export function looksLikeUi(s) {
  if (s.length < 2 || s.length > 120) return false;
  if (/\$\{|\\n|https?:|\/\/|[<>]|^[a-z0-9_.-]+$|\.(js|ts|json|svg|png)\b|^[A-Z0-9_]+$/.test(s))
    return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters / s.length < 0.6) return false;
  return /^[A-Z(]/.test(s) || /\s/.test(s);
}

function walk(p, out) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (EXT.test(p) && !SKIP.test(p.split(sep).join('/'))) out.push(p);
    return;
  }
  for (const f of readdirSync(p)) if (f !== 'node_modules' && f !== 'target') walk(join(p, f), out);
}

export function extract(roots) {
  const found = new Map(); // text -> {score, files:Set}
  const seenFile = new Set();
  for (const [root, sub, weight] of AREAS) {
    if (!roots[root]) continue;
    const files = [];
    walk(join(roots[root], sub), files);
    for (const f of files) {
      if (seenFile.has(f)) continue;
      seenFile.add(f);
      const src = readFileSync(f, 'utf8');
      const add = (raw) => {
        const s = raw
          .replace(/\\(['"\x60])/g, '$1')
          .replace(/\s+/g, ' ')
          .trim();
        if (!looksLikeUi(s)) return;
        const e = found.get(s) || { score: 0, files: new Set() };
        e.score += weight;
        e.files.add(relative(roots[root], f).split(sep).join('/'));
        found.set(s, e);
      };
      for (const m of src.matchAll(RE_PROP)) add(m[2]);
      if (/\.(tsx|jsx|js)$/.test(f)) for (const m of src.matchAll(RE_JSX_TEXT)) add(m[1]);
    }
  }
  return [...found.entries()]
    .map(([text, e]) => ({ text, score: e.score, files: e.files.size, sample: [...e.files][0] }))
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
}

const isMain = (process.argv[1] || '').replace(/\\/g, '/').endsWith('tools/extract-strings.mjs');
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.osd && !args.wazuh) {
    console.error(
      'Uso: node tools/extract-strings.mjs --osd <wazuh-dashboard> --wazuh <wazuh-dashboard-plugins> ' +
        '[--glossary public/glossary.es.json] [--all] [--min-score N] [--json out.json]',
    );
    process.exit(2);
  }
  let rows = extract({ osd: args.osd, wazuh: args.wazuh });
  const min = Number(args['min-score'] || 1);
  rows = rows.filter((r) => r.score >= min);
  if (args.glossary && !args.all) {
    const g = JSON.parse(readFileSync(args.glossary, 'utf8'));
    const known = new Set(
      [...Object.keys(g.entries || {}), ...(g.keep || [])].map((k) => k.toLowerCase()),
    );
    rows = rows.filter((r) => !known.has(r.text.toLowerCase()));
  }
  if (args.json) writeFileSync(args.json, JSON.stringify(rows, null, 1));
  else for (const r of rows) console.log(`${String(r.score).padStart(4)}\t${r.text}\t${r.sample}`);
  console.error(`${rows.length} cadenas${args.glossary && !args.all ? ' sin traducir' : ''}.`);
}
