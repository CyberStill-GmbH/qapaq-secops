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
  assert.equal(
    lock.buildBases.golang1273Alpine323,
    'docker.io/library/golang:1.27.3-alpine3.23@sha256:7fd63dd7c37f5ddaef15bd8fd3f3e4f90f0d50cd9cae255c7cf73887a494d8df',
  );
  assert.equal(
    lock.buildBases.alpine3226,
    'docker.io/library/alpine:3.22.6@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8',
  );
  assert.deepEqual(
    Object.keys(lock.componentStatus).sort(),
    ['backend', 'frontend', 'opensearch', 'orborus', 'shuffle-security', 'worker'].sort(),
  );
});

test('runtime Dockerfiles receive both pinned build bases before the first FROM', () => {
  for (const name of ['backend', 'worker']) {
    const dockerfile = readFileSync(
      new URL(`./runtime/Dockerfile.${name}`, import.meta.url),
      'utf8',
    );
    const firstFrom = dockerfile.indexOf('\nFROM ');
    assert.ok(firstFrom > 0, `${name} has a first FROM instruction`);
    const globalArgs = dockerfile.slice(0, firstFrom);
    assert.match(globalArgs, /^ARG GO_BUILDER_IMAGE\s*\nARG ALPINE_RUNTIME_IMAGE\s*$/);
    assert.match(dockerfile, /FROM \$\{GO_BUILDER_IMAGE\} AS builder/);
    assert.match(dockerfile, /FROM \$\{ALPINE_RUNTIME_IMAGE\}/);
    assert.match(dockerfile, /RUN go mod download\s*\n/);
  }
});

