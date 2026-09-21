export interface ApiConfig {
  readonly host: string;
  readonly port: number;
}

export interface WorkerConfig {
  readonly redisUrl: URL;
}

const requirePort = (value: string | undefined, name: string, fallback?: number): number => {
  const resolved = value ?? (fallback === undefined ? undefined : String(fallback));
  const port = Number(resolved);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
};

const requireUrl = (value: string | undefined, name: string, protocols: readonly string[]): URL => {
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use one of: ${protocols.join(', ')}`);
  }
  return parsed;
};

export const loadApiConfig = (environment: NodeJS.ProcessEnv): ApiConfig => ({
  host: environment['API_HOST'] ?? '127.0.0.1',
  port: requirePort(environment['API_PORT'], 'API_PORT', 3000),
});

export const loadWorkerConfig = (environment: NodeJS.ProcessEnv): WorkerConfig => ({
  redisUrl: requireUrl(environment['REDIS_URL'], 'REDIS_URL', ['redis:', 'rediss:']),
});
