/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Núcleo puro (sin DOM, sin imports) del traductor de UI de QAPAQ SecOps.
 * Solo usa sintaxis TypeScript "borrable" para poder probarse con `node --test`
 * (type stripping) sin compilar.
 */

export interface GlossaryPattern {
  from: string;
  to: string;
}

export interface GlossaryFile {
  entries: Record<string, string>;
  patterns?: GlossaryPattern[];
  keep?: string[];
  brand?: Array<[string, string]>;
}

interface CompiledPattern {
  re: RegExp;
  names: string[];
  to: string;
}

export interface Glossary {
  exact: Map<string, string>;
  lower: Map<string, string>;
  keep: Set<string>;
  patterns: CompiledPattern[];
  brand: Array<[RegExp, string]>;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compila "{n} hits" -> /^([\d.,]+) hits$/ ; {n},{m} = números, {s} = texto corto. */
export function compilePattern(p: GlossaryPattern): CompiledPattern {
  const names: string[] = [];
  const source = p.from
    .split(/(\{[a-z]\})/)
    .map((part) => {
      const m = /^\{([a-z])\}$/.exec(part);
      if (!m) return escapeRe(part);
      names.push(m[1]);
      return m[1] === 's' ? '(.{1,60}?)' : '(\\d[\\d.,]*)';
    })
    .join('');
  return { re: new RegExp(`^${source}$`), names, to: p.to };
}

export function compileGlossary(file: GlossaryFile): Glossary {
  const exact = new Map<string, string>();
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(file.entries || {})) {
    exact.set(k, v);
    const lk = k.toLowerCase();
    if (!lower.has(lk)) lower.set(lk, v);
  }
  return {
    exact,
    lower,
    keep: new Set(file.keep || []),
    patterns: (file.patterns || []).map(compilePattern),
    brand: (file.brand || []).map(
      ([from, to]) => [new RegExp(`\\b${escapeRe(from)}\\b`, 'g'), to] as [RegExp, string],
    ),
  };
}

/** Aplica el reemplazo de marca (Wazuh / OpenSearch Dashboards -> QAPAQ SecOps). */
export function applyBrand(g: Glossary, s: string): string {
  let out = s;
  for (const [re, to] of g.brand) out = out.replace(re, to);
  return out;
}

function matchCase(source: string, target: string): string {
  const a = source.charAt(0);
  const b = target.charAt(0);
  if (a && a === a.toLowerCase() && a !== a.toUpperCase() && b !== b.toLowerCase()) {
    return b.toLowerCase() + target.slice(1);
  }
  return target;
}

function lookupCore(g: Glossary, core: string): string | null {
  const e = g.exact.get(core);
  if (e !== undefined) return e;
  const l = g.lower.get(core.toLowerCase());
  if (l !== undefined) return matchCase(core, l);
  for (const p of g.patterns) {
    const m = p.re.exec(core);
    if (!m) continue;
    let out = p.to;
    p.names.forEach((name, i) => {
      out = out.split(`{${name}}`).join(m[i + 1]);
    });
    return out;
  }
  return null;
}

/**
 * Traduce con el glosario un texto (ya recortado). Prueba: exacto, sin mayúsculas,
 * patrones, y luego quitando puntuación final (":", ".", "...", "…") que se reañade.
 * Devuelve null si no hay traducción curada.
 */
export function glossaryLookup(g: Glossary, text: string): string | null {
  if (!text) return null;
  if (g.keep.has(text)) return null;
  const direct = lookupCore(g, text);
  if (direct !== null) return direct;
  const m = /^(.*?)(\s*(?::|\.{3}|…|\.|\?))$/.exec(text);
  if (m && m[1]) {
    const inner = lookupCore(g, m[1]);
    if (inner !== null) return inner + m[2];
  }
  return null;
}

/** Separa espacios iniciales/finales para preservarlos al reemplazar. */
export function splitWhitespace(raw: string): [string, string, string] {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
  return m ? [m[1], m[2], m[3]] : ['', raw, ''];
}

