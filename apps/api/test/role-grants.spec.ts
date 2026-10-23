/**
 * Sprint 5 — roles concedidos por QAPAQ: asignaciones del deploy, dueños del grupo (deploy y
 * Graph) y nada para quien no figura. OID sintéticos.
 */

import { describe, expect, it, vi } from 'vitest';

import { InMemoryRoleGrantStore } from '@qapaq/access';
import { loadRoleGrantsConfig } from '@qapaq/configuration';

import {
  createRoleGrantResolver,
  isRoleRosterFresh,
  withDynamicGrants,
} from '../src/runtime/role-grants.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ANALYST = '22222222-2222-4222-8222-222222222222';
const GRAPH_OWNER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const TENANT = 'qapaq-test-tenant';

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

  it('la pertenencia al padrón de admisión no eleva el rol explícito de analista', async () => {
    const admissionGroup = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const withoutImplicitAdminGroup = loadRoleGrantsConfig({
      QAPAQ_PROFILE: 'test',
      QAPAQ_ROLE_BINDINGS: `${ANALYST}=qapaq.soc.analyst`,
    });
    const resolve = createRoleGrantResolver(withoutImplicitAdminGroup, {
      groupId: admissionGroup,
      owners: async () => new Set(),
      isMember: async (oid) => oid === ANALYST,
    });

    expect(await resolve(ANALYST)).toEqual(['qapaq.soc.analyst']);
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

  it('no suma grants dinámicos si el padrón de Entra está vencido o falló', async () => {
    const now = new Date('2026-10-22T12:00:00.000Z');
    const store = new InMemoryRoleGrantStore();
    await store.replace(TENANT, ANALYST, {
      roles: ['qapaq.platform.admin'],
      expectedRevision: 0,
      actorId: 'test-approver',
      at: now,
    });
    const current = vi.spyOn(store, 'current');
    const isActiveMember = vi.fn(async () => true);
    const stale = {
      tenantId: TENANT,
      groupId: 'admission-group',
      deltaLink: 'delta',
      status: 'ok' as const,
      lastAttemptAt: now,
      lastSuccessAt: new Date(now.getTime() - 4 * 60_000),
      lastErrorClass: null,
    };
    const failed = { ...stale, status: 'failed' as const, lastErrorClass: 'DIRECTORY_UNAVAILABLE' };

    for (const state of [stale, failed]) {
      const resolve = withDynamicGrants(async () => [], {
        store,
        tenantId: TENANT,
        isRosterFresh: async () => isRoleRosterFresh(state, now, 60_000),
        isActiveMember,
      });

      expect(await resolve(ANALYST)).toEqual([]);
    }

    expect(isActiveMember).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
  });

  it('suma grants dinámicos solo con padrón confirmado y reciente', async () => {
    const now = new Date('2026-10-22T12:00:00.000Z');
    const store = new InMemoryRoleGrantStore();
    await store.replace(TENANT, ANALYST, {
      roles: ['qapaq.soc.lead'],
      expectedRevision: 0,
      actorId: 'test-approver',
      at: now,
    });
    const fresh = {
      tenantId: TENANT,
      groupId: 'admission-group',
      deltaLink: 'delta',
      status: 'ok' as const,
      lastAttemptAt: now,
      lastSuccessAt: new Date(now.getTime() - 60_000),
      lastErrorClass: null,
    };
    const resolve = withDynamicGrants(async () => [], {
      store,
      tenantId: TENANT,
      isRosterFresh: async () => isRoleRosterFresh(fresh, now, 60_000),
      isActiveMember: async () => true,
    });

    expect(await resolve(ANALYST)).toEqual(['qapaq.soc.lead']);
  });
});
