export type IntegrationEnvironmentState =
  | 'created'
  | 'preflight_passed'
  | 'starting'
  | 'healthy'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'blocked';
