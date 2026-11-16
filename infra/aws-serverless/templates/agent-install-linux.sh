#!/bin/bash
# Instalación idempotente del agente Wazuh en Linux (apt, dnf o yum), ejecutada por SSM.
# Los valores {{ ... }} los sustituye SSM con los parámetros del documento.
set -euo pipefail

MANAGER='{{ ManagerAddress }}'
SECRET_ARN='{{ RegistrationSecretArn }}'
REGION='{{ Region }}'
VERSION='{{ WazuhVersion }}'
DEFAULT_GROUP='{{ DefaultGroup }}'
GROUP_TAG='{{ GroupTagKey }}'
OSSEC_CONF=/var/ossec/etc/ossec.conf

# 1. Idempotencia: si ya está activo y apunta al manager, no hace nada.
if systemctl is-active --quiet wazuh-agent 2>/dev/null \
  && grep -q "<address>$MANAGER</address>" "$OSSEC_CONF" 2>/dev/null; then
  echo "wazuh-agent ya activo y apuntando a $MANAGER; sin cambios."
  exit 0
fi

if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
else echo "Gestor de paquetes no soportado" >&2; exit 1
fi

pkg_install() {
  if [ "$PM" = apt ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  else
    "$PM" install -y "$@"
  fi
}

[ "$PM" = apt ] && apt-get update -y
command -v curl >/dev/null 2>&1 || pkg_install curl
command -v unzip >/dev/null 2>&1 || pkg_install unzip
command -v gpg >/dev/null 2>&1 || pkg_install gnupg

# 2. AWS CLI v2 si falta.
if ! command -v aws >/dev/null 2>&1; then
  ARCH="$(uname -m)"
  case "$ARCH" in x86_64|aarch64) ;; *) echo "Arquitectura no soportada: $ARCH" >&2; exit 1 ;; esac
  TMP="$(mktemp -d)"
  curl -fsSLo "$TMP/awscliv2.zip" "https://awscli.amazonaws.com/awscli-exe-linux-$ARCH.zip"
  unzip -q "$TMP/awscliv2.zip" -d "$TMP"
  "$TMP/aws/install" --update
  rm -rf "$TMP"
  export PATH="/usr/local/bin:$PATH"
fi

# 3. Grupo y nombre: tag por IMDSv2 (requiere tags en metadatos) o DescribeTags; si no, default.
GROUP="$DEFAULT_GROUP"
NAME="$(hostname -s)"
TOKEN="$(curl -fsS -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null || true)"
if [ -n "$TOKEN" ]; then
  IID="$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)"
  TAG_VALUE="$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/tags/instance/$GROUP_TAG" 2>/dev/null || true)"
  if [ -z "$TAG_VALUE" ] && [ -n "$IID" ]; then
    TAG_VALUE="$(aws ec2 describe-tags --region "$REGION" \
      --filters "Name=resource-id,Values=$IID" "Name=key,Values=$GROUP_TAG" \
      --query 'Tags[0].Value' --output text 2>/dev/null || true)"
  fi
  [ "$TAG_VALUE" = "None" ] && TAG_VALUE=""
  [ -n "$TAG_VALUE" ] && GROUP="$TAG_VALUE"
  [ -n "$IID" ] && NAME="$NAME-$IID"
fi
if ! [[ "$GROUP" =~ ^[A-Za-z0-9_.,-]{1,255}$ ]]; then GROUP="$DEFAULT_GROUP"; fi

# 4. Contraseña de registro (con el rol de la instancia o las credenciales del nodo híbrido).
REG_PASSWORD="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ARN" \
  --query SecretString --output text)"

# 5. Instalación o reconfiguración.
if [ -x /var/ossec/bin/wazuh-control ]; then
  echo "wazuh-agent instalado pero inactivo o con otro manager; se reconfigura."
  sed -i -E "s#<address>[^<]*</address>#<address>$MANAGER</address>#" "$OSSEC_CONF"
else
  if [ "$PM" = apt ]; then
    curl -fsSL https://packages.wazuh.com/key/GPG-KEY-WAZUH \
      | gpg --dearmor --yes -o /usr/share/keyrings/wazuh.gpg
    chmod 644 /usr/share/keyrings/wazuh.gpg
    echo "deb [signed-by=/usr/share/keyrings/wazuh.gpg] https://packages.wazuh.com/4.x/apt/ stable main" \
      > /etc/apt/sources.list.d/wazuh.list
    apt-get update -y
    WAZUH_MANAGER="$MANAGER" WAZUH_REGISTRATION_PASSWORD="$REG_PASSWORD" \
      WAZUH_AGENT_GROUP="$GROUP" WAZUH_AGENT_NAME="$NAME" \
      DEBIAN_FRONTEND=noninteractive apt-get install -y "wazuh-agent=$VERSION-1"
    apt-mark hold wazuh-agent || true
    sed -i 's/^deb /#deb /' /etc/apt/sources.list.d/wazuh.list
  else
    rpm --import https://packages.wazuh.com/key/GPG-KEY-WAZUH
    cat > /etc/yum.repos.d/wazuh.repo <<'REPO'
[wazuh]
gpgcheck=1
gpgkey=https://packages.wazuh.com/key/GPG-KEY-WAZUH
enabled=1
name=EL-$releasever - Wazuh
baseurl=https://packages.wazuh.com/4.x/yum/
protect=1
REPO
    WAZUH_MANAGER="$MANAGER" WAZUH_REGISTRATION_PASSWORD="$REG_PASSWORD" \
      WAZUH_AGENT_GROUP="$GROUP" WAZUH_AGENT_NAME="$NAME" \
      "$PM" install -y "wazuh-agent-$VERSION-1"
    sed -i 's/^enabled=1/enabled=0/' /etc/yum.repos.d/wazuh.repo
  fi
fi

# La contraseña también queda en authd.pass para re-registros automáticos del agente.
umask 027
printf '%s' "$REG_PASSWORD" > /var/ossec/etc/authd.pass
chown root:wazuh /var/ossec/etc/authd.pass 2>/dev/null || true
chmod 640 /var/ossec/etc/authd.pass
unset REG_PASSWORD

systemctl daemon-reload
systemctl enable wazuh-agent
systemctl restart wazuh-agent
echo "wazuh-agent $VERSION activo; manager=$MANAGER grupo=$GROUP nombre=$NAME"
