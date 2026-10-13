/**
 * Sprint 5 · fase 3 — sincronización del padrón y adapter de Microsoft Graph.
 *
 * Fija las garantías de entra-soc-user-admin.md y de la guía del repositorio: delta persistido,
 * una lectura parcial nunca da de baja a nadie, un delta vencido obliga a lectura completa, un
 * 429 se respeta, y un enlace guardado nunca redirige el token fuera de Graph. OID sintéticos.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DirectoryError,
  InMemoryDirectoryStore,
  type DirectoryPerson,
  type DirectoryReader,
  type MemberDeltaPage,
} from '@qapaq/access';

import { capabilitiesForRoles, openSession } from '@qapaq/access';

import { buildApi } from '../src/bootstrap.js';
import { cachedOwnerSource, createDirectorySyncPass } from '../src/runtime/directory-sync.js';
import type { SecOpsRuntime } from '../src/runtime/secops-runtime.js';
import { GraphDirectoryReader } from '../src/runtime/graph-directory.js';

const TENANT = 'tenant-dir';
const GROUP = '99999999-9999-4999-8999-999999999999';
const ANA = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';
const DUENO = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-12T21:00:00.000Z');

const person = (oid: string, name: string): DirectoryPerson => ({
  oid,
  displayName: name,
  upn: `${name.toLowerCase()}@qapaq-lab.example`,
  accountEnabled: true,
});

/** Lector programable: cada llamada consume la siguiente respuesta o error. */
function scriptedReader(
  steps: (MemberDeltaPage | Error)[],
  owners: DirectoryPerson[] | Error = [person(DUENO, 'Dueno')],
) {
  const cursors: (string | null)[] = [];
  const reader: DirectoryReader = {
    async readMemberDelta(_group, cursor) {
      cursors.push(cursor);
      const step = steps.shift();
      if (!step) throw new Error('sin guion');
      if (step instanceof Error) throw step;
      return step;
    },
    async readOwners() {
      if (owners instanceof Error) throw owners;
      return owners;
    },
  };
  return { reader, cursors };
}