test('runtime components use a fixed non-root identity with only backend generation writable', () => {
  const backend = readFileSync(new URL('./runtime/Dockerfile.backend', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('./runtime/Dockerfile.worker', import.meta.url), 'utf8');

  for (const dockerfile of [backend, worker]) {
    assert.match(dockerfile, /addgroup -S -g 10001 ankay/);
    assert.match(dockerfile, /adduser -S -D -H -u 10001 -G ankay ankay/);
    assert.match(dockerfile, /USER 10001:10001/);
    assert.doesNotMatch(dockerfile, /chown\s+-R/);
  }

  assert.match(backend, /mkdir -p \/app\/generated\s+\\\r?\n\s+&& chown 10001:10001 \/app\/generated/);
  assert.doesNotMatch(worker, /chown|chmod/);
});

test('runtime build checks effective users and documents the Docker socket production gate', () => {
  const runtimeCheck = readFileSync(new URL('./verify-runtime-users.sh', import.meta.url), 'utf8');
  const workflow = readFileSync(
    new URL('../.github/workflows/ankay-azure.yml', import.meta.url),
    'utf8',
  );
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

  assert.match(runtimeCheck, /test -w \/app\/generated/);
  assert.match(runtimeCheck, /test ! -w \/app/);
  assert.match(workflow, /bash ankay\/verify-runtime-users\.sh/);
  assert.match(readme, /autoridad prácticamente equivalente\s+a root sobre el daemon y su VM/);
  assert.match(readme, /Ankay no queda listo para producción/);
});

test('pinned shuffle-shared sums are applied to both source modules before image builds', () => {
  const buildScript = readFileSync(
    new URL('./build-runtime-components.sh', import.meta.url),
    'utf8',
  );
  const sumsPatch = readFileSync(
    new URL('./runtime/shuffle-shared-v1.3.22-sums.patch', import.meta.url),
    'utf8',
  );
  const expected = [
    'github.com/shuffle/shuffle-shared v1.3.22 h1:Xb9EnYLyrhlP8AiH52Frst6iflIkbxyBmG/bntpRo5o=',
    'github.com/shuffle/shuffle-shared v1.3.22/go.mod h1:0vOWNn+aXibNcbjROmrgszm3/KirYtwzE5BuVnCzQVE=',
  ];

  for (const sum of expected) assert.equal(sumsPatch.split(sum).length - 1, 2);
  assert.match(
    buildScript,
    /git -C "\$work_dir\/shuffle" apply --check "\$shuffle_shared_sums_patch"/,
  );
  assert.match(buildScript, /git -C "\$work_dir\/shuffle" apply "\$shuffle_shared_sums_patch"/);
  assert.match(buildScript, /cp "\$work_dir\/shuffle\/backend\/go-app\/go\.sum"/);
  assert.match(buildScript, /cp "\$work_dir\/shuffle\/functions\/onprem\/worker\/go\.sum"/);
  assert.match(buildScript, /cp "\$work_dir\/shuffle\/backend\/go-app\/go\.mod"/);
  assert.match(buildScript, /cp "\$work_dir\/shuffle\/functions\/onprem\/worker\/go\.mod"/);
});

test('security upgrades are a pinned upstream overlay compatible with the Go builder', () => {
  const buildScript = readFileSync(
    new URL('./build-runtime-components.sh', import.meta.url),
    'utf8',
  );
  const patch = readFileSync(
    new URL('./runtime/shuffle-runtime-security-upgrades.patch', import.meta.url),
    'utf8',
  );
  assert.match(buildScript, /apply --check "\$shuffle_runtime_security_patch"/);
  assert.match(buildScript, /apply "\$shuffle_runtime_security_patch"/);
  assert.match(patch, /golang\.org\/x\/net v0\.60\.0/);
  assert.match(patch, /golang\.org\/x\/crypto v0\.57\.0/);
  assert.match(patch, /golang\.org\/x\/text v0\.42\.0/);
  assert.doesNotMatch(patch, /github\.com\/moby\/go-archive v0\.3\.0/);
  assert.match(patch, /^\+go 1\.26\.0$/m);
  assert.equal(lock.goSecurityUpgrades.minimumToolchain, '1.27.3');
  assert.equal(lock.goSecurityUpgrades['golang.org/x/net'], 'v0.60.0');
  assert.equal(lock.goSecurityUpgrades['golang.org/x/crypto'], 'v0.57.0');
  assert.equal(lock.goSecurityUpgrades['golang.org/x/text'], 'v0.42.0');
  assert.equal(lock.goSecurityUpgrades['google.golang.org/grpc'], 'v1.83.2');
});

test('runtime source overlay fixes vet format diagnostics and tests sync URL allowlist', () => {
  const buildScript = readFileSync(
    new URL('./build-runtime-components.sh', import.meta.url),
    'utf8',
  );
  const patch = readFileSync(
    new URL('./runtime/shuffle-runtime-vet-and-cloud-url.patch', import.meta.url),
    'utf8',
  );
  assert.match(buildScript, /apply --check "\$shuffle_runtime_source_patch"/);
  assert.match(buildScript, /apply "\$shuffle_runtime_source_patch"/);
  assert.match(buildScript, /cp "\$work_dir\/shuffle\/backend\/go-app\/cloud_sync_url_test\.go"/);
  assert.match(patch, /func normalizeCloudSyncBaseURL/);
  assert.match(patch, /TestNormalizeCloudSyncBaseURL/);
  assert.match(patch, /https:\/\/eu\.shuffler\.io/);
  assert.match(patch, /strings\.ReplaceAll\(name, "\.\", "-"\)/);
});

test('backend Docker SDK migration uses pinned Moby overlays and corresponding shared source', () => {
  const buildScript = readFileSync(
    new URL('./build-runtime-components.sh', import.meta.url),
    'utf8',
  );
  const backendPatch = readFileSync(
    new URL('./runtime/shuffle-runtime-moby-v29.patch', import.meta.url),
    'utf8',
  );
  const sharedPatch = readFileSync(
    new URL('./runtime/shuffle-shared-moby-v29.patch', import.meta.url),
    'utf8',
  );
  const dockerfile = readFileSync(new URL('./runtime/Dockerfile.backend', import.meta.url), 'utf8');
  const shared = lock.sources.shuffleShared;

  assert.equal(shared.repository, 'https://github.com/Shuffle/shuffle-shared.git');
  assert.match(shared.commit, /^[0-9a-f]{40}$/);
  assert.match(buildScript, /fetch_commit "\$shuffle_shared_repo" "\$shuffle_shared_sha"/);
  assert.match(buildScript, /apply --check "\$shuffle_runtime_moby_patch"/);
  assert.match(buildScript, /apply --check "\$shuffle_shared_moby_patch"/);
  assert.match(buildScript, /git -C "\$work_dir\/shuffle-shared" archive "\$shuffle_shared_sha"/);
  assert.match(buildScript, /:\(exclude\)app_upload/);
  assert.match(buildScript, /sourceCommits:\{shuffle:\$shuffle_sha, shuffleShared:\$shuffle_shared_sha/);
  assert.match(dockerfile, /COPY backend\/go-app\/moby-shuffle-shared\/ \/app\/moby-shuffle-shared\//);
  assert.match(backendPatch, /github\.com\/moby\/moby\/client/);
  assert.match(backendPatch, /ImageSave\(ctx, \[\]string\{tagFound\}\)/);
  assert.doesNotMatch(backendPatch, /\+\s*"github\.com\/fsouza\/go-dockerclient"/);
  assert.doesNotMatch(backendPatch, /\+\s*github\.com\/moby\/go-archive/);
  assert.match(sharedPatch, /github\.com\/moby\/moby\/client/);
  assert.doesNotMatch(sharedPatch, /\+\s*"github\.com\/docker\/docker/);
});

test('worker Docker SDK advisories remain explicit release blockers', () => {
  const blocker = lock.securityBlockers.dockerSdk;
  assert.equal(blocker.module, 'github.com/docker/docker@v28.3.3+incompatible');
  assert.equal(blocker.status, 'backend-migrated-worker-still-blocked');
  assert.deepEqual(blocker.cves, ['CVE-2026-41567', 'CVE-2026-42306']);
  assert.equal(blocker.requiredEngineVersion, '29.5.1');
  assert.match(blocker.reason, /worker still uses the deprecated SDK/);
  const archive = lock.securityBlockers.mobyGoArchive;
  assert.equal(archive.module, 'github.com/moby/go-archive@v0.1.0');
  assert.equal(archive.status, 'worker-still-blocked');
  assert.deepEqual(archive.cves, ['CVE-2026-17106']);
  assert.equal(archive.fixedVersion, 'v0.3.0');
  assert.match(archive.reason, /worker still uses the deprecated Docker SDK/);
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
