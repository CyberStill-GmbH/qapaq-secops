/**
 * Administración de roles sobre HTTP real (inyección Fastify, sin red), como en `bff.spec.ts`:
 * `POST /api/admin/users/:oid/role-requests`, `GET /api/admin/role-requests` y
 * `POST /api/admin/role-requests/:id/approve|reject`. No existe asignación directa.
 *
 * El perfil `test` arranca sin padrón; aquí se le da al runtime un padrón en memoria, la unidad de
 * trabajo en memoria y aprobadores declarados, igual que el composition root con Graph activo. Lo
 * que se comprueba es que la frontera HTTP no relaje ninguna regla: capability exacta, CSRF,
 * validación, SoD, padrón, step-up, auditoría y revocación de sesiones tras el cambio.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ACCESS_APPROVER_ROLE,
  capabilitiesForRoles,
  InMemoryDirectoryStore,
  InMemoryRoleAdministration,
  openSession,
  SECURITY_APPROVER_ROLE,
} from '@qapaq/access';

import { buildApi } from '../src/bootstrap.js';
import type { RuntimeDirectory, SecOpsRuntime } from '../src/runtime/secops-runtime.js';

const GROUP = '99999999-9999-4999-8999-999999999999';
const ANA = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';
const CARLA = '33333333-3333-4333-8333-333333333333';
const DANI = '44444444-4444-4444-8444-444444444444';
/** Platform admin: solicita, no aprueba. */
const ADMIN_OID = '55555555-5555-4555-8555-555555555555';
const ACCESS_OID = '66666666-6666-4666-8666-666666666666';
const SECURITY_OID = '77777777-7777-4777-8777-777777777777';
const REASON = 'Cobertura del turno nocturno del SOC.';

let application: NestFastifyApplication;
let runtime: SecOpsRuntime;
let stop: () => Promise<void>;
let administration: InMemoryRoleAdministration;
let officeSequence = 0;
let officeIp = '10.20.5.9';

function server() {
  return application.getHttpAdapter().getInstance();
}

/** Sesión abierta en el store, con la cookie y el token CSRF que vería el navegador. */
async function sessionFor(roles: readonly string[], oid: string, amr: readonly string[] = ['pwd']) {
  const { session } = openSession(
    {
      subjectId: `sub-${oid}`,
      oid,
      tenantId: runtime.tenantIdForDirectory,
      roles,
      scopes: ['soc.read', 'soc.write'],
      capabilities: capabilitiesForRoles(roles),
      amr,
      clientIp: officeIp,
    },
    [],
    runtime.now(),
  );
  await runtime.sessions.create(session);
  const cookie = `qapaq_session=${encodeURIComponent(session.id)}`;
  return {
    session,
    cookie,
    mutation: { cookie, 'x-csrf-token': runtime.csrfTokenFor(session.id) },
  };
}

type Caller = Awaited<ReturnType<typeof sessionFor>>;

function post(who: Caller, url: string, payload: object, headers = who.mutation) {
  return server().inject({ method: 'POST', url, headers, payload, remoteAddress: officeIp });
}

function get(who: Caller, url: string) {
  return server().inject({
    method: 'GET',
    url,
    headers: { cookie: who.cookie },
    remoteAddress: officeIp,
  });
}

const submit = (who: Caller, oid: string, payload: object) =>
  post(who, `/api/admin/users/${oid}/role-requests`, payload);
const decide = (who: Caller, id: string, decision: 'approve' | 'reject', payload: object) =>
  post(who, `/api/admin/role-requests/${id}/${decision}`, payload);
/** Cuerpo de una decisión con la revisión leída. */
const reviewed = (revision: number) => ({ expectedRevision: revision, reason: REASON });
const grantOf = (oid: string) => administration.grants.current(runtime.tenantIdForDirectory, oid);

/** Las mismas cabeceras sin el token CSRF. */
function withoutCsrf(who: Caller): Caller['mutation'] {
  return { cookie: who.cookie } as Caller['mutation'];
}

