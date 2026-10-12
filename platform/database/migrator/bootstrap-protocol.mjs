/**
 * D-11 — protocolo recuperable de bootstrap y rotación de roles PostgreSQL.
 *
 * El problema que resuelve: cambiar la contraseña en la base y publicarla en Secrets Manager
 * son dos sistemas sin transacción común. Si el proceso cae entre ambos, la base exige una
 * credencial que el secreto vigente (`AWSCURRENT`) no tiene.
 *
 * Protocolo:
 *
 * 1. **Candidata durable antes de tocar la base**: por cada rol, si el secreto ya tiene una
 *    versión `AWSPENDING` (corrida anterior incompleta) se reutiliza esa contraseña; si no,
 *    se genera una y se publica como `AWSPENDING`. La candidata queda guardada antes de que
 *    la base la conozca.
 * 2. **Aplicar en la base** las candidatas (`roles.sql`, idempotente: `ALTER ROLE … PASSWORD`).
 * 3. **Promover** cada candidata a `AWSCURRENT`. Promover es idempotente: si la candidata ya
 *    es la vigente, no se hace nada.
 *
 * Cualquier fallo en 2 o 3 se recupera repitiendo la corrida: el paso 1 encuentra las mismas
 * candidatas, el 2 vuelve a aplicar exactamente esas contraseñas y el 3 completa lo que falte.
 * Nunca hay dos contraseñas candidatas distintas para el mismo rol.
 *
 * Ventana conocida (sin usuarios alternados): desde el COMMIT del paso 2 hasta el redespliegue
 * del API, las conexiones nuevas con la contraseña anterior fallan. El workflow fuerza el
 * redespliegue al terminar con éxito.
 *
 * Este módulo no depende de AWS ni de pg: recibe `secrets` y `applyRoles`, así el protocolo se
 * prueba con fallos inyectados.
 */

/**
 * @typedef {object} SecretsPort
 * @property {(secretId: string) => Promise<{ versionId: string, password: string } | null>} pending
 *   Versión `AWSPENDING` si existe y no es ya `AWSCURRENT`.
 * @property {(secretId: string, value: { username: string, password: string }) => Promise<string>} stagePending
 *   Publica una versión `AWSPENDING` y devuelve su id.
 * @property {(secretId: string, versionId: string) => Promise<boolean>} promote
 *   Mueve `AWSCURRENT` a la versión; `false` si ya lo era.
 */

/**
 * @param {object} input
 * @param {SecretsPort} input.secrets
 * @param {ReadonlyArray<{ role: string, secretId: string }>} input.roles
 * @param {(passwords: Record<string, string>) => Promise<void>} input.applyRoles
 * @param {() => string} input.generatePassword
 * @param {(event: string, extra?: object) => void} input.log
 */
export async function runBootstrapProtocol({ secrets, roles, applyRoles, generatePassword, log }) {
  /** @type {Record<string, { secretId: string, versionId: string, password: string }>} */
  const candidates = {};

  // 1. Candidatas durables: reutilizar la pendiente o crear una nueva.
  for (const { role, secretId } of roles) {
    const existing = await secrets.pending(secretId);
    if (existing) {
      candidates[role] = { secretId, ...existing };
      log('bootstrap.candidate_reused', { role });
    } else {
      const password = generatePassword();
      const versionId = await secrets.stagePending(secretId, { username: role, password });
      candidates[role] = { secretId, versionId, password };
      log('bootstrap.candidate_staged', { role });
    }
  }

  // 2. Aplicar exactamente esas candidatas en la base.
  await applyRoles(
    Object.fromEntries(Object.entries(candidates).map(([role, value]) => [role, value.password])),
  );
  log('bootstrap.roles_applied');

  // 3. Promover; idempotente para completar una corrida que cayó a mitad.
  for (const [role, { secretId, versionId }] of Object.entries(candidates)) {
    const moved = await secrets.promote(secretId, versionId);
    log(moved ? 'bootstrap.candidate_promoted' : 'bootstrap.candidate_already_current', { role });
  }
}

/** Implementación del puerto sobre el SDK de Secrets Manager. */
export function awsSecretsPort(sdk, client) {
  async function stagesOf(secretId) {
    const described = await client.send(new sdk.DescribeSecretCommand({ SecretId: secretId }));
    return described.VersionIdsToStages ?? {};
  }

  return {
    async pending(secretId) {
      const stages = await stagesOf(secretId);
      const entry = Object.entries(stages).find(
        ([, labels]) => labels.includes('AWSPENDING') && !labels.includes('AWSCURRENT'),
      );
      if (!entry) return null;
      const value = await client.send(
        new sdk.GetSecretValueCommand({ SecretId: secretId, VersionId: entry[0] }),
      );
      const parsed = JSON.parse(value.SecretString ?? '{}');
      if (typeof parsed.password !== 'string' || parsed.password.length < 32) return null;
      return { versionId: entry[0], password: parsed.password };
    },

    async stagePending(secretId, value) {
      const result = await client.send(
        new sdk.PutSecretValueCommand({
          SecretId: secretId,
          SecretString: JSON.stringify(value),
          VersionStages: ['AWSPENDING'],
        }),
      );
      return result.VersionId;
    },

    async promote(secretId, versionId) {
      const stages = await stagesOf(secretId);
      if ((stages[versionId] ?? []).includes('AWSCURRENT')) return false;
      const current = Object.entries(stages).find(([, labels]) =>
        labels.includes('AWSCURRENT'),
      )?.[0];
      await client.send(
        new sdk.UpdateSecretVersionStageCommand({
          SecretId: secretId,
          VersionStage: 'AWSCURRENT',
          MoveToVersionId: versionId,
          ...(current ? { RemoveFromVersionId: current } : {}),
        }),
      );
      // AWSPENDING ya cumplió: se retira para que la próxima rotación genere una nueva.
      await client.send(
        new sdk.UpdateSecretVersionStageCommand({
          SecretId: secretId,
          VersionStage: 'AWSPENDING',
          RemoveFromVersionId: versionId,
        }),
      );
      return true;
    },
  };
}
