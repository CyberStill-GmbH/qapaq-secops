#!/usr/bin/env bash
# Install the pinned offline Wazuh/QAPAQ release on a clean Ubuntu 24.04 host.
# Runtime credentials and the Wazuh certificate archive are provided by bootstrap
# from named Key Vault references; this script never generates or prints credentials.
set -Eeuo pipefail
umask 077

fail() { printf 'qapaq-siem-install: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-siem-install: %s\n' "$1"; }

[[ "$(id -u)" == 0 ]] || fail 'se requiere root'
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SECRETS=/etc/qapaq-secrets
CERT_ARCHIVE_B64="$SECRETS/wazuh-install-files.tar.b64"
OFFLINE_ROOT="$HERE/official-wazuh"
CORE_ARCHIVE="$(find "$HERE/files/core" -maxdepth 1 -type f -name 'qapaq-core-*.tar.gz' -print -quit)"

for command in apt-get bash dpkg-deb dpkg-query python3 sha256sum tar systemctl; do
  command -v "$command" >/dev/null 2>&1 || fail "falta dependencia local requerida: $command"
done
[[ -s "$OFFLINE_ROOT/wazuh-install.sh" && -s "$OFFLINE_ROOT/wazuh-offline.tar.gz" ]] ||
  fail 'bundle no contiene el instalador oficial y sus paquetes offline'
[[ -f "$CERT_ARCHIVE_B64" && ! -L "$CERT_ARCHIVE_B64" ]] ||
  fail 'falta Key Vault ref `wazuh-install-files.tar.b64` con certificados y contraseñas Wazuh en base64 de una línea'
[[ -s "$CORE_ARCHIVE" && ! -L "$CORE_ARCHIVE" ]] || fail 'falta el archive versionado de qapaq-core'

# The Azure Ubuntu image does not include every dependency required by the pinned Wazuh
# installation assistant. Install only the documented runtime prerequisites, without
# upgrading the image or contacting any non-Ubuntu repository. Azure Firewall's reviewed
# FQDN allowlist includes the Ubuntu archive and security endpoints used below.
required_packages=(curl tar gnupg openssl lsof apt-transport-https libcap2-bin debconf adduser procps)
missing_packages=()
for package in "${required_packages[@]}"; do
  status="$(dpkg-query --show -f='${db:Status-Status}' "$package" 2>/dev/null || true)"
  [[ "$status" == installed ]] || missing_packages+=("$package")
