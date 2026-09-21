export interface ServiceHealth {
  readonly service: string;
  readonly status: 'ok' | 'degraded' | 'failed';
}

export interface SourceCoverage {
  readonly sourceId: string;
  readonly observedAt: string;
  readonly status: 'current' | 'lagging' | 'unavailable';
}
