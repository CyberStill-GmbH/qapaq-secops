#!/usr/bin/env bash
# Instala un release qapaq-core Azure en el host SIEM usando el core.env que ya
# materializó el bootstrap desde Key Vault. No crea, rota ni obtiene secretos.
set -euo pipefail
umask 077

fail() { printf 'qapaq-core-azure: ERROR %s\n' "$1" >&2; exit 1; }
info() { printf 'qapaq-core-azure: %s\n' "$1"; }

archive="${1:?uso: apply-core-azure.sh <archive.tar.gz> <sha256> [env-file]}"
expected_sha="${2:?uso: apply-core-azure.sh <archive.tar.gz> <sha256> [env-file]}"
env_file="${3:-/etc/qapaq-core/core.env}"
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || fail 'SHA-256 de release inválido'
[[ -f "$archive" && ! -L "$archive" ]] || fail 'el archive no es un archivo normal'
[[ -f "$env_file" && ! -L "$env_file" ]] || fail 'falta el EnvironmentFile materializado desde Key Vault'
[[ "$(stat -c '%u' "$env_file")" == 0 ]] || fail 'core.env no pertenece a root'
mode="$(stat -c '%a' "$env_file")"
(( (8#$mode & 0077) == 0 )) || fail 'core.env permite acceso a otros usuarios'
echo "$expected_sha  $archive" | sha256sum --check --status || fail 'checksum del archive no coincide'

for command in curl sha256sum tar systemctl install useradd python3; do
  command -v "$command" >/dev/null || fail "falta el comando requerido: $command"
done

BASE=/opt/qapaq-core
work="$(mktemp -d)"
link_tmp=''
previous=''
switched=false
deployment_ok=false
rollback() {
  [[ "$switched" == true && "$deployment_ok" != true ]] || return 0
  if [[ -n "$previous" && -d "$previous" ]]; then
    local restore_tmp="$BASE/.rollback-$$"
    rm -f -- "$restore_tmp"
    ln -s -- "$previous" "$restore_tmp" && mv -Tf -- "$restore_tmp" "$BASE/current"
    systemctl restart qapaq-core-api || true
    systemctl restart qapaq-core-worker || true
    info 'se restauró el release anterior tras el fallo de activación'
  else
    rm -f -- "$BASE/current"
    systemctl stop qapaq-core-api qapaq-core-worker >/dev/null 2>&1 || true
    info 'se retiró el release fallido; no existía una versión anterior'
  fi
}
cleanup() {
  rollback
  rm -rf -- "$work"
  [[ -z "$link_tmp" ]] || rm -f -- "$link_tmp"
}
trap cleanup EXIT

# Rechaza traversal, enlaces fuera de la raíz y tipos especiales antes de extraer.
# El Node.js distribuido contiene symlinks internos, por eso se permiten solo si quedan bajo la raíz.
python3 - "$archive" <<'PY'
import posixpath
import sys
import tarfile

archive_path = sys.argv[1]
root = None
try:
    with tarfile.open(archive_path, "r:gz") as tar:
        members = tar.getmembers()
        if not members:
            raise ValueError("archive vacío")
        for member in members:
            name = member.name
            if not name or name.startswith("/") or "\\" in name:
                raise ValueError("nombre de ruta inválido")
            normalized = posixpath.normpath(name)
            if normalized in (".", "..") or normalized.startswith("../"):
                raise ValueError("path traversal")
            component = normalized.split("/", 1)[0]
            if not __import__("re").fullmatch(r"qapaq-core-[0-9a-f]{12}", component):
                raise ValueError("raíz inesperada")
            if root is None:
                root = component
            if component != root:
                raise ValueError("más de una raíz")
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError("tipo de archivo especial no permitido")
            if member.issym() or member.islnk():
                target = member.linkname
                if not target or target.startswith("/") or "\\" in target:
                    raise ValueError("destino de enlace inválido")
                base = posixpath.dirname(normalized) if member.issym() else ""
                resolved = posixpath.normpath(posixpath.join(base, target))
                if resolved == ".." or resolved.startswith("../") or not resolved.startswith(root + "/"):
                    raise ValueError("enlace fuera de la raíz")
except (OSError, tarfile.TarError, ValueError) as exc:
    print(f"qapaq-core-azure: ERROR archive inseguro o inválido: {exc}", file=sys.stderr)
    sys.exit(1)
PY

top=''
while IFS= read -r member; do
  component="${member%%/*}"
  [[ "$component" =~ ^qapaq-core-[0-9a-f]{12}$ ]] || fail 'estructura del archive inesperada'
  if [[ -z "$top" ]]; then top="$component"; fi
  [[ "$component" == "$top" ]] || fail 'el archive contiene más de una raíz'
done < <(tar -tzf "$archive")
[[ -n "$top" ]] || fail 'el archive está vacío'
tar -xzf "$archive" -C "$work" --no-same-owner --no-same-permissions
release_source="$work/$top"
[[ -s "$release_source/RELEASE" && "$(cat "$release_source/RELEASE")" == "${top#qapaq-core-}" ]] || \
  fail 'el marcador RELEASE no coincide con el nombre del archive'
[[ -x "$release_source/node/bin/node" ]] || fail 'Node del release no es ejecutable'
[[ "$("$release_source/node/bin/node" --version)" == 'v24.21.0' ]] || fail 'versión Node distinta de 24.21.0'
[[ -d "$release_source/api" && -d "$release_source/worker" && -d "$release_source/systemd" ]] || \
  fail 'el release no contiene API, worker y unidades systemd'

id qapaq-core >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin qapaq-core
install -d -m 0750 -o root -g qapaq-core "$BASE" "$BASE/releases" /etc/qapaq-core
if [[ "$(readlink -f "$env_file")" == "$(readlink -f /etc/qapaq-core/core.env)" ]]; then
  chown root:qapaq-core /etc/qapaq-core/core.env
  chmod 0640 /etc/qapaq-core/core.env
else
  install -m 0640 -o root -g qapaq-core "$env_file" /etc/qapaq-core/core.env
fi

release="$BASE/releases/${top#qapaq-core-}"
if [[ -e "$release" ]]; then
  [[ -d "$release" && ! -L "$release" ]] || fail 'el destino de release existente no es un directorio normal'
  [[ -s "$release/RELEASE" && "$(cat "$release/RELEASE")" == "${top#qapaq-core-}" ]] || \
    fail 'ya existe el mismo commit con contenido distinto'
  diff -qr --no-dereference "$release_source" "$release" >/dev/null || \
    fail 'el release existente difiere del archive validado'
  source_modes="$(find "$release_source" -printf '%m %P\n' | sort)"
  installed_modes="$(find "$release" -printf '%m %P\n' | sort)"
  [[ "$source_modes" == "$installed_modes" ]] || fail 'los permisos del release existente difieren del archive'
else
  mv -- "$release_source" "$release"
  chown -R root:qapaq-core "$release"
  chmod -R g+rX,o-rwx "$release"
fi

previous="$(readlink -f "$BASE/current" 2>/dev/null || true)"
if [[ -n "$previous" ]]; then
  [[ "$previous" == "$BASE"/releases/* && -d "$previous" ]] || \
    fail 'el release actualmente activo apunta fuera del directorio administrado'
fi
install -m 0644 "$release"/systemd/qapaq-core-*.service /etc/systemd/system/
systemctl daemon-reload
link_tmp="$BASE/.current-${top#qapaq-core-}.$$"
ln -s -- "$release" "$link_tmp"
if [[ -L "$BASE/current" && -z "$previous" ]]; then rm -f -- "$BASE/current"; fi
mv -Tf -- "$link_tmp" "$BASE/current"
link_tmp=''
switched=true
[[ "$(readlink -f "$BASE/current")" == "$release" ]] || fail 'activación atómica del release falló'

systemctl enable --quiet qapaq-core-api qapaq-core-worker || fail 'no se pudieron habilitar los servicios systemd'
systemctl restart qapaq-core-api || fail 'no se pudo reiniciar la API'
ready=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3000/health/ready; then ready=true; break; fi
  sleep 3
done
if [[ "$ready" != true ]]; then
  fail 'API no alcanzó health/ready; se revirtió la activación'
fi

systemctl restart qapaq-core-worker || fail 'no se pudo reiniciar el worker'
systemctl is-active --quiet qapaq-core-worker || {
  fail 'worker no quedó activo; se revirtió la activación'
}
deployment_ok=true

# Conserva el release activo y tres releases anteriores para rollback.
current="$(readlink -f "$BASE/current")"
find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | \
  awk 'NR > 4 { $1=""; sub(/^ /, ""); print }' | while IFS= read -r old; do
    [[ -n "$old" && "$old" != "$current" && "$old" == "$BASE"/releases/* ]] || continue
    rm -rf -- "$old"
  done

info "release ${top#qapaq-core-} activo; API lista y worker activo; secretos no impresos"
