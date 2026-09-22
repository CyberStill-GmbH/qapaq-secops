import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { root, fixtureToken } from './support.mjs';

const cwd = resolve(root, 'apps/web');
const require = createRequire(resolve(cwd, 'package.json'));
const env = {
  ...process.env,
  VITE_PUBLIC_BASE_PATH: '/',
  SECRET_TOKEN: fixtureToken,
  VITE_PRIVATE_PASSWORD: fixtureToken,
  VITE_ACCESS_KEY: fixtureToken,
  VITE_PRIVATE_CA: `-----BEGIN PRIVATE KEY-----${fixtureToken}`,
  VITE_PRIVATE_URL: `https://user:${fixtureToken}@example.test`,
  QAPAQ_POSTGRES_PASSWORD_REF: `secret://test/${fixtureToken}`,
};

for (const args of [
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit'],
  [resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'],
]) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  if (code !== 0) {
    process.exitCode = 1;
    break;
  }
}
