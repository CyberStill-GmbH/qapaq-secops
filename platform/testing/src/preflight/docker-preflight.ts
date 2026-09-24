import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function dockerPreflight(
  profile: 'postgres' | 'base' | 'search' | 'wazuh' | 'full' = 'base',
): Promise<{
  status: 'PASS' | 'BLOCKED';
  checks: { name: string; status: 'PASS' | 'BLOCKED'; detail: string }[];
}> {
  try {
    const { stdout } = await exec('docker', ['info', '--format', '{{json .}}'], {
      timeout: 45_000,
    });
    const info = JSON.parse(stdout) as {
      ServerVersion?: string;
      NCPU?: number;
      MemTotal?: number;
      Architecture?: string;
    };
    const memoryGiB = Math.round((info.MemTotal ?? 0) / 1024 ** 3);
    const minimumGiB =
      profile === 'wazuh' || profile === 'full'
        ? 16
        : profile === 'search'
          ? 8
          : profile === 'postgres'
            ? 2
            : 4;
    const architecture = info.Architecture ?? 'desconocida';
    const checks: { name: string; status: 'PASS' | 'BLOCKED'; detail: string }[] = [
      {
        name: 'docker-daemon',
        status: 'PASS' as const,
        detail: `Docker ${info.ServerVersion ?? 'desconocido'}`,
      },
      { name: 'arquitectura', status: 'PASS', detail: architecture },
      {
        name: 'cpu',
        status: (info.NCPU ?? 0) >= 2 ? ('PASS' as const) : ('BLOCKED' as const),
        detail: `${info.NCPU ?? 0} CPU`,
      },
      {
        name: 'memoria',
        status: memoryGiB >= minimumGiB ? ('PASS' as const) : ('BLOCKED' as const),
        detail: `${memoryGiB} GiB disponibles para Docker; mínimo ${minimumGiB} GiB para ${profile}`,
      },
    ];
    return {
      status: checks.some((check) => check.status === 'BLOCKED') ? 'BLOCKED' : 'PASS',
      checks,
    };
  } catch (error) {
    const detail =
      error instanceof Error
        ? (error.message.split('\n')[0] ?? error.message)
        : 'Docker no está disponible';
    return { status: 'BLOCKED', checks: [{ name: 'docker-daemon', status: 'BLOCKED', detail }] };
  }
}
