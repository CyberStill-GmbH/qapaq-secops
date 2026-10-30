import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { RawObjectIntegrityError, type DurableRawStore } from './admission.js';
import { rawObjectKey } from './raw-object-key.js';

export interface S3RawStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle?: boolean;
  /** Permit cleartext only for an explicitly opted-in loopback test/development endpoint. */
  readonly allowInsecureLocalhost?: boolean;
  readonly maxAttempts?: number;
  readonly requestTimeoutMs?: number;
}

/** S3-compatible immutable object adapter; bucket lifecycle/encryption are provisioned out-of-band. */
export class S3RawStore implements DurableRawStore {
  readonly #client: S3Client;
  constructor(private readonly options: S3RawStoreOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch (error) {
      throw new Error('Invalid object-storage endpoint', { cause: error });
    }
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname);
    if (
      endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && options.allowInsecureLocalhost === true && loopback)
    )
      throw new Error('Object storage requires HTTPS except explicitly allowed loopback endpoints');
    if (!options.bucket || !options.accessKeyId || !options.secretAccessKey)
      throw new Error('Object storage bucket and credentials are required');
    const config: S3ClientConfig = {
      endpoint: endpoint.toString(),
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      maxAttempts: options.maxAttempts ?? 2,
    };
    this.#client = new S3Client(config);
  }

  async putIfAbsent(
    ref: string,
    bytes: Uint8Array,
    sha256: string,
  ): Promise<{ version?: string | null }> {
    const key = this.#key(ref);
    const existing = await this.#existingObject(key);
    if (existing) return this.#verifyMetadata(existing, sha256, bytes.byteLength);
    try {
      const result = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: bytes,
          ContentType: 'application/json',
          Metadata: { sha256 },
          IfNoneMatch: '*',
        }),
        this.#sendOptions(),
      );
      return result.VersionId === undefined ? {} : { version: result.VersionId };
    } catch (error) {
      if (
        !['PreconditionFailed', 'ConditionalRequestConflict'].includes(
          (error as { name?: string }).name ?? '',
        ) &&
        ![409, 412].includes(
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0,
        )
      )
        throw error;
      const raced = await this.#existingObject(key);
      if (!raced) throw error;
      return this.#verifyMetadata(raced, sha256, bytes.byteLength);
    }
  }

  async get(ref: string, maximumBytes: number): Promise<Uint8Array> {
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.#key(ref) }),
      this.#sendOptions(),
    );
    if (
      !response.Body ||
      response.ContentLength === undefined ||
      response.ContentLength > maximumBytes
    )
      throw new RawObjectIntegrityError('Raw object missing or exceeds configured limit');
    const result = await response.Body.transformToByteArray();
    if (result.byteLength > maximumBytes)
      throw new RawObjectIntegrityError('Raw object exceeds configured limit');
    return result;
  }

  close(): void {
    this.#client.destroy();
  }

  #sendOptions(): { abortSignal?: AbortSignal } {
    return this.options.requestTimeoutMs === undefined
      ? {}
      : { abortSignal: AbortSignal.timeout(this.options.requestTimeoutMs) };
  }

  async #existingObject(key: string) {
    try {
      return await this.#client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
        this.#sendOptions(),
      );
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (
        status === 404 ||
        ['NotFound', 'NoSuchKey'].includes((error as { name?: string }).name ?? '')
      )
        return null;
      throw error;
    }
  }

  #verifyMetadata(head: HeadObjectCommandOutput, sha256: string, size: number) {
    if (head.Metadata?.['sha256'] !== sha256 || head.ContentLength !== size)
      throw new RawObjectIntegrityError(
        'Existing raw object metadata does not match expected digest/size',
      );
    return head.VersionId === undefined ? {} : { version: head.VersionId };
  }

  #key(ref: string): string {
    return rawObjectKey(ref);
  }
}
