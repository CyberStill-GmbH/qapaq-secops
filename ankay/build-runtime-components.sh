#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:?uso: build-runtime-components.sh <output-directory>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_file="$root/ankay/azure-components.lock.json"
tmp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
mkdir -p "$out_dir" "$tmp_root"
work_dir="$(mktemp -d "$tmp_root/ankay-runtime-components.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

require_sha() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || { echo "$name no es un commit SHA completo" >&2; exit 1; }
}

shuffle_repo="$(jq -r '.sources.shuffle.repository' "$lock_file")"
shuffle_sha="$(jq -r '.sources.shuffle.commit' "$lock_file")"
app_sdk_repo="$(jq -r '.sources.appSdk.repository' "$lock_file")"
app_sdk_sha="$(jq -r '.sources.appSdk.commit' "$lock_file")"
app_sdk_file="$(jq -r '.sources.appSdk.file' "$lock_file")"
app_sdk_file_sha="$(jq -r '.sources.appSdk.fileSha256' "$lock_file")"
shuffle_shared_repo="$(jq -r '.sources.shuffleShared.repository' "$lock_file")"
shuffle_shared_sha="$(jq -r '.sources.shuffleShared.commit' "$lock_file")"
orborus_repo="$(jq -r '.sources.orborus.repository' "$lock_file")"
orborus_sha="$(jq -r '.sources.orborus.commit' "$lock_file")"
orborus_path="$(jq -r '.sources.orborus.path' "$lock_file")"
require_sha shuffle.commit "$shuffle_sha"
require_sha appSdk.commit "$app_sdk_sha"
require_sha shuffleShared.commit "$shuffle_shared_sha"
require_sha orborus.commit "$orborus_sha"
[[ "$app_sdk_file_sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'appSdk.fileSha256 no es un SHA-256 completo' >&2; exit 1; }

fetch_commit() {
  local repository="$1" commit="$2" directory="$3"
  git init --quiet "$directory"
  git -C "$directory" remote add origin "$repository"
  git -C "$directory" fetch --quiet --depth 1 origin "$commit"
  git -C "$directory" checkout --quiet --detach FETCH_HEAD
  [[ "$(git -C "$directory" rev-parse HEAD)" == "$commit" ]] || {
    echo "La fuente $repository no coincide con el SHA fijado" >&2
    exit 1
  }
}

fetch_commit "$shuffle_repo" "$shuffle_sha" "$work_dir/shuffle"
fetch_commit "$app_sdk_repo" "$app_sdk_sha" "$work_dir/app-sdk"
fetch_commit "$shuffle_shared_repo" "$shuffle_shared_sha" "$work_dir/shuffle-shared"
fetch_commit "$orborus_repo" "$orborus_sha" "$work_dir/shuffle-orborus"
shuffle_shared_sums_patch="$root/ankay/runtime/shuffle-shared-v1.3.22-sums.patch"
shuffle_runtime_security_patch="$root/ankay/runtime/shuffle-runtime-security-upgrades.patch"
shuffle_runtime_source_patch="$root/ankay/runtime/shuffle-runtime-vet-and-cloud-url.patch"
shuffle_runtime_moby_patch="$root/ankay/runtime/shuffle-runtime-moby-v29.patch"
shuffle_shared_moby_patch="$root/ankay/runtime/shuffle-shared-moby-v29.patch"
shuffle_worker_moby_patch="$root/ankay/runtime/shuffle-worker-moby-v29.patch"
git -C "$work_dir/shuffle" apply --check "$shuffle_shared_sums_patch"
git -C "$work_dir/shuffle" apply "$shuffle_shared_sums_patch"
git -C "$work_dir/shuffle" apply --check "$shuffle_runtime_security_patch"
git -C "$work_dir/shuffle" apply "$shuffle_runtime_security_patch"
git -C "$work_dir/shuffle" apply --check "$shuffle_runtime_source_patch"
git -C "$work_dir/shuffle" apply "$shuffle_runtime_source_patch"
git -C "$work_dir/shuffle" apply --check "$shuffle_runtime_moby_patch"
git -C "$work_dir/shuffle" apply "$shuffle_runtime_moby_patch"
git -C "$work_dir/shuffle" apply --check "$shuffle_worker_moby_patch"
git -C "$work_dir/shuffle" apply "$shuffle_worker_moby_patch"
# go-jose v4.1.6 corrige CVE-2026-116587 (DoS al parsear JWK RSA) en backend y worker.
shuffle_go_jose_patch="$root/ankay/runtime/shuffle-runtime-go-jose.patch"
git -C "$work_dir/shuffle" apply --check "$shuffle_go_jose_patch"
git -C "$work_dir/shuffle" apply "$shuffle_go_jose_patch"
git -C "$work_dir/shuffle-shared" apply --check "$shuffle_shared_moby_patch"
git -C "$work_dir/shuffle-shared" apply "$shuffle_shared_moby_patch"
shared_overlay="$work_dir/shuffle/backend/go-app/moby-shuffle-shared"
mkdir -p "$shared_overlay"
git -C "$work_dir/shuffle-shared" archive "$shuffle_shared_sha" -- . ':(exclude)app_upload' |
  tar -xf - -C "$shared_overlay"
cp "$work_dir/shuffle-shared/shared.go" "$work_dir/shuffle-shared/codegen.go" \
  "$work_dir/shuffle-shared/go.mod" "$work_dir/shuffle-shared/go.sum" "$shared_overlay/"
cp -a "$shared_overlay" "$work_dir/shuffle/functions/onprem/worker/moby-shuffle-shared"
# Orborus: último tag del monorepo con su fuente bajo la LICENSE AGPL-3.0, portado a Moby v29.
orborus_patch="$root/ankay/runtime/orborus/orborus-moby-v29.patch"
orborus_dir="$work_dir/shuffle-orborus/$orborus_path"
git -C "$work_dir/shuffle-orborus" apply --check "$orborus_patch"
git -C "$work_dir/shuffle-orborus" apply "$orborus_patch"
cp "$root/ankay/runtime/orborus/go.mod" "$root/ankay/runtime/orborus/go.sum" "$orborus_dir/"
cp -a "$shared_overlay" "$orborus_dir/moby-shuffle-shared"
grep -qi 'GNU AFFERO GENERAL PUBLIC LICENSE' "$work_dir/shuffle-orborus/LICENSE" || {
  echo 'La fuente Orborus no acredita AGPL-3.0 en LICENSE' >&2; exit 1;
}
# La app QAPAQ Ankay se registra por hotload desde la imagen del backend.
python3 "$root/ankay/playbooks/build_workflows.py" --check
mkdir -p "$work_dir/shuffle/ankay-apps"
cp -a "$root/ankay/apps/qapaq-ankay" "$work_dir/shuffle/ankay-apps/qapaq-ankay"
rm -f "$work_dir/shuffle/ankay-apps/qapaq-ankay/test_"*.py
grep -qi 'GNU AFFERO GENERAL PUBLIC LICENSE' "$work_dir/shuffle/LICENSE" || {
  echo 'La fuente Shuffle no acredita AGPL-3.0 en LICENSE' >&2; exit 1;
}
grep -qi 'GNU AFFERO GENERAL PUBLIC LICENSE' "$work_dir/shuffle-shared/LICENSE" || {
  echo 'La fuente shuffle-shared no acredita AGPL-3.0 en LICENSE' >&2; exit 1;
}
grep -q 'MIT License' "$work_dir/app-sdk/LICENSE" || {
  echo 'La fuente app_sdk no acredita MIT en LICENSE' >&2; exit 1;
}
actual_app_sdk_file_sha="$(git -C "$work_dir/app-sdk" cat-file blob "$app_sdk_sha:$app_sdk_file" | sha256sum | awk '{print $1}')"
[[ "$actual_app_sdk_file_sha" == "$app_sdk_file_sha" ]] || {
  echo 'El blob app_sdk no coincide con su SHA-256 fijado' >&2; exit 1;
}

go_builder_image="$(jq -r '.buildBases.golang1273Alpine323' "$lock_file")"
alpine_runtime_image="$(jq -r '.buildBases.alpine3226' "$lock_file")"
python_runtime_image="$(jq -r '.buildBases.python31316Alpine' "$lock_file")"
app_sdk_license_sha="$(jq -r '.sources.qapaqAnkayApp.sdkLicenseSha256' "$lock_file")"
opensearch_image="$(jq -r '.sources.opensearch.repository + "@" + .sources.opensearch.amd64Digest' "$lock_file")"
amazon_linux_image="$(jq -r '.buildBases.amazonLinux2023' "$lock_file")"
amazon_linux_release="$(jq -r '.buildPolicy.amazonLinux2023Release' "$lock_file")"
for image in "$go_builder_image" "$alpine_runtime_image" "$python_runtime_image" "$opensearch_image" "$amazon_linux_image"; do
  [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "Imagen base sin digest: $image" >&2; exit 1; }
done
[[ "$amazon_linux_release" =~ ^2023\.12\.[0-9]{8}$ ]] || {
  echo "Release Amazon Linux 2023 inválido o no fijado: $amazon_linux_release" >&2
  exit 1
}

shuffle_backend="ankay-qapaq-backend:${GITHUB_SHA:-local}"
shuffle_worker="ankay-qapaq-worker:${GITHUB_SHA:-local}"
ankay_opensearch="ankay-qapaq-opensearch:${GITHUB_SHA:-local}"
ankay_orborus="ankay-qapaq-orborus:${GITHUB_SHA:-local}"
ankay_docker_guard="ankay-qapaq-docker-guard:${GITHUB_SHA:-local}"
ankay_app="ankay-qapaq-app-qapaq-ankay:${GITHUB_SHA:-local}"
docker buildx build --platform linux/amd64 --load \
  --build-arg "GO_BUILDER_IMAGE=$go_builder_image" \
  --build-arg "ALPINE_RUNTIME_IMAGE=$alpine_runtime_image" \
  --build-arg "APP_SDK_SHA=$app_sdk_sha" \
  --build-arg "APP_SDK_FILE_SHA256=$app_sdk_file_sha" \
  --label "org.opencontainers.image.source=$shuffle_repo" \
  --label "org.opencontainers.image.revision=$shuffle_sha" \
  --label 'org.opencontainers.image.licenses=AGPL-3.0' \
  --tag "$shuffle_backend" \
  --file "$root/ankay/runtime/Dockerfile.backend" "$work_dir/shuffle"

docker buildx build --platform linux/amd64 --load \
  --build-arg "GO_BUILDER_IMAGE=$go_builder_image" \
  --build-arg "ALPINE_RUNTIME_IMAGE=$alpine_runtime_image" \
  --label "org.opencontainers.image.source=$shuffle_repo" \
  --label "org.opencontainers.image.revision=$shuffle_sha" \
  --label 'org.opencontainers.image.licenses=AGPL-3.0' \
  --tag "$shuffle_worker" \
  --file "$root/ankay/runtime/Dockerfile.worker" "$work_dir/shuffle"

docker buildx build --platform linux/amd64 --load \
  --build-arg "OPENSEARCH_BASE_IMAGE=$opensearch_image" \
  --build-arg "AMAZON_LINUX_IMAGE=$amazon_linux_image" \
  --build-arg "AMAZON_LINUX_RELEASE=$amazon_linux_release" \
  --label "org.opencontainers.image.base.name=$amazon_linux_image" \
  --label "org.opencontainers.image.base.digest=${amazon_linux_image##*@}" \
  --label "io.qapaq.source.opensearch.image=$opensearch_image" \
  --label "org.opencontainers.image.base.version=$amazon_linux_release" \
  --label 'org.opencontainers.image.licenses=Apache-2.0' \
  --tag "$ankay_opensearch" \
  --file "$root/ankay/runtime/Dockerfile.opensearch" "$root/ankay/runtime"

docker buildx build --platform linux/amd64 --load \
  --build-arg "GO_BUILDER_IMAGE=$go_builder_image" \
  --build-arg "ALPINE_RUNTIME_IMAGE=$alpine_runtime_image" \
  --label "org.opencontainers.image.source=$orborus_repo" \
  --label "org.opencontainers.image.revision=$orborus_sha" \
  --label 'org.opencontainers.image.licenses=AGPL-3.0' \
  --tag "$ankay_orborus" \
  --file "$root/ankay/runtime/Dockerfile.orborus" "$orborus_dir"

docker buildx build --platform linux/amd64 --load \
  --build-arg "GO_BUILDER_IMAGE=$go_builder_image" \
  --build-arg "ALPINE_RUNTIME_IMAGE=$alpine_runtime_image" \
  --label "org.opencontainers.image.revision=${GITHUB_SHA:-local}" \
  --label 'org.opencontainers.image.licenses=MIT' \
  --tag "$ankay_docker_guard" \
  --file "$root/ankay/runtime/Dockerfile.docker-guard" "$root/ankay/runtime"

docker buildx build --platform linux/amd64 --load \
  --build-arg "PYTHON_RUNTIME_IMAGE=$python_runtime_image" \
  --build-arg "APP_SDK_SHA=$app_sdk_sha" \
  --build-arg "APP_SDK_FILE_SHA256=$app_sdk_file_sha" \
  --build-arg "APP_SDK_LICENSE_SHA256=$app_sdk_license_sha" \
  --label "org.opencontainers.image.revision=${GITHUB_SHA:-local}" \
  --label 'org.opencontainers.image.licenses=MIT' \
  --tag "$ankay_app" \
  --file "$root/ankay/apps/qapaq-ankay/1.0.0/Dockerfile" "$root/ankay"

docker save "$shuffle_backend" | gzip -1 > "$out_dir/backend-image.tar.gz"
docker save "$shuffle_worker" | gzip -1 > "$out_dir/worker-image.tar.gz"
docker save "$ankay_opensearch" | gzip -1 > "$out_dir/opensearch-image.tar.gz"
docker save "$ankay_orborus" | gzip -1 > "$out_dir/orborus-image.tar.gz"
docker save "$ankay_docker_guard" | gzip -1 > "$out_dir/docker-guard-image.tar.gz"
docker save "$ankay_app" | gzip -1 > "$out_dir/app-qapaq-ankay-image.tar.gz"

mkdir -p "$work_dir/source/shuffle" "$work_dir/source/app-sdk"
git -C "$work_dir/shuffle" archive "$shuffle_sha" LICENSE backend/go-app backend/app_gen \
  functions/onprem/worker > "$work_dir/source/shuffle/source.tar"
tar -xf "$work_dir/source/shuffle/source.tar" -C "$work_dir/source/shuffle"
rm "$work_dir/source/shuffle/source.tar"
cp "$work_dir/shuffle/backend/go-app/go.mod" "$work_dir/source/shuffle/backend/go-app/go.mod"
cp "$work_dir/shuffle/backend/go-app/go.sum" "$work_dir/source/shuffle/backend/go-app/go.sum"
cp "$work_dir/shuffle/functions/onprem/worker/go.mod" "$work_dir/source/shuffle/functions/onprem/worker/go.mod"
cp "$work_dir/shuffle/functions/onprem/worker/go.sum" "$work_dir/source/shuffle/functions/onprem/worker/go.sum"
git -C "$work_dir/app-sdk" archive "$app_sdk_sha" LICENSE shuffle_sdk/shuffle_sdk.py \
  > "$work_dir/source/app-sdk/source.tar"
tar -xf "$work_dir/source/app-sdk/source.tar" -C "$work_dir/source/app-sdk"
rm "$work_dir/source/app-sdk/source.tar"
cp "$root/ankay/azure-components.lock.json" "$work_dir/source/"
mkdir -p "$work_dir/source/ankay-overlay"
cp "$shuffle_shared_sums_patch" "$work_dir/source/ankay-overlay/"
cp "$shuffle_runtime_security_patch" "$work_dir/source/ankay-overlay/"
cp "$shuffle_runtime_source_patch" "$work_dir/source/ankay-overlay/"
cp "$shuffle_runtime_moby_patch" "$shuffle_shared_moby_patch" "$work_dir/source/ankay-overlay/"
cp "$shuffle_worker_moby_patch" "$work_dir/source/ankay-overlay/"
cp "$shuffle_go_jose_patch" "$work_dir/source/ankay-overlay/"
cp "$work_dir/shuffle/backend/go-app/main.go" "$work_dir/source/shuffle/backend/go-app/main.go"
cp "$work_dir/shuffle/backend/go-app/docker.go" "$work_dir/source/shuffle/backend/go-app/docker.go"
cp "$work_dir/shuffle/backend/go-app/walkoff.go" "$work_dir/source/shuffle/backend/go-app/walkoff.go"
cp -a "$shared_overlay" "$work_dir/source/shuffle/backend/go-app/moby-shuffle-shared"
cp "$work_dir/shuffle/backend/go-app/cloud_sync_url_test.go" "$work_dir/source/shuffle/backend/go-app/cloud_sync_url_test.go"
cp "$work_dir/shuffle/functions/onprem/worker/worker.go" "$work_dir/source/shuffle/functions/onprem/worker/worker.go"
cp "$work_dir/shuffle/functions/onprem/worker/worker_image_test.go" "$work_dir/source/shuffle/functions/onprem/worker/worker_image_test.go"
cp -a "$shared_overlay" "$work_dir/source/shuffle/functions/onprem/worker/moby-shuffle-shared"
mkdir -p "$work_dir/source/shuffle-v2.2.0"
git -C "$work_dir/shuffle-orborus" archive "$orborus_sha" LICENSE "$orborus_path" > "$work_dir/source/shuffle-v2.2.0/source.tar"
tar -xf "$work_dir/source/shuffle-v2.2.0/source.tar" -C "$work_dir/source/shuffle-v2.2.0"
rm "$work_dir/source/shuffle-v2.2.0/source.tar"
cp "$orborus_dir/orborus.go" "$orborus_dir/go.mod" "$orborus_dir/go.sum" "$work_dir/source/shuffle-v2.2.0/$orborus_path/"
cp "$orborus_patch" "$work_dir/source/ankay-overlay/"
mkdir -p "$work_dir/source/qapaq"
cp -a "$root/ankay/runtime/docker-guard" "$root/ankay/apps" "$root/ankay/playbooks" "$work_dir/source/qapaq/"
cp "$root/LICENSE" "$work_dir/source/qapaq/LICENSE"
cp "$root/ankay/runtime/Dockerfile.backend" "$root/ankay/runtime/Dockerfile.worker" \
  "$root/ankay/runtime/Dockerfile.opensearch" "$root/ankay/runtime/Dockerfile.orborus" \
  "$root/ankay/runtime/Dockerfile.docker-guard" "$work_dir/source/"
cp "$root/ankay/runtime/opensearch-dependencies.lock" \
  "$root/ankay/runtime/patch-opensearch-dependencies.sh" \
  "$root/ankay/runtime/prune_opensearch_shadow_metadata.py" \
  "$root/ankay/runtime/sync_opensaml_guava_descriptor.py" "$work_dir/source/"
cp "$root/ankay/build-runtime-components.sh" "$root/ankay/verify-opensearch-runtime.sh" \
  "$work_dir/source/"
tar -czf "$out_dir/shuffle-corresponding-source.tar.gz" -C "$work_dir/source" .

image_id() { docker image inspect --format '{{.Id}}' "$1"; }
archive_sha() { sha256sum "$out_dir/$1" | awk '{print $1}'; }
source_archive_sha="$(archive_sha shuffle-corresponding-source.tar.gz)"
jq -n \
  --arg shuffle_sha "$shuffle_sha" --arg app_sdk_sha "$app_sdk_sha" \
  --arg shuffle_shared_sha "$shuffle_shared_sha" --arg orborus_sha "$orborus_sha" \
  --arg backend_id "$(image_id "$shuffle_backend")" --arg backend_sha "$(archive_sha backend-image.tar.gz)" \
  --arg worker_id "$(image_id "$shuffle_worker")" --arg worker_sha "$(archive_sha worker-image.tar.gz)" \
  --arg orborus_id "$(image_id "$ankay_orborus")" --arg orborus_sha_archive "$(archive_sha orborus-image.tar.gz)" \
  --arg guard_id "$(image_id "$ankay_docker_guard")" --arg guard_sha "$(archive_sha docker-guard-image.tar.gz)" \
  --arg app_id "$(image_id "$ankay_app")" --arg app_sha "$(archive_sha app-qapaq-ankay-image.tar.gz)" \
  --arg opensearch_id "$(image_id "$ankay_opensearch")" --arg opensearch_sha "$(archive_sha opensearch-image.tar.gz)" \
  --arg amazon_linux_release "$amazon_linux_release" --arg source_archive_sha "$source_archive_sha" \
  --argjson lock "$(cat "$lock_file")" \
  '{schemaVersion:2, targetPlatform:"linux/amd64",
    sourceCommits:{shuffle:$shuffle_sha, shuffleShared:$shuffle_shared_sha, appSdk:$app_sdk_sha, orborus:$orborus_sha},
    built:{
      backend:{archive:"backend-image.tar.gz", repository:"ankay-qapaq-backend", imageId:$backend_id, archiveSha256:$backend_sha, license:"AGPL-3.0"},
      worker:{archive:"worker-image.tar.gz", repository:"ankay-qapaq-worker", imageId:$worker_id, archiveSha256:$worker_sha, license:"AGPL-3.0"},
      orborus:{archive:"orborus-image.tar.gz", repository:"ankay-qapaq-orborus", imageId:$orborus_id, archiveSha256:$orborus_sha_archive, license:"AGPL-3.0"},
      "docker-guard":{archive:"docker-guard-image.tar.gz", repository:"ankay-qapaq-docker-guard", imageId:$guard_id, archiveSha256:$guard_sha, license:"MIT"},
      "app-qapaq-ankay":{archive:"app-qapaq-ankay-image.tar.gz", repository:"ankay-qapaq-app-qapaq-ankay", localTag:"ankay/apps:qapaq-ankay_1.0.0", imageId:$app_id, archiveSha256:$app_sha, license:"MIT"},
      opensearch:{archive:"opensearch-image.tar.gz", repository:"ankay-qapaq-opensearch", imageId:$opensearch_id, archiveSha256:$opensearch_sha,
        sourceTag:$lock.sources.opensearch.tag, sourceImage:($lock.sources.opensearch.repository + "@" + $lock.sources.opensearch.amd64Digest),
        runtimeBase:$lock.buildBases.amazonLinux2023, amazonLinuxRelease:$amazon_linux_release, license:$lock.sources.opensearch.license}},
    excluded:{shuffleSecurity:$lock.sources.shuffleSecurity.reason},
    sourceArchiveSha256:$source_archive_sha, acrPublication:false, terraformRuntimeReady:false}' \
  > "$out_dir/component-manifest.json"
(cd "$out_dir" && sha256sum *.tar.gz component-manifest.json > SHA256SUMS)
printf 'Componentes runtime construidos; la publicación ACR la hace ankay-azure-eus2-publish.yml (environment protegido).\n'