describe('sincronización del padrón', () => {
  it('lectura completa, luego delta: altas, bajas y dueños; el delta se persiste', async () => {
    const store = new InMemoryDirectoryStore();
    const first = scriptedReader([
      {
        changes: [{ kind: 'upsert', person: person(ANA, 'Ana') }],
        nextLink: 'https://graph.microsoft.com/next',
      },
      {
        changes: [{ kind: 'upsert', person: person(BETO, 'Beto') }],
        deltaLink: 'https://graph.microsoft.com/delta-1',
      },
    ]);
    await createDirectorySyncPass({
      tenantId: TENANT,
      groupId: GROUP,
      reader: first.reader,
      store,
      now: () => NOW,
    })();
    expect(first.cursors).toEqual([null, 'https://graph.microsoft.com/next']);
    expect((await store.members(TENANT, GROUP)).map((m) => m.membership)).toEqual([
      'member',
      'member',
    ]);
    expect((await store.owners(TENANT, GROUP)).map((o) => o.oid)).toEqual([DUENO]);

    const second = scriptedReader(
      [
        {
          changes: [{ kind: 'removed', oid: BETO }],
          deltaLink: 'https://graph.microsoft.com/delta-2',
        },
      ],
      [],
    );
    await createDirectorySyncPass({
      tenantId: TENANT,
      groupId: GROUP,
      reader: second.reader,
      store,
      now: () => NOW,
    })();
    expect(second.cursors).toEqual(['https://graph.microsoft.com/delta-1']);
    expect((await store.member(TENANT, GROUP, BETO))?.membership).toBe('removed');
    expect(await store.owners(TENANT, GROUP)).toEqual([]);
    expect(await store.syncState(TENANT, GROUP)).toMatchObject({
      status: 'ok',
      deltaLink: 'https://graph.microsoft.com/delta-2',
    });
  });

  it('una lectura que falla a mitad no da de baja a nadie y registra el código', async () => {
    const store = new InMemoryDirectoryStore();
    await createDirectorySyncPass({
      tenantId: TENANT,
      groupId: GROUP,
      store,
      now: () => NOW,
      reader: scriptedReader([
        {
          changes: [{ kind: 'upsert', person: person(ANA, 'Ana') }],
          deltaLink: 'https://graph.microsoft.com/d1',
        },
      ]).reader,
    })();
    const failing = scriptedReader([
      { changes: [{ kind: 'removed', oid: ANA }], nextLink: 'https://graph.microsoft.com/n' },
      new DirectoryError('DIRECTORY_THROTTLED', 30_000),
    ]);
    await expect(
      createDirectorySyncPass({
        tenantId: TENANT,
        groupId: GROUP,
        reader: failing.reader,
        store,
        now: () => NOW,
      })(),
    ).rejects.toMatchObject({ code: 'DIRECTORY_THROTTLED' });
    expect((await store.member(TENANT, GROUP, ANA))?.membership).toBe('member');
    expect(await store.syncState(TENANT, GROUP)).toMatchObject({
      status: 'failed',
      lastErrorClass: 'DIRECTORY_THROTTLED',
      deltaLink: 'https://graph.microsoft.com/d1',
    });
  });

  it('un delta vencido obliga a lectura completa: quien no aparece pasa a baja', async () => {
    const store = new InMemoryDirectoryStore();
    const run = (reader: DirectoryReader) =>
      createDirectorySyncPass({
        tenantId: TENANT,
        groupId: GROUP,
        reader,
        store,
        now: () => NOW,
      })();
    await run(
      scriptedReader([
        {
          changes: [
            { kind: 'upsert', person: person(ANA, 'Ana') },
            { kind: 'upsert', person: person(BETO, 'Beto') },
          ],
          deltaLink: 'https://graph.microsoft.com/d1',
        },
      ]).reader,
    );
    await expect(
      run(scriptedReader([new DirectoryError('DIRECTORY_DELTA_EXPIRED')]).reader),
    ).rejects.toThrow();
    expect((await store.syncState(TENANT, GROUP))?.deltaLink).toBeNull();

    const full = scriptedReader([
      {
        changes: [{ kind: 'upsert', person: person(ANA, 'Ana') }],
        deltaLink: 'https://graph.microsoft.com/d2',
      },
    ]);
    await run(full.reader);
    expect(full.cursors).toEqual([null]);
    expect((await store.member(TENANT, GROUP, BETO))?.membership).toBe('removed');
    expect((await store.member(TENANT, GROUP, ANA))?.membership).toBe('member');
  });

  it('con el lease tomado por otra réplica no lee nada', async () => {
    const store = new InMemoryDirectoryStore();
    await store.claimSync(TENANT, GROUP, NOW, 300_000);
    const reader = scriptedReader([]);
    expect(
      await createDirectorySyncPass({
        tenantId: TENANT,
        groupId: GROUP,
        reader: reader.reader,
        store,
        now: () => NOW,
      })(),
    ).toBe(0);
    expect(reader.cursors).toEqual([]);
  });

  it('los dueños para el inicio de sesión salen del store con caché corta', async () => {
    const store = new InMemoryDirectoryStore();
    await createDirectorySyncPass({
      tenantId: TENANT,
      groupId: GROUP,
      store,
      now: () => NOW,
      reader: scriptedReader([{ changes: [], deltaLink: 'https://graph.microsoft.com/d' }]).reader,
    })();
    let clock = 0;
    const source = cachedOwnerSource(store, TENANT, GROUP, 60_000, () => clock);
    expect((await source.owners()).has(DUENO)).toBe(true);
  });
});

