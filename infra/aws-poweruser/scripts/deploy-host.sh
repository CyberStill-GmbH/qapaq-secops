#!/usr/bin/env bash
# QAPAQ SOC (modo PowerUser) — instala o actualiza el runtime en el nodo. Se ejecuta EN el host,
# como root, con el árbol del repo ya copiado en /opt/qapaq/src (ver ship.sh). Idempotente:
# los secretos se generan una sola vez en /opt/qapaq/secrets (0700/0600) y nunca salen del host.
#
#   sudo SOC_HOSTNAME=dev.security.qapaq.pe bash /opt/qapaq/src/infra/aws-poweruser/scripts/deploy-host.sh
set -euo pipefail
# 022: los contenedores (indexer uid 1000, dashboard) leen configs del clon de wazuh-docker. Los
# secretos quedan protegidos por /opt/qapaq/secrets (0700) y chmod 600 explícito.
umask 022

# A single node must never run two QAPAQ deployments at once. `ship.sh` holds this same lock while
# switching /opt/qapaq/src and running this script. Direct host invocations acquire it themselves.
DEPLOY_LOCK=/run/lock/qapaq-wazuh-deploy.lock
if [[ ${QAPAQ_DEPLOY_LOCK_HELD:-0} != 1 ]]; then
  command -v flock >/dev/null || { echo 'flock is required to serialize QAPAQ deployments' >&2; exit 69; }
  exec 9>"$DEPLOY_LOCK"
  flock -n 9 || { echo 'another QAPAQ deployment is active on this host' >&2; exit 75; }
fi

: "${SOC_HOSTNAME:?}"
WAZUH_DOCKER_TAG="${WAZUH_DOCKER_TAG:-v4.14.8}"
ROOT=/opt/qapaq
SRC=$ROOT/src
HOST_DIR=$SRC/infra/aws-poweruser/host
SECRETS=$ROOT/secrets
WD=$ROOT/wazuh-docker/single-node
log() { printf '[qapaq-deploy] %s\n' "$*"; }

# custom-qapaq calls the edge over HTTPS from inside the Manager. All deployment entrypoints
# that include compose.qapaq.yaml require the same host trust bundle before doing any work.
EDGE_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
[[ -s $EDGE_CA_BUNDLE && -r $EDGE_CA_BUNDLE ]] || {
  echo "host CA bundle missing or unreadable: $EDGE_CA_BUNDLE" >&2
  exit 1
}

export DEBIAN_FRONTEND=noninteractive
command -v envsubst >/dev/null || apt-get install -y gettext-base
python3 -c 'import bcrypt, yaml' 2>/dev/null || apt-get install -y python3-bcrypt python3-yaml
command -v certbot >/dev/null || apt-get install -y certbot
install -d -m 0700 "$SECRETS"
install -d -m 0755 "$ROOT/config" /var/www/certbot