done
if (( ${#missing_packages[@]} > 0 )); then
  # Ubuntu 24.04 images can ship HTTP archive URIs, while this subnet permits only
  # HTTPS through Azure Firewall. Upgrade approved mirrors and fail closed on others.
  python3 "$HERE/wazuh/azure-release/normalize_ubuntu_apt_sources.py" ||
    fail 'las fuentes apt contienen HTTP fuera del allowlist Ubuntu; se detuvo antes de descargar paquetes'
  apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update >/dev/null ||
    fail 'no se pudieron actualizar los índices apt por HTTPS a través del firewall aprobado'
  DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 \
    install --no-install-recommends --yes "${missing_packages[@]}" >/dev/null ||
    fail 'no se pudieron instalar los prerrequisitos del asistente Wazuh desde Ubuntu'
fi

for package in "${required_packages[@]}"; do
  status="$(dpkg-query --show -f='${db:Status-Status}' "$package" 2>/dev/null || true)"
  [[ "$status" == installed ]] || fail "prerrequisito del asistente Wazuh no quedó instalado: $package"
done

work="$(mktemp -d /run/qapaq-siem-install.XXXXXX)"
cleanup() {
  rm -rf -- "$work"
}
trap cleanup EXIT

python3 "$HERE/wazuh/azure-release/verify_wazuh_credentials_tar.py" \
  "$CERT_ARCHIVE_B64" "$work/wazuh-install-files.tar" >/dev/null ||
  fail 'Key Vault Wazuh certificate/password archive is missing, malformed or too large'
chmod 0600 "$work/wazuh-install-files.tar"
install -m 0600 "$work/wazuh-install-files.tar" "$OFFLINE_ROOT/wazuh-install-files.tar"

# The module bootstrap already verified a pristine host and the signed release hashes.
# Never re-run the official assistant over an existing installation.
for package in wazuh-manager wazuh-indexer wazuh-dashboard filebeat; do
  state="$(dpkg-query --show -f='${db:Status-Status}' "$package" 2>/dev/null || true)"
  [[ -z "$state" ]] || fail "host has pre-existing package $package; refusing an in-place install"
done

info 'instalando Wazuh 4.14.8 con el asistente oficial fijado y paquetes offline verificados'
(
  cd "$OFFLINE_ROOT"
  # The official assistant handles cert installation, Indexer security initialization,
  # Manager/Filebeat configuration, and Dashboard initialization for an all-in-one node.
  bash ./wazuh-install.sh --all-in-one --offline-installation --tar ./wazuh-install-files.tar
) >/dev/null 2>&1 || fail 'el asistente oficial no completó la instalación offline; salida suprimida por seguridad'

expected_manifest="$HERE/manifest.json"
[[ -s "$expected_manifest" ]] || fail 'manifest.json ausente'
for package in wazuh-manager wazuh-indexer filebeat wazuh-dashboard; do
  expected="$(python3 - "$expected_manifest" "$package" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["debianPackages"][sys.argv[2]])
PY
)" || fail "no se pudo leer la versión fijada de $package"
  actual="$(dpkg-query --show -f='${Version}' "$package" 2>/dev/null || true)"
  [[ "$actual" == "$expected" ]] || fail "la versión Debian instalada de $package no coincide con el manifiesto"
done

# Keep the original certificate/password archive in protected durable storage so the existing
# QAPAQ Indexer/security adapters can use it. Do not expose it in the bundle or logs.
install -d -m 0700 /srv/qapaq-siem/secrets
install -m 0600 "$work/wazuh-install-files.tar" /srv/qapaq-siem/secrets/wazuh-install-files.tar
install -m 0600 "$work/wazuh-install-files.tar" /root/wazuh-install-files.tar

# Configure M365 from files that the Azure Managed Identity bootstrap materialized
# from Key Vault. The secret value never enters Terraform state, argv, or CI output.
[[ "${QAPAQ_O365_TENANT_ID:-}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
  fail 'falta QAPAQ_O365_TENANT_ID con un GUID válido'
[[ "${QAPAQ_O365_CLIENT_ID:-}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] ||
  fail 'falta QAPAQ_O365_CLIENT_ID con un GUID válido'
[[ -s "$SECRETS/office365-client-secret" && ! -L "$SECRETS/office365-client-secret" ]] ||
  fail 'falta el secreto M365 office365-client-secret materializado desde Key Vault'
office365_env=(
  QAPAQ_O365_TENANT_ID="$QAPAQ_O365_TENANT_ID"
  QAPAQ_O365_CLIENT_ID="$QAPAQ_O365_CLIENT_ID"
  QAPAQ_O365_API_TYPE="${QAPAQ_O365_API_TYPE:-commercial}"
  QAPAQ_O365_ENABLE_DLP="${QAPAQ_O365_ENABLE_DLP:-false}"
  QAPAQ_O365_SECRET_SOURCE="file:$SECRETS/office365-client-secret"
)
if [[ -s "$SECRETS/break-glass-identities" && ! -L "$SECRETS/break-glass-identities" ]]; then
  office365_env+=(QAPAQ_BREAK_GLASS_SOURCE="file:$SECRETS/break-glass-identities")
fi
# Validate M365 settings and templates before activating QAPAQ Core. This avoids a
# known bad tenant/app/template leaving Core activated on a host marked incomplete.
env "${office365_env[@]}" QAPAQ_APPLY_MODE=render \
  bash "$HERE/wazuh/office365/apply-office365.sh" >/dev/null 2>&1 ||
  fail 'la validación previa de M365 falló; no se activó QAPAQ Core'

# Install the Azure-targeted QAPAQ core with its own atomic activation and rollback.
core_sha="$(sha256sum "$CORE_ARCHIVE" | awk '{print $1}')"
bash "$HERE/wazuh/core/apply-core-azure.sh" "$CORE_ARCHIVE" "$core_sha" \
  >/dev/null 2>&1 || fail 'el instalador QAPAQ core falló; su rollback local quedó activo si había release anterior'

env "${office365_env[@]}" bash "$HERE/wazuh/office365/apply-office365.sh" \
  >/dev/null 2>&1 || fail 'la configuración M365 o la validación de reglas Wazuh falló; salida suprimida'

provider_config="$work/provider-ingestion.json"
provider_config_value="${QAPAQ_PROVIDER_INGESTION_JSON:-}"
if [[ -z "$provider_config_value" ]]; then provider_config_value='{}'; fi
printf '%s' "$provider_config_value" > "$provider_config"
python3 "$HERE/wazuh/provider-ingestion/configure.py" \
  --config "$provider_config" --root /var/ossec --secrets "$SECRETS" \
  --ossec-conf /var/ossec/etc/ossec.conf >/dev/null 2>&1 ||
  fail 'la configuración de ingesta Sophos/Cato falló; salida suprimida'

for service in wazuh-indexer wazuh-manager filebeat wazuh-dashboard qapaq-core-api qapaq-core-worker; do
  systemctl is-active --quiet "$service" || fail "servicio requerido no está activo: $service"
done
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/health/ready >/dev/null ||
  fail 'qapaq-core no responde /health/ready'
python3 - "$OFFLINE_ROOT/wazuh-install-files.tar" "$work/indexer-admin.curl" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    lines = archive.extractfile("wazuh-install-files/wazuh-passwords.txt").read().decode().splitlines()
for i, line in enumerate(lines):
    k, sep, v = line.partition(":")
    if sep and k.strip().lower() == "indexer_username" and v.strip().strip("'\"") == "admin":
        for next_line in lines[i + 1:i + 4]:
            k2, sep2, v2 = next_line.partition(":")
            if sep2 and k2.strip().lower() == "indexer_password":
                password = v2.strip().strip("'\"")
                escaped = password.replace("\\", "\\\\").replace('"', '\\"')
                open(sys.argv[2], "w", encoding="utf-8").write(f'user = "admin:{escaped}"\n')
                raise SystemExit(0)
raise SystemExit(1)
PY
chmod 0600 "$work/indexer-admin.curl"
curl --fail --silent --show-error --max-time 5 --cacert /etc/wazuh-indexer/certs/root-ca.pem \
  -K "$work/indexer-admin.curl" https://127.0.0.1:9200/_cluster/health >/dev/null ||
  fail 'Wazuh Indexer no pasó la comprobación TLS de salud'

info 'Wazuh QAPAQ, reglas M365 y qapaq-core instalados; integraciones de proveedor son opcionales y requieren smoke tests; edge/DNS, acceso/roles y Ankay siguen separados'
