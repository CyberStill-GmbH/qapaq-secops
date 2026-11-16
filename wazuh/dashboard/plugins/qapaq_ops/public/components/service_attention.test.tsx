import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServiceAttentionList, attentionQuery, filterAttention } from './service_attention';
import { TopEvent } from '../../common';

const events: TopEvent[] = [
  {
    id: 'critical-1',
    level: 12,
    description: '<script>critical</script>',
    agent: 'server-a',
    ruleId: '100',
    at: '2026-11-13T12:00:00Z',
    provider: 'aws',
  },
  {
    id: 'high-1',
    level: 8,
    description: 'High event',
    agent: 'server-b',
    ruleId: '200',
    at: '2026-11-13T12:00:00Z',
    provider: 'aws',
  },
];
it('filters by critical band and title, rule or host without mixing service query', () => {
  expect(filterAttention(events, true, 'server-a')).toEqual([events[0]]);
  expect(filterAttention(events, true, '200')).toEqual([]);
  expect(attentionQuery('sharepoint', true)).toBe(
    'rule.level >= 12 and rule.groups: "qapaq_sharepoint"',
  );
});
it('shows event context without opening cards, escapes source text and states truncation', () => {
  const html = renderToStaticMarkup(
    <ServiceAttentionList
      service="aws"
      name="AWS"
      basePath="/base"
      data={{ access: 'ok', total: 120, events }}
    />,
  );
  expect(html).toContain('critical-1');
  expect(html).toContain('&lt;script&gt;critical&lt;/script&gt;');
  expect(html).toContain('server-a');
  expect(html).toContain('100 eventos');
  expect(html).toContain('Investigar evento');
  expect(html).toContain('/base/app/data-explorer/discover');
});
it('never labels denied evidence as an empty queue', () => {
  const html = renderToStaticMarkup(
    <ServiceAttentionList
      service="aws"
      name="AWS"
      basePath=""
      data={{ access: 'forbidden', total: null, events: [] }}
    />,
  );
  expect(html).toContain('Sin permiso');
  expect(html).not.toContain('Sin eventos');
});
