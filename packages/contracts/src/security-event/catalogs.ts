export const SECURITY_EVENT_SCHEMA_VERSION = '1.0.0' as const;
export const SUPPORTED_SECURITY_EVENT_VERSIONS = [SECURITY_EVENT_SCHEMA_VERSION] as const;

export const SECURITY_EVENT_KINDS = ['event', 'alert', 'finding', 'state'] as const;
export const EVENT_UID_TYPES = ['native', 'transport', 'derived'] as const;
export const NORMALIZED_SEVERITIES = [
  'unknown',
  'informational',
  'low',
  'medium',
  'high',
  'critical',
] as const;
export const SECURITY_EVENT_CATEGORIES = [
  'authentication',
  'iam',
  'network',
  'intrusion_detection',
  'malware',
  'host',
  'file',
  'process',
  'configuration',
  'email',
  'web',
  'vulnerability',
  'threat',
  'api',
  'database',
  'unclassified',
] as const;
export const SECURITY_EVENT_OUTCOMES = ['success', 'failure', 'unknown'] as const;
export const SECURITY_EVENT_SOURCE_KINDS = [
  'siem',
  'identity',
  'email',
  'endpoint',
  'network',
  'cloud',
  'application',
  'database',
  'other',
] as const;
export const TIMESTAMP_QUALITIES = ['source', 'derived', 'estimated'] as const;

export const SECURITY_EVENT_LIMITS = Object.freeze({
  extensionBytes: 16 * 1024,
  extensionDepth: 4,
  extensionProperties: 64,
  extensionArrayItems: 64,
  extensionKeyLength: 128,
  extensionStringLength: 4096,
  extensionNamespaces: 16,
  normalizedEventBytes: 256 * 1024,
  rawSizeBytes: 256 * 1024,
} as const);

export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];
export type EventUidType = (typeof EVENT_UID_TYPES)[number];
export type NormalizedSeverity = (typeof NORMALIZED_SEVERITIES)[number];
export type SecurityEventCategory = (typeof SECURITY_EVENT_CATEGORIES)[number];
export type SecurityEventOutcome = (typeof SECURITY_EVENT_OUTCOMES)[number];
export type SecurityEventSourceKind = (typeof SECURITY_EVENT_SOURCE_KINDS)[number];
export type TimestampQuality = (typeof TIMESTAMP_QUALITIES)[number];
