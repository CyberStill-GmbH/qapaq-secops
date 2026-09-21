#!/usr/bin/env bash
set -euo pipefail
case "${1:?scanner name required}" in
  gitleaks)
    version=8.30.1
    archive="gitleaks_${version}_linux_x64.tar.gz"
    url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}"
    checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  trivy)
    version=0.74.0
    archive="trivy_${version}_Linux-64bit.tar.gz"
    url="https://github.com/aquasecurity/trivy/releases/download/v${version}/${archive}"
    checksum=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a
    ;;
  *) echo 'Unsupported scanner' >&2; exit 1 ;;
esac
directory=$(mktemp -d)
trap 'rm -rf -- "$directory"' EXIT
curl --fail --silent --show-error --location --retry 3 "$url" -o "$directory/$archive"
printf '%s  %s\n' "$checksum" "$directory/$archive" | sha256sum --check --strict
tar -xzf "$directory/$archive" -C "$directory" "$1"
mkdir -p "$RUNNER_TEMP/scanners"
install -m 0755 "$directory/$1" "$RUNNER_TEMP/scanners/$1"
echo "$RUNNER_TEMP/scanners" >> "$GITHUB_PATH"
