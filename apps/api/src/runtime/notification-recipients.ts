/**
 * Sprint 5 — destinatarios de Teams por rol, desde el padrón del grupo de admisión.
 *
 * Para cada persona del padrón (miembros activos y dueños) calcula el rol efectivo con la misma
 * regla que la administración (`explainRole`): dueño del grupo → admin; asignación del deploy;
 * app role observado en su última sesión. Quien queda «sin acceso asignado», está dado de baja
 * o tiene la cuenta deshabilitada no recibe nada. La mención usa el UPN del padrón.
 *
 * Sin padrón (sincronización deshabilitada o sin resolver) no hay UPN que mencionar: devuelve
 * vacío y la tarjeta sale al canal sin menciones.
 */

import type { DirectoryPerson, SessionStore } from '@qapaq/access';
import type { RoleGrantsConfig } from '@qapaq/configuration';
import type { NotificationRecipient, NotifiedRole, RecipientDirectory } from '@qapaq/soar';

import { explainRole } from './role-grants.js';
import type { RuntimeDirectory } from './secops-runtime.js';

const SESSION_WINDOW_MS = 30 * 86_400_000;
const SESSION_LIMIT = 2_000;

export function directoryRecipients(input: {
  readonly directory: () => RuntimeDirectory | undefined;
  readonly grants: RoleGrantsConfig;
  readonly sessions: () => SessionStore;
  readonly now: () => Date;
}): RecipientDirectory {
  return {
    async recipientsFor(tenantId: string, roles: readonly NotifiedRole[]) {
      const directory = input.directory();
      if (!directory || directory.mode !== 'graph') return [];
      const [members, owners, sessions] = await Promise.all([
        directory.store.members(tenantId, directory.groupId),
        directory.store.owners(tenantId, directory.groupId),
        input
          .sessions()
          .recentByTenant(
            tenantId,
            new Date(input.now().getTime() - SESSION_WINDOW_MS),
            SESSION_LIMIT,
          ),
      ]);
      const ownerIds = new Set(owners.map((owner) => owner.oid.toLowerCase()));
      // Roles observados por UPN: los de la sesión más reciente de cada persona.
      const observed = new Map<string, readonly string[]>();
      for (const session of [...sessions].sort(
        (a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime(),
      )) {
        if (session.email) observed.set(session.email.toLowerCase(), session.roles);
      }
      const people: DirectoryPerson[] = [
        ...members.filter(
          (member) => member.membership === 'member' && member.accountEnabled !== false,
        ),
        ...owners,
      ];
      const seen = new Set<string>();
      const recipients: NotificationRecipient[] = [];
      for (const person of people) {
        const upn = person.upn?.toLowerCase();
        if (!upn || seen.has(upn)) continue;
        seen.add(upn);
        const effective = explainRole(input.grants, ownerIds, person.oid, observed.get(upn) ?? []);
        if (effective.roles.some((role) => (roles as readonly string[]).includes(role))) {
          recipients.push({
            upn,
            displayName: person.displayName ?? upn,
            subjectKey: person.oid.toLowerCase(),
          });
        }
      }
      return recipients.sort((a, b) => a.displayName.localeCompare(b.displayName, 'es'));
    },
  };
}
