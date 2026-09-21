/* Este archivo se genera desde security-event.schema.json. No editar manualmente. */

/**
 * Contrato canónico de eventos de seguridad de QAPAQ SecOps.
 */
export type QapaqSecurityEvent = {
  schemaVersion: '1.0.0';
  recordId: UuidV7;
  eventUid: OpaqueIdentifier;
  eventUidType: 'native' | 'transport' | 'derived';
  kind: 'event' | 'alert' | 'finding' | 'state';
  occurredAt: UtcTimestamp;
  observedAt: UtcTimestamp;
  receivedAt: UtcTimestamp;
  source: Source;
  tenant: Tenant;
  severity: Severity;
  /**
   * @minItems 1
   * @maxItems 16
   */
  category: [
    (
      | 'authentication'
      | 'iam'
      | 'network'
      | 'intrusion_detection'
      | 'malware'
      | 'host'
      | 'file'
      | 'process'
      | 'configuration'
      | 'email'
      | 'web'
      | 'vulnerability'
      | 'threat'
      | 'api'
      | 'database'
      | 'unclassified'
    ),
    ...(
      | 'authentication'
      | 'iam'
      | 'network'
      | 'intrusion_detection'
      | 'malware'
      | 'host'
      | 'file'
      | 'process'
      | 'configuration'
      | 'email'
      | 'web'
      | 'vulnerability'
      | 'threat'
      | 'api'
      | 'database'
      | 'unclassified'
    )[],
  ];
  outcome: 'success' | 'failure' | 'unknown';
  action?: string;
  entities: Entities;
  detection?: Detection;
  raw: Raw;
  provenance: Provenance;
  extensions?: Extensions;
};
export type UuidV7 = string;
export type OpaqueIdentifier = string;
export type UtcTimestamp = string;
export type ShortText = string;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [k: string]: JsonValue;
    };

export interface Source {
  kind:
    | 'siem'
    | 'identity'
    | 'email'
    | 'endpoint'
    | 'network'
    | 'cloud'
    | 'application'
    | 'database'
    | 'other';
  vendor: ShortText;
  product: ShortText;
  dataset: ShortText;
  instanceId: OpaqueIdentifier;
  nativeEventId?: OpaqueIdentifier;
}
export interface Tenant {
  id: OpaqueIdentifier;
}
export interface Severity {
  normalized: 'unknown' | 'informational' | 'low' | 'medium' | 'high' | 'critical';
  score?: number;
  originalValue: string | number;
  originalLabel: string;
  originalScale: string;
  mappingId: string;
  mappingVersion: string;
}
export interface Entities {
  /**
   * @maxItems 64
   */
  identities: Identity[];
  /**
   * @maxItems 64
   */
  resources: Resource[];
}
export interface Identity {
  kind: string;
  id?: OpaqueIdentifier;
  name?: ShortText;
  principal?: string;
  domain?: string;
}
export interface Resource {
  kind: string;
  id?: OpaqueIdentifier;
  name?: ShortText;
  type?: string;
}
export interface Detection {
  rule: DetectionRule;
}
export interface DetectionRule {
  id: OpaqueIdentifier;
  name: ShortText;
  version?: string;
  provider: ShortText;
  /**
   * @maxItems 32
   */
  groups: string[];
}
export interface Raw {
  ref: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
}
export interface Provenance {
  connector: ShortText;
  connectorVersion: ShortText;
  parserVersion: ShortText;
  mappingVersion: ShortText;
  timestampQuality: 'source' | 'derived' | 'estimated';
  /**
   * @minItems 1
   * @maxItems 16
   */
  ingestionPath: [IngestionHop, ...IngestionHop[]];
}
export interface IngestionHop {
  kind: 'origin' | 'collector' | 'adapter';
  vendor: ShortText;
  product: ShortText;
  instanceId?: OpaqueIdentifier;
}
export interface Extensions {
  [k: string]: JsonValue;
}
