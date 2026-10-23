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
require_sha shuffle.commit "$shuffle_sha"
require_sha appSdk.commit "$app_sdk_sha"
require_sha shuffleShared.commit "$shuffle_shared_sha"
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
git -C "$work_dir/shuffle-shared" apply --check "$shuffle_shared_moby_patch"
git -C "$work_dir/shuffle-shared" apply "$shuffle_shared_moby_patch"
shared_overlay="$work_dir/shuffle/backend/go-app/moby-shuffle-shared"
mkdir -p "$shared_overlay"
git -C "$work_dir/shuffle-shared" archive "$shuffle_shared_sha" -- . ':(exclude)app_upload' |
  tar -xf - -C "$shared_overlay"
cp "$work_dir/shuffle-shared/shared.go" "$work_dir/shuffle-shared/codegen.go" \
  "$work_dir/shuffle-shared/go.mod" "$work_dir/shuffle-shared/go.sum" "$shared_overlay/"
cp -a "$shared_overlay" "$work_dir/shuffle/functions/onprem/worker/moby-shuffle-shared"
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
opensearch_image="$(jq -r '.sources.opensearch.repository + "@" + .sources.opensearch.amd64Digest' "$lock_file")"
for image in "$go_builder_image" "$alpine_runtime_image" "$opensearch_image"; do
  [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "Imagen base sin digest: $image" >&2; exit 1; }
done

shuffle_backend="ankay-qapaq-backend:${GITHUB_SHA:-local}"
shuffle_worker="ankay-qapaq-worker:${GITHUB_SHA:-local}"
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

docker pull --platform linux/amd64 "$opensearch_image"
docker image inspect "$opensearch_image" >/dev/null

docker save "$shuffle_backend" | gzip -1 > "$out_dir/backend-image.tar.gz"
docker save "$shuffle_worker" | gzip -1 > "$out_dir/worker-image.tar.gz"
docker save "$opensearch_image" | gzip -1 > "$out_dir/opensearch-image.tar.gz"

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
cp "$work_dir/shuffle/backend/go-app/main.go" "$work_dir/source/shuffle/backend/go-app/main.go"
cp "$work_dir/shuffle/backend/go-app/docker.go" "$work_dir/source/shuffle/backend/go-app/docker.go"
cp "$work_dir/shuffle/backend/go-app/walkoff.go" "$work_dir/source/shuffle/backend/go-app/walkoff.go"
cp -a "$shared_overlay" "$work_dir/source/shuffle/backend/go-app/moby-shuffle-shared"
cp "$work_dir/shuffle/backend/go-app/cloud_sync_url_test.go" "$work_dir/source/shuffle/backend/go-app/cloud_sync_url_test.go"
cp "$work_dir/shuffle/functions/onprem/worker/worker.go" "$work_dir/source/shuffle/functions/onprem/worker/worker.go"
cp "$work_dir/shuffle/functions/onprem/worker/worker_image_test.go" "$work_dir/source/shuffle/functions/onprem/worker/worker_image_test.go"
cp -a "$shared_overlay" "$work_dir/source/shuffle/functions/onprem/worker/moby-shuffle-shared"
cp "$root/ankay/runtime/Dockerfile.backend" "$root/ankay/runtime/Dockerfile.worker" "$work_dir/source/"
cp "$root/ankay/build-runtime-components.sh" "$work_dir/source/"
tar -czf "$out_dir/shuffle-corresponding-source.tar.gz" -C "$work_dir/source" .

backend_id="$(docker image inspect --format '{{.Id}}' "$shuffle_backend")"
worker_id="$(docker image inspect --format '{{.Id}}' "$shuffle_worker")"
backend_archive_sha="$(sha256sum "$out_dir/backend-image.tar.gz" | awk '{print $1}')"
worker_archive_sha="$(sha256sum "$out_dir/worker-image.tar.gz" | awk '{print $1}')"
opensearch_archive_sha="$(sha256sum "$out_dir/opensearch-image.tar.gz" | awk '{print $1}')"
source_archive_sha="$(sha256sum "$out_dir/shuffle-corresponding-source.tar.gz" | awk '{print $1}')"
jq -n \
  --arg shuffle_sha "$shuffle_sha" --arg app_sdk_sha "$app_sdk_sha" \
  --arg backend_id "$backend_id" --arg worker_id "$worker_id" \
  --arg backend_archive_sha "$backend_archive_sha" --arg worker_archive_sha "$worker_archive_sha" \
  --arg opensearch_archive_sha "$opensearch_archive_sha" --arg source_archive_sha "$source_archive_sha" \
  --argjson lock "$(cat "$lock_file")" \
  '{schemaVersion:1, targetPlatform:"linux/amd64", sourceCommits:{shuffle:$shuffle_sha, shuffleShared:$shuffle_shared_sha, appSdk:$app_sdk_sha},
    built:{backend:{imageId:$backend_id, archiveSha256:$backend_archive_sha, license:"AGPL-3.0"},
      worker:{imageId:$worker_id, archiveSha256:$worker_archive_sha, license:"AGPL-3.0"}},
    pinned:{opensearch:{image:($lock.sources.opensearch.repository + "@" + $lock.sources.opensearch.amd64Digest),
      archiveSha256:$opensearch_archive_sha, license:$lock.sources.opensearch.license}},
    blocked:{orborus:$lock.sources.orborus.reason, shuffleSecurity:$lock.sources.shuffleSecurity.reason},
    sourceArchiveSha256:$source_archive_sha, acrPublication:false, terraformRuntimeReady:false}' \
  > "$out_dir/component-manifest.json"
(cd "$out_dir" && sha256sum *.tar.gz component-manifest.json > SHA256SUMS)
printf 'Imágenes validadas localmente; publicación ACR y runtime quedan deshabilitados por bloqueos de licencia/compatibilidad.\n'
