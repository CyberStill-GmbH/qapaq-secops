#!/usr/bin/env bash
# QAPAQ SecOps — descarga los paquetes deb/rpm del agente, verifica su firma GPG de Wazuh y fija
# su SHA-256 en package-manifest.json. Lo ejecuta un operador en un host de construcción.
#
# Uso: update-linux-manifest.sh <directorio-de-salida> [<manifiesto>]
#
# La huella de la clave de Wazuh se fija en el manifiesto la primera vez tras confirmarla con la
# documentación oficial; después, una clave distinta detiene el proceso.
set -Eeuo pipefail

out="${1:?Uso: update-linux-manifest.sh <directorio-de-salida> [<manifiesto>]}"
manifest="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/package-manifest.json}"
for tool in curl gpg python3 sha256sum rpm zcat; do
  command -v "${tool}" >/dev/null || { echo "falta ${tool} (rpm verifica la firma del paquete RPM)." >&2; exit 1; }
done
mkdir -p "${out}"
gnupg="$(mktemp -d)"
trap 'rm -rf "${gnupg}"' EXIT

mapfile -t rows < <(python3 - "${manifest}" <<'PY'
import json, sys
for a in json.load(open(sys.argv[1], encoding="utf-8"))["artifacts"]:
    if a["verification"]["type"] == "gpg":
        print(a["id"], a["file"], a["url"], a["verification"]["keyUrl"], a["verification"]["fingerprint"])
PY
)

for row in "${rows[@]}"; do
  read -r id file url key_url pinned <<<"${row}"
  curl -sSfL "${key_url}" -o "${gnupg}/key.asc"
  fingerprint="$(gpg --homedir "${gnupg}" --with-colons --import-options show-only --import "${gnupg}/key.asc" | awk -F: '/^fpr/ {print $10; exit}')"
  if [[ "${pinned}" != TO_BE_PROVIDED && "${pinned}" != "${fingerprint}" ]]; then
    echo "la clave de ${key_url} (${fingerprint}) no coincide con la fijada (${pinned})." >&2; exit 1
  fi
  curl -sSfL "${url}" -o "${out}/${file}"
  case "${file}" in
    *.rpm)
      rpmdb="$(mktemp -d)"
      rpm --dbpath "${rpmdb}" --import "${gnupg}/key.asc"
      rpm --dbpath "${rpmdb}" -K "${out}/${file}" | grep -qi 'digests signatures OK' || { echo "firma RPM inválida: ${file}" >&2; exit 1; }
      rm -rf "${rpmdb}" ;;
    *.deb)
      # Los .deb de Wazuh se validan por el Release firmado del repositorio APT; aquí se compara
      # el SHA-256 del paquete con el que publica el índice Packages firmado.
      curl -sSfL "https://packages.wazuh.com/4.x/apt/dists/stable/InRelease" -o "${gnupg}/InRelease"
      gpg --homedir "${gnupg}" --import "${gnupg}/key.asc" 2>/dev/null
      gpg --homedir "${gnupg}" --verify "${gnupg}/InRelease" 2>/dev/null || { echo 'InRelease sin firma válida' >&2; exit 1; }
      packages_sha="$(awk '/^SHA256:/{f=1;next} /^[A-Z]/{f=0} f && $3=="main/binary-amd64/Packages.gz"{print $1}' "${gnupg}/InRelease")"
      curl -sSfL "https://packages.wazuh.com/4.x/apt/dists/stable/main/binary-amd64/Packages.gz" -o "${gnupg}/Packages.gz"
      echo "${packages_sha}  ${gnupg}/Packages.gz" | sha256sum --check --status || { echo 'Packages.gz no coincide con InRelease' >&2; exit 1; }
      expected="$(zcat "${gnupg}/Packages.gz" | awk -v f="pool/main/w/wazuh-agent/${file}" '$1=="Filename:" && $2==f {hit=1} hit && $1=="SHA256:" {print $2; exit}')"
      [[ "$(sha256sum "${out}/${file}" | cut -d' ' -f1)" == "${expected}" ]] || { echo "SHA-256 de ${file} no coincide con el índice firmado" >&2; exit 1; } ;;
  esac
  sha="$(sha256sum "${out}/${file}" | cut -d' ' -f1)"
  python3 - "${manifest}" "${id}" "${sha}" "${fingerprint}" <<'PY'
import json, sys
path, artifact_id, sha, fingerprint = sys.argv[1:5]
manifest = json.load(open(path, encoding="utf-8"))
for artifact in manifest["artifacts"]:
    if artifact["id"] == artifact_id:
        artifact["sha256"] = sha
        artifact["verification"]["fingerprint"] = fingerprint
pending = [a for a in manifest["artifacts"] if len(a["sha256"]) != 64]
manifest["status"] = "pinned" if not pending else "hashes-pending"
open(path, "w", encoding="utf-8").write(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
PY
  echo "[QAPAQ manifest] ${id} ${sha} (clave ${fingerprint})"
done
