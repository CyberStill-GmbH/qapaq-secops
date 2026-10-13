import { describe, expect, it } from 'vitest';

import { validateSecurityEvent } from '@qapaq/contracts';

import {
  normalizeWazuhAlert,
  WAZUH_MAPPING_VERSION,
  type WazuhAlertInput,
  type WazuhNormalizationContext,
} from '../src/wazuh-normalization.js';
import {
  normalizeClientIp,
  OFFICE365_EXTENSION_NAMESPACE,
  office365ActionSlug,
  projectOffice365,
} from '../src/wazuh-office365.js';

/**
 * C-12 · mapping 1.1.0 — alertas Wazuh derivadas de Office 365.
 *
 * Los documentos son sintéticos: reproducen la forma que el módulo `office365` de Wazuh
 * deja en `data.office365`, con IPs de documentación (RFC 5737/3849) y cuentas ficticias.
 */

const context: WazuhNormalizationContext = {
  tenantId: 'tenant-qapaq-001',
  instanceId: 'siem-qapaq-lab',
  connector: 'qapaq-wazuh-indexer',
  connectorVersion: '1.0.0',
  receivedAt: new Date('2026-10-11T12:00:00.000Z'),
};

function office365Alert(
  office365: Record<string, unknown>,
  rule: Record<string, unknown> = {},
): WazuhAlertInput {
  return {
    record: {
      sourceRecordId: 'o365-01',
      dataset: 'alerts',
      collectedAt: '2026-10-11T11:59:30.000Z',
      raw: {
        timestamp: '2026-10-11T11:59:00.000Z',
        rule: {
          id: 100510,
          level: 12,
          description: 'Office 365: regla de bandeja que reenvía correo',
          groups: ['office365', 'qapaq_m365'],
          ...rule,
        },
        agent: { id: '000', name: 'wazuh-manager' },
        data: { integration: 'office365', office365 },
      },
    },
    raw: {
      ref: 'raw:tenant-qapaq-001/2026/10/11/o365-01',
      sha256: 'ab'.repeat(32),
      mediaType: 'application/json',
      sizeBytes: 4096,
    },
  };
}

const inboxRule = {
  CreationTime: '2026-10-11T11:58:58',
  Operation: 'New-InboxRule',
  Workload: 'Exchange',
  RecordType: 1,
  ResultStatus: 'True',
  UserId: 'Usuario.Sintetico@qapaq-lab.example',
  UserKey: '10032000A1B2C3D4',
  UserType: 0,
  OrganizationId: '00000000-0000-4000-8000-000000000001',
  ClientIP: '203.0.113.24:51544',
  ObjectId: 'Usuario.Sintetico\\Reenviar todo',
  Parameters: [
    { Name: 'ForwardTo', Value: 'externo@dominio-ajeno.example' },
    { Name: 'Name', Value: 'Reenviar todo' },
  ],
};

function normalized(input: WazuhAlertInput) {
  const outcome = normalizeWazuhAlert(input, context);
  if (outcome.status !== 'normalized') throw new Error('se esperaba normalización');
  return outcome.event;
}

describe('C-12 · Office 365: lo que el analista necesita para triar', () => {
  it('lleva la operación de Microsoft como acción del evento', () => {
    const event = normalized(office365Alert(inboxRule));

    expect(validateSecurityEvent(event).valid).toBe(true);
    expect(event.action).toBe('office365.new-inboxrule');
    expect(event.provenance.mappingVersion).toBe(WAZUH_MAPPING_VERSION);
    expect(WAZUH_MAPPING_VERSION).toBe('1.1.0');
  });

  it('identifica al usuario por UPN con dominio e identificador opaco', () => {
    const event = normalized(office365Alert(inboxRule));

    expect(event.entities.identities).toEqual([
      {
        kind: 'user',
        principal: 'Usuario.Sintetico@qapaq-lab.example',
        id: '10032000A1B2C3D4',
        domain: 'qapaq-lab.example',
      },
    ]);
  });

  it('declara IP de cliente sin puerto, workload y objeto afectado como recursos', () => {
    const event = normalized(office365Alert(inboxRule));

    expect(event.entities.resources).toEqual(
      expect.arrayContaining([
        { kind: 'ip', id: '203.0.113.24', type: 'client' },
        { kind: 'service', name: 'Exchange', type: 'microsoft365.workload' },
        { kind: 'object', name: 'Usuario.Sintetico\\Reenviar todo', type: 'microsoft365.object' },
      ]),
    );
  });

  it('publica la extensión microsoft.office365 solo con escalares declarados', () => {
    const event = normalized(office365Alert(inboxRule));

    expect(event.extensions?.[OFFICE365_EXTENSION_NAMESPACE]).toEqual({
      operation: 'New-InboxRule',
      workload: 'Exchange',
      recordType: 1,
      resultStatus: 'True',
      userType: 'regular',
      organizationId: '00000000-0000-4000-8000-000000000001',
      clientIp: '203.0.113.24',
    });
  });

  it('no copia Parameters: la dirección de reenvío queda solo en el crudo', () => {
    const serialized = JSON.stringify(normalized(office365Alert(inboxRule)));

    expect(serialized).not.toContain('externo@dominio-ajeno.example');
    expect(serialized).not.toContain('Parameters');
  });

  it('complementa la categoría del grupo con la del workload', () => {
    const event = normalized(office365Alert(inboxRule));

    expect(event.category).toEqual(['iam', 'email']);
  });
});

