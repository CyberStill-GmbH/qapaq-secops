export { canonicalize, CanonicalizationError, type CanonicalValue } from './canonical-json.js';
export {
  auditDigestInput,
  auditHash,
  AUDIT_ACTOR_TYPES,
  AUDIT_CHAIN_GENESIS,
  AUDIT_DRAFT_ERROR_CODES,
  AUDIT_HASH_ALGORITHM,
  AUDIT_LIMITS,
  AUDIT_OUTCOMES,
  AuditDraftError,
  sealAuditEvent,
  type AuditActor,
  type AuditActorType,
  type AuditChainHead,
  type AuditDraftErrorCode,
  type AuditEventDraft,
  type AuditOutcome,
  type AuditResource,
  type SealedAuditEvent,
} from './audit-event.js';
export {
  CHAIN_VIOLATIONS,
  verifyChain,
  type ChainVerification,
  type ChainViolation,
  type ChainViolationCode,
  type VerifyOptions,
} from './hash-chain.js';
export {
  AUDIT_QUERY_ERROR_CODES,
  AUDIT_QUERY_LIMITS,
  AUDIT_READ,
  AUDIT_READ_SENSITIVE,
  AUDIT_VERIFY,
  planAuditQuery,
  projectAuditEvent,
  REDACTED,
  type AuditProjection,
  type AuditQuery,
  type AuditQueryErrorCode,
  type AuditQueryPlan,
  type AuditReaderContext,
  type RawAuditQuery,
} from './audit-query.js';
export {
  AUDIT_APPEND_MAX_ATTEMPTS,
  AuditAppendExhaustedError,
  recordAudit,
} from './audit-writer.js';
export { AuditArchiveError, FileAuditArchive, type AuditArchiveErrorCode } from './file-archive.js';
export { AuditAppendConflictError, InMemoryAuditStore } from './memory-store.js';
export {
  RECONCILIATION_FINDINGS,
  reconcileAudit,
  type ReconcileOptions,
  type ReconciliationFinding,
  type ReconciliationFindingCode,
  type ReconciliationReport,
} from './reconciliation.js';
export type { AuditArchive, AuditArchiveSegmentRef, AuditStore } from './ports.js';