# --- 1. Secretos (una sola vez) -------------------------------------------------
# Política de la API de Wazuh: mayúscula, minúscula, dígito y símbolo de .*+?-
wpass() { printf '%sAa9.' "$(openssl rand -hex 16)"; }
if [[ ! -s $SECRETS/compose.env ]]; then
  log 'generando secretos'
  {
    echo "INDEXER_ADMIN_PASSWORD=$(wpass)"
    echo "KIBANASERVER_PASSWORD=$(wpass)"
    echo "WAZUH_API_PASSWORD=$(wpass)"
    echo "POSTGRES_ADMIN_PASSWORD=$(openssl rand -hex 24)"
    echo "QAPAQ_MIGRATOR_PASSWORD=$(openssl rand -hex 24)"
    echo "QAPAQ_RUNTIME_PASSWORD=$(openssl rand -hex 24)"
  } >"$SECRETS/compose.env"
  openssl rand -base64 18 | tr -d '/+=' | head -c 20 | sed 's/^/QAPAQ-/' >"$SECRETS/demo-admin-password.txt"
  chmod 600 "$SECRETS"/*
fi
set -a; . "$SECRETS/compose.env"; set +a

# --- 2. PKI interna de PostgreSQL ------------------------------------------------
if [[ ! -s $ROOT/pki/ca.pem ]]; then
  log 'creando CA interna y certificado de postgres'
  install -d -m 0755 "$ROOT/pki" "$ROOT/pki/postgres"
  openssl req -x509 -new -nodes -newkey rsa:3072 -sha256 -days 1825 -subj '/CN=QAPAQ SOC dev internal CA' \
    -keyout "$SECRETS/ca.key" -out "$ROOT/pki/ca.pem"
  openssl req -new -nodes -newkey rsa:2048 -subj '/CN=postgres' \
    -keyout "$ROOT/pki/postgres/postgres.key" -out /tmp/pg.csr
  openssl x509 -req -in /tmp/pg.csr -CA "$ROOT/pki/ca.pem" -CAkey "$SECRETS/ca.key" -CAcreateserial \
    -days 825 -sha256 -extfile <(printf 'subjectAltName=DNS:postgres\nextendedKeyUsage=serverAuth\n') \
    -out "$ROOT/pki/postgres/postgres.crt"
  rm -f /tmp/pg.csr
  chmod 0644 "$ROOT/pki/ca.pem" "$ROOT/pki/postgres/postgres.crt"
  chown 999:999 "$ROOT/pki/postgres/postgres.key"; chmod 0600 "$ROOT/pki/postgres/postgres.key"
fi

# --- 3. wazuh-docker fijado + certificados + usuarios internos ---------------------
if [[ ! -d $ROOT/wazuh-docker ]]; then
  log "clonando wazuh-docker $WAZUH_DOCKER_TAG"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$WAZUH_DOCKER_TAG" \
    https://github.com/wazuh/wazuh-docker.git "$ROOT/wazuh-docker"
fi
cd "$WD"
if [[ ! -s config/wazuh_indexer_ssl_certs/root-ca.pem ]]; then
  log 'generando certificados de Wazuh'
  docker compose -f generate-indexer-certs.yml run --rm generator
fi
if [[ ! -f $SECRETS/.internal-users-applied ]]; then
  log 'aplicando hashes de admin y kibanaserver en internal_users.yml (antes del primer arranque)'
  python3 - config/wazuh_indexer/internal_users.yml <<'PY'
import os, sys, bcrypt, yaml
path = sys.argv[1]
data = yaml.safe_load(open(path))
for user, var in (("admin", "INDEXER_ADMIN_PASSWORD"), ("kibanaserver", "KIBANASERVER_PASSWORD")):
    data[user]["hash"] = bcrypt.hashpw(os.environ[var].encode(), bcrypt.gensalt(12)).decode()
yaml.safe_dump(data, open(path, "w"), sort_keys=False)
PY
  touch "$SECRETS/.internal-users-applied"
fi
# La app de Wazuh del dashboard lee la credencial de wazuh-wui de este archivo (el oficial trae
# la de ejemplo). Solo lo lee el uid 1000 del contenedor.
python3 - config/wazuh_dashboard/wazuh.yml <<'PY'
import os, sys, yaml
path = sys.argv[1]
data = yaml.safe_load(open(path))
for host in data["hosts"]:
    for entry in host.values():
        entry["password"] = os.environ["WAZUH_API_PASSWORD"]
        # run_as: false (como infra/local/wazuh-dashboard/wazuh.local.yml): la app habla con la API
        # del manager como wazuh-wui; con run_as la API intentaría mapear cada usuario QAPAQ y el
        # chequeo «API connection» se queda girando.
        entry["run_as"] = False
# Los datos viven en wazuh-alerts-* (el manager no se renombra). Un `pattern`/prefijo qapaq-* deja
# los módulos de la app (Office 365, vulnerabilidades, SCA, FIM...) vacíos: se vuelve al default.
for key in ("pattern", "alerts.sample.prefix", "cron.prefix"):
    data.pop(key, None)
# Informes PDF de la app de Wazuh con identidad QAPAQ (claves customization.* de 4.14; cabecera
# 3 líneas × 40, pie 2 × 50). El logo es el de assets/wazuh-app/logo_reports.png (targets.tsv).
data["customization.enabled"] = True
data["customization.reports.header"] = "QAPAQ SOC · Operaciones de Seguridad\nsoc@qapaq.pe\nhttps://dev.security.qapaq.pe"
data["customization.reports.footer"] = "QAPAQ SOC · Informe confidencial\nGenerado por QAPAQ SecOps (motor Wazuh)"
yaml.safe_dump(data, open(path, "w"), sort_keys=False)
PY
chown 1000:1000 config/wazuh_dashboard/wazuh.yml; chmod 0600 config/wazuh_dashboard/wazuh.yml

# --- 4. Config del dashboard y del API ------------------------------------------
# Sin los plugins QAPAQ (login qapaq_ops) no hay proxy auth posible: se aborta en vez de exponer el
# formulario del Security plugin.
compgen -G "$SRC/infra/local/wazuh-dashboard/plugins-dist/qapaqOps-*.zip" >/dev/null \
  || { echo 'faltan los plugins QAPAQ en infra/local/wazuh-dashboard/plugins-dist (build-plugins.sh)' >&2; exit 1; }
cp "$HOST_DIR/opensearch_dashboards.yml" "$ROOT/config/opensearch_dashboards.yml"
chmod 0644 "$ROOT/config/opensearch_dashboards.yml"

if [[ ! -s $SECRETS/api.env ]]; then
  log 'generando secretos del API'
  demo_hash="$(docker run --rm -i -v "$SRC/scripts/dev:/s:ro" node:24.21.0-trixie-slim \
    node /s/hash-demo-admin-password.mjs <"$SECRETS/demo-admin-password.txt")"
  vapid="$(openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -outform DER | base64 -w0)"
  {
    echo "QAPAQ_POSTGRES_PASSWORD=$QAPAQ_RUNTIME_PASSWORD"
    echo "QAPAQ_ENTITY_REF_KEY=$(openssl rand 48 | base64 -w0 | tr '+/' '-_' | tr -d '=')"
    echo "QAPAQ_VAPID_PRIVATE_KEY=$vapid"
    # Comillas simples: Compose interpola `$` en env_file y el hash scrypt los contiene.
    echo "QAPAQ_DEMO_ADMIN_PASSWORD_HASH='$demo_hash'"
  } >"$SECRETS/api.env"
  chmod 600 "$SECRETS/api.env"
fi
# Entra uses the app registration secret provisioned from the local .env into services.env.
# Never let a generated placeholder secret make production sign-in appear configured.
entra_client_secret="$(grep -s '^QAPAQ_ENTRA_CLIENT_SECRET=.' "$SECRETS/services.env" | cut -d= -f2- || true)"
if [[ -z $entra_client_secret ]]; then
  echo 'Entra: falta el client secret en /opt/qapaq/secrets/services.env; no se inicia el API' >&2
  exit 1
fi
sed -i '/^QAPAQ_ENTRA_CLIENT_SECRET=/d' "$SECRETS/api.env"
printf "QAPAQ_ENTRA_CLIENT_SECRET='%s'\n" "$entra_client_secret" >>"$SECRETS/api.env"
chmod 600 "$SECRETS/api.env"
unset entra_client_secret
# Cuentas demo por rol (QAPAQ_DEMO_ACCOUNTS, docs/04-identidad-y-acceso.md): la fuente es
# secrets/demo-accounts.txt (0600, una cuenta por línea: `usuario rol contraseña`; `#` comenta).
# Una línea QAPAQ_DEMO_ACCOUNTS ya presente en secrets/api.env se conserva tal cual; si falta (p. ej.
# api.env regenerado), se rehacen los hashes scrypt desde el .txt. Guarda: si el código aún no
# admite la variable (KNOWN_QAPAQ_VARIABLES), definirla tumbaría el arranque del API.
if [[ -s $SECRETS/demo-accounts.txt ]] && ! grep -q '^QAPAQ_DEMO_ACCOUNTS=' "$SECRETS/api.env"; then
  if grep -q "'QAPAQ_DEMO_ACCOUNTS'" "$SRC/platform/configuration/src/schema/environment.schema.ts"; then
    log 'cuentas demo: regenerando QAPAQ_DEMO_ACCOUNTS desde secrets/demo-accounts.txt'
    demo_accounts=''
    while read -r demo_user demo_role demo_password; do
      [[ -z $demo_user || $demo_user == \#* ]] && continue
      [[ $demo_user =~ ^[a-z0-9][a-z0-9._@+-]{2,63}$ && $demo_role =~ ^qapaq\.(soc\.analyst|soc\.lead|auditor|platform\.admin)$ ]] \
        || { echo 'secrets/demo-accounts.txt: línea inválida' >&2; exit 1; }
      demo_account_hash="$(printf '%s' "$demo_password" | docker run --rm -i -v "$SRC/scripts/dev:/s:ro" \
        node:24.21.0-trixie-slim node /s/hash-demo-admin-password.mjs)"
      demo_accounts+="${demo_accounts:+,}{\"username\":\"$demo_user\",\"role\":\"$demo_role\",\"passwordHash\":\"$demo_account_hash\"}"
    done <"$SECRETS/demo-accounts.txt"
    # Comillas simples: Compose interpola `$` en env_file y los hashes scrypt los contienen.
    [[ -n $demo_accounts ]] && printf "QAPAQ_DEMO_ACCOUNTS='[%s]'\n" "$demo_accounts" >>"$SECRETS/api.env"
    chmod 600 "$SECRETS/api.env"
    unset demo_accounts demo_user demo_role demo_password demo_account_hash
  else
    log 'cuentas demo: el código aún no admite QAPAQ_DEMO_ACCOUNTS; solo la cuenta admin'
  fi
fi
# Entra real + cuentas demo exige el opt-in QAPAQ_DEMO_LOGIN_WITH_ENTRA (api.env.template). Si el
# código copiado no lo admite, el API no arrancaría (CONFIG_VALUE_INVALID): se aborta antes.
grep -q "'QAPAQ_DEMO_LOGIN_WITH_ENTRA'" "$SRC/platform/configuration/src/schema/environment.schema.ts"   || { echo 'el código no admite QAPAQ_DEMO_LOGIN_WITH_ENTRA; no se reescribe config/api.env' >&2; exit 1; }
# La excepción demo vence como máximo a los 30 días del arranque: se renueva en cada despliegue.
DEMO_UNTIL="$(date -u -d '+29 days' +%Y-%m-%dT%H:%M:%SZ)" SOC_HOSTNAME="$SOC_HOSTNAME" \
  envsubst '${SOC_HOSTNAME} ${DEMO_UNTIL}' <"$HOST_DIR/api.env.template" >"$ROOT/config/api.env"
# Informes de Qapaqzito: sin el servicio desplegado (SKIP_API_BUILD=1) o con código que aún no admite
# QAPAQ_REPORTS_* (KNOWN_QAPAQ_VARIABLES), la URL tumbaría el arranque del API: se quita de la config.
if [[ ${SKIP_API_BUILD:-0} == 1 ]]   || ! grep -q "'QAPAQ_REPORTS_TOKEN'" "$SRC/platform/configuration/src/schema/environment.schema.ts"; then
  sed -i '/^QAPAQ_REPORTS_/d' "$ROOT/config/api.env"
fi
chmod 0644 "$ROOT/config/api.env"

# Configuración pública del correlador; el helper conserva este archivo después de crearlo.
# Emitir alertas sigue desactivado hasta revisar una canary y cambiarlo explícitamente.
[[ ! -L $ROOT/config/correlator.env ]] || { echo 'config/correlator.env no puede ser un symlink' >&2; exit 1; }
if [[ ! -e $ROOT/config/correlator.env ]]; then
  printf '%s\n' 'QAPAQ_CORRELATOR_EMIT=false' >"$ROOT/config/correlator.env"
fi
[[ -f $ROOT/config/correlator.env ]] || { echo 'config/correlator.env no es un archivo regular' >&2; exit 1; }
chown root:root "$ROOT/config/correlator.env"
chmod 0644 "$ROOT/config/correlator.env"

# Qapaqzito (asistente IA): sin IAM no hay Bedrock, así que usa Claude por la API directa de Anthropic
# con la clave QAPAQ_CLAUDE_API de /opt/qapaq/secrets/services.env (nunca en el repo). Cada despliegue
# la vuelve a copiar a api.env (así una rotación se aplica). Sin clave queda apagado.
# Guarda: hasta que platform/configuration acepte las variables QAPAQ_QAPAQZITO_* (KNOWN_QAPAQ_VARIABLES),
# activarlas tumba el arranque del API con CONFIG_VALUE_INVALID.
sed -i '/^QAPAQ_QAPAQZITO_/d' "$SECRETS/api.env"
qapaqzito_key="$(grep -s '^QAPAQ_CLAUDE_API=.\+' "$SECRETS/services.env" | cut -d= -f2- || true)"
if ! grep -q "'QAPAQ_QAPAQZITO_API_KEY'" "$SRC/platform/configuration/src/schema/environment.schema.ts"; then
  log 'Qapaqzito: el código aún no admite QAPAQ_QAPAQZITO_* en la configuración; asistente apagado'
elif [[ -n $qapaqzito_key ]]; then
  printf 'QAPAQ_QAPAQZITO_API_KEY=%s\n' "$qapaqzito_key" >>"$SECRETS/api.env"; chmod 600 "$SECRETS/api.env"
  log 'Qapaqzito: clave de Anthropic presente, asistente activado (Claude)'
  printf '%s\n' 'QAPAQ_QAPAQZITO_ENABLED=true' 'QAPAQ_QAPAQZITO_PROVIDER=anthropic' 'QAPAQ_QAPAQZITO_EFFORT=medium' \
    'QAPAQ_QAPAQZITO_REDACT_PII=true' >>"$ROOT/config/api.env"
  sed -i "s/^qapaq_ops.qapaqzito.enabled: .*/qapaq_ops.qapaqzito.enabled: true/" "$ROOT/config/opensearch_dashboards.yml"