const RE_IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const RE_IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/i;
const RE_HASH = /\b[0-9a-f]{16,}\b/i;
const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const RE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const RE_PATH = /(?:^|\s)(?:[A-Za-z]:\\|\\\\|\/[\w.-]+\/|~\/)|[\w-]+\\[\w-]+\\/;
const RE_URL = /\b(?:https?|ftp|file):\/\//i;
const RE_FIELD = /^[\w@-]+(?:\.[\w@-]+)+$/; // agent.name, rule.mitre.id
const RE_JSON = /^\s*[[{].*[\]}]\s*$|":\s*/;
const RE_CODEISH = /[{}<>=;$`|]|&&|\(\)/;

/** ¿Parece dato (IP, hash, ruta, email, id, JSON, campo) y no texto de interfaz? */
export function isDataLike(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (RE_IPV4.test(t) || RE_IPV6.test(t) || RE_HASH.test(t) || RE_UUID.test(t)) return true;
  if (RE_EMAIL.test(t) || RE_URL.test(t) || RE_PATH.test(t) || RE_FIELD.test(t)) return true;
  if (RE_JSON.test(t) || RE_CODEISH.test(t)) return true;
  if (/^[\d\s.,:%/+-]+$/.test(t)) return true; // números, fechas, porcentajes
  if (/\b[A-Z]{2,}-\d{2,}[\w-]*\b/.test(t)) return true; // CVE-2024-1234, IDs de tickets
  if (/_/.test(t) && !/\s/.test(t)) return true; // identificadores snake_case
  return false;
}

const RE_SPANISH = /[áéíóúñ¿¡ÁÉÍÓÚÑ]/;
const STOP_ES = /\b(el|la|los|las|de|del|que|para|con|una|por|está|sin)\b/i;

/**
 * ¿Es candidato al traductor en el dispositivo? Solo texto de interfaz en inglés:
 * 2–120 caracteres, mayormente alfabético, al menos dos palabras, no dato.
 */
export function isEligibleForMachineTranslation(g: Glossary, text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 120) return false;
  if (g.keep.has(t)) return false;
  if (RE_SPANISH.test(t) || STOP_ES.test(t)) return false;
  if (isDataLike(t)) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (letters / t.replace(/\s/g, '').length < 0.75) return false;
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'’-]*[.,:;!?)]*$/.test(w));
  if (words.length < 2) return false;
  // la mayoría de "palabras" debe ser alfabética (descarta mezclas tipo "eth0 up 1500")
  return words.length / t.split(/\s+/).length >= 0.7;
}

/**
 * Traducción determinista de un nodo de texto: glosario y luego marca.
 * Devuelve el texto completo (con espacios originales) o null si no cambia.
 */
export function translateText(g: Glossary, raw: string): string | null {
  const [lead, core, trail] = splitWhitespace(raw);
  if (!core || core.length > 200) return null;
  let out = glossaryLookup(g, core);
  if (out === null) {
    if (isDataLike(core)) return null;
    const branded = applyBrand(g, core);
    if (branded === core) return null;
    out = branded;
  } else {
    out = applyBrand(g, out);
  }
  return out === core ? null : lead + out + trail;
}

/** Traduce document.title tipo "Discover - Wazuh" parte por parte. */
export function translateTitle(g: Glossary, title: string): string {
  return title
    .split(' - ')
    .map((part) => {
      const t = translateText(g, part);
      return t === null ? part : t;
    })
    .join(' - ');
}

/* ---------------- Exclusión (sin DOM real: interfaz mínima de elemento) ---------------- */

export interface ElementLike {
  tagName: string;
  className?: unknown;
  parentElement: ElementLike | null;
  getAttribute(name: string): string | null;
}

export const EXCLUDED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'VAR',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'SVG',
  'CANVAS',
  'IFRAME',
  'MATH',
]);

/** Prefijos de clase cuyo subárbol es dato de seguridad o editor (nunca se traduce). */
export const EXCLUDED_CLASS_PREFIXES = [
  'euiDataGrid',
  'osdDocTable',
  'osdDocViewer',
  'dscTable',
  'dscDocsGrid',
  'euiCodeBlock',
  'euiCodeEditor',
  'monaco-editor',
  'ace_editor',
  'CodeMirror',
  'euiTableRowCell',
  'echChart',
  'visChart',
  'visLegend',
  'vgaVis',
  'tvbVis',
  'globalFilterItem',
  'euiComboBoxPill',
  'euiMarkdownFormat',
  'notranslate',
  'qapaq-no-translate',
];

const RE_EXCLUDED_TEST_SUBJ =
  /docTable|discoverTable|dscDocsGrid|osdDocViewer|dataGrid|codeEditor|documentDetail/i;

function classTokens(el: ElementLike): string[] {
  const c = el.className;
  const s =
    typeof c === 'string'
      ? c
      : c && typeof (c as { baseVal?: unknown }).baseVal === 'string'
        ? (c as { baseVal: string }).baseVal
        : '';
  return s ? s.split(/\s+/) : [];
}

/** Reglas sobre el propio elemento, sin mirar la etiqueta (para atributos de <input>). */
export function isSelfExcludedByMarkers(el: ElementLike): boolean {
  if (el.getAttribute('data-qapaq-no-translate') !== null) return true;
  if (el.getAttribute('translate') === 'no') return true;
  const ce = el.getAttribute('contenteditable');
  if (ce !== null && ce !== 'false') return true;
  if (el.getAttribute('role') === 'grid') return true;
  const subj = el.getAttribute('data-test-subj');
  if (subj && RE_EXCLUDED_TEST_SUBJ.test(subj)) return true;
  for (const tok of classTokens(el)) {
    for (const p of EXCLUDED_CLASS_PREFIXES) if (tok.startsWith(p)) return true;
  }
  return false;
}

export function isSelfExcluded(el: ElementLike): boolean {
  return EXCLUDED_TAGS.has(el.tagName.toUpperCase()) || isSelfExcludedByMarkers(el);
}

/** ¿El elemento o algún ancestro está excluido? Usa `cache` (WeakMap) si se entrega. */
export function isExcluded(el: ElementLike | null, cache?: WeakMap<object, boolean>): boolean {
  const chain: ElementLike[] = [];
  let cur = el;
  let result = false;
  while (cur) {
    const cached = cache ? cache.get(cur) : undefined;
    if (cached !== undefined) {
      result = cached;
      break;
    }
    chain.push(cur);
    if (isSelfExcluded(cur)) {
      result = true;
      break;
    }
    cur = cur.parentElement;
  }
  if (cache) {
    // Los ancestros por encima del primer excluido no son necesariamente excluidos: solo
    // se cachea como "true" desde el excluido hacia abajo; "false" vale para toda la cadena.
    for (const c of chain) cache.set(c, result);
  }
  return result;
}
