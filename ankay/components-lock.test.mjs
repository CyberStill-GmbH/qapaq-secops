import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const lock = JSON.parse(
  readFileSync(new URL('./azure-components.lock.json', import.meta.url), 'utf8'),
);

test('locks Shuffle and app_sdk to full source commits with declared licenses', () => {
  assert.match(lock.sources.shuffle.commit, /^[0-9a-f]{40}$/);
  assert.equal(lock.sources.shuffle.tag, 'v2.3.0');
  assert.equal(lock.sources.shuffle.license, 'AGPL-3.0');
  assert.match(lock.sources.appSdk.commit, /^[0-9a-f]{40}$/);
  assert.match(lock.sources.appSdk.fileSha256, /^[0-9a-f]{64}$/);
  assert.equal(lock.sources.appSdk.license, 'MIT');
  assert.equal(
    lock.sources.appSdk.fileSha256,
    'f4a0820309df6e2768ffb233ef4848051b62515da0864fca279c6f903bc877a5',
  );
});

test('runtime source checksum is computed from the pinned Git blob', () => {
  const buildScript = readFileSync(
    new URL('./build-runtime-components.sh', import.meta.url),
    'utf8',
  );
  assert.match(buildScript, /\.sources\.appSdk\.file'\s+"\$lock_file"/);
  assert.match(
    buildScript,
    /git -C "\$work_dir\/app-sdk" cat-file blob "\$app_sdk_sha:\$app_sdk_file"/,
  );
  assert.doesNotMatch(buildScript, /sha256sum "\$work_dir\/app-sdk\/shuffle_sdk\/shuffle_sdk\.py"/);
});

test('runtime component refs use immutable digests and linux/amd64 target', () => {
  assert.equal(lock.targetPlatform, 'linux/amd64');
  for (const image of Object.values(lock.buildBases)) assert.match(image, /@sha256:[0-9a-f]{64}$/);
  assert.match(lock.sources.opensearch.indexDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(lock.sources.opensearch.amd64Digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(lock.sources.opensearch.license, 'Apache-2.0');
  assert.deepEqual(
    Object.keys(lock.componentStatus).sort(),
    ['backend', 'frontend', 'opensearch', 'orborus', 'shuffle-security', 'worker'].sort(),
  );
});

test('unverified service sources remain blocked instead of receiving mutable tags', () => {
  for (const key of ['orborus', 'shuffleSecurity']) {
    assert.match(lock.sources[key].commit, /^[0-9a-f]{40}$/);
    assert.equal(lock.sources[key].license, 'NOASSERTION');
    assert.equal(lock.sources[key].status, 'blocked');
    assert.ok(lock.sources[key].reason.length > 20);
  }
  assert.equal(lock.componentStatus.orborus, 'blocked-license-review');
  assert.equal(
    lock.componentStatus['shuffle-security'],
    'blocked-license-and-compatibility-review',
  );
});

test('Shuffle OpenSearch connections keep certificate verification enabled', () => {
  const backendDockerfile = readFileSync(
    new URL('./runtime/Dockerfile.backend', import.meta.url),
    'utf8',
  );
  const workerDockerfile = readFileSync(
    new URL('./runtime/Dockerfile.worker', import.meta.url),
    'utf8',
  );
  const shared = lock.sources.shuffleShared;

  assert.equal(shared.module, 'github.com/shuffle/shuffle-shared');
  assert.equal(shared.version, 'v1.3.22');
  assert.equal(shared.sum, 'h1:Xb9EnYLyrhlP8AiH52Frst6iflIkbxyBmG/bntpRo5o=');
  assert.equal(shared.goModSum, 'h1:0vOWNn+aXibNcbjROmrgszm3/KirYtwzE5BuVnCzQVE=');
  assert.equal(shared.tlsContract.skipVerifyDefault, false);
  assert.equal(shared.tlsContract.certificateFileEnv, 'SHUFFLE_OPENSEARCH_CERTIFICATE_FILE');
  assert.equal(shared.tlsContract.certificateDirectoryEnv, 'SHUFFLE_CERT_DIR');
  assert.match(
    backendDockerfile,
    /SHUFFLE_OPENSEARCH_CERTIFICATE_FILE=\/run\/ankay\/opensearch-ca\/ca\.pem/,
  );
  for (const dockerfile of [backendDockerfile, workerDockerfile]) {
    assert.match(dockerfile, /SHUFFLE_CERT_DIR=\/run\/ankay\/opensearch-ca/);
    assert.doesNotMatch(dockerfile, /SHUFFLE_(?:OPENSEARCH_)?SKIPSSL_VERIFY\s*=\s*true/i);
  }
});

test('Ankay documents a read-only trusted CA mount for both runtime services', () => {
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.equal(
    readme.match(/\/var\/lib\/qapaq\/ankay\/opensearch-ca:\/run\/ankay\/opensearch-ca:ro/g)?.length,
    2,
  );
  assert.match(readme, /SHUFFLE_OPENSEARCH_CERTIFICATE_FILE/);
  assert.match(readme, /SHUFFLE_CERT_DIR/);
  assert.match(readme, /no declarar\s+Ankay listo para Terraform\/runtime/);
});
