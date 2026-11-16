import { parseServiceAttention, serviceAttentionQuery } from './overview';

describe('service attention evidence', () => {
  it('bounds a single request, separates overlapping sources and sorts severity first', () => {
    const q = serviceAttentionQuery() as any;
    expect(q.query.bool.filter).toContainEqual({ range: { 'rule.level': { gte: 8 } } });
    expect(q.aggs.services.filters.filters.sharepoint).toEqual({
      term: { 'rule.groups': 'qapaq_sharepoint' },
    });
    expect(q.aggs.services.filters.filters.office365).toEqual({
      term: { 'rule.groups': 'office365' },
    });
    expect(q.aggs.services.aggs.events.top_hits.size).toBe(100);
    expect(q.aggs.services.aggs.events.top_hits.sort[0]).toEqual({
      'rule.level': { order: 'desc' },
    });
  });
  it('preserves total independently of bounded preview and distinguishes missing from empty', () => {
    const result = parseServiceAttention({
      aggregations: {
        services: {
          buckets: {
            wazuh: {
              doc_count: 150,
              events: {
                hits: {
                  hits: [{ _id: 'e1', _source: { rule: { level: 15, description: 'Critical' } } }],
                },
              },
            },
            aws: { doc_count: 0, events: { hits: { hits: [] } } },
          },
        },
      },
    });
    expect(result.wazuh).toMatchObject({ total: 150, access: 'ok', events: [{ id: 'e1' }] });
    expect(result.aws).toEqual({ total: 0, access: 'ok', events: [] });
    expect(result.office365).toEqual({ total: null, access: 'error', events: [] });
  });
  it.each([{ timed_out: true }, { _shards: { failed: 1 } }, { terminated_early: true }])(
    'does not present partial search as complete: %j',
    (failure) => {
      const result = parseServiceAttention({
        ...failure,
        aggregations: {
          services: {
            buckets: {
              wazuh: { doc_count: 0, events: { hits: { hits: [] } } },
            },
          },
        },
      });
      expect(result.wazuh?.access).toBe('error');
      expect(result.wazuh?.total).toBeNull();
    },
  );
});
