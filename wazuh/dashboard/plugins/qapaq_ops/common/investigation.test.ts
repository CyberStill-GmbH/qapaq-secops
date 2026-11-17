/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  entityClauses,
  entityKey,
  entityKql,
  extractEntities,
  emailOperationDirection,
  groupExactEmailMessages,
  summarizeExactEmailMessageGroup,
  parseEntityKey,
  selectQueryEntities,
  validEntity,
} from './investigation';
import { discoverUrlForQuery, mitreTechniqueUrl, threatHuntingUrl } from './discover';
import { vendorLogoUrl, vendorOfGroups, vendorOfTitle, wazuhRuleIdOfTitle } from './vendors';
import { alertQuestion } from './qapaqzito_bridge';
import { NAV_CATEGORIES, NAV_HIDDEN, NAV_PLACEMENT } from './navigation';

describe('entidades de un evento de wazuh-alerts-*', () => {
  it('mantiene la selección visible alineada con el límite de entidades consultadas', () => {
    const entities = Array.from({ length: 10 }, (_, index) => ({
      kind: 'host' as const,
      value: `host-${index}`,
      field: 'agent.name',
    }));

    expect(selectQueryEntities(entities)).toEqual(entities.slice(0, 8));
    expect(selectQueryEntities(entities, ['host:host-1', 'host:host-9'])).toEqual([entities[1]]);
    expect(selectQueryEntities(entities, [])).toEqual([]);
  });

  it('extrae usuario, IP y zona de Cloudflare sin el manager como equipo', () => {
    const source = {
      agent: { id: '000', name: 'wazuh.manager' },
      data: {
        cloudflare: {
          zone_name: 'qapaq.pe',
          audit: { actor_email: 'qapaqservice@qapaq.pe', actor_ip: '18.214.220.109' },
        },
      },
    };
    expect(extractEntities(source).map(entityKey)).toEqual([
      'user:qapaqservice@qapaq.pe',
      'ip:18.214.220.109',
      'zone:qapaq.pe',
    ]);
  });

  it('usa mailbox owner y destinatarios del schema como pivotes de usuario', () => {
    const source = {
      agent: { id: '000', name: 'wazuh.manager' },
      data: {
        office365: {
          UserId: 'sender@example.test',
          MailboxOwnerUPN: 'owner@example.test',
          recipientList: [
            { Address: 'recipient@example.test', Name: 'Recipient' },
            { Address: 'recipient@example.test', Name: 'duplicate' },
            { Name: 'missing address' },
          ],
        },
      },
    };
    expect(extractEntities(source).map(entityKey)).toEqual([
      'user:sender@example.test',
      'user:owner@example.test',
      'user:recipient@example.test',
    ]);
    expect(entityClauses([{ kind: 'user', value: 'recipient@example.test' }])).toContainEqual({
      term: { 'data.office365.recipientList.Address': 'recipient@example.test' },
    });
  });

  it('usa el agente cuando no es el manager y quita duplicados y ruido', () => {
    const source = {
      agent: { id: '001', name: 'web-01', ip: '10.0.0.5' },
      data: { srcip: '10.0.0.5', srcuser: '-', bitdefender: { endpoint: { name: 'web-01' } } },
    };
    expect(extractEntities(source).map(entityKey)).toEqual(['host:web-01', 'ip:10.0.0.5']);
  });

  it('valida las claves de pivote', () => {
    expect(parseEntityKey('ip:2001:db8::1')).toEqual({ kind: 'ip', value: '2001:db8::1' });
    expect(parseEntityKey('ip:no-es-ip')).toBeNull();
    expect(parseEntityKey('otro:x')).toBeNull();
    expect(validEntity('host', 'wazuh.manager')).toBe(false);
    expect(validEntity('user', `a${String.fromCharCode(0)}b`)).toBe(false);
  });

  it('consulta todos los campos de cada entidad (Indexer y KQL)', () => {
    expect(entityClauses([{ kind: 'zone', value: 'qapaq.pe' }])).toEqual([
      { term: { 'data.cloudflare.zone_name': 'qapaq.pe' } },
      { term: { 'data.cloudflare.audit.zone_name': 'qapaq.pe' } },
    ]);
    expect(entityKql([{ kind: 'project', value: 'a"b' }])).toBe('data.snyk.project.name:"a\\"b"');
  });
});

