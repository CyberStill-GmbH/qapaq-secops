/** Stable, provider-neutral C-04 command DTO. No Prisma types cross this boundary. */
export interface RawObjectProof {
  readonly id: string;
  readonly objectRef: string;
  readonly objectVersion?: string | null;
  readonly sha256: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly receivedAt: Date;
}

export interface AdmissionQuarantine {
  readonly id: string;
  readonly errorCode: string;
  readonly errorPath?: string | null;
  readonly contractVersion?: string | null;
  readonly parserVersion?: string | null;
}

export interface AdmissionEvent {
  readonly id: string;
  readonly recordId: string;
  readonly providerEventId?: string | null;
  readonly idempotencyKey: string;
  readonly rawReferenceId: string;
  readonly quarantine?: AdmissionQuarantine | null;
}

export interface AdmissionCommand {
  readonly sourceId: string;
  readonly dataset: string;
  readonly manifestKey: string;
  readonly manifestId: string;
  readonly outboxId: string;
  readonly messageId: string;
  readonly outboxIdempotencyKey: string;
  readonly events: readonly AdmissionEvent[];
  readonly newRawObjects: readonly RawObjectProof[];
  readonly receivedAt: Date;
  readonly expectedRevision?: bigint;
  readonly cursor?: {
    readonly from: string | null;
    readonly to: string;
    readonly version: string;
    readonly sourceGeneration?: string | null;
    readonly lastOccurredAt?: Date | null;
    readonly lastTieBreaker?: string | null;
  } | null;
}

export interface AdmissionReceipt {
  readonly manifestId: string;
  readonly eventCount: number;
  readonly acceptedCount: number;
  readonly quarantinedCount: number;
  readonly duplicateCount: 0;
  readonly checkpointRevision: bigint | null;
}
