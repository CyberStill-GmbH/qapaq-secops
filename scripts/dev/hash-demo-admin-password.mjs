#!/usr/bin/env node
/**
 * Genera el hash scrypt de la contraseña de la excepción demo del administrador
 * (`QAPAQ_DEMO_ADMIN_PASSWORD_HASH`, docs/04-identidad-y-acceso.md).
 *
 * Uso:
 *   node scripts/dev/hash-demo-admin-password.mjs            # pide la contraseña dos veces, sin eco
 *   printf '%s' "$PASSWORD" | node scripts/dev/hash-demo-admin-password.mjs   # desde stdin
 *
 * Imprime SOLO el hash en stdout. La contraseña nunca se acepta como argumento (quedaría en el
 * historial de la shell y en la lista de procesos) ni se imprime. Política mínima: 14 caracteres.
 *
 * Formato (autodescrito, estilo PHC): `$scrypt$ln=16,r=8,p=1$<sal base64>$<clave base64>`, con
 * N = 2^16, sal aleatoria de 16 bytes y clave de 32 bytes. El API lo valida al arrancar
 * (apps/api/src/access/demo-admin-credentials.ts) y rechaza cualquier otro formato o parámetros
 * más débiles que N = 2^15.
 */

import { randomBytes, scrypt } from 'node:crypto';
import { stdin, stdout, stderr, argv, exit } from 'node:process';

const MIN_LENGTH = 14;
const MAX_LENGTH = 256;
const LOG_N = 16;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function fail(message) {
  stderr.write(`${message}\n`);
  exit(1);
}

function policyViolation(password) {
  const length = [...password.normalize('NFC')].length;
  if (length < MIN_LENGTH) return `La contraseña debe tener al menos ${MIN_LENGTH} caracteres.`;
  if (length > MAX_LENGTH) return `La contraseña no puede superar ${MAX_LENGTH} caracteres.`;
  if (password.trim() !== password)
    return 'La contraseña no puede empezar ni terminar en espacios.';
  return undefined;
}

/** Lee una línea del terminal sin eco (modo raw). */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    stderr.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          stderr.write('\n');
          reject(new Error('Cancelado.'));
          return;
        }
        if (character === '\r' || character === '\n' || character === '\u0004') {
          cleanup();
          stderr.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        value += character;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

async function readPiped() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  // Un salto de línea final es del `echo`, no de la contraseña.
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/u, '');
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password.normalize('NFC'), 'utf8'),
      salt,
      KEY_BYTES,
      { N: 2 ** LOG_N, r: R, p: P, maxmem: 2 * 128 * 2 ** LOG_N * R },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

async function main() {
  if (argv.length > 2) {
    fail('No pase la contraseña como argumento: se lee por stdin o por el prompt sin eco.');
  }
  let password;
  if (stdin.isTTY) {
    password = await promptHidden('Contraseña del administrador demo: ');
    const confirmation = await promptHidden('Repita la contraseña: ');
    if (password !== confirmation) fail('Las contraseñas no coinciden.');
  } else {
    password = await readPiped();
  }
  const violation = policyViolation(password);
  if (violation) fail(violation);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  const encode = (value) => value.toString('base64').replace(/=+$/u, '');
  stdout.write(`$scrypt$ln=${LOG_N},r=${R},p=${P}$${encode(salt)}$${encode(key)}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : 'Error inesperado.'));