async function auditActions(start: number): Promise<string[]> {
  const events = await runtime.audit.range(runtime.tenantIdForDirectory, 1n, 100_000);
  return events.slice(start).map((event) => event.action);
}

async function auditLength(): Promise<number> {
  return (await runtime.audit.range(runtime.tenantIdForDirectory, 1n, 100_000)).length;
}

beforeAll(async () => {
  const built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
  application = built.application;
  runtime = built.runtime;
  stop = built.stop;

  // Padrón: Ana, Beto, admin y aprobadores vigentes; Carla deshabilitada; Dani salió.
  const tenantId = runtime.tenantIdForDirectory;
  const directory = new InMemoryDirectoryStore();
  const person = (oid: string, accountEnabled: boolean) => ({
    oid,
    displayName: oid.slice(0, 4),
    upn: null,
    accountEnabled,
  });
  const cycle = async (changes: Parameters<typeof directory.commitSync>[1]['changes']) => {
    const at = runtime.now();
    const claim = await directory.claimSync(tenantId, GROUP, at, 60_000);
    expect(
      await directory.commitSync(claim!, {
        at,
        changes,
        fullRead: false,
        owners: [],
        deltaLink: 'https://graph.microsoft.com/delta',
      }),
    ).toBe(true);
  };
  await cycle(
    [ANA, BETO, DANI, ADMIN_OID, ACCESS_OID, SECURITY_OID]
      .map((oid) => ({ kind: 'upsert' as const, person: person(oid, true) }))
      .concat([{ kind: 'upsert' as const, person: person(CARLA, false) }]),
  );
  await cycle([{ kind: 'removed', oid: DANI }]);

  administration = new InMemoryRoleAdministration((work) =>
    runtime.soc.run((context) => work(context.audit)),
  );
  const roster: RuntimeDirectory = {
    mode: 'graph',
    groupId: GROUP,
    intervalMs: 60_000,
    store: directory,
  };
  Object.defineProperty(runtime, 'directory', { value: roster });
  Object.defineProperty(runtime, 'roleAdministration', { value: administration });
  Object.defineProperty(runtime, 'roleGrantsConfig', {
    value: {
      bindings: {},
      groupOwnerOids: [],
      accessApproverOids: [ACCESS_OID],
      securityApproverOids: [SECURITY_OID],
    },
  });

  await application.init();
  await server().ready();
});

afterAll(async () => {
  await stop();
});

beforeEach(() => {
  officeSequence += 1;
  officeIp = `10.20.${100 + Math.floor(officeSequence / 250)}.${(officeSequence % 250) + 1}`;
});

