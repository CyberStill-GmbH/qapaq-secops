import os from 'node:os';

export function resourcePreflight(profile: 'postgres' | 'base' | 'search' | 'wazuh' | 'full') {
  const memoryGiB = Math.round(os.totalmem() / 1024 ** 3);
  const minimumGiB =
    profile === 'wazuh' || profile === 'full'
      ? 16
      : profile === 'search'
        ? 8
        : profile === 'postgres'
          ? 2
          : 4;
  const check = {
    name: 'host-resources',
    status: memoryGiB >= minimumGiB ? ('PASS' as const) : ('BLOCKED' as const),
    detail: `${memoryGiB} GiB RAM; mínimo ${minimumGiB} GiB para ${profile}`,
  };
  return { status: check.status, checks: [check] };
}
