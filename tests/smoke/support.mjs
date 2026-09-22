import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const fixtureToken = 'c02-fixture-value';
// WSL puede tardar más de 50 segundos en cargar Nest desde node_modules en un disco Windows montado.
// Esta opción solo amplía la observación del arranque, nunca el límite de cierre.
export const startupTimeout = process.env['C02_SMOKE_SLOW_FILESYSTEM'] === '1' ? 90_000 : 10_000;
export const root = fileURLToPath(new URL('../../', import.meta.url));

export function startProcess(args, overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(QAPAQ_|VITE_|NODE_OPTIONS$)/u.test(key)),
  );
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, SECRET_TOKEN: fixtureToken, QAPAQ_PROFILE: 'test', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let output = '';
  let port;
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  child.on('message', (message) => {
    if (typeof message?.port === 'number') port = message.port;
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    get output() {
      return output;
    },
    get port() {
      return port;
    },
  };
}

export function startApp(name, environment) {
  return startProcess(
    ['--import', './tests/smoke/process-observer.mjs', `apps/${name}/dist/main.js`],
    environment,
  );
}

export async function until(predicate, label, timeout = startupTimeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function exitedWithin(runtime, timeout = 8_000) {
  let timer;
  try {
    return await Promise.race([
      runtime.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Process did not exit in time')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function signal(runtime, value = 'SIGTERM') {
  if (process.platform === 'win32') runtime.child.send({ signal: value });
  else runtime.child.kill(value);
}

export async function cleanup(runtime) {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null)
    runtime.child.kill('SIGKILL');
  await exitedWithin(runtime);
  assert.equal(runtime.child.exitCode !== null || runtime.child.signalCode !== null, true);
}

export function events(runtime) {
  return runtime.output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function assertSafe(runtime) {
  assert.ok(!runtime.output.includes(fixtureToken));
  assert.ok(!runtime.output.includes('synthetic-private-fault'));
  for (const item of events(runtime)) {
    assert.ok(
      Object.keys(item).every((key) =>
        ['service', 'profile', 'event', 'timestamp', 'errorCode'].includes(key),
      ),
    );
  }
}
