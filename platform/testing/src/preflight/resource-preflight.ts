import os from 'node:os';
import { statfsSync } from 'node:fs';

export function resourcePreflight(
  profile: 'postgres' | 'base' | 'search' | 'wazuh' | 'full',
  repositoryRoot = process.cwd(),
) {
  const memoryGiB = Math.round(os.totalmem() / 1024 ** 3);
  const minimumGiB =
    profile === 'full'
      ? 16
      : profile === 'wazuh'
        ? 8
        : profile === 'search'
          ? 8
          : profile === 'postgres'
            ? 2
            : 3;
  const memoryCheck = {
    name: 'host-memory',
    status: memoryGiB >= minimumGiB ? ('PASS' as const) : ('BLOCKED' as const),
    detail: `${memoryGiB} GiB RAM; mínimo ${minimumGiB} GiB para ${profile}`,
  };
  let diskCheck: typeof memoryCheck;
  try {
    const stat = statfsSync(repositoryRoot);
    const diskGiB = (stat.bavail * stat.bsize) / 1024 ** 3;
    const minimumDiskGiB =
      profile === 'wazuh' || profile === 'full' ? 50 : profile === 'search' ? 20 : 5;
    diskCheck = {
      name: 'host-disk',
      status: diskGiB >= minimumDiskGiB ? ('PASS' as const) : ('BLOCKED' as const),
      detail: `${diskGiB.toFixed(1)} GiB libres; mínimo ${minimumDiskGiB} GiB para ${profile}`,
    };
  } catch {
    diskCheck = {
      name: 'host-disk',
      status: 'BLOCKED',
      detail: 'No se pudo verificar el espacio libre del workspace',
    };
  }
  const checks = [memoryCheck, diskCheck];
  return {
    status: checks.some((check) => check.status === 'BLOCKED')
      ? ('BLOCKED' as const)
      : ('PASS' as const),
    checks,
  };
}
