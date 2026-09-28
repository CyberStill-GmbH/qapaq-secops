export type {
  EventPage,
  EventQuery,
  JsonObject,
  JsonValue,
  ProviderComponentHealth,
  ProviderErrorCode,
  ProviderHealth,
  ProviderRecord,
  SecurityEventProvider,
  SourceCapabilities,
} from '../application/security-event-provider.js';
export { SecurityEventProviderError } from '../application/security-event-provider.js';
export {
  createWazuhSecurityEventProvider,
  type WazuhProviderConfiguration,
} from '../infrastructure/wazuh/wazuh-provider.factory.js';
