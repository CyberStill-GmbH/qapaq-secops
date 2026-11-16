/* Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0 */
import { safeMarkdownFilename } from '../../common';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

/** Restricted report renderer: source text cannot inject HTML, scripts or remote resources. */
export function analystReportHtml(filename: string, markdown: string, basePath = ''): string {
  let table = false;
  const lines: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*\|/.test(raw)) {
      if (/^\s*\|[ :|\-]+$/.test(raw)) continue;
      if (!table) {
        lines.push('<table>');
        table = true;
      }
      lines.push(
        '<tr>' +
          raw
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((cell) => '<td>' + escape(cell.trim()) + '</td>')
            .join('') +
          '</tr>',
      );
      continue;
    }
    if (table) {
      lines.push('</table>');
      table = false;
    }
    const heading = /^(#{1,4}) (.+)$/.exec(raw);
    if (heading) lines.push(`<h${heading[1].length}>${escape(heading[2])}</h${heading[1].length}>`);
    else if (raw.trim()) lines.push(`<p>${escape(raw)}</p>`);
  }
  if (table) lines.push('</table>');
  const title = safeMarkdownFilename(filename, 'qapaq-informe').replace(/\.md$/i, '');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escape(title)}</title>
  <style>@page{size:A4;margin:18mm}body{font:11pt Arial,sans-serif;color:#20232a;line-height:1.5;margin:24px auto;max-width:190mm}header{display:flex;align-items:center;gap:18px;border-bottom:4px solid #ff5841;padding-bottom:18px}header img{width:64px;height:64px;object-fit:contain}header strong{font-size:22pt}header small{display:block;color:#555}h1{font-size:20pt}h2{font-size:15pt;border-bottom:1px solid #ddd;padding-bottom:6px}h3{font-size:12pt}h1,h2,h3,h4{break-after:avoid}p,td{overflow-wrap:anywhere;white-space:pre-wrap}table{width:100%;border-collapse:collapse;font-size:9pt;margin:14px 0}td{border:1px solid #ccc;padding:7px;vertical-align:top}tr{break-inside:avoid}footer{border-top:1px solid #ccc;margin-top:24px;font-size:9pt;color:#555}.toolbar{padding:12px;background:#f3f4f6;margin-bottom:20px}.toolbar button{padding:10px 18px;cursor:pointer}@media print{body{margin:0;max-width:none}.toolbar{display:none}}</style></head><body>
  <div class="toolbar"><button id="print">Guardar como PDF / Imprimir</button><p>Selecciona Guardar como PDF en el diálogo del navegador. Revisa la cobertura declarada antes de distribuir.</p></div>
  <header><img src="${escape(basePath)}/ui/qapaq/qapaq-mark-gradient.png" alt="QAPAQ"><div><strong>QAPAQ SOC</strong><small>Informe de investigación · Analista IA</small></div></header>
  <main>${lines.join('\n')}</main><footer>QAPAQ SOC · Documento de uso interno. Las conclusiones conservan las limitaciones y referencias del expediente original.</footer></body></html>`;
}

export function openReportWindow(): Window {
  const target = window.open('', '_blank');
  if (!target) throw new Error('Permite ventanas emergentes para preparar el PDF.');
  target.opener = null;
  target.document.body.textContent = 'Preparando informe QAPAQ…';
  return target;
}

export function printAnalystReport(
  filename: string,
  markdown: string,
  basePath = '',
  target = openReportWindow(),
): void {
  target.document.open();
  target.document.write(analystReportHtml(filename, markdown, basePath));
  target.document.close();
  target.document.getElementById('print')?.addEventListener('click', () => target.print());
}

export function digestFilename(from: string, to: string): string {
  return safeMarkdownFilename(`analista-ia-resumen-${from}_${to}`, 'analista-ia-resumen');
}