else
  log 'Qapaqzito: sin QAPAQ_CLAUDE_API en secrets/services.env, asistente apagado'
fi
unset qapaqzito_key

# Analista IA (24/7): el proceso vive dentro del API y lo enciende QAPAQ_ANALYST_ENABLED. Por decisión
# del dueño queda ENCENDIDO por defecto; services.env puede apagarlo (QAPAQ_ANALYST_ENABLED=false) o
# cambiar el techo diario de gasto estimado (QAPAQ_ANALYST_DAILY_CEILING_USD, por defecto 2 USD).
# Sin clave de Claude no hay inferencia: el techo no se escribe y todo se resuelve por reglas.
# Lo que el admin elige en Analista IA → Configuración (modo, acciones, techo menor) se aplica
# encima de esto: la configuración solo puede restringir lo que el despliegue habilita.
if ! grep -q "'QAPAQ_ANALYST_ENABLED'" "$SRC/platform/configuration/src/schema/environment.schema.ts"; then
  log 'Analista IA: el código aún no admite QAPAQ_ANALYST_*; analista apagado'
else
  analyst_enabled="$(grep -s '^QAPAQ_ANALYST_ENABLED=' "$SECRETS/services.env" | tail -1 | cut -d= -f2- || true)"
  analyst_enabled="${analyst_enabled:-true}"
  [[ $analyst_enabled == true || $analyst_enabled == false ]] || {
    echo 'QAPAQ_ANALYST_ENABLED inválido en secrets/services.env (true|false)' >&2; exit 1;
  }
  printf 'QAPAQ_ANALYST_ENABLED=%s\n' "$analyst_enabled" >>"$ROOT/config/api.env"
  if [[ $analyst_enabled == true ]] && grep -q '^QAPAQ_QAPAQZITO_API_KEY=.' "$SECRETS/api.env"; then
    analyst_ceiling="$(grep -s '^QAPAQ_ANALYST_DAILY_CEILING_USD=' "$SECRETS/services.env" | tail -1 | cut -d= -f2- || true)"
    analyst_ceiling="${analyst_ceiling:-2}"
    [[ $analyst_ceiling =~ ^[0-9]{1,4}(\.[0-9]{1,2})?$ ]] || {
      echo 'QAPAQ_ANALYST_DAILY_CEILING_USD inválido en secrets/services.env' >&2; exit 1;
    }
    printf 'QAPAQ_ANALYST_DAILY_CEILING_USD=%s\n' "$analyst_ceiling" >>"$ROOT/config/api.env"
    log "Analista IA: encendido; techo diario estimado ${analyst_ceiling} USD"
  elif [[ $analyst_enabled == true ]]; then
    log 'Analista IA: encendido sin clave de Claude; solo reglas deterministas (sin inferencia)'
  else
    log 'Analista IA: apagado por secrets/services.env'
  fi
  unset analyst_enabled analyst_ceiling
