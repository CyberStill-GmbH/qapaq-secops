#!/usr/bin/env bash
set -euo pipefail

root="${1:-/usr/share/opensearch}"
lock="${2:-/usr/share/opensearch/opensearch-dependencies.lock}"
test -d "$root"
test -f "$lock"

while IFS='|' read -r source_jar replacement_jar url sha256; do
  [[ -n "$source_jar" && "$source_jar" != \#* ]] || continue
  [[ "$sha256" =~ ^[0-9a-f]{64}$ ]]
  [[ "$url" == https://repo.maven.apache.org/maven2/* ]]

  mapfile -t matches < <(find "$root" -type f -name "$source_jar" -print)
  if (( ${#matches[@]} == 0 )); then
    printf 'Expected vulnerable dependency is missing: %s\n' "$source_jar" >&2
    exit 1
  fi

  artifact="$(mktemp)"
  curl --fail --location --silent --show-error "$url" --output "$artifact"
  printf '%s  %s\n' "$sha256" "$artifact" | sha256sum --check --status

  for source_path in "${matches[@]}"; do
    destination="$(dirname "$source_path")/$replacement_jar"
    install --owner=1000 --group=1000 --mode=0644 "$artifact" "$destination"
    rm -- "$source_path"
  done

  rm -- "$artifact"
  printf 'Replaced %s occurrence(s) of %s with checksum-pinned %s.\n' \
    "${#matches[@]}" "$source_jar" "$replacement_jar"
done < "$lock"

