/**
 * Casos de uso de la administración de roles (`runtime/role-administration.ts`) sin HTTP.
 *
 * Padrón y unidad de trabajo en memoria, con reloj fijo. Cubre lo que el controlador no puede
 * forzar: el camino posterior a un step-up (que en producción no existe todavía), la atomicidad
 * grant + solicitud + auditoría ante un commit fallido y la limpieza por baja del padrón.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  InMemoryDirectoryStore,
  InMemoryRoleAdministration,
  type DirectoryStore,
  type RequestableRole,
} from '@qapaq/access';
import type { RoleGrantsConfig } from '@qapaq/configuration';
import { InMemorySoc } from '@qapaq/soc';

import {
  clearRemovedMembers,
  decideRoleRequest,
  submitRoleRequest,
  type RoleAdministrationActor,
  type RoleAdministrationDependencies,
  type RoleDecisionInput,
  type RoleRequestInput,
} from '../src/runtime/role-administration.js';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const GROUP = '99999999-9999-4999-8999-999999999999';
const REQUESTER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const ACCESS = '33333333-3333-4333-8333-333333333333';
const SECURITY = '44444444-4444-4444-8444-444444444444';
const REASON = 'Cobertura del turno nocturno del SOC.';
const NOW = new Date('2026-10-20T15:00:00.000Z');
const INTERVAL_MS = 60_000;

type MemberChanges = Parameters<DirectoryStore['commitSync']>[1]['changes'];

let soc: InMemorySoc;
let administration: InMemoryRoleAdministration;
let directory: InMemoryDirectoryStore;
let clock: Date;

function actor(oid: string, capabilities: readonly string[], amr = ['pwd']) {
  return {
    subjectId: `sub-${oid}`,
    sessionId: `session-${oid}`,
    oid,
    capabilities: new Set(capabilities),
    amr,
  } satisfies RoleAdministrationActor;
}

const requester = () => actor(REQUESTER, ['roles.request']);
const accessApprover = () => actor(ACCESS, ['roles.approve']);
const securityApprover = (amr = ['fido']) => actor(SECURITY, ['roles.approve.privileged'], amr);

function approvers(access: string, security: string): RoleGrantsConfig {
  return {
    bindings: {},
    groupOwnerOids: [],
    accessApproverOids: [access],
    securityApproverOids: [security],
  };
}

function deps(
  overrides: Partial<RoleAdministrationDependencies> = {},
): RoleAdministrationDependencies {
  return {
    administration,
    directory: { store: directory, groupId: GROUP, intervalMs: INTERVAL_MS },
    config: approvers(ACCESS, SECURITY),
    tenantId: TENANT,
    now: () => clock,
    ...overrides,
  };
}

function wanted(role: RequestableRole, expectedRevision = 0): RoleRequestInput {
  return {
    targetOid: TARGET,
    action: 'grant',
    role,
    reason: REASON,
    ticket: null,
    expectedRevision,
  };
}

function approval(requestId: string, expectedRevision: number): RoleDecisionInput {
  return { requestId, decision: 'approve', expectedRevision, reason: REASON };
}

function rejection(requestId: string, expectedRevision: number): RoleDecisionInput {
  return { requestId, decision: 'reject', expectedRevision, reason: REASON };
}

async function cycle(store: DirectoryStore, changes: MemberChanges) {
  const claim = await store.claimSync(TENANT, GROUP, clock, 60_000);
  expect(
    await store.commitSync(claim!, {
      at: clock,
      changes,
      fullRead: false,
      owners: [],
      deltaLink: 'https://graph.microsoft.com/delta',
    }),
  ).toBe(true);
}

async function request(role: RequestableRole = 'qapaq.soc.lead') {
  const input = { ...wanted(role), ticket: 'CHG-1042' };
  const result = await submitRoleRequest(deps(), requester(), input, 'corr-submit');
  if (!result.ok) throw new Error(result.failure);
  return result.value;
}

async function actions(): Promise<string[]> {
  return (await soc.audit.range(TENANT, 1n, 1_000)).map((event) => event.action);
}

const grantOf = () => administration.grants.current(TENANT, TARGET);

beforeEach(async () => {
  clock = NOW;
  soc = new InMemorySoc();
  administration = new InMemoryRoleAdministration((work) =>
    soc.run((context) => work(context.audit)),
  );
  directory = new InMemoryDirectoryStore();
  await cycle(
    directory,
    [REQUESTER, TARGET, ACCESS, SECURITY].map((oid) => ({
      kind: 'upsert' as const,
      person: { oid, displayName: oid.slice(0, 4), upn: null, accountEnabled: true },
    })),
  );
});

describe('administración de roles · casos de uso', () => {
  it('la etapa de Acceso aprueba un rol ordinario sin exigir AMR fuerte, con auditoría atómica', async () => {
    const pending = await request();
    const decided = await decideRoleRequest(
      deps(),
      accessApprover(),
      approval(pending.id, pending.revision),
      'corr-approve',
    );
    expect(decided).toMatchObject({
      ok: true,
      value: {
        request: { status: 'approved' },
        grant: { roles: ['qapaq.soc.lead'], revision: 1 },
      },
    });
    expect(await actions()).toEqual([
      'access.role_request.submitted',
      'access.role_request.approved',
    ]);
  });

  it('un commit fallido no deja grant, solicitud ni auditoría', async () => {
    const pending = await request();
    soc.failNextCommit = true;
    await expect(
      decideRoleRequest(deps(), accessApprover(), approval(pending.id, pending.revision), 'corr'),
    ).rejects.toThrow('COMMIT_FAILED');
    expect((await grantOf()).revision).toBe(0);
    expect((await administration.requests.byId(TENANT, pending.id))?.status).toBe('pending_access');
    expect(await actions()).toEqual(['access.role_request.submitted']);
  });

  it('SoD: el solicitante, el objetivo y un aprobador no declarado no resuelven', async () => {
    const self = actor(TARGET, ['roles.request']);
    expect(await submitRoleRequest(deps(), self, wanted('qapaq.soc.lead'), 'corr')).toEqual({
      ok: false,
      failure: 'CONFLICT',
    });
    const pending = await request();
    const decide = (who: RoleAdministrationActor, dependencies = deps()) =>
      decideRoleRequest(dependencies, who, approval(pending.id, pending.revision), 'corr');
    // Con la capability pero sin declaración en el deploy: no aprueba.
    const unavailable = { ok: false, failure: 'UNAVAILABLE' };
    expect(await decide(actor(REQUESTER, ['roles.approve']))).toEqual(unavailable);
    expect(await decide(actor(TARGET, ['roles.approve']))).toEqual(unavailable);
    // Declarado como aprobador pero también solicitante: conflicto de SoD.
    const sameAsRequester = deps({ config: approvers(REQUESTER, SECURITY) });
    expect(await decide(actor(REQUESTER, ['roles.approve']), sameAsRequester)).toEqual({
      ok: false,
      failure: 'CONFLICT',
    });
    expect((await grantOf()).revision).toBe(0);
  });

  it('platform.admin: Acceso pasa a Seguridad; Seguridad sin step-up falla cerrada y audita', async () => {
    const pending = await request('qapaq.platform.admin');
    const access = await decideRoleRequest(
      deps(),
      accessApprover(),
      approval(pending.id, pending.revision),
      'corr',
    );
    expect(access).toMatchObject({ ok: true, value: { request: { status: 'pending_security' } } });
    expect(access.ok && access.value.grant).toBeUndefined();
    const second = approval(pending.id, access.ok ? access.value.request.revision : -1);
    const stepUpRequired = { ok: false, failure: 'STEP_UP_REQUIRED' };

    // AMR fuerte no basta: falta evidencia reciente (auth_time) y ningún runtime la provee.
    expect(await decideRoleRequest(deps(), securityApprover(['fido']), second, 'corr')).toEqual(
      stepUpRequired,
    );
    expect((await grantOf()).revision).toBe(0);
    expect((await actions()).at(-1)).toBe('access.role_request.step_up_required');

    // El aprobador de Acceso no puede firmar también la etapa de Seguridad.
    const twice = deps({ config: approvers(ACCESS, ACCESS), stepUp: () => true });
    const accessAsSecurity = actor(ACCESS, ['roles.approve.privileged'], ['fido']);
    expect(await decideRoleRequest(twice, accessAsSecurity, second, 'corr')).toEqual({
      ok: false,
      failure: 'CONFLICT',
    });

    // Solo con un verificador (inexistente en producción) y AMR fuerte se completa.
    const verified = deps({ stepUp: () => true });
    expect(await decideRoleRequest(verified, securityApprover(['pwd']), second, 'corr')).toEqual(
      stepUpRequired,
    );
    const approved = await decideRoleRequest(verified, securityApprover(['fido']), second, 'corr');
    expect(approved).toMatchObject({
      ok: true,
      value: { request: { status: 'approved' }, grant: { roles: ['qapaq.platform.admin'] } },
    });
  });

  it('rechazar cierra la solicitud sin tocar el grant y no admite otra decisión', async () => {
    const pending = await request();
    const rejected = await decideRoleRequest(
      deps(),
      accessApprover(),
      rejection(pending.id, pending.revision),
      'corr',
    );
    expect(rejected).toMatchObject({ ok: true, value: { request: { status: 'rejected' } } });
    expect(rejected.ok && rejected.value.grant).toBeUndefined();
    const late = approval(pending.id, pending.revision + 1);
    expect(await decideRoleRequest(deps(), accessApprover(), late, 'corr')).toEqual({
      ok: false,
      failure: 'UNAVAILABLE',
    });
    expect((await grantOf()).revision).toBe(0);
  });

  it('padrón viejo o participante dado de baja: falla cerrada', async () => {
    const pending = await request();
    const approve = () =>
      decideRoleRequest(deps(), accessApprover(), approval(pending.id, pending.revision), 'corr');
    clock = new Date(NOW.getTime() + 4 * INTERVAL_MS);
    expect(await approve()).toEqual({ ok: false, failure: 'UNAVAILABLE' });
    clock = NOW;

    // El solicitante sale del grupo: antes del siguiente ciclo, la decisión ya lo ve.
    await cycle(directory, [{ kind: 'removed', oid: REQUESTER }]);
    expect(await approve()).toEqual({ ok: false, failure: 'CONFLICT' });
    expect(await submitRoleRequest(deps(), requester(), wanted('qapaq.auditor'), 'corr')).toEqual({
      ok: false,
      failure: 'UNAVAILABLE',
    });
  });

  it('la baja del padrón retira el grant y cancela las solicitudes abiertas, auditado', async () => {
    const first = await request();
    const approved = await decideRoleRequest(
      deps(),
      accessApprover(),
      approval(first.id, first.revision),
      'corr',
    );
    expect(approved.ok).toBe(true);
    const open = await submitRoleRequest(deps(), requester(), wanted('qapaq.auditor', 1), 'corr');
    expect(open.ok).toBe(true);

    await cycle(directory, [{ kind: 'removed', oid: TARGET }]);
    expect(await clearRemovedMembers(deps(), [TARGET.toUpperCase()])).toBe(1);
    expect(await grantOf()).toMatchObject({ roles: [], revision: 2 });
    const openId = open.ok ? open.value.id : '';
    expect((await administration.requests.byId(TENANT, openId))?.status).toBe('cancelled');
    expect((await actions()).slice(-2)).toEqual([
      'access.role_grant.cleared',
      'access.role_request.cancelled',
    ]);
    // Idempotente: el ciclo siguiente no reescribe ni audita nada.
    expect(await clearRemovedMembers(deps(), [TARGET])).toBe(0);
  });
});
