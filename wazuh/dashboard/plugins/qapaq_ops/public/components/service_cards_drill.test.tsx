import { linkedMetrics } from './service_cards';

describe('linkedMetrics', () => {
  it('convierte el conteo con consulta en un enlace a las alertas contadas', () => {
    const [critical, plain] = linkedMetrics(
      [
        {
          label: 'Críticas',
          value: '3',
          drill: { kql: 'rule.groups: "snyk" and data.snyk.issue.severity: "critical"', from: 'now-30d' },
        },
        { label: 'Zonas', value: '2' },
      ],
      '/base',
    );
    expect(critical.href).toContain('/base/app/data-explorer/discover#?');
    expect(decodeURIComponent(critical.href as string)).toContain('data.snyk.issue.severity');
    expect(decodeURIComponent(critical.href as string)).toContain('now-30d');
    expect(plain.href).toBeUndefined();
  });
});
