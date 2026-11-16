/* Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import { analystReportHtml, openReportWindow, printAnalystReport } from './ai_analyst_download';

describe('branded analyst printable report', () => {
  it('preserves coverage and citations in an A4 document with the official mark', () => {
    const html = analystReportHtml(
      'case.md',
      '# Expediente\n## Cobertura\nEvidencia incompleta: alerta a-1\n| Fuente | ID |\n| --- | --- |\n| Wazuh | a-1 |',
      '/soc',
    );
    expect(html).toContain('src="/soc/ui/qapaq/qapaq-mark-gradient.png"');
    expect(html).toContain('<title>case</title>');
    expect(html).toContain('@page{size:A4');
    expect(html).toContain('<h2>Cobertura</h2>');
    expect(html).toContain('Evidencia incompleta: alerta a-1');
    expect(html).toContain('<td>Wazuh</td><td>a-1</td>');
    expect(html).not.toContain('<td>---</td>');
    expect(html).toContain('diálogo');
    expect(html).toContain('Informe de investigación');
  });

  it('renders evidence as text without executable markup or external markdown images', () => {
    const html = analystReportHtml(
      'case.md',
      '# <script>alert(1)</script>\n<img src=x onerror=alert(1)>\n![tracking](https://attacker.test/pixel)\n| <svg onload=alert(1)> |',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;script&gt;');
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
  });

  it('reports a blocked popup instead of claiming a saved PDF', () => {
    vi.stubGlobal('window', { open: () => null });
    try {
      expect(() => openReportWindow()).toThrow('Permite ventanas emergentes');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('prints only on explicit action in the prepared report', () => {
    const print = vi.fn();
    const addEventListener = vi.fn();
    const target = {
      document: {
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        getElementById: () => ({ addEventListener }),
      },
      print,
    };
    printAnalystReport('case.md', '# Informe', '', target as unknown as Window);
    expect(print).not.toHaveBeenCalled();
    expect(addEventListener.mock.calls[0][0]).toBe('click');
    addEventListener.mock.calls[0][1]();
    expect(print).toHaveBeenCalledOnce();
  });
});
