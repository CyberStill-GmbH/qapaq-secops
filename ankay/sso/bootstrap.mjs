#!/usr/bin/env node
/*
 * Prepara los secretos del puente SSO de Ankay (idempotente). Se corre una vez por despliegue
 * con la imagen del puente:
 *
 *   docker compose … run --rm -v <dir-secretos>:/out \
 *     -e SHUFFLE_ADMIN_USERNAME -e SHUFFLE_ADMIN_PASSWORD ankay-sso node bootstrap.mjs
 *
 * Deja en /out (no imprime ningún secreto):
 *   edge-token       token compartido edge → puente (32 bytes hex), solo si no existe
 *   edge-token.map   el mismo token como entrada de `map` de nginx (lo incluye el edge)
 *   shuffle-apikey   API key de la cuenta de servicio admin `ankay-sso@qapaq.internal`
 *
 * La cuenta de servicio se crea con la API de Shuffle usando el admin inicial (SHUFFLE_ADMIN_*):
 * se registra como «user», inicia sesión una vez para generar su propia API key (Shuffle no deja
 * generarla para otro usuario) y después se la promueve a admin. La API key del admin inicial no se toca.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomPassword } from './lib.mjs';
import { createShuffleClient } from './shuffle-client.mjs';

const SERVICE_USER = (process.env.RESPOND_SSO_SERVICE_USER ?? 'ankay-sso@qapaq.internal').toLowerCase();
const OUT = process.env.OUT_DIR ?? '/out';
const baseUrl = process.env.SHUFFLE_URL ?? 'http://shuffle-backend:5001';
const log = (event, extra = {}) => console.log(JSON.stringify({ event: `respond_sso.bootstrap.${event}`, ...extra }));

function write(name, content) {
  // Dueño: `node` (uid 1000, el mismo del puente). El edge (nginx, root) también lo lee.
  writeFileSync(`${OUT}/${name}`, content, { mode: 0o600 });
  chmodSync(`${OUT}/${name}`, 0o600);
}

async function main() {
  if (!existsSync(`${OUT}/edge-token`)) {
    write('edge-token', `${randomBytes(32).toString('hex')}\n`);
    log('edge_token_created');
  }
  const edgeToken = readFileSync(`${OUT}/edge-token`, 'utf8').trim();
  write('edge-token.map', `# Generado por ankay/sso/bootstrap.mjs. Secreto: no versionar.\n~. "${edgeToken}";\n`);

  if (existsSync(`${OUT}/shuffle-apikey`)) {
    const current = readFileSync(`${OUT}/shuffle-apikey`, 'utf8').trim();
    try {
      const me = await createShuffleClient({ baseUrl, apiKey: current }).whoami();
      if (String(me.username).toLowerCase() === SERVICE_USER && String(me.admin) === 'true') {
        log('apikey_valid');
        return;
      }
    } catch {
      // se regenera
    }
  }

  const username = process.env.SHUFFLE_ADMIN_USERNAME;
  const password = process.env.SHUFFLE_ADMIN_PASSWORD;
  if (!username || !password) throw new Error('faltan SHUFFLE_ADMIN_USERNAME / SHUFFLE_ADMIN_PASSWORD');
  const anon = createShuffleClient({ baseUrl, apiKey: null });
  const adminSession = await anon.login(username.toLowerCase(), password);
  if (!adminSession) throw new Error('el admin inicial de Shuffle no pudo iniciar sesión');
  const admin = createShuffleClient({ baseUrl, apiKey: adminSession });

  let service = await admin.findUser(SERVICE_USER);
  if (!service) {
    await admin.register(SERVICE_USER, randomPassword());
    service = await admin.findUser(SERVICE_USER);
    if (!service) throw new Error('no se pudo crear la cuenta de servicio');
    log('service_user_created', { user: SERVICE_USER });
  }
  if (service.role === 'admin') await admin.setRole(service.id, 'user');
  // Nadie más inicia sesión con esta cuenta: contraseña aleatoria que se descarta al terminar.
  const servicePassword = randomPassword();
  await admin.setPassword(SERVICE_USER, servicePassword);
  const serviceSession = await anon.login(SERVICE_USER, servicePassword);
  if (!serviceSession) throw new Error('la cuenta de servicio no pudo iniciar sesión');
  const apiKey = await anon.generateOwnApiKey(serviceSession);
  await anon.logout(serviceSession);
  await admin.setRole(service.id, 'admin');
  if (typeof apiKey !== 'string' || apiKey.length < 32) throw new Error('Shuffle no devolvió una API key');
  write('shuffle-apikey', `${apiKey}\n`);
  log('apikey_written', { user: SERVICE_USER });
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'respond_sso.bootstrap.failed', reason: error?.code ?? error?.message }));
  process.exit(1);
});
