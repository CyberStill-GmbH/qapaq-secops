import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

type DockerProfile = 'postgres' | 'base' | 'search' | 'wazuh' | 'full';
type DockerPreflightReport = {
  status: 'PASS' | 'BLOCKED';
  checks: { name: string; status: 'PASS' | 'BLOCKED'; detail: string }[];
};

const probesInFlight = new Map<DockerProfile, Promise<DockerPreflightReport>>();

async function runDockerPreflight(profile: DockerProfile): Promise<DockerPreflightReport> {
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
      profile === 'full'
        ? 16
        : profile === 'wazuh'
          ? 8
          : profile === 'search'
            ? 8
            : profile === 'postgres'
              ? 2
              : 3;
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
        detail: `${((info.MemTotal ?? 0) / 1024 ** 3).toFixed(2)} GiB disponibles para Docker; mínimo ${minimumGiB} GiB para ${profile}`,
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

/** Coalesces concurrent Docker Desktop probes without caching a stale result. */
export function dockerPreflight(profile: DockerProfile = 'base'): Promise<DockerPreflightReport> {
  const existing = probesInFlight.get(profile);
  if (existing) return existing;
  const probe = runDockerPreflight(profile).finally(() => probesInFlight.delete(profile));
  probesInFlight.set(profile, probe);
  return probe;
}