fi

# Teams Workflow: el webhook firmado es una credencial y solo vive en services.env (0600).
# Se copia al env privado del API para activar el transporte SOC ya implementado; si no existe,
# el canal queda apagado. Nunca mostrar ni pasar la URL por argumentos o logs.
sed -i '/^QAPAQ_TEAMS_WORKFLOW_URL=/d' "$SECRETS/api.env"
teams_workflow_url="$(grep -s '^QAPAQ_TEAMS_WORKFLOW_URL=.' "$SECRETS/services.env" | cut -d= -f2- || true)"
if [[ -n $teams_workflow_url ]]; then
  [[ $teams_workflow_url != *$'\n'* && $teams_workflow_url != *$'\r'* ]] || {
    echo 'Teams Workflow URL inválida en secrets/services.env' >&2; exit 1;
  }
  printf 'QAPAQ_TEAMS_WORKFLOW_URL=%s\n' "$teams_workflow_url" >>"$SECRETS/api.env"
  chmod 600 "$SECRETS/api.env"
  log 'Teams: webhook de alertas de revisión configurado'
else
  log 'Teams: falta QAPAQ_TEAMS_WORKFLOW_URL en secrets/services.env; notificaciones apagadas'
fi
unset teams_workflow_url

# Respaldo por correo: el buzón remitente (UPN) también vive en services.env y se copia igual que
# el webhook de Teams. Sin él, el canal de correo queda «sin configurar» y el respaldo de un P1 es
# solo la bandeja. Guarda: el código debe admitir la variable (una desconocida tumba el arranque)
# y el valor debe ser una dirección de una sola línea. La dirección no se muestra en el log.
sed -i '/^QAPAQ_ALERT_MAIL_SENDER=/d' "$SECRETS/api.env"
alert_mail_sender="$(grep -s '^QAPAQ_ALERT_MAIL_SENDER=.' "$SECRETS/services.env" | cut -d= -f2- || true)"
if ! grep -q "'QAPAQ_ALERT_MAIL_SENDER'" "$SRC/platform/configuration/src/schema/environment.schema.ts"; then
  log 'Correo: el código aún no admite QAPAQ_ALERT_MAIL_SENDER; respaldo por correo apagado'