describe('C-12 · Office 365: resultado y autenticación', () => {
  it('un UserLoginFailed es autenticación fallida aunque falte ResultStatus', () => {
    const event = normalized(
      office365Alert({
        Operation: 'UserLoginFailed',
        Workload: 'AzureActiveDirectory',
        RecordType: 15,
        UserId: 'usuario.sintetico@qapaq-lab.example',
        ClientIP: '198.51.100.7',
      }),
    );

    expect(event.outcome).toBe('failure');
    expect(event.category).toEqual(['iam', 'authentication']);
  });

  it('un UserLoggedIn es autenticación exitosa', () => {
    const event = normalized(
      office365Alert({
        Operation: 'UserLoggedIn',
        Workload: 'AzureActiveDirectory',
        UserId: 'usuario.sintetico@qapaq-lab.example',
      }),
    );

    expect(event.outcome).toBe('success');
  });

  it('el grupo de la regla prevalece sobre ResultStatus', () => {
    const event = normalized(
      office365Alert(
        { Operation: 'UserLoggedIn', Workload: 'AzureActiveDirectory', ResultStatus: 'Success' },
        { groups: ['office365', 'authentication_failed'] },
      ),
    );

    expect(event.outcome).toBe('failure');
  });

  it('traduce UserType numérico o textual y conserva lo desconocido como tal', () => {
    expect(projectOffice365({ office365: { UserType: '2' } })?.extension['userType']).toBe('admin');
    expect(projectOffice365({ office365: { UserType: 42 } })?.extension['userType']).toBe(
      'unknown_42',
    );
  });
});

describe('C-12 · Office 365: acción como slug del contrato', () => {
  it.each([
    ['New-InboxRule', 'office365.new-inboxrule'],
    ['Add member to role.', 'office365.add-member-to-role'],
    ['UserLoginFailed', 'office365.userloginfailed'],
    ['Set-Mailbox', 'office365.set-mailbox'],
  ])('%s → %s', (operation, expected) => {
    expect(office365ActionSlug(operation)).toBe(expected);
  });

  it('descarta una operación sin caracteres utilizables', () => {
    expect(office365ActionSlug('...')).toBeUndefined();
  });
});

describe('C-12 · Office 365: entradas hostiles o incompletas', () => {
  it.each([
    ['203.0.113.24', '203.0.113.24'],
    ['203.0.113.24:443', '203.0.113.24'],
    ['2001:DB8::1', '2001:db8::1'],
    ['[2001:db8::1]:443', '2001:db8::1'],
  ])('normaliza la IP %s', (input, expected) => {
    expect(normalizeClientIp(input)).toBe(expected);
  });

  it.each(['', 'no-es-ip', '999.1.1.1', '203.0.113.24:abc', '<script>', 42])(
    'descarta %s como IP',
    (input) => {
      expect(normalizeClientIp(input)).toBeUndefined();
    },
  );

  it('no inventa recursos ni extensión si data.office365 está vacío', () => {
    const event = normalized(office365Alert({}));

    expect(event.action).toBe('alert.created');
    expect(event.extensions).toBeUndefined();
    expect(event.entities.identities).toEqual([]);
  });

  it('recorta valores largos a los límites del contrato y el evento sigue validando', () => {
    const event = normalized(
      office365Alert({
        Operation: 'X'.repeat(500),
        UserId: `${'u'.repeat(400)}@qapaq-lab.example`,
        ObjectId: 'o'.repeat(1000),
      }),
    );

    expect(validateSecurityEvent(event).valid).toBe(true);
    expect(event.action).toBe(`office365.${'x'.repeat(100)}`);
  });

  it('ignora data.office365 que no es un objeto plano', () => {
    expect(projectOffice365({ office365: ['no', 'objeto'] })).toBeUndefined();
    expect(projectOffice365({ office365: 'texto' })).toBeUndefined();
    expect(projectOffice365(undefined)).toBeUndefined();
  });
});

describe('C-12 · data.srcip genérico', () => {
  it('declara la IP de origen de alertas que no son de Office 365', () => {
    const outcome = normalizeWazuhAlert(
      {
        record: {
          sourceRecordId: 'ssh-01',
          dataset: 'alerts',
          collectedAt: '2026-10-11T11:59:30.000Z',
          raw: {
            timestamp: '2026-10-11T11:59:00.000Z',
            rule: {
              id: 5716,
              level: 5,
              description: 'sshd: authentication failed',
              groups: ['sshd'],
            },
            data: { srcuser: 'svc-sintetico', srcip: '192.0.2.10' },
          },
        },
        raw: office365Alert({}).raw,
      },
      context,
    );
    if (outcome.status !== 'normalized') throw new Error('se esperaba normalización');

    expect(outcome.event.entities.resources).toContainEqual({
      kind: 'ip',
      id: '192.0.2.10',
      type: 'source',
    });
  });
});
