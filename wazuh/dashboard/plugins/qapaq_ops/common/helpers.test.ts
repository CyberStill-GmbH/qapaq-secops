/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { discoverUrlForEntity, entityQuery, kqlQuoted, risonString } from './discover';
import { parseResource } from './audit_filters';
import { userState } from './user_state';
import type { DirectoryUser } from './api_contract';

describe('enlace a Discover', () => {
  it('escapa rison y KQL', () => {
    expect(risonString("a'b!c")).toBe("'a!'b!!c'");
    expect(kqlQuoted('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('filtra por el campo de la entidad', () => {
    expect(entityQuery({ ref: null, kind: 'user', label: 'ana@qapaq.pe' })).toBe(
      'data.office365.UserId:"ana@qapaq.pe"',
    );
    expect(entityQuery({ ref: null, kind: 'ip', label: '10.0.0.1' })).toBe(
      'data.office365.ClientIP:"10.0.0.1" or data.srcip:"10.0.0.1"',
    );
    expect(entityQuery({ ref: null, kind: 'device', label: 'x' })).toBeNull();
  });

  it('arma la URL de data-explorer con ventana de ±1 h y el patrón de alertas', () => {
    const url = discoverUrlForEntity(
      '',
      { ref: 'e1', kind: 'user', label: 'ana@qapaq.pe' },
      '2026-10-13T12:00:00.000Z',
    )!;
    expect(url.startsWith('/app/data-explorer/discover#?_a=')).toBe(true);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("indexPattern:'wazuh-alerts-*'");
    expect(decoded).toContain(
      "time:(from:'2026-10-13T11:00:00.000Z',to:'2026-10-13T13:00:00.000Z')",
    );
    expect(decoded).toContain(
      `query:(language:kuery,query:'data.office365.UserId:"ana@qapaq.pe"')`,
    );
  });

  it('sin fecha válida no hay enlace', () => {
    expect(discoverUrlForEntity('', { ref: null, kind: 'ip', label: '1.1.1.1' }, 'x')).toBeNull();
  });
});

describe('filtro de recurso de auditoría', () => {
  it.each([
    ['', {}],
    ['incident', { resourceType: 'incident' }],
    ['incident:abc', { resourceType: 'incident', resourceId: 'abc' }],
    [':abc', { resourceType: undefined, resourceId: 'abc' }],
  ])('%p', (input, expected) => {
    expect(parseResource(input)).toEqual(expected);
  });
});

describe('estado de una persona', () => {
  const now = Date.parse('2026-10-13T12:00:00.000Z');
  const base: DirectoryUser = {
    oid: '00000000-0000-0000-0000-000000000001',
    displayName: 'Ana',
    upn: 'ana@qapaq.pe',
    accountEnabled: true,
    membership: 'member',
    isOwner: false,
    roles: ['qapaq.soc.analyst'],
    roleOrigin: 'entra_app_role',
    lastSeenAt: '2026-10-13T11:45:00.000Z',
    activeSessions: 1,
  };

  it.each<[Partial<DirectoryUser>, string]>([
    [{}, 'En línea'],
    [{ lastSeenAt: '2026-10-13T11:00:00.000Z' }, 'Inactiva'],
    [{ activeSessions: 0 }, 'Sin sesión'],
    [{ roleOrigin: 'none', roles: [] }, 'Sin rol'],
    [{ accountEnabled: false }, 'Deshabilitada en Entra'],
    [{ membership: 'removed' }, 'Fuera del grupo'],
    [{ accountEnabled: false, membership: 'removed' }, 'Deshabilitada en Entra'],
  ])('%p → %s', (patch, label) => {
    expect(userState({ ...base, ...patch }, now).label).toBe(label);
  });
});
