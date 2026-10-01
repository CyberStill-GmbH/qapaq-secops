export {
  classifyHttpStatus,
  classifyTransportError,
  FAILURE_CLASSES,
  nextDelayMs,
  RETRY_POLICY,
  shouldRetry,
  type DeliveryFailure,
  type FailureClass,
} from './delivery-policy.js';
export {
  ACKNOWLEDGEMENT_ERROR_CODES,
  acknowledge,
  clientRequestIdFor,
  createAttempt,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  type AcknowledgementErrorCode,
  type AcknowledgementResult,
  type NotificationAttempt,
  type NotificationChannel,
  type NotificationStatus,
} from './notification.js';
export {
  buildTeamsMessage,
  FORBIDDEN_PAYLOAD_KEYS,
  TEAMS_PAYLOAD_VERSION,
  type CriticalNotificationInput,
  type TeamsMessage,
} from './teams-payload.js';
export {
  TeamsWorkflowTransport,
  type DeliveryOutcome,
  type NotificationTransport,
  type TeamsTransportOptions,
} from './teams-adapter.js';
export {
  DISPATCH_RESULTS,
  dispatchMessage,
  drainOutbox,
  type DispatchDependencies,
  type DispatchResult,
  type DispatchResultCode,
} from './dispatcher.js';
export { ConsoleFallbackChannel, InMemoryAttemptStore, InMemoryOutbox } from './memory-stores.js';
export type { AttemptStore, FallbackChannel, FallbackNotification, OutboxReader } from './ports.js';
