export type PreflightStatus = 'PASS' | 'FAIL' | 'BLOCKED';

export interface PreflightCheck {
  readonly name: string;
  readonly status: PreflightStatus;
  readonly detail: string;
}

export interface PreflightReport {
  readonly status: PreflightStatus;
  readonly checks: readonly PreflightCheck[];
  readonly generatedAt: string;
}

export function reportStatus(checks: readonly PreflightCheck[]): PreflightStatus {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  return 'PASS';
}
