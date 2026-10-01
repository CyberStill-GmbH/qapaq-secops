export interface ServiceHealth {
  readonly service: string;
  readonly status: 'ok' | 'degraded' | 'failed';
}

export interface SourceCoverage {
  readonly sourceId: string;
  readonly observedAt: string;
  readonly status: 'current' | 'lagging' | 'unavailable';
}

export * from './security-event/index.js';

export * from './api-error/index.js';
