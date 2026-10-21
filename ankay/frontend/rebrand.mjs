#!/usr/bin/env node
/*
 * Copyright QAPAQ. Ankay Qapaq — codemod determinista del frontend de Shuffle (AGPL-3.0: las
 * modificaciones se publican, ver ankay/README.md «Código fuente»).
 *
 *   node ankay/frontend/rebrand.mjs <frontend-dir>           aplica y reporta lo que queda
 *   node ankay/frontend/rebrand.mjs <frontend-dir> --check   solo reporta
 *
 * Por qué codemod y no parches: hay unas 290 apariciones visibles de «Shuffle» y unos 460 colores
 * naranja fijos en 180 archivos. Un parche por cada uno se rompe en cada versión; esta regla se
 * vuelve a aplicar sobre cualquier tag.
 *
 * Se usa el parser de TypeScript (JSX), no expresiones regulares, para distinguir texto visible de
 * lógica. Solo cambia «Shuffle» (palabra completa, con mayúscula) en:
 *  - texto JSX (`<p>… Shuffle …</p>`);
 *  - atributos JSX visibles (title, label, placeholder, alt, aria-label, helperText, tooltip, …);
 *  - literales hijos de JSX (`{"… Shuffle …"}`) y argumentos de toast(), alert() o setBrandName();
 *  - títulos de pestaña (`document.title = …`) y propiedades de texto de UI (`label:`, `desc:`, `title:`).
 * Nunca toca comparaciones (`app_name === "Shuffle Tools"`), asignaciones de datos
 * (`environment = "Shuffle"`), claves, imports, URLs ni identificadores, porque cambiarlos rompería
 * la lógica y la compatibilidad con el backend de Shuffle.
 * Colores: mapa fijo naranja Shuffle → ámbar QAPAQ en todo el código (mantiene coherentes las
 * comparaciones con el color por defecto).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// TypeScript del monorepo de qapaq-secops (devDependency raíz).
const ts = createRequire(resolve(here, '../../package.json'))('typescript');

export const BRAND = 'Ankay Qapaq';

/** Naranja de Shuffle → ámbar QAPAQ (#c49a5a) y sus tonos, por luminosidad equivalente. */
export const COLOR_MAP = {
  '#ff8544': '#c49a5a',
  '#f86a3e': '#c49a5a',
  '#f85a3e': '#b5874a',
  '#ff6600': '#c49a5a',
  '#ec517c': '#d6b27a',
  '#ff955c': '#d4ad74',
  '#ff7c35': '#b5874a',
  '#ff8d4f': '#d1aa70',
  '#cc5f1f': '#8c6a38',
  '#ffe8dc': '#f3eadc',
};

const VISIBLE_ATTRS = new Set([
  'title',
  'label',
  'placeholder',
  'alt',
  'aria-label',
  'helperText',
  'tooltip',
  'description',
  'text',
  'subheader',
  'header',
  'primary',
  'secondary',
  'message',
  'emptyText',
]);
const VISIBLE_CALLS = new Set(['toast', 'alert', 'setBrandName', 'confirm']);
const VISIBLE_VARIABLES = new Set(['helperText', 'workflowDescription']);
// These labels are also used by adjacent rendering logic in the same upstream component. Renaming
// every occurrence in the file keeps the UI comparison intact without changing backend app IDs.
const SAFE_UI_ENUM_RENAMES = new Map([['Shuffle Security', 'Ankay Security']]);
/** Propiedades de objetos de UI que se muestran tal cual (menús, tarjetas, tablas de planes). */
const VISIBLE_PROPS = new Set([
  'label',
  'desc',
  'description',
  'title',
  'text',
  'tooltip',
  'helperText',
  'subtitle',
  'header',
  'message',
]);
/**
 * «Shuffle» como palabra. No toca los nombres de apps y entidades que existen con ese nombre en el
 * backend (Shuffle Tools, Shuffle DB, Shuffle AI): cambiarlos solo en la ayuda confundiría al buscarlos.
 */
const WORD = /(?<![A-Za-z0-9_$./-])Shuffle(?![A-Za-z0-9_$-])(?! (?:Tools|DB|AI|Subflow)\b)/g;
const NOT_TEXT = /https?:|\/\/|\.(png|svg|jpe?g|gif|ico|js|jsx|css|json)\b|shuffler/i;

export function recolor(source) {
  return source.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => COLOR_MAP[hex.toLowerCase()] ?? hex);
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e))
    return `${ts.isIdentifier(e.expression) ? e.expression.text : ''}.${e.name.text}`;
  return '';
}

/** ¿El literal es texto que ve la persona usuaria? */
function isVisible(node) {
  // Templates may be wrapped in a conditional/parenthesized expression before reaching the UI sink.
  let expression = node;
  while (
    expression.parent &&
    (ts.isConditionalExpression(expression.parent) ||
      ts.isParenthesizedExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent))
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  if (ts.isJsxText(node)) return true;
  if (ts.isJsxAttribute(parent)) return VISIBLE_ATTRS.has(parent.name.getText());
  if (ts.isJsxExpression(parent)) {
    const holder = parent.parent;
    if (ts.isJsxElement(holder) || ts.isJsxFragment(holder)) return true; // {"…"} como hijo
    if (ts.isJsxAttribute(holder)) return VISIBLE_ATTRS.has(holder.name.getText());
    return false;
  }
  // document.title = "…" / window.title = "…"
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === expression &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const left = parent.left;
    return (
      /^(document|window)\.title$/.test(left.getText()) ||
      (ts.isIdentifier(left) && VISIBLE_VARIABLES.has(left.text))
    );
  }
  // { label: "…" } en objetos de UI
  if (ts.isPropertyAssignment(parent) && parent.initializer === expression) {
    const key =
      ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name) ? parent.name.text : '';
    return VISIBLE_PROPS.has(key);
  }
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    ts.isIdentifier(parent.name) &&
    VISIBLE_VARIABLES.has(parent.name.text)
  )
    return true;
  if (ts.isCallExpression(parent) && parent.arguments.includes(expression)) {
    const name = calleeName(parent);
    return VISIBLE_CALLS.has(name) || name.startsWith('toast.');
  }
  return false;
}