describe('administración de roles · solicitudes y aprobación', () => {
  it('no existe reemplazo directo del grant', async () => {
    const admin = await sessionFor(['qapaq.platform.admin'], ADMIN_OID);
    const put = await server().inject({
      method: 'PUT',
      url: `/api/admin/users/${ANA}/role-grant`,
      headers: admin.mutation,
      payload: { roles: ['qapaq.soc.lead'], expectedRevision: 0, reason: REASON },
      remoteAddress: officeIp,
    });
    expect(put.statusCode).toBe(404);
    expect((await grantOf(ANA)).revision).toBe(0);
  });

  it('solicitar exige roles.request y CSRF; valida forma y catálogo', async () => {
    const lead = await sessionFor(['qapaq.soc.lead'], BETO);
    const body = { action: 'grant', role: 'qapaq.soc.lead', reason: REASON, expectedRevision: 0 };
    expect((await submit(lead, ANA, body)).statusCode).toBe(404);

    const admin = await sessionFor(['qapaq.platform.admin'], ADMIN_OID);
    const unverified = await post(
      admin,
      `/api/admin/users/${ANA}/role-requests`,
      body,
      withoutCsrf(admin),
    );
    expect(unverified.statusCode).toBe(403);

    const invalid = await submit(admin, ANA, {
      action: 'replace',
      role: ACCESS_APPROVER_ROLE,
      reason: 'corto',
      ticket: '<script>',
      expectedRevision: -1,
    });
    expect(invalid.statusCode).toBe(422);
    expect(JSON.parse(invalid.body).fields).toEqual([
      'action',
      'role',
      'reason',
      'ticket',
      'expectedRevision',
    ]);
    const open = await administration.requests.list(runtime.tenantIdForDirectory, [
      'pending_access',
    ]);
    expect(open).toEqual([]);
  });

  it('SoD y padrón: ni a sí mismo, ni a deshabilitados, bajas u OID fuera del padrón', async () => {
    const admin = await sessionFor(['qapaq.platform.admin'], ADMIN_OID);
    const body = { action: 'grant', role: 'qapaq.soc.lead', reason: REASON, expectedRevision: 0 };
    expect((await submit(admin, ADMIN_OID.toUpperCase(), body)).statusCode).toBe(409);
    for (const oid of [CARLA, DANI, '88888888-8888-4888-8888-888888888888', 'no-es-un-guid']) {
      expect((await submit(admin, oid, body)).statusCode).toBe(404);
    }
  });

  it('Acceso aprueba un rol ordinario: grant, auditoría y revocación de sesiones del objetivo', async () => {
    const admin = await sessionFor(['qapaq.platform.admin'], ADMIN_OID);
    // AMR sin MFA: la etapa de Acceso de un rol ordinario no la exige.
    const approver = await sessionFor([ACCESS_APPROVER_ROLE], ACCESS_OID, ['pwd']);
    const target = await sessionFor(['qapaq.soc.analyst'], ANA);
    const start = await auditLength();

    const created = await submit(admin, ANA, {
      action: 'grant',
      role: 'qapaq.soc.lead',
      reason: REASON,
      ticket: 'CHG-1042',
      expectedRevision: 0,
    });
    expect(created.statusCode).toBe(201);
    const pending = JSON.parse(created.body).request;
    expect(pending).toMatchObject({
      targetOid: ANA,
      status: 'pending_access',
      approvalStage: 'access',
      requesterOid: ADMIN_OID,
      ticket: 'CHG-1042',
    });
    expect((await grantOf(ANA)).revision).toBe(0);

    // El solicitante no aprueba: sin roles.approve ni declaración, ni siquiera ve la solicitud.
    const byRequester = await decide(admin, pending.id, 'approve', reviewed(pending.revision));
    expect(byRequester.statusCode).toBe(404);
    // Sin CSRF, nada.
    const unverified = await post(
      approver,
      `/api/admin/role-requests/${pending.id}/approve`,
      reviewed(pending.revision),
      withoutCsrf(approver),
    );
    expect(unverified.statusCode).toBe(403);
    // Revisión vieja: conflicto.
    expect((await decide(approver, pending.id, 'approve', reviewed(99))).statusCode).toBe(409);

    const approved = await decide(approver, pending.id, 'approve', reviewed(pending.revision));
    expect(approved.statusCode).toBe(201);
    expect(JSON.parse(approved.body)).toMatchObject({
      request: { status: 'approved', priorApproverOid: ACCESS_OID },
      grant: { roles: ['qapaq.soc.lead'], revision: 1 },
      sessionRevocation: { revoked: 1, remaining: 0 },
    });
    expect((await runtime.sessions.byId(target.session.id))?.state).toBe('revoked');
    expect((await grantOf(ANA)).roles).toEqual(['qapaq.soc.lead']);

    const actions = await auditActions(start);
    expect(actions).toEqual(
      expect.arrayContaining([
        'access.role_request.submitted',
        'access.role_request.approved',
        'access.session.revoked',
      ]),
    );
    expect(actions).not.toContain('access.role_grant.sessions_revocation_incomplete');

    const view = JSON.parse((await get(admin, `/api/admin/users/${ANA}/role-grant`)).body);
    expect(view).toMatchObject({
      eligible: true,
      grant: { roles: ['qapaq.soc.lead'], revision: 1 },
    });
    expect(view.assignableRoles).toEqual([
      'qapaq.auditor',
      'qapaq.platform.admin',
      'qapaq.soc.analyst',
      'qapaq.soc.lead',
    ]);
  });

  it('rechazar cierra la solicitud sin cambiar el grant', async () => {
    const admin = await sessionFor(['qapaq.platform.admin'], ADMIN_OID);
    const approver = await sessionFor([ACCESS_APPROVER_ROLE], ACCESS_OID);
    const submitted = await submit(admin, BETO, {
      action: 'grant',
      role: 'qapaq.auditor',
      reason: REASON,
      expectedRevision: 0,
    });
    const created = JSON.parse(submitted.body).request;
    const rejected = await decide(approver, created.id, 'reject', reviewed(created.revision));
    expect(rejected.statusCode).toBe(201);
    expect(JSON.parse(rejected.body)).toMatchObject({ request: { status: 'rejected' } });
    expect(JSON.parse(rejected.body).grant).toBeUndefined();
    expect((await grantOf(BETO)).revision).toBe(0);
  });

  it('platform.admin necesita Acceso y Seguridad; Seguridad falla cerrada sin step-up real', async () => {
    const admin = await sessionFor(['qapaq.platform.admin'], ADMIN_OID);
    const access = await sessionFor([ACCESS_APPROVER_ROLE], ACCESS_OID);
    const security = await sessionFor([SECURITY_APPROVER_ROLE], SECURITY_OID, ['fido']);
    const submitted = await submit(admin, BETO, {
      action: 'grant',
      role: 'qapaq.platform.admin',
      reason: REASON,
      expectedRevision: 0,
    });
    const created = JSON.parse(submitted.body).request;

    // Seguridad no puede adelantarse a Acceso.
    const early = await decide(security, created.id, 'approve', reviewed(created.revision));
    expect(early.statusCode).toBe(404);
    const accessed = await decide(access, created.id, 'approve', reviewed(created.revision));
    const first = JSON.parse(accessed.body);
    expect(first.request).toMatchObject({ status: 'pending_security', approvalStage: 'security' });
    expect(first.grant).toBeUndefined();
    // Acceso no firma la segunda etapa.
    const twice = await decide(access, created.id, 'approve', reviewed(first.request.revision));
    expect(twice.statusCode).toBe(404);

    const start = await auditLength();
    const blocked = await decide(security, created.id, 'approve', reviewed(first.request.revision));
    expect(blocked.statusCode).toBe(403);
    expect(JSON.parse(blocked.body).code).toBe('STEP_UP_REQUIRED');
    expect((await grantOf(BETO)).roles).not.toContain('qapaq.platform.admin');
    expect(await auditActions(start)).toEqual(['access.role_request.step_up_required']);

    // Rechazar no amplía privilegios: no exige step-up.
    const rejected = await decide(security, created.id, 'reject', reviewed(first.request.revision));
    expect(rejected.statusCode).toBe(201);
  });

  it('la bandeja exige una capability de roles y valida filtros', async () => {
    const lead = await sessionFor(['qapaq.soc.lead'], BETO);
    expect((await get(lead, '/api/admin/role-requests')).statusCode).toBe(404);
    const approver = await sessionFor([ACCESS_APPROVER_ROLE], ACCESS_OID);
    expect((await get(approver, '/api/admin/role-requests?status=open')).statusCode).toBe(422);
    const all = await get(approver, '/api/admin/role-requests?status=all&pageSize=2');
    expect(JSON.parse(all.body)).toMatchObject({ nextCursor: '2' });
    expect(JSON.parse(all.body).items).toHaveLength(2);
    const closed = await get(approver, '/api/admin/role-requests?status=closed');
    const items: { status: string }[] = JSON.parse(closed.body).items;
    const statuses = items.map((item) => item.status);
    expect(statuses).not.toContain('pending_access');
    expect(statuses).not.toContain('pending_security');
  });
});
