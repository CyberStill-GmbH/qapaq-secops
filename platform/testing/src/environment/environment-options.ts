export type IntegrationProfile = 'base' | 'search' | 'wazuh' | 'full';

export interface IntegrationEnvironmentOptions {
  readonly profile?: IntegrationProfile;
  readonly repositoryRoot?: string;
  readonly keepEnvironment?: boolean;
  readonly timeouts?: Partial<IntegrationTimeouts>;
}

export interface IntegrationTimeouts {
  readonly preflightMs: number;
  readonly startupMs: number;
  readonly healthMs: number;
  readonly pollMs: number;
}

export const defaultTimeouts: IntegrationTimeouts = {
  preflightMs: 15_000,
  startupMs: 180_000,
  healthMs: 120_000,
  pollMs: 500,
};

export interface ServiceImageLock {
  readonly image: string;
  readonly version: string;
  readonly digest: string | null;
}

export interface IntegrationImageLock {
  readonly postgres: ServiceImageLock;
  readonly redis: ServiceImageLock;
  readonly minio: ServiceImageLock;
  readonly opensearch: ServiceImageLock;
  readonly wazuhManager: ServiceImageLock;
  readonly wazuhIndexer: ServiceImageLock;
}

export const imageLock: IntegrationImageLock = {
  postgres: { image: 'postgres', version: '18.6', digest: null },
  redis: { image: 'redis', version: '8.10.1', digest: null },
  minio: { image: 'quay.io/minio/minio', version: 'RELEASE.2025-09-07T16-13-09Z', digest: null },
  opensearch: { image: 'opensearchproject/opensearch', version: '3.7.0', digest: null },
  wazuhManager: { image: 'wazuh/wazuh-manager', version: '4.14.7', digest: null },
  wazuhIndexer: { image: 'wazuh/wazuh-indexer', version: '4.14.7', digest: null },
};

export function resolveOptions(options: IntegrationEnvironmentOptions = {}) {
  const keepEnvironment = options.keepEnvironment ?? process.env['KEEP_TEST_ENV'] === '1';
  if (keepEnvironment && process.env['CI'] === 'true') {
    throw new Error('KEEP_TEST_ENV está prohibido en CI');
  }
  return {
    profile: options.profile ?? 'base',
    repositoryRoot: options.repositoryRoot ?? process.cwd(),
    keepEnvironment,
    timeouts: { ...defaultTimeouts, ...options.timeouts },
  } as const;
}
