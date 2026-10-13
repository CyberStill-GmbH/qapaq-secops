/**
 * Sprint 5 — destinatarios de avisos por rol desde el padrón del grupo de admisión.
 *
 * Misma regla de acceso que la administración: dueño → admin, asignación del deploy, app role
 * observado; sin acceso, baja o cuenta deshabilitada no reciben. OID y correos sintéticos.
 */

import { describe, expect, it } from 'vitest';

import {
  capabilitiesForRoles,
  InMemoryDirectoryStore,
  InMemorySessionStore,
  openSession,
} from '@qapaq/access';
import { loadRoleGrantsConfig, loadTeamsWorkflowUrl } from '@qapaq/configuration';

import { directoryRecipients } from '../src/runtime/notification-recipients.js';

const TENANT = 'tenant-teams';
const GROUP = '99999999-9999-4999-8999-999999999999';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ANALYST = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const NOBODY = '44444444-4444-4444-8444-444444444444';
const GONE = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-13T01:00:00.000Z');
const person = (oid: string, name: string) => ({
  oid,
  displayName: name,
  upn: `${name.toLowerCase()}@qapaq-lab.example`,
  accountEnabled: true,
});

describe('destinatarios por rol', () => {
  it('cada evento llega solo a quien tiene un rol de la ruta', async () => {
    const store = new InMemoryDirectoryStore();
    const claim = await store.claimSync(TENANT, GROUP, NOW, 60_000);
    await store.commitSync(claim!, {
      at: NOW,
      fullRead: true,
      deltaLink: 'https://graph.microsoft.com/d',
      owners: [person(OWNER, 'Dueno')],
      changes: [
        { kind: 'upsert', person: person(ANALYST, 'Analista') },
        { kind: 'upsert', person: person(LEAD, 'Lider') },
        { kind: 'upsert', person: person(NOBODY, 'Nadie') },
        { kind: 'upsert', person: person(GONE, 'Ido') },
      ],
    });
    const later = await store.claimSync(TENANT, GROUP, new Date(NOW.getTime() + 1), 60_000);
    await store.commitSync(later!, {
      at: NOW,
      fullRead: false,
      deltaLink: 'https://graph.microsoft.com/d2',
      owners: [person(OWNER, 'Dueno')],
      changes: [{ kind: 'removed', oid: GONE }],
    });
    const sessions = new InMemorySessionStore();
    // El lead lo es por app role de Entra observado en su sesión.
    await sessions.create(
      openSession(
        {
          subjectId: 'sub-lead',
          oid: LEAD,
          email: 'lider@qapaq-lab.example',
          tenantId: TENANT,
          roles: ['qapaq.soc.lead'],
          scopes: ['soc.read'],
          capabilities: capabilitiesForRoles(['qapaq.soc.lead']),
          amr: ['mfa'],
          clientIp: '10.0.0.1',
        },
        [],
        NOW,
      ).session,
    );
    const resolver = directoryRecipients({
      directory: () => ({ mode: 'graph', groupId: GROUP, intervalMs: 900_000, store }),
      sessions: () => sessions,
      grants: loadRoleGrantsConfig({
        QAPAQ_PROFILE: 'test',
        QAPAQ_ROLE_BINDINGS: `${ANALYST}=qapaq.soc.analyst`,
      }),
      now: () => NOW,
    });

    const triage = await resolver.recipientsFor(TENANT, ['qapaq.soc.analyst', 'qapaq.soc.lead']);
    expect(triage.map((recipient) => recipient.upn)).toEqual([
      'analista@qapaq-lab.example',
      'lider@qapaq-lab.example',
    ]);
    const command = await resolver.recipientsFor(TENANT, [
      'qapaq.soc.lead',
      'qapaq.platform.admin',
    ]);
    expect(command.map((recipient) => recipient.upn)).toEqual([
      'dueno@qapaq-lab.example',
      'lider@qapaq-lab.example',
    ]);
  });

  it('sin padrón no hay a quién avisar', async () => {
    const resolver = directoryRecipients({
      directory: () => ({ mode: 'disabled' }),
      sessions: () => new InMemorySessionStore(),
      grants: loadRoleGrantsConfig({ QAPAQ_PROFILE: 'test' }),
      now: () => NOW,
    });
    expect(await resolver.recipientsFor(TENANT, ['qapaq.soc.analyst'])).toEqual([]);
  });
});

describe('URL del Teams Workflow', () => {
  const load = (value: string) =>
    loadTeamsWorkflowUrl({ QAPAQ_PROFILE: 'test', QAPAQ_TEAMS_WORKFLOW_URL: value });

  it('acepta HTTPS hacia hosts de Microsoft', () => {
    expect(
      load(
        'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x',
      ),
    ).toContain('logic.azure.com');
    expect(load('https://abc.environment.api.powerplatform.com/powerautomate/x')).toContain(
      'powerplatform.com',
    );
    expect(loadTeamsWorkflowUrl({ QAPAQ_PROFILE: 'test' })).toBeUndefined();
  });

  it.each([
    'http://prod-12.westus.logic.azure.com/x',
    'https://atacante.example/logic.azure.com',
    'https://logic.azure.com.atacante.example/x',
    'no es url',
  ])('rechaza %s', (value) => {
    expect(() => load(value)).toThrow();
  });
});