describe('correlación de mensajes M365 por identificador exacto', () => {
  const summary = (
    id: string,
    email?: {
      networkMessageId?: string;
      internetMessageId?: string;
      operation?: string;
      mailboxOwnerUpn?: string;
      recipients?: readonly string[];
      recipientsTruncated?: boolean;
    },
  ) => ({
    id,
    index: 'wazuh-alerts-test',
    at: '2026-11-11T12:00:00.000Z',
    level: 8,
    ruleId: '101700',
    description: `evento ${id}`,
    groups: ['office365'],
    vendor: 'office365' as const,
    agent: null,
    ...(email ? { email } : {}),
    mitre: { ids: [], tactics: [], techniques: [] },
    matched: [],
  });

  it('agrupa por NetworkMessageId compartido aunque no pueda afirmar recepción', () => {
    const sender = summary('send-1', {
      networkMessageId: 'abcdef01-2345-6789-abcd-ef0123456789',
      internetMessageId: '<message-1@example.test>',
      operation: 'Send',
    });
    const receiver = summary('receive-1', {
      networkMessageId: 'ABCDEF01-2345-6789-ABCD-EF0123456789',
      internetMessageId: '<message-1@example.test>',
      operation: 'MailItemsAccessed',
    });
    const sameUserAndTime = summary('nearby-1');

    expect(groupExactEmailMessages([sender, receiver, sameUserAndTime])).toEqual([
      {
        idType: 'NetworkMessageId',
        id: 'abcdef01-2345-6789-abcd-ef0123456789',
        events: [sender, receiver],
      },
    ]);
  });

  it('agrupa por InternetMessageId solo cuando no hay NetworkMessageId común', () => {
    const first = summary('send-2', { internetMessageId: '<message-2@example.test>' });
    const second = summary('receive-2', { internetMessageId: '<message-2@example.test>' });
    const conflictingNetwork = summary('other-2', {
      networkMessageId: '12345678-1234-1234-1234-123456789abc',
      internetMessageId: '<message-2@example.test>',
    });
    const groups = groupExactEmailMessages([first, second, conflictingNetwork]);
    expect(groups).toEqual([
      {
        idType: 'InternetMessageId',
        id: '<message-2@example.test>',
        events: [first, second],
      },
    ]);
    expect(
      groupExactEmailMessages([
        first,
        summary('case-variant', { internetMessageId: '<MESSAGE-2@EXAMPLE.TEST>' }),
      ]),
    ).toEqual([]);
  });

  it('resume buzones, destinatarios y direcciones solo desde operaciones explícitas', () => {
    const send = summary('send', {
      networkMessageId: 'same-id',
      operation: 'SendAs',
      mailboxOwnerUpn: 'sender@example.test',
      recipients: ['recipient@example.test'],
    });
    const receive = summary('receive', {
      networkMessageId: 'same-id',
      operation: 'MailItemsAccessed',
      mailboxOwnerUpn: 'recipient@example.test',
      recipients: ['archive@example.test'],
      recipientsTruncated: true,
    });
    const ambiguous = summary('ambiguous', {
      networkMessageId: 'same-id',
      operation: 'MailItemsAccessed',
    });
    const group = groupExactEmailMessages([send, receive, ambiguous])[0]!;

    expect(summarizeExactEmailMessageGroup(group)).toEqual({
      direction: 'Salida; Dirección no determinada',
      operations: ['MailItemsAccessed', 'SendAs'],
      auditedMailboxes: ['recipient@example.test', 'sender@example.test'],
      recipients: ['archive@example.test', 'recipient@example.test'],
      recipientCount: 2,
      recipientsTruncated: true,
    });
    expect(emailOperationDirection('MailItemsAccessed')).toBe('Dirección no determinada');
    expect(emailOperationDirection('Receive')).toBe('Dirección no determinada');
    expect(emailOperationDirection('Deliver')).toBe('Dirección no determinada');
    expect(emailOperationDirection(undefined)).toBe('Dirección no determinada');
  });

  it('acota memoria y lista de destinatarios y reporta un conteo mínimo al superar el límite', () => {
    const recipients = new Proxy(
      Array.from({ length: 105 }, (_, index) => `recipient-${index}@example.test`),
      {
        get(target, property, receiver) {
          if (property === '101') throw new Error('recipient scan continued after overflow');
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const first = summary('send-large', {
      networkMessageId: 'large-message',
      recipients,
    });
    const second = summary('audit-large', {
      networkMessageId: 'large-message',
      recipients: ['recipient-0@example.test', 'recipient-104@example.test'],
    });
    const evidence = summarizeExactEmailMessageGroup(groupExactEmailMessages([first, second])[0]!);

    expect(evidence.recipients).toHaveLength(100);
    expect(evidence.recipients).toContain('recipient-0@example.test');
    expect(evidence.recipients).not.toContain('recipient-104@example.test');
    expect(evidence.recipientCount).toBe(101);
    expect(evidence.recipientsTruncated).toBe(true);
  });
});

describe('enlaces de investigación', () => {
  it('Threat Hunting y Discover llevan la consulta y la ventana', () => {
    const th = threatHuntingUrl(
      '',
      'rule.id:1',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    );
    expect(th.startsWith('/app/threat-hunting#/overview/?tab=general&tabView=events&_a=')).toBe(
      true,
    );
    expect(decodeURIComponent(th)).toContain("query:'rule.id:1'");
    expect(decodeURIComponent(th)).toContain("from:'2026-01-01T00:00:00.000Z'");
    const discover = discoverUrlForQuery('/base', 'x:"y"', 'a', 'b');
    expect(discover.startsWith('/base/app/data-explorer/discover#?_a=')).toBe(true);
  });

  it('MITRE: técnica y subtécnica', () => {
    expect(mitreTechniqueUrl('T1562.001')).toBe('https://attack.mitre.org/techniques/T1562/001/');
    expect(mitreTechniqueUrl('T1110')).toBe('https://attack.mitre.org/techniques/T1110/');
    expect(mitreTechniqueUrl('javascript:1')).toBeNull();
  });
});

describe('proveedores', () => {
  it('reconoce el origen por grupo, por data.qapaq.vendor y por título', () => {
    expect(vendorOfGroups(['qapaq_waf', 'cloudflare'])).toBe('cloudflare');
    expect(vendorOfGroups(['syslog'], 'snyk')).toBe('snyk');
    expect(vendorOfGroups(['sshd'])).toBe('wazuh');
    expect(vendorOfTitle('QAPAQ Bitdefender: firmas desactualizadas en X. (wazuh 101407)')).toBe(
      'bitdefender',
    );
    expect(vendorOfTitle('Inicio de sesión en Office 365')).toBe('office365');
    expect(vendorOfTitle('sshd: autenticación fallida')).toBe('wazuh');
    expect(wazuhRuleIdOfTitle('QAPAQ Cloudflare: cambio DNS. (wazuh 101503)')).toBe('101503');
    expect(wazuhRuleIdOfTitle('sin regla')).toBeNull();
    expect(vendorLogoUrl('/b', 'aws', true)).toBe('/b/ui/qapaq/vendors/aws-on-dark.svg');
  });
});

describe('Preguntar a Qapaqzito', () => {
  it('arma una pregunta con la alerta, la regla, MITRE y entidades', () => {
    const text = alertQuestion({
      id: 'a1',
      title: 'QAPAQ Cloudflare: cambio DNS',
      priority: 'P3',
      occurredAt: '2026-11-08T14:57:31.925Z',
      ruleId: '101503',
      entities: [{ kind: 'zone', value: 'qapaq.pe' }],
      mitre: ['T1584.002'],
    });
    expect(text).toContain('«QAPAQ Cloudflare: cambio DNS»');
    expect(text).toContain('Regla de Wazuh: 101503.');
    expect(text).toContain('MITRE ATT&CK: T1584.002.');
    expect(text).toContain('zone qapaq.pe');
  });
});

describe('navegación del SIEM', () => {
  it('cada app visible cae en una categoría conocida y ninguna está a la vez oculta', () => {
    for (const [id, placement] of Object.entries(NAV_PLACEMENT)) {
      expect(NAV_CATEGORIES[placement.category]).toBeDefined();
      expect(NAV_HIDDEN[id]).toBeUndefined();
    }
  });

  it('Ankay aparece con su nombre de producto, no como «SOAR»', () => {
    expect(NAV_PLACEMENT['ankay'].title).toBe('Ankay');
    expect(NAV_PLACEMENT['ankay'].category).toBe('response');
  });

  it('oculta los módulos sin servicio en este despliegue', () => {
    for (const id of ['google-cloud', 'github', 'microsoft-graph-api', 'cluster']) {
      expect(NAV_HIDDEN[id]).toBeTruthy();
    }
  });
});