elif [[ -n $alert_mail_sender ]]; then
  [[ $alert_mail_sender =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$ ]] || {
    echo 'QAPAQ_ALERT_MAIL_SENDER inválido en secrets/services.env' >&2; exit 1;
  }
  printf 'QAPAQ_ALERT_MAIL_SENDER=%s\n' "$alert_mail_sender" >>"$SECRETS/api.env"
  chmod 600 "$SECRETS/api.env"
  log 'Correo: buzón remitente del respaldo configurado'
else
  log 'Correo: falta QAPAQ_ALERT_MAIL_SENDER en secrets/services.env; respaldo por correo sin configurar'
fi
unset alert_mail_sender

COMPOSE=(docker compose --env-file "$SECRETS/compose.env" -f "$WD/docker-compose.yml" -f "$HOST_DIR/compose.qapaq.yaml")
# Con Ankay ya desplegado (deploy-respond.sh), el proyecto incluye sus servicios.
[[ -d $ROOT/respond/frontend ]] && COMPOSE+=(-f "$HOST_DIR/compose.respond.yaml")

# --- 5. Certificado público (HTTP-01 con webroot servido por un nginx temporal) ------
if [[ ! -s /etc/letsencrypt/live/$SOC_HOSTNAME/fullchain.pem ]]; then
  log "emitiendo certificado Let's Encrypt para $SOC_HOSTNAME"
  docker rm -f qapaq-acme >/dev/null 2>&1 || true
  docker run -d --name qapaq-acme -p 80:80 -v /var/www/certbot:/usr/share/nginx/html:ro nginx:1.29.3 >/dev/null
  certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --webroot --webroot-path /var/www/certbot -d "$SOC_HOSTNAME"
  docker rm -f qapaq-acme >/dev/null
