import type {
  IntegrationProfile,
  IntegrationImageLock,
} from '../environment/environment-options.js';
import type { IntegrationEnvironmentState } from '../environment/environment-state.js';
import type { PreflightReport } from '../preflight/preflight-report.js';
import type { HealthResult } from '../health/health-result.js';

export interface EnvironmentEvidence {
  readonly runId: string;
  readonly projectCommit: string;
  readonly workingTreeDirty: boolean;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly profile: IntegrationProfile;
  readonly state: IntegrationEnvironmentState;
  readonly images: IntegrationImageLock;
  readonly preflight?: PreflightReport;
  readonly health: readonly HealthResult[];
  readonly cleanup: {
    readonly status: 'PENDING' | 'PASS' | 'FAIL';
    readonly remainingOwnedResources: readonly string[];
  };
  readonly result: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
}

export function redactEvidence<T>(value: T): T {
  const text = JSON.stringify(value).replace(
    /(password|secret|token|access[_-]?key|connection|string|private[_-]?key)"?\s*:\s*"[^"]*"/giu,
    '$1":"[REDACTED]"',
  );
  return JSON.parse(text) as T;
}
