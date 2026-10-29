#!/usr/bin/env bash
# Prueba el docker-guard contra el daemon real del runner: lo permitido para ejecutar
# workers/apps funciona y los escapes al host (privileged, binds, pull, exec, contenedores
# ajenos) se rechazan antes de llegar al daemon.
set -euo pipefail

guard_image="${1:?uso: verify-docker-guard.sh GUARD_IMAGE ALLOWED_IMAGE}"
allowed_image="${2:?uso: verify-docker-guard.sh GUARD_IMAGE ALLOWED_IMAGE}"
name="ankay-guard-smoke-${GITHUB_RUN_ID:-local}"
probe="ankay-guard-probe-${GITHUB_RUN_ID:-local}"
port=12375
socket_gid="$(stat -c '%g' /var/run/docker.sock)"

cleanup() {
  docker rm --force "$name" "$probe" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$name" \
  --publish "127.0.0.1:${port}:2375" \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$socket_gid" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --env "DOCKER_GUARD_ALLOWED_IMAGES=$allowed_image" \
  "$guard_image" >/dev/null

for _ in $(seq 1 30); do
  curl --fail --silent "http://127.0.0.1:${port}/_guard/health" >/dev/null && break
  sleep 1
done
curl --fail --silent "http://127.0.0.1:${port}/_guard/health" >/dev/null || {
  docker logs "$name" >&2 || true
  echo 'docker-guard no quedó saludable con el socket real.' >&2
  exit 1
}

guarded() { DOCKER_HOST="tcp://127.0.0.1:${port}" docker "$@"; }
must_fail() {
  if guarded "$@" >/dev/null 2>&1; then
    echo "docker-guard permitió una operación prohibida: docker $*" >&2
    exit 1
  fi
}

guarded version --format '{{.Server.Version}}' >/dev/null
guarded ps --all >/dev/null
guarded create --name "$probe" --entrypoint python "$allowed_image" -c 'print("ankay-guard-ok")' >/dev/null
guarded start "$probe" >/dev/null
[[ "$(guarded wait "$probe")" == 0 ]]
guarded logs "$probe" | grep -Fxq 'ankay-guard-ok'
guarded rm "$probe" >/dev/null

must_fail create --privileged "$allowed_image"
must_fail create --volume /:/host "$allowed_image"
must_fail create --volume /var/run/docker.sock:/var/run/docker.sock "$allowed_image"
must_fail create --network host "$allowed_image"
must_fail create --pid host "$allowed_image"
must_fail create --cap-add SYS_ADMIN "$allowed_image"
must_fail create --security-opt seccomp=unconfined "$allowed_image"
must_fail create --publish 8080:80 "$allowed_image"
must_fail create --user 0 "$allowed_image"
must_fail create alpine:3.22
must_fail pull alpine:3.22
must_fail exec "$name" true
must_fail stop "$name"
must_fail inspect "$name"
must_fail network create ankay-guard-escape
must_fail volume create ankay-guard-escape

guarded create --name "$probe" "$allowed_image" true >/dev/null
labels="$(docker inspect --format '{{index .Config.Labels "io.qapaq.ankay.docker-guard"}} {{.HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}}' "$probe")"
[[ "$labels" == 'true [no-new-privileges:true] 1024' ]] || {
  echo "El contenedor creado por el guard no quedó endurecido: $labels" >&2
  exit 1
}
echo 'docker-guard verificado contra el daemon real: operaciones permitidas y escapes bloqueados.'
