/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { citationPath } from './chat_client';
import type { QapaqzitoCitation } from './chat_client';

/**
 * Markdown seguro para las respuestas de Qapaqzito. Todo se construye como elementos de React: nunca
 * se inserta HTML y el modelo no puede inyectar URL. Soporta:
 *
 * - Encabezados (`### Resumen`, `### Evidencia`…) con estilo por sección del formato de analista.
 * - Párrafos, listas (con y sin número), tablas simples, **negrita**, *énfasis* y `código`.
 * - Bloques de código con lenguaje (```kql) y botón «Copiar».
 * - Chips de prioridad (P1–P4) y de severidad/confianza («Severidad: alta»).
 * - Identificadores de alerta/incidente (UUID) como enlaces a la consola: la ruta la decide la
 *   consola (`citationPath`) a partir de las citas de la respuesta, nunca el modelo.
 * - Técnicas MITRE ATT&CK (`T1110.003`) con enlace a attack.mitre.org construido aquí.
 */

export interface MarkdownOptions {
  /** Citas de la respuesta: deciden si un id es alerta o incidente. */
  readonly citations?: readonly QapaqzitoCitation[];
  /** Navega a una ruta de la consola (enlaces de ids). Sin ella, los ids no son enlaces. */
  readonly onOpen?: (path: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TECHNIQUE = /^T\d{4}(?:\.\d{3})?$/u;
const LEVEL_WORDS: Record<string, string> = {
  crítica: 'critical',
  critica: 'critical',
  alta: 'high',
  media: 'medium',
  baja: 'low',
};

type Section = 'summary' | 'evidence' | 'assessment' | 'actions' | 'next' | 'other';

export function sectionOf(heading: string): Section {
  const text = heading.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase();
  if (text.startsWith('resumen')) return 'summary';
  if (text.startsWith('evidencia')) return 'evidence';
  if (text.startsWith('evaluacion')) return 'assessment';
  if (text.startsWith('acciones')) return 'actions';
  if (text.startsWith('proximos')) return 'next';
  return 'other';
}

function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="qapaqQapaqzito__copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? 'Copiado' : label}
    </button>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <div className="qapaqQapaqzito__code">
      <div className="qapaqQapaqzito__codeHead">
        <span>{language || 'código'}</span>
        <CopyButton text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function IdLink({ id, options }: { id: string; options: MarkdownOptions }) {
  const cited = options.citations?.find((citation) => citation.id === id);
  const kind = cited?.kind === 'incident' ? 'incident' : 'alert';
  const path = citationPath({ kind, id, label: cited?.label ?? id });
  const short = `${id.slice(0, 8)}…`;
  const title = `${kind === 'incident' ? 'Incidente' : 'Alerta'} ${id}${cited?.label ? ` · ${cited.label}` : ''}`;
  if (!path || !options.onOpen) {
    return (
      <code className="qapaqQapaqzito__id" title={title}>
        {short}
      </code>
    );
  }
  return (
    <a
      className={`qapaqQapaqzito__id qapaqQapaqzito__id--${kind}`}
      href={path}
      title={title}
      onClick={(event) => {
        event.preventDefault();
        options.onOpen?.(path);
      }}
    >
      {kind === 'incident' ? 'INC ' : ''}
      {short}
    </a>
  );
}

function chip(level: string, text: string, key: string): React.ReactNode {
  return (
    <span key={key} className={`qapaqQapaqzito__chip qapaqQapaqzito__chip--${level}`}>
      {text}
    </span>
  );
}

const INLINE =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bT\d{4}(?:\.\d{3})?\b|\bP[1-4]\b)/giu;

/** En líneas de «Severidad:»/«Confianza:», las palabras crítica/alta/media/baja se vuelven chips. */
function levels(text: string, key: string, enabled: boolean): React.ReactNode[] {
  if (!enabled) return [text];
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(
    /(^|[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ])(cr[ií]tica|alta|media|baja)(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/giu,
  )) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const word = match[2] ?? '';
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(chip(LEVEL_WORDS[word.toLowerCase()] ?? 'medium', word, `${key}-l${n++}`));
    last = start + word.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function inline(
  text: string,
  keyPrefix: string,
  options: MarkdownOptions,
  levelChips = false,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) {
      nodes.push(...levels(text.slice(last, start), `${keyPrefix}-t${index}`, levelChips));
    }
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith('`')) {
      const content = token.slice(1, -1);
      if (UUID.test(content)) nodes.push(<IdLink key={key} id={content} options={options} />);
      else nodes.push(<code key={key}>{content}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{inline(token.slice(2, -2), key, options, levelChips)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (UUID.test(token)) {
      nodes.push(<IdLink key={key} id={token} options={options} />);
    } else if (TECHNIQUE.test(token)) {
      nodes.push(
        <a
          key={key}
          className="qapaqQapaqzito__mitre"
          href={`https://attack.mitre.org/techniques/${token.replace('.', '/')}/`}
          target="_blank"
          rel="noopener noreferrer"
          title="Ver en MITRE ATT&CK"
        >
          {token}
        </a>,
      );
    } else {
      nodes.push(chip(token.toLowerCase(), token.toUpperCase(), key));
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(...levels(text.slice(last), `${keyPrefix}-end`, levelChips));
  return nodes;
}

const HEADING = /^\s*(#{1,4})\s+(.*)$/u;
const FENCE = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/u;
const BULLET = /^\s*[-*•]\s+(.*)$/u;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/u;
const LEVEL_LINE = /(severidad|confianza|prioridad)\s*:/iu;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/gu, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isBlockStart(line: string): boolean {
  return (
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    TABLE_ROW.test(line) ||
    HEADING.test(line) ||
    FENCE.test(line)
  );
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): React.ReactNode[] {
  const lines = source.replace(/\r\n/gu, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // cierre (o fin del texto si el modelo no lo cerró)
      blocks.push(<CodeBlock key={`b${key++}`} language={fence[1] ?? ''} code={code.join('\n')} />);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const title = (heading[2] ?? '').replace(/\*\*/gu, '');
      blocks.push(
        <h4
          key={`b${key++}`}
          className={`qapaqQapaqzito__h qapaqQapaqzito__h--${sectionOf(title)} qapaqQapaqzito__h--l${(heading[1] ?? '###').length}`}
        >
          {inline(title, `h${key}`, options)}
        </h4>,
      );
      i += 1;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      blocks.push(
        <div className="qapaqQapaqzito__tableWrap" key={`b${key++}`}>
          <table className="qapaqQapaqzito__table">
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th key={c}>{inline(cell, `h${c}`, options)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{inline(cell, `r${r}c${c}`, options)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i] ?? '')) {
        items.push((pattern.exec(lines[i] ?? '') ?? [])[1] ?? '');
        i += 1;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={`b${key++}`}>
          {items.map((item, n) => (
            <li key={n}>{inline(item, `li${n}`, options, LEVEL_LINE.test(item))}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !isBlockStart(lines[i] ?? '')) {
      paragraph.push(lines[i] ?? '');
      i += 1;
    }
    if (paragraph.length === 0) {
      // Línea que parecía bloque y no lo es (p. ej. una fila de tabla suelta).
      paragraph.push(line);
      i += 1;
    }
    blocks.push(
      <p key={`b${key++}`}>
        {paragraph.map((text, n) => (
          <React.Fragment key={n}>
            {n > 0 && <br />}
            {inline(text, `p${n}`, options, LEVEL_LINE.test(text))}
          </React.Fragment>
        ))}
      </p>,
    );
  }
  return blocks;
}