/**
 * Devuelve el tramo de texto literal de un template string, sin sus delimitadores ni expresiones.
 * Así se puede rebrandear `Shuffle ${name}` en una etiqueta visible sin tocar `${name}`.
 */
function templateTextRange(node, sf) {
  const start = node.getStart(sf);
  const end = node.end;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node))
    return { start: start + 1, end: end - 2 }; // `text${  o  }text${
  if (ts.isTemplateTail(node)) return { start: start + 1, end: end - 1 }; // }text`
  return null;
}

/**
 * Literales que el código compara (===, !==, ==, !=, case, includes, startsWith, endsWith, indexOf).
 * Un texto de UI que además se compara en algún archivo no se renombra: cambiar solo un lado
 * rompería esa comparación (p. ej. `menuItem.title === "Shuffle Security"`).
 */
export function comparedLiterals(source, fileName = 'file.jsx', into = new Set()) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const COMPARE = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);
  const add = (n) => {
    if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) into.add(n.text);
  };
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && COMPARE.has(node.operatorToken.kind)) {
      add(node.left);
      add(node.right);
    }
    if (ts.isCaseClause(node)) add(node.expression);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['includes', 'startsWith', 'endsWith', 'indexOf'].includes(node.expression.name.text)
    )
      node.arguments.forEach(add);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return into;
}

export function retext(source, fileName = 'file.jsx', compared = new Set()) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const edits = [];
  const visit = (node) => {
    const literal =
      ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node
        : null;
    const safeEnumRename =
      literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))
        ? SAFE_UI_ENUM_RENAMES.get(literal.text)
        : undefined;
    if (
      literal &&
      (safeEnumRename ||
        (isVisible(literal) &&
          !(ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)
            ? compared.has(literal.text)
            : false)))
    ) {
      const start = literal.getStart(sf);
      const raw = source.slice(start, literal.end);
      if (safeEnumRename && !NOT_TEXT.test(raw)) {
        edits.push([start, literal.end, raw.replace(literal.text, safeEnumRename)]);
      } else if (!NOT_TEXT.test(raw) && WORD.test(raw)) {
        WORD.lastIndex = 0;
        edits.push([start, literal.end, raw.replace(WORD, BRAND)]);
      }
      WORD.lastIndex = 0;
    }
    if (ts.isTemplateExpression(node) && isVisible(node)) {
      const segments = [node.head, ...node.templateSpans.map((span) => span.literal)];
      for (const segment of segments) {
        const range = templateTextRange(segment, sf);
        if (!range) continue;
        const raw = source.slice(range.start, range.end);
        if (NOT_TEXT.test(raw)) continue;
        WORD.lastIndex = 0;
        if (WORD.test(raw)) {
          WORD.lastIndex = 0;
          edits.push([range.start, range.end, raw.replace(WORD, BRAND)]);
        }
        WORD.lastIndex = 0;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let out = source;
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0]))
    out = out.slice(0, start) + text + out.slice(end);
  return out;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (['.js', '.jsx', '.css'].includes(extname(name))) yield path;
  }
}

function main() {
  const root = process.argv[2];
  const check = process.argv.includes('--check');
  if (!root) {
    console.error('uso: rebrand.mjs <frontend-dir> [--check]');
    process.exit(2);
  }
  let changed = 0;
  let syntaxErrors = 0;
  const leftovers = [];
  const compared = new Set();
  for (const path of files(join(root, 'src'))) {
    if (extname(path) !== '.css') comparedLiterals(readFileSync(path, 'utf8'), path, compared);
  }
  for (const path of files(join(root, 'src'))) {
    const before = readFileSync(path, 'utf8');
    const after =
      extname(path) === '.css' ? recolor(before) : retext(recolor(before), path, compared);
    if (extname(path) !== '.css' && after !== before) {
      const parsed = ts.createSourceFile(
        path,
        after,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JSX,
      );
      if (
        parsed.parseDiagnostics?.length > 0 &&
        !(
          ts.createSourceFile(path, before, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)
            .parseDiagnostics?.length > 0
        )
      ) {
        syntaxErrors += 1;
        console.error(`sintaxis rota tras el rebrand: ${relative(root, path)}`);
        continue;
      }
    }
    if (!check && after !== before) {
      writeFileSync(path, after);
      changed += 1;
    }
    (check ? before : after).split('\n').forEach((line, index) => {
      if (WORD.test(line) && !NOT_TEXT.test(line))
        leftovers.push(`${relative(root, path)}:${index + 1}: ${line.trim().slice(0, 140)}`);
      WORD.lastIndex = 0;
    });
  }
  console.log(`archivos modificados: ${changed}`);
  console.log(
    `apariciones restantes (lógica, datos o comentarios; no son texto visible): ${leftovers.length}`,
  );
  for (const line of leftovers.slice(0, 30)) console.log(`  ${line}`);
  if (syntaxErrors > 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
