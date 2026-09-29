import { describe, expect, it } from 'vitest';
import { S3RawStore } from '../src/s3-raw-store.js';

const base = {
  region: 'us-east-1',
  bucket: 'raw-test',
  accessKeyId: 'test-access',
  secretAccessKey: 'test-secret',
};

describe('S3RawStore transport security', () => {
  it('rejects cleartext except for an explicitly enabled loopback endpoint', () => {
    expect(() => new S3RawStore({ ...base, endpoint: 'http://object-store.internal' })).toThrow(
      /HTTPS/u,
    );
    expect(
      () => new S3RawStore({ ...base, endpoint: 'http://10.0.0.12', allowInsecureLocalhost: true }),
    ).toThrow(/HTTPS/u);
    expect(
      () =>
        new S3RawStore({
          ...base,
          endpoint: 'http://127.0.0.1:9000',
          allowInsecureLocalhost: true,
        }),
    ).not.toThrow();
  });

  it('accepts TLS endpoints without a development exception', () => {
    const store = new S3RawStore({ ...base, endpoint: 'https://objects.example.test' });
    store.close();
  });
});
