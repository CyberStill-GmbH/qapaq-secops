import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnvironmentEvidence } from './environment-evidence.js';

export async function writeEnvironmentEvidence(
  root: string,
  evidence: EnvironmentEvidence,
): Promise<string> {
  const directory = join(root, 'artifacts', 'integration', evidence.runId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'environment-evidence.json');
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}