fi
SOC_HOSTNAME="$SOC_HOSTNAME" envsubst '${SOC_HOSTNAME}' <"$HOST_DIR/edge.conf.template" >"$ROOT/config/edge.conf"
chmod 0644 "$ROOT/config/edge.conf"
cat >/etc/letsencrypt/renewal-hooks/deploy/qapaq-edge.sh <<'EOF'
#!/bin/sh
docker exec qapaq-edge-1 nginx -s reload || true
EOF
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/qapaq-edge.sh

# --- 6. Build y arranque -----------------------------------------------------
# SKIP_API_BUILD=1: conserva las imágenes vigentes del API y del migrador (p. ej. si apps/api
# tiene trabajo en curso que aún no compila).
if [[ ${SKIP_API_BUILD:-0} == 1 ]]; then
  log 'construyendo imagen del dashboard QAPAQ (API, migrador, correlador e informes sin cambios)'
  "${COMPOSE[@]}" build wazuh.dashboard
else
  log 'construyendo imágenes (dashboard QAPAQ, API, migrador, correlador e informes)'
  "${COMPOSE[@]}" --profile tools build wazuh.dashboard api migrator correlator reports
fi
log 'arrancando Wazuh y PostgreSQL'
"${COMPOSE[@]}" up -d wazuh.indexer wazuh.manager postgres --wait

