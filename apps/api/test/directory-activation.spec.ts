/**
 * Activación diferida del padrón: el grupo Accesos_SOC se resuelve por nombre cuando Entra
 * concede el permiso, con reintentos exponenciales y sin reiniciar el API. Los dueños leídos de
 * Graph pasan a `qapaq.platform.admin` por la misma fuente perezosa.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DirectoryError, InMemoryDirectoryStore } from '@qapaq/access';

import { DirectoryGroupActivation } from '../src/runtime/directory-activation.js';
import { directoryOwnerSource, lazyOwnerSource } from '../src/runtime/directory-sync.js';
import { createRoleGrantResolver } from '../src/runtime/role-grants.js';

const GROUP = '99999999-9999-4999-8999-999999999999';
const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const TENANT = 'tenant-test';

afterEach(() => {
  vi.useRealTimers();
});

describe('DirectoryGroupActivation', () => {
  it('con el ID configurado queda resuelta sin llamar a Graph', async () => {
    const resolve = vi.fn(async () => GROUP);
    const activation = new DirectoryGroupActivation({ groupId: GROUP.toUpperCase(), resolve });
    expect(await activation.attempt()).toBe(true);
    expect(activation.groupId).toBe(GROUP);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('sin permiso queda pendiente con el código y reintenta con espera exponencial', async () => {
    vi.useFakeTimers();
    let allowed = false;
    const resolve = vi.fn(async () => {
      if (!allowed) throw new DirectoryError('DIRECTORY_FORBIDDEN');
      return GROUP;
    });
    const onResolved = vi.fn();
    const onError = vi.fn();
    const activation = new DirectoryGroupActivation({
      groupName: 'Accesos_SOC',
      resolve,
      onResolved,
      onError,
      minimumDelayMs: 1_000,
      maximumDelayMs: 4_000,
    });
    expect(await activation.attempt()).toBe(false);
    expect(activation.state).toMatchObject({
      groupId: undefined,
      lastErrorCode: 'DIRECTORY_FORBIDDEN',
    });
    activation.start();
    expect(activation.state.nextAttemptAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000); // 2.º intento
    await vi.advanceTimersByTimeAsync(2_000); // 3.º, con la espera duplicada
    expect(resolve).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3_999); // tope de 4 s: todavía no
    expect(resolve).toHaveBeenCalledTimes(3);
    allowed = true; // el administrador de Entra concede GroupMember.Read.All
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(activation.groupId).toBe(GROUP);
    expect(activation.state).toMatchObject({ lastErrorCode: null, nextAttemptAt: null });
    expect(onResolved).toHaveBeenCalledWith(GROUP);
    expect(onError).toHaveBeenCalledTimes(3);
    // Resuelto, no hay más intentos.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(4);
    await activation.stop();
  });

  it('retiene el diagnóstico Graph seguro mientras el nombre del grupo no se resuelve', async () => {
    const activation = new DirectoryGroupActivation({
      groupName: 'Accesos_SOC',
      resolve: async () => {
        throw new DirectoryError('DIRECTORY_PERMISSION_MISSING', undefined, {
          status: 403,
          errorCode: 'Authorization_RequestDenied',
          requestId: 'graph-request-789',
          operation: 'resolveGroupId',
        });
      },
    });
    expect(await activation.attempt()).toBe(false);
    expect(activation.state).toMatchObject({
      lastErrorCode: 'DIRECTORY_PERMISSION_MISSING',
      diagnostic: {
        status: 403,
        errorCode: 'Authorization_RequestDenied',
        requestId: 'graph-request-789',
        operation: 'resolveGroupId',
      },
    });
  });

  it('un intento colgado vence con DIRECTORY_UNAVAILABLE: el arranque no espera más', async () => {
    vi.useFakeTimers();
    const activation = new DirectoryGroupActivation({
      groupName: 'Accesos_SOC',
      resolve: () => new Promise<string>(() => undefined),
      attemptTimeoutMs: 500,
    });
    const attempt = activation.attempt();
    await vi.advanceTimersByTimeAsync(500);
    expect(await attempt).toBe(false);
    expect(activation.state.lastErrorCode).toBe('DIRECTORY_UNAVAILABLE');
  });

  it('stop detiene los reintentos', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async (): Promise<string> => {
      throw new DirectoryError('DIRECTORY_FORBIDDEN');
    });
    const activation = new DirectoryGroupActivation({
      groupName: 'Accesos_SOC',
      resolve,
      minimumDelayMs: 1_000,
    });
    activation.start();
    await activation.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('dueños de Accesos_SOC leídos de Graph: qapaq.platform.admin', () => {
  async function storeWithOwner() {
    const store = new InMemoryDirectoryStore();
    const at = new Date();
    const person = (oid: string) => ({
      oid,
      displayName: oid.slice(0, 4),
      upn: null,
      accountEnabled: true,
    });
    const claim = await store.claimSync(TENANT, GROUP, at, 60_000);
    await store.commitSync(claim!, {
      at,
      changes: [
        { kind: 'upsert', person: person(OWNER) },
        { kind: 'upsert', person: person(MEMBER) },
      ],
      fullRead: true,
      owners: [person(OWNER)],
      deltaLink: 'https://graph.microsoft.com/delta',
    });
    return store;
  }

  it('sin grupo resuelto no hay dueños de Graph; al resolverse, el dueño es admin', async () => {
    const store = await storeWithOwner();
    let groupId: string | undefined;
    const owners = lazyOwnerSource(
      () => groupId,
      (id) => directoryOwnerSource(store, TENANT, id),
    );
    const resolveRoles = createRoleGrantResolver(
      { bindings: {}, groupOwnerOids: [], adminGroupIds: [] },
      owners,
    );
    expect(await resolveRoles(OWNER, undefined)).toEqual([]);
    expect(owners.groupId).toBeUndefined();
    groupId = GROUP;
    expect(owners.groupId).toBe(GROUP);
    expect(await resolveRoles(OWNER, undefined)).toEqual(['qapaq.platform.admin']);
    // Un miembro que no es dueño no recibe ningún rol automático: queda pendiente de asignación.
    expect(await resolveRoles(MEMBER, undefined)).toEqual([]);
  });
});
