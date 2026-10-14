import type { EnvironmentInput, RedisConfig } from '@qapaq/configuration';
import type { RedisOptions } from 'ioredis';

export declare function buildNotificationDrain(
  environment: EnvironmentInput,
  onDispatchError?: (error: unknown) => void,
): Promise<{
  drain(limit?: number): Promise<number>;
  close(): Promise<void>;
}>;

export declare const NOTIFICATION_DRAIN_JOB: string;
export declare const NOTIFICATION_QUEUE_NAME: string;

export type RedisConnectionRole = 'cache' | 'producer' | 'worker';
export declare function redisConnectionOptions(
  config: RedisConfig,
  role?: RedisConnectionRole,
): RedisOptions;
