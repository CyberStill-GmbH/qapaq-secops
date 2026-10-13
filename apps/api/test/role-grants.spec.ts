/**
 * Sprint 5 — roles concedidos por QAPAQ: asignaciones del deploy, dueños del grupo (deploy y
 * Graph) y nada para quien no figura. OID sintéticos.
 */

import { describe, expect, it } from 'vitest';

import { loadRoleGrantsConfig } from '@qapaq/configuration';

import { createRoleGrantResolver } from '../src/runtime/role-grants.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ANALYST = '22222222-2222-4222-8222-222222222222';
const GRAPH_OWNER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';

const config = loadRoleGrantsConfig({
  QAPAQ_PROFILE: 'test',
  QAPAQ_ROLE_BINDINGS: `${ANALYST.toUpperCase()}=qapaq.soc.analyst`,
  QAPAQ_GROUP_OWNER_OIDS: OWNER,
});

describe('roles concedidos por QAPAQ', () => {
  it('el dueño declarado es admin y la asignación explícita da analista (sin distinguir mayúsculas)', async () => {
    const resolve = createRoleGrantResolver(config);
    expect(await resolve(OWNER)).toEqual(['qapaq.platform.admin']);
    expect(await resolve(ANALYST)).toEqual(['qapaq.soc.analyst']);
  });

  it('quien no figura no recibe nada, y sin oid tampoco', async () => {
    const resolve = createRoleGrantResolver(config);
    expect(await resolve(STRANGER)).toEqual([]);
    expect(await resolve(undefined)).toEqual([]);
  });

  it('suma los dueños leídos del directorio; si el directorio falla conserva el deploy', async () => {
    const resolve = createRoleGrantResolver(config, {
      owners: async () => new Set([GRAPH_OWNER]),
    });
    expect(await resolve(GRAPH_OWNER)).toEqual(['qapaq.platform.admin']);

    const failing = createRoleGrantResolver(config, {
      owners: async () => {
        throw new Error('graph caído');
      },
    });
    expect(await failing(OWNER)).toEqual(['qapaq.platform.admin']);
    expect(await failing(GRAPH_OWNER)).toEqual([]);
  });

  it('los miembros de un grupo admin son admin, por claim `groups` o por el padrón', async () => {
    const ADMIN_GROUP = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const withGroup = loadRoleGrantsConfig({
      QAPAQ_PROFILE: 'test',
      QAPAQ_ADMIN_GROUP_IDS: ADMIN_GROUP.toUpperCase(),
    });
    const byClaim = createRoleGrantResolver(withGroup);
    expect(await byClaim(STRANGER, [ADMIN_GROUP])).toEqual(['qapaq.platform.admin']);
    expect(await byClaim(STRANGER, ['bbbbbbbb-0000-0000-0000-00000000000b'])).toEqual([]);

    const byDirectory = createRoleGrantResolver(withGroup, {
      groupId: ADMIN_GROUP,
      owners: async () => new Set(),
      isMember: async (oid) => oid === STRANGER,
    });
    expect(await byDirectory(STRANGER)).toEqual(['qapaq.platform.admin']);
    expect(await byDirectory(ANALYST)).toEqual([]);

    // El padrón de otro grupo no concede admin aunque la persona sea miembro.
    const otherGroup = createRoleGrantResolver(withGroup, {
      groupId: 'bbbbbbbb-0000-0000-0000-00000000000b',
      owners: async () => new Set(),
      isMember: async () => true,
    });
    expect(await otherGroup(STRANGER)).toEqual([]);
  });

  it('rechaza grupos admin que no son GUID', () => {
    expect(() =>
      loadRoleGrantsConfig({ QAPAQ_PROFILE: 'test', QAPAQ_ADMIN_GROUP_IDS: 'admins' }),
    ).toThrow();
  });

  it('rechaza asignaciones mal formadas o con roles inexistentes', () => {
    for (const value of [`${ANALYST}=qapaq.root`, 'no-es-oid=qapaq.soc.analyst', `${ANALYST}`]) {
      expect(() =>
        loadRoleGrantsConfig({ QAPAQ_PROFILE: 'test', QAPAQ_ROLE_BINDINGS: value }),
      ).toThrow();
    }
  });
});
