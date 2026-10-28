/**
 * Azure EUS2 — bootstrap de roles y migración en una sola corrida, sin credencial DDL guardada.
 *
 * En Azure no hay tarea one-off en la VNet: el workflow protegido escribe la contraseña del
 * runtime en Key Vault (ARM, `secureString`) y la entrega junto con la del administrador como
 * parámetros protegidos de un Run Command en el host SIEM, el único cómputo con ruta privada a
 * PostgreSQL Flexible Server. Este módulo:
 *
 * 1. Valida la contraseña del runtime (la misma que ya quedó en Key Vault).
 * 2. Genera una contraseña de un solo uso para `qapaq_migrator`; nunca se guarda.
 * 3. Aplica `roles.sql` con el administrador (mismos roles y permisos que AWS, D-6).
 * 4. Migra como `qapaq_migrator` y reaplica `post-migrate.sql`.
 * 5. Siempre que los roles se aplicaron, deja `qapaq_migrator` sin LOGIN: la próxima migración
 *    vuelve a pasar por este flujo con el administrador.
 *
 * Recuperación: Key Vault se escribe antes de tocar la base. Si algo falla después, repetir el
 * workflow genera una contraseña nueva, la escribe y la vuelve a aplicar; no hay estado
 * intermedio que reconciliar. Como en D-11, el API toma la contraseña al reiniciar.
 *
 * No depende de pg, Prisma ni Azure: recibe los pasos inyectados para probarlos con dobles.
 */

const MINIMUM_PASSWORD_LENGTH = 32;
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]+$/u;

export class AzureBootstrapError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = 'AzureBootstrapError';
    this.code = code;
  }
}

/**
 * @param {object} input
 * @param {string} input.runtimePassword
 * @param {() => string} input.generatePassword
 * @param {(passwords: Record<string, string>) => Promise<void>} input.applyRoles
 * @param {(migratorPassword: string) => Promise<void>} input.migrate
 * @param {() => Promise<void>} input.lockMigrator
 * @param {(event: string, extra?: object) => void} input.log
 */
export async function runAzureBootstrap({
  runtimePassword,
  generatePassword,
  applyRoles,
  migrate,
  lockMigrator,
  log,
}) {
  if (
    typeof runtimePassword !== 'string' ||
    runtimePassword.length < MINIMUM_PASSWORD_LENGTH ||
    !PASSWORD_PATTERN.test(runtimePassword)
  ) {
    throw new AzureBootstrapError('RUNTIME_PASSWORD_INVALID');
  }
  const migratorPassword = generatePassword();
  if (migratorPassword.length < MINIMUM_PASSWORD_LENGTH || migratorPassword === runtimePassword) {
    throw new AzureBootstrapError('MIGRATOR_PASSWORD_INVALID');
  }

  await applyRoles({ qapaq_migrator: migratorPassword, qapaq_soc_runtime: runtimePassword });
  log('azure_bootstrap.roles_applied');
  try {
    await migrate(migratorPassword);
    log('azure_bootstrap.migrated');
  } finally {
    await lockMigrator();
    log('azure_bootstrap.migrator_locked');
  }
}
