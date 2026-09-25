import { createHash } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface S3ProbeOptions {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
  readonly runId: string;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function verifyS3RoundTrip(options: S3ProbeOptions): Promise<void> {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKey,
      secretAccessKey: options.secretKey,
    },
    maxAttempts: 1,
  });
  const key = `c06/${options.runId}/probe.json`;
  const payload = Buffer.from(JSON.stringify({ runId: options.runId, probe: 'c06' }));
  const expectedHash = sha256(payload);
  let bucketCreated = false;
  let objectCreated = false;
  try {
    await client.send(new CreateBucketCommand({ Bucket: options.bucket }));
    bucketCreated = true;
    await client.send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: payload,
        Metadata: { sha256: expectedHash },
      }),
    );
    objectCreated = true;

    const head = await client.send(
      new HeadObjectCommand({ Bucket: options.bucket, Key: key }),
    );
    if (head.Metadata?.['sha256'] !== expectedHash)
      throw new Error('S3 HeadObject: metadata SHA-256 no coincide');
    if (head.ContentLength !== payload.length)
      throw new Error('S3 HeadObject: tamaño no coincide');

    const get = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
    if (!get.Body) throw new Error('S3 GetObject: respuesta sin contenido');
    const stored = Buffer.from(await get.Body.transformToByteArray());
    if (!stored.equals(payload) || sha256(stored) !== expectedHash)
      throw new Error('S3 GetObject: contenido o SHA-256 no coincide');

    await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    objectCreated = false;
    await client.send(new DeleteBucketCommand({ Bucket: options.bucket }));
    bucketCreated = false;
  } catch (error) {
    if (error instanceof Error && /^(S3 |S3 )/u.test(error.message)) throw error;
    const name = error instanceof Error ? error.name : 'S3Error';
    throw new Error(`S3 CRUD: ${name}`);
  } finally {
    if (objectCreated)
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key })).catch(() => undefined);
    if (bucketCreated)
      await client.send(new DeleteBucketCommand({ Bucket: options.bucket })).catch(() => undefined);
    client.destroy();
  }
}
