#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const prettierCli = require.resolve('prettier/bin/prettier.cjs');

function git(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function resolveBase() {
  const candidates = [
    process.env.FORMAT_BASE_SHA,
    'main',
    'refs/remotes/origin/main',
    'HEAD^',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (/^0+$/.test(candidate)) continue;
    const result = git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
      allowFailure: true,
    });
    if (result.status === 0) return result.stdout.trim();
  }
  throw new Error('No valid format baseline found. Set FORMAT_BASE_SHA to the base commit.');
}

const base = resolveBase();
const changed = git(['diff', '--name-only', '--diff-filter=ACMR', '-z', `${base}...HEAD`], {
  encoding: 'buffer',
})
  .stdout.toString('utf8')
  .split('\0')
  .filter(Boolean);
const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
  encoding: 'buffer',
})
  .stdout.toString('utf8')
  .split('\0')
  .filter(Boolean);
changed.push(...staged);

if (process.argv.includes('--include-working-tree')) {
  const workingTree = git(['diff', '--name-only', '--diff-filter=ACMR', '-z', 'HEAD'], {
    encoding: 'buffer',
  })
    .stdout.toString('utf8')
    .split('\0')
    .filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'buffer',
  })
    .stdout.toString('utf8')
    .split('\0')
    .filter(Boolean);
  changed.push(...workingTree, ...untracked);
}

const files = [...new Set(changed)].sort();
if (files.length === 0) {
  console.log('Prettier check: no changed files relative to the selected baseline.');
  process.exit(0);
}

console.log(`Checking Prettier for ${files.length} changed file(s) since ${base.slice(0, 12)}.`);
const chunkSize = 80;
for (let index = 0; index < files.length; index += chunkSize) {
  const chunk = files.slice(index, index + chunkSize);
  const result = spawnSync(
    process.execPath,
    [prettierCli, '--check', '--ignore-unknown', ...chunk],
    { cwd: root, encoding: 'utf8', stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