describe('adapter de Microsoft Graph', () => {
  function graph(routes: Record<string, () => Response>) {
    const calls: string[] = [];
    const reader = new GraphDirectoryReader({
      accessToken: async () => 'token-sintetico',
      fetch: (async (url: URL) => {
        const key = decodeURIComponent(url.pathname + url.search);
        calls.push(key);
        const route = Object.entries(routes).find(([prefix]) => key.startsWith(prefix));
        if (!route) return new Response('{}', { status: 404 });
        return route[1]();
      }) as unknown as typeof fetch,
    });
    return { reader, calls };
  }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it('traduce el delta: solo usuarios, bajas marcadas y datos de cada alta', async () => {
    const { reader } = graph({
      '/v1.0/groups/delta': () =>
        json({
          value: [
            {
              id: GROUP,
              'members@delta': [
                { '@odata.type': '#microsoft.graph.user', id: ANA },
                {
                  '@odata.type': '#microsoft.graph.user',
                  id: BETO,
                  '@removed': { reason: 'deleted' },
                },
                { '@odata.type': '#microsoft.graph.group', id: DUENO },
              ],
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/groups/delta?$deltatoken=x',
        }),
      [`/v1.0/users/${ANA}`]: () =>
        json({
          id: ANA,
          displayName: 'Ana',
          userPrincipalName: 'ana@qapaq-lab.example',
          accountEnabled: true,
        }),
    });
    const page = await reader.readMemberDelta(GROUP, null);
    expect(page.changes).toEqual([
      { kind: 'removed', oid: BETO },
      {
        kind: 'upsert',
        person: {
          oid: ANA,
          displayName: 'Ana',
          upn: 'ana@qapaq-lab.example',
          accountEnabled: true,
        },
      },
    ]);
    expect(page.deltaLink).toContain('https://graph.microsoft.com/');
  });

  it('sin permiso para accountEnabled, lo informa como desconocido en vez de fallar', async () => {
    let first = true;
    const { reader } = graph({
      '/v1.0/groups/delta': () =>
        json({
          value: [
            { id: GROUP, 'members@delta': [{ '@odata.type': '#microsoft.graph.user', id: ANA }] },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/d',
        }),
      [`/v1.0/users/${ANA}`]: () => {
        if (first) {
          first = false;
          return json({ error: { code: 'Authorization_RequestDenied' } }, 403);
        }
        return json({ id: ANA, displayName: 'Ana', userPrincipalName: 'ana@qapaq-lab.example' });
      },
    });
    const page = await reader.readMemberDelta(GROUP, null);
    expect(page.changes[0]).toMatchObject({ kind: 'upsert', person: { accountEnabled: null } });
  });

  it('429 con Retry-After, 410 delta vencido y enlaces fuera de Graph rechazados', async () => {
    const throttled = graph({ '/v1.0/groups/delta': () => json({}, 429, { 'retry-after': '20' }) });
    await expect(throttled.reader.readMemberDelta(GROUP, null)).rejects.toMatchObject({
      code: 'DIRECTORY_THROTTLED',
      retryAfterMs: 20_000,
    });
    const expired = graph({ '/v1.0/groups/delta': () => json({}, 410) });
    await expect(expired.reader.readMemberDelta(GROUP, null)).rejects.toMatchObject({
      code: 'DIRECTORY_DELTA_EXPIRED',
    });
    const hostile = graph({});
    await expect(
      hostile.reader.readMemberDelta(GROUP, 'https://atacante.example/robar'),
    ).rejects.toMatchObject({ code: 'DIRECTORY_RESPONSE_INVALID' });
    expect(hostile.calls).toEqual([]);
  });

  it('resuelve el grupo por nombre exacto; ninguno o varios es error, nunca elige uno', async () => {
    const seen: string[] = [];
    const reply = (value: unknown[]) =>
      new GraphDirectoryReader({
        accessToken: async () => 'token-sintetico',
        fetch: (async (url: URL) => {
          seen.push(decodeURIComponent(url.search));
          return new Response(JSON.stringify({ value }), { status: 200 });
        }) as unknown as typeof fetch,
      });
    expect(await reply([{ id: GROUP.toUpperCase() }]).resolveGroupId('QAPAQ-SecOps-Users')).toBe(
      GROUP,
    );
    expect(seen[0]).toContain("displayName eq 'QAPAQ-SecOps-Users'");
    await expect(reply([]).resolveGroupId('No-Existe')).rejects.toMatchObject({
      code: 'DIRECTORY_RESPONSE_INVALID',
    });
    await expect(
      reply([{ id: GROUP }, { id: ANA }]).resolveGroupId('Duplicado'),
    ).rejects.toMatchObject({
      code: 'DIRECTORY_RESPONSE_INVALID',
    });
    await reply([{ id: GROUP }]).resolveGroupId("O'Brien");
    expect(seen.at(-1)).toContain("displayName eq 'O''Brien'");
  });

  it('lee los dueños paginados', async () => {
    const { reader } = graph({
      [`/v1.0/groups/${GROUP}/owners/microsoft.graph.user?$select=id,displayName,userPrincipalName&$top=100`]:
        () =>
          json({
            value: [
              { id: DUENO, displayName: 'Dueno', userPrincipalName: 'dueno@qapaq-lab.example' },
            ],
            '@odata.nextLink': `https://graph.microsoft.com/v1.0/groups/${GROUP}/owners/page2`,
          }),
      [`/v1.0/groups/${GROUP}/owners/page2`]: () =>
        json({ value: [{ id: ANA, displayName: 'Ana' }] }),
    });
    expect((await reader.readOwners(GROUP)).map((owner) => owner.oid)).toEqual([DUENO, ANA]);
  });
});

describe('pérdida de acceso por cambios en el padrón', () => {
  it('informa todas las bajas y los dueños que dejaron de serlo tras un ciclo confirmado', async () => {
    const store = new InMemoryDirectoryStore();
    const seen: { removedMembers: readonly string[]; formerOwners: readonly string[] }[] = [];
    const run = (reader: DirectoryReader) =>
      createDirectorySyncPass({
        tenantId: TENANT,
        groupId: GROUP,
        reader,
        store,
        now: () => NOW,
        reconcileAccess: async (input) => {
          seen.push(input);
        },
      })();
    await run(
      scriptedReader([
        {
          changes: [
            { kind: 'upsert', person: person(ANA, 'Ana') },
            { kind: 'upsert', person: person(BETO, 'Beto') },
          ],
          deltaLink: 'https://graph.microsoft.com/d1',
        },
      ]).reader,
    );
    await run(
      scriptedReader(
        [
          {
            changes: [{ kind: 'removed', oid: BETO }],
            deltaLink: 'https://graph.microsoft.com/d2',
          },
        ],
        [],
      ).reader,
    );
    expect(seen).toEqual([
      { removedMembers: [], formerOwners: [] },
      { removedMembers: [BETO], formerOwners: [DUENO] },
    ]);
  });

  describe('revocación en el runtime', () => {
    let runtime: SecOpsRuntime;
    let stop: () => Promise<void>;

    beforeAll(async () => {
      const built = await buildApi({ QAPAQ_PROFILE: 'test' }, () => {});
      runtime = built.runtime;
      stop = built.stop;
    });

    afterAll(async () => {
      await stop();
    });

    it('revoca solo las sesiones activas de esos OID y deja AuditEvent con el motivo', async () => {
      const tenantId = runtime.tenantIdForDirectory;
      const open = (oid: string, subjectId: string) =>
        openSession(
          {
            subjectId,
            oid,
            tenantId,
            roles: ['qapaq.soc.analyst'],
            scopes: ['soc.read'],
            capabilities: capabilitiesForRoles(['qapaq.soc.analyst']),
            amr: ['pwd', 'mfa'],
            clientIp: '10.20.0.15',
          },
          [],
          NOW,
        ).session;
      const leaving = open(BETO.toUpperCase(), 'sub-beto');
      const staying = open(ANA, 'sub-ana');
      await runtime.sessions.create(leaving);
      await runtime.sessions.create(staying);

      expect(await runtime.revokeSessionsByOid([BETO], 'membership_removed')).toBe(1);
      expect((await runtime.sessions.byId(leaving.id))?.state).toBe('revoked');
      expect((await runtime.sessions.byId(staying.id))?.state).toBe('active');
      // Idempotente: una segunda reconciliación no encuentra nada que revocar.
      expect(await runtime.revokeSessionsByOid([BETO], 'membership_removed')).toBe(0);

      const events = await runtime.audit.range(tenantId, 1n, 1_000);
      expect(events.at(-1)).toMatchObject({
        action: 'access.session.revoked',
        reason: 'membership_removed',
        actor: { id: 'system:directory-sync' },
      });
    });
  });
});
