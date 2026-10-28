#!/usr/bin/env node
/**
 * QAPAQ SecOps — tarea one-off de base de datos (C-1, decisiones D-6/D-7).
 *
 * Modos (primer argumento):
 *
 *   bootstrap-roles  Con la credencial master de RDS crea o rota `qapaq_migrator` y
 *                    `qapaq_soc_runtime`. Las contraseñas se generan aquí, se publican en
 *                    Secrets Manager como AWSPENDING, se aplican y solo entonces pasan a
 *                    AWSCURRENT. Si algo falla, las credenciales vigentes no cambian. Nunca
 *                    pasan por Terraform, logs ni argumentos de proceso.
 *   migrate          Con `qapaq_migrator` ejecuta `prisma migrate deploy` y reaplica el
 *                    endurecimiento de permisos (`bootstrap/post-migrate.sql`).
 *   azure-bootstrap  Azure EUS2, desde el host SIEM: con el administrador del Flexible Server
 *                    aplica `roles.sql`, migra con una contraseña de un solo uso para
 *                    `qapaq_migrator` y lo deja sin LOGIN. La contraseña del runtime ya está en
 *                    Key Vault (`qapaq-postgres-app-password`); no llama a AWS.
 *
 * Entorno:
 *   QAPAQ_POSTGRES_HOST, QAPAQ_POSTGRES_PORT, QAPAQ_POSTGRES_DATABASE, QAPAQ_POSTGRES_TLS
 *   bootstrap-roles: QAPAQ_MASTER_USERNAME, QAPAQ_MASTER_PASSWORD (inyectadas por ECS desde
 *                    el secret administrado por RDS), QAPAQ_MIGRATOR_SECRET_ID,
 *                    QAPAQ_RUNTIME_SECRET_ID, QAPAQ_ENTITY_REF_SECRET_ID,
 *                    QAPAQ_VAPID_SECRET_ID, AWS_REGION
 *   migrate:         QAPAQ_MIGRATOR_PASSWORD (inyectada por ECS)
 *   azure-bootstrap: QAPAQ_MASTER_USERNAME, QAPAQ_MASTER_PASSWORD, QAPAQ_RUNTIME_PASSWORD
 *                    (parámetros protegidos del Run Command; nunca argumentos de proceso)
 *
 * Salida: una línea JSON por fase, sin secretos. Código distinto de cero si algo falla: el
 * pipeline de release no despliega el API sin una migración exitosa.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { runAzureBootstrap } from './azure-bootstrap.mjs';
import { awsSecretsPort, runBootstrapProtocol } from './bootstrap-protocol.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIGRATOR_ROLE = 'qapaq_migrator';
const RUNTIME_ROLE = 'qapaq_soc_runtime';

function log(event, extra = {}) {
  process.stdout.write(
    `${JSON.stringify({ service: 'qapaq-secops-migrator', event, timestamp: new Date().toISOString(), ...extra })}\n`,
  );
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`CONFIG_MISSING:${name}`);
  return value;
}

function connectionUrl(username, password) {
  const url = new URL('postgresql://placeholder');
  url.hostname = required('QAPAQ_POSTGRES_HOST');
  url.port = process.env.QAPAQ_POSTGRES_PORT ?? '5432';
  url.pathname = `/${encodeURIComponent(required('QAPAQ_POSTGRES_DATABASE'))}`;
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  // Mismo criterio que el API: cifrado con verificación de CA y nombre (bundle RDS en la imagen).
  if ((process.env.QAPAQ_POSTGRES_TLS ?? 'true') === 'true') {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}

async function withClient(url, work) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** 48 bytes aleatorios en base64url: 64 caracteres sin símbolos problemáticos en URLs. */
function generatePassword() {
  return randomBytes(48).toString('base64url');
}

async function secretsClient() {
  const sdk = await import('@aws-sdk/client-secrets-manager');
  return { sdk, client: new sdk.SecretsManagerClient({ region: required('AWS_REGION') }) };
}

/**
 * D-10b — crea la clave HMAC de referencias de entidad si el secreto no tiene versión
 * vigente. Si ya existe no se toca: rotarla invalidaría las referencias guardadas.
 */
async function ensureEntityRefKey({ sdk, client }) {
  const secretId = process.env.QAPAQ_ENTITY_REF_SECRET_ID;
  if (!secretId) return;
  const described = await client.send(new sdk.DescribeSecretCommand({ SecretId: secretId }));
  const hasCurrent = Object.values(described.VersionIdsToStages ?? {}).some((stages) =>
    stages.includes('AWSCURRENT'),
  );
  if (hasCurrent) {
    log('bootstrap.entity_ref_key_kept');
    return;
  }
  await client.send(
    new sdk.PutSecretValueCommand({
      SecretId: secretId,
      SecretString: randomBytes(48).toString('base64url'),
    }),
  );
  log('bootstrap.entity_ref_key_created');
}

/**
 * Sprint 5 — crea la clave privada VAPID (P-256, PKCS#8 en base64) del Web Push si el secreto no
 * tiene versión vigente. Si existe no se toca: rotarla invalidaría las suscripciones de todos
 * los dispositivos registrados.
 */
