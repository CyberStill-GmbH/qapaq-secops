import { randomUUID } from 'node:crypto';

export function createTestRunId(): string {
  return `c06-${randomUUID()}`;
}

export function resourceName(runId: string, suffix: string): string {
  return `${runId}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