# The aws-events receiver must not write until its JSONL target and Wazuh localfile are ready.
# The installer validates and rolls back an invalid ossec.conf before restarting only Manager.
log 'instalando localfile y reglas AWS en Wazuh'
QAPAQ_RESTART=true bash "$SRC/wazuh/aws-events/install-aws-events.sh"
log 'arrancando receptor AWS después de preparar el localfile'
"${COMPOSE[@]}" up -d --wait aws-events

log 'roles de base de datos'
# Las contraseñas viajan por variables de entorno del exec (\getenv), no por argumentos.
{
  printf '%s\n' '\getenv mig QAPAQ_MIG' '\getenv run QAPAQ_RUN' 'BEGIN;' \
    "SELECT set_config('qapaq.migrator_password', :'mig', true), set_config('qapaq.runtime_password', :'run', true);"
  cat "$SRC/platform/database/bootstrap/roles.sql"
  echo 'COMMIT;'
} | QAPAQ_MIG="$QAPAQ_MIGRATOR_PASSWORD" QAPAQ_RUN="$QAPAQ_RUNTIME_PASSWORD" "${COMPOSE[@]}" exec -T \
  -e QAPAQ_MIG -e QAPAQ_RUN postgres psql -v ON_ERROR_STOP=1 -U qapaq_admin -d qapaq_secops -q -f - >/dev/null
log 'migraciones'
"${COMPOSE[@]}" --profile tools run --rm migrator migrate

log 'proxy auth QAPAQ en el indexer (solo desde la IP del dashboard)'
INDEXER_ADMIN_PASSWORD="$INDEXER_ADMIN_PASSWORD" bash "$SRC/infra/aws-poweruser/scripts/apply-indexer-security.sh"

log 'ingesta sin Entra: lector, token y gateway'
INDEXER_ADMIN_PASSWORD="$INDEXER_ADMIN_PASSWORD" bash "$SRC/infra/aws-poweruser/scripts/setup-ingestion.sh"
if [[ ${SKIP_API_BUILD:-0} != 1 ]]; then
  log 'preparando secretos del correlador privado'
  bash "$SRC/infra/aws-poweruser/scripts/bootstrap-correlator.sh"
  log 'preparando el token del servicio de informes de Qapaqzito'
  bash "$SRC/infra/aws-poweruser/scripts/bootstrap-reports.sh"
else
  log 'SKIP_API_BUILD=1: correlador e informes omitidos para conservar el contrato API desplegado'
fi
# Informes de Qapaqzito: el servicio debe estar sano antes de recrear el API que lo consume.
if [[ ${SKIP_API_BUILD:-0} != 1 ]]; then
  log 'arrancando el servicio de informes de Qapaqzito'
  "${COMPOSE[@]}" up -d --wait reports
fi
"${COMPOSE[@]}" up -d --force-recreate wazuh-gateway

log 'contenido QAPAQ del manager (reglas, grupos, integraciones sin activar)'
bash "$SRC/infra/aws-poweruser/scripts/setup-wazuh-content.sh"
log 'agente Wazuh del propio nodo'
bash "$SRC/infra/aws-poweruser/scripts/setup-host-agent.sh"

log 'arrancando dashboard, API y edge'
log 'preparando volumen compartido de logs del edge'
"${COMPOSE[@]}" exec -T wazuh.manager sh -c \
  'install -d -o wazuh -g wazuh -m 0750 /var/ossec/logs/qapaq-collectors/edge && touch /var/ossec/logs/qapaq-collectors/edge/access.json /var/ossec/logs/qapaq-collectors/edge/error.log && chown wazuh:wazuh /var/ossec/logs/qapaq-collectors/edge/access.json /var/ossec/logs/qapaq-collectors/edge/error.log'
"${COMPOSE[@]}" up -d --force-recreate wazuh.dashboard api edge
if [[ ${SKIP_API_BUILD:-0} != 1 ]]; then
  log 'arrancando correlador privado (emisión controlada por correlator.env)'
  "${COMPOSE[@]}" up -d --force-recreate --wait correlator
fi
bash "$SRC/infra/aws-poweruser/scripts/bootstrap-wazuh-app.sh"
bash "$SRC/infra/aws-poweruser/scripts/bootstrap-detection-content.sh"
"${COMPOSE[@]}" ps --format 'table {{.Name}}\t{{.Status}}'
log 'listo'