async function ensureVapidKey({ sdk, client }) {
  const secretId = process.env.QAPAQ_VAPID_SECRET_ID;
  if (!secretId) return;
  const described = await client.send(new sdk.DescribeSecretCommand({ SecretId: secretId }));
  const hasCurrent = Object.values(described.VersionIdsToStages ?? {}).some((stages) =>
    stages.includes('AWSCURRENT'),
  );
  if (hasCurrent) {
    log('bootstrap.vapid_key_kept');
    return;
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await client.send(
    new sdk.PutSecretValueCommand({
      SecretId: secretId,
      SecretString: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    }),
  );
  log('bootstrap.vapid_key_created');
}

async function bootstrapRoles() {
  const { sdk, client } = await secretsClient();
  const sql = await readFile(new URL('../bootstrap/roles.sql', import.meta.url), 'utf8');
  await runBootstrapProtocol({
    secrets: awsSecretsPort(sdk, client),
    roles: [
      { role: MIGRATOR_ROLE, secretId: required('QAPAQ_MIGRATOR_SECRET_ID') },
      { role: RUNTIME_ROLE, secretId: required('QAPAQ_RUNTIME_SECRET_ID') },
    ],
    generatePassword,
    log,
    applyRoles: (passwords) =>
      withClient(
        connectionUrl(required('QAPAQ_MASTER_USERNAME'), required('QAPAQ_MASTER_PASSWORD')),
        async (db) => {
          await db.query('BEGIN');
          try {
            // `set_config(..., true)` vive solo dentro de esta transacción.
            await db.query(
              "SELECT set_config('qapaq.migrator_password', $1, true), set_config('qapaq.runtime_password', $2, true)",
              [passwords[MIGRATOR_ROLE], passwords[RUNTIME_ROLE]],
            );
            await db.query(sql);
            await db.query('COMMIT');
          } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        },
      ),
  });
  await ensureEntityRefKey({ sdk, client });
  await ensureVapidKey({ sdk, client });
  log('bootstrap.completed', {
    note: 'Forzar un nuevo despliegue del API para que tome la contraseña rotada.',
  });
}

/**
 * D-12 — Prisma escribe en stdout/stderr y sus errores pueden citar la URL de conexión. La
 * salida se captura y se redacta (URLs postgres y la contraseña literal) antes de llegar a
 * CloudWatch o al workflow.
 */
export function redact(text, secrets) {
  let output = text.replace(/postgres(?:ql)?:\/\/[^\s'"]+/giu, 'postgresql://[REDACTED]');
  for (const secret of secrets) {
    if (secret && secret.length >= 8) output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

function runPrisma(databaseUrl, password = process.env.QAPAQ_MIGRATOR_PASSWORD ?? '') {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)),
        'migrate',
        'deploy',
        '--schema',
        'prisma/schema.prisma',
      ],
      {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const sensitive = [databaseUrl, password];
    child.stdout.on('data', (chunk) => process.stdout.write(redact(String(chunk), sensitive)));
    child.stderr.on('data', (chunk) => process.stderr.write(redact(String(chunk), sensitive)));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`PRISMA_MIGRATE_FAILED:${code}`)),
    );
  });
}

async function migrate(password = required('QAPAQ_MIGRATOR_PASSWORD')) {
  const url = connectionUrl(MIGRATOR_ROLE, password);
  await runPrisma(url, password);
  log('migrate.applied');
  const sql = await readFile(new URL('../bootstrap/post-migrate.sql', import.meta.url), 'utf8');
  await withClient(url, (client) => client.query(sql));
  log('migrate.hardened');
}

/**
 * Azure EUS2 — roles y migración con la credencial de administrador del Flexible Server, que
 * llega junto con la contraseña del runtime como parámetros protegidos del Run Command. No usa
 * AWS ni guarda la contraseña de `qapaq_migrator` (ver `azure-bootstrap.mjs`).
 */
async function azureBootstrap() {
  const masterUrl = connectionUrl(required('QAPAQ_MASTER_USERNAME'), required('QAPAQ_MASTER_PASSWORD'));
  const sql = await readFile(new URL('../bootstrap/roles.sql', import.meta.url), 'utf8');
  await runAzureBootstrap({
    runtimePassword: required('QAPAQ_RUNTIME_PASSWORD'),
    generatePassword,
    log,
    applyRoles: (passwords) =>
      withClient(masterUrl, async (db) => {
        await db.query('BEGIN');
        try {
          await db.query(
            "SELECT set_config('qapaq.migrator_password', $1, true), set_config('qapaq.runtime_password', $2, true)",
            [passwords[MIGRATOR_ROLE], passwords[RUNTIME_ROLE]],
          );
          await db.query(sql);
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }),
    migrate: (password) => migrate(password),
    lockMigrator: () =>
      withClient(masterUrl, (db) =>
        db.query(`ALTER ROLE ${MIGRATOR_ROLE} WITH NOLOGIN PASSWORD NULL`),
      ),
  });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const mode = invokedDirectly ? process.argv[2] : undefined;
if (invokedDirectly)
  try {
    if (mode === 'bootstrap-roles') await bootstrapRoles();
    else if (mode === 'migrate') await migrate();
    else if (mode === 'azure-bootstrap') await azureBootstrap();
    else throw new Error('MODE_INVALID: usar bootstrap-roles, migrate o azure-bootstrap');
    log('completed', { mode });
  } catch (error) {
    // Solo el tipo y un código: un mensaje de pg podría citar parámetros de conexión.
    const code = error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN';
    log('failed', { mode, errorCode: code.slice(0, 64) });
    process.exitCode = 1;
  }
