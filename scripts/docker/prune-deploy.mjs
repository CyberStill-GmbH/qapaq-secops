import { readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const deployment = resolve(process.argv[2] ?? '');
if (!process.argv[2] || deployment === resolve('/')) {
  throw new Error('A deployment directory is required.');
}

const removableDirectories = [
  'src',
  'test',
  'tests',
  'scripts',
  'coverage',
  'playwright-report',
  'test-results',
];

async function pruneWorkspacePackage(packagePath) {
  const entries = await readdir(packagePath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (
        (entry.isDirectory() && removableDirectories.includes(entry.name)) ||
        (entry.isFile() && /^tsconfig(?:\..+)?\.json$/u.test(entry.name)) ||
        (entry.isFile() && entry.name.endsWith('.tsbuildinfo'))
      ) {
        await rm(join(packagePath, entry.name), { recursive: true, force: true });
      }
    }),
  );
}

await pruneWorkspacePackage(deployment);

const virtualStore = join(deployment, 'node_modules', '.pnpm');
for (const snapshot of await readdir(virtualStore, { withFileTypes: true })) {
  if (!snapshot.isDirectory()) continue;
  const workspaceScope = join(virtualStore, snapshot.name, 'node_modules', '@qapaq');
  let packages;
  try {
    packages = await readdir(workspaceScope, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
    throw error;
  }

  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const packagePath = join(workspaceScope, entry.name);
    const manifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
    if (typeof manifest.name === 'string' && manifest.name.startsWith('@qapaq/')) {
      await pruneWorkspacePackage(packagePath);
    }
  }
}
