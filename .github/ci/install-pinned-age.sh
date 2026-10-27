#!/usr/bin/env bash
set -euo pipefail

readonly AGE_VERSION='1.3.2'
readonly AGE_SHA256='cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10'
readonly AGE_ARCHIVE_URL="https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-amd64.tar.gz"

install_root="${1:?usage: install-pinned-age.sh RUNNER_TEMP/qapaq-age}"
[[ -n "${RUNNER_TEMP:-}" && "$install_root" == "$RUNNER_TEMP/qapaq-age" ]] || {
  echo '::error::age install path must be the dedicated runner temporary directory.'
  exit 1
}
[[ ! -e "$install_root" && ! -L "$install_root" ]] || {
  echo '::error::age install path already exists; refusing to reuse it.'
  exit 1
}
mkdir -m 700 "$install_root"

archive="$(mktemp "$RUNNER_TEMP/qapaq-age-dist.XXXXXX")"
cleanup() { rm -f -- "$archive"; }
trap cleanup EXIT

curl --fail --location --silent --show-error --retry 2 --max-time 120 \
  "$AGE_ARCHIVE_URL" --output "$archive"
printf '%s  %s\n' "$AGE_SHA256" "$archive" | sha256sum --check --status || {
  echo '::error::Pinned age release archive failed SHA-256 verification.'
  exit 1
}

tar --extract --gzip --file "$archive" --directory "$install_root" \
  --no-same-owner --no-same-permissions age/age age/age-keygen
for binary in age age-keygen; do
  path="$install_root/age/$binary"
  [[ -f "$path" && ! -L "$path" ]] || {
    echo '::error::Pinned age release is missing an expected executable.'
    exit 1
  }
  chmod 700 "$path"
  [[ "$("$path" --version 2>/dev/null)" == "v${AGE_VERSION}" ]] || {
    echo '::error::Pinned age executable version did not match.'
    exit 1
  }
done

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$install_root/age" >> "$GITHUB_PATH"
fi
echo "Pinned age v${AGE_VERSION} installed after SHA-256 verification."
