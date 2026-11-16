import { describe, expect, it } from 'vitest';

import { subjectFromRaw } from '../src/assistant/analyst-subject.js';

describe('detalles del evento de la alerta (lista blanca por dominio)', () => {
  it('vulnerabilidad priorizada: toma data.qapaq.vuln y nada más', () => {
    const subject = subjectFromRaw({
      rule: { level: 13, id: '101862' },
      full_log: 'NO DEBE SALIR',
      data: { qapaq: { vuln: { cve: 'CVE-2026-125350', kev: 'true', epss: '', asset: 'repo:Dockerfile' } } },
    });
    expect(subject.domain).toBe('vulnerability');
    expect(subject.details).toMatchObject({ cve: 'CVE-2026-125350', kev: 'true', asset: 'repo:Dockerfile', rule_level: 13 });
    expect(JSON.stringify(subject)).not.toContain('NO DEBE SALIR');
  });

  it('salud de plataforma: chequeo, estado, componente y resumen', () => {
    const subject = subjectFromRaw({
      data: { qapaq: { health: { check: 'host_disk', status: 'problem', component: '/', summary: 'Disco / al 92%', secret: 'x' } } },
    });
    expect(subject.domain).toBe('platform');
    expect(subject.details).toEqual({ check: 'host_disk', status: 'problem', component: '/', summary: 'Disco / al 92%' });
  });

  it('FIM y rootcheck por grupos de la regla; sin registro, dominio por grupos y sin detalles', () => {
    expect(subjectFromRaw({ syscheck: { path: '/etc/sudoers', event: 'modified', sha256_after: 'abc' } }).details).toEqual({
      path: '/etc/sudoers',
      event: 'modified',
    });
    expect(subjectFromRaw(null, ['ossec', 'rootcheck']).domain).toBe('rootcheck');
    expect(subjectFromRaw(null, ['snyk', 'qapaq_vulnerability']).domain).toBe('vulnerability');
    expect(subjectFromRaw(null, []).domain).toBe('generic');
  });

  it('enmascara datos personales en los textos', () => {
    const subject = subjectFromRaw({ data: { qapaq: { health: { check: 'x', summary: 'falló para jperez@qapaq.pe' } } } });
    expect(String(subject.details['summary'])).not.toContain('jperez@qapaq.pe');
  });
});
