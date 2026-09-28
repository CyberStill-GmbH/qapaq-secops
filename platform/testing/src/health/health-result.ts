export interface HealthResult {
  readonly service: string;
  readonly healthy: boolean;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly detail: string;
}
