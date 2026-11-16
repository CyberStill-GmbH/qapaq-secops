#!/usr/bin/env bash
# Copia el árbol de trabajo de qapaq-secops al nodo y ejecuta deploy-host.sh.
# Acceso directo: SSH_KEY=<clave> HOST=<ip> SOC_HOSTNAME=dev.security.qapaq.pe .../ship.sh
# EC2 Instance Connect: EC2_INSTANCE_ID=i-... AWS_REGION=us-east-1 SOC_HOSTNAME=... .../ship.sh
# Nunca envía .env* (credenciales locales), .git, node_modules ni salidas locales.
set -euo pipefail
: "${SOC_HOSTNAME:?}"
[[ $SOC_HOSTNAME =~ ^[A-Za-z0-9.-]{1,253}$ && $SOC_HOSTNAME != *..* ]] || {
  echo 'SOC_HOSTNAME inválido' >&2
  exit 64
}
SKIP_API_BUILD="${SKIP_API_BUILD:-0}"
[[ $SKIP_API_BUILD == 0 || $SKIP_API_BUILD == 1 ]] || { echo 'SKIP_API_BUILD debe ser 0 o 1' >&2; exit 64; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%S)-$(printf '%04x' "$RANDOM")"
REMOTE_STAGE="/opt/qapaq/staging/$RELEASE_ID"
REMOTE_HELPER="$REMOTE_STAGE/infra/aws-poweruser/scripts/deploy-staged-host.sh"

EC2_INSTANCE_ID="${EC2_INSTANCE_ID:-}"
EIC_TEMP_DIR=''
EIC_PUBLIC_KEY=''
cleanup_eic_temp() {
  if [[ -n $EIC_TEMP_DIR ]]; then
    rm -f -- "$EIC_TEMP_DIR/id_ed25519" "$EIC_TEMP_DIR/id_ed25519.pub" \
      "$EIC_TEMP_DIR/provided_key.pub"
    rmdir -- "$EIC_TEMP_DIR" 2>/dev/null || true
  fi
}

if [[ -n $EC2_INSTANCE_ID ]]; then
  AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  : "${AWS_REGION:?AWS_REGION es obligatorio para EC2 Instance Connect}"
  [[ $EC2_INSTANCE_ID =~ ^i-[0-9a-f]{8,17}$ ]] || {
    echo 'EC2_INSTANCE_ID inválido' >&2
    exit 64
  }
  [[ $AWS_REGION =~ ^[a-z0-9]+(-[a-z0-9]+)+-[0-9]+$ ]] || {
    echo 'AWS_REGION inválida' >&2
    exit 64
  }
  command -v aws >/dev/null || { echo 'aws CLI es obligatorio para EC2 Instance Connect' >&2; exit 69; }
  command -v ssh-keygen >/dev/null || { echo 'ssh-keygen es obligatorio para EC2 Instance Connect' >&2; exit 69; }
  command -v mktemp >/dev/null || { echo 'mktemp es obligatorio para EC2 Instance Connect' >&2; exit 69; }

  EIC_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qapaq-eice.XXXXXXXX")"
  chmod 700 "$EIC_TEMP_DIR"
  trap cleanup_eic_temp EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [[ -z ${SSH_KEY:-} ]]; then
    SSH_KEY="$EIC_TEMP_DIR/id_ed25519"
    ssh-keygen -q -t ed25519 -N '' -f "$SSH_KEY" -C "qapaq-eice-$$" >/dev/null
  else
    [[ -r $SSH_KEY ]] || { echo 'SSH_KEY no es legible' >&2; exit 66; }
    EIC_PUBLIC_KEY="$EIC_TEMP_DIR/provided_key.pub"
    if [[ -r ${SSH_KEY}.pub ]]; then
      cp -- "${SSH_KEY}.pub" "$EIC_PUBLIC_KEY"
    else
      ssh-keygen -y -f "$SSH_KEY" >"$EIC_PUBLIC_KEY"
    fi
  fi
  EIC_PUBLIC_KEY="${EIC_PUBLIC_KEY:-${SSH_KEY}.pub}"
  chmod 600 "$SSH_KEY" "$EIC_PUBLIC_KEY"

  INSTANCE_AZ="$(aws ec2 describe-instances --instance-ids "$EC2_INSTANCE_ID" \
    --region "$AWS_REGION" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' \
    --output text)"
  [[ -n $INSTANCE_AZ && $INSTANCE_AZ != None ]] || {
    echo 'No se pudo resolver la zona de disponibilidad de la instancia EIC' >&2
    exit 1
  }
  SSH_TARGET="ubuntu@$EC2_INSTANCE_ID"
  SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
    -o "ProxyCommand=aws ec2-instance-connect open-tunnel --instance-id $EC2_INSTANCE_ID --region $AWS_REGION" \
    "$SSH_TARGET")
else
  : "${SSH_KEY:?}" "${HOST:?}"
  [[ -r $SSH_KEY ]] || { echo 'SSH_KEY no es legible' >&2; exit 66; }
  SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "ubuntu@$HOST")
fi

ssh_remote() {
  if [[ -n $EC2_INSTANCE_ID ]]; then
    local success
    success="$(aws ec2-instance-connect send-ssh-public-key \
      --instance-id "$EC2_INSTANCE_ID" \
      --availability-zone "$INSTANCE_AZ" \
      --instance-os-user ubuntu \
      --ssh-public-key "$(<"$EIC_PUBLIC_KEY")" \
      --region "$AWS_REGION" \
      --query Success --output text)"
    [[ $success == True ]] || {
      echo 'EC2 Instance Connect rechazó la clave SSH temporal' >&2
      return 1
    }
  fi
  "${SSH[@]}" "$@"
}

entra_client_secret=''
if [[ -f $REPO/.env ]]; then
  entra_client_secret="$(sed -n 's/^export[[:space:]]\+CLIENT_SECRET=//p; s/^CLIENT_SECRET=//p' "$REPO/.env" | head -n1 | tr -d '\r')"
  entra_client_secret="${entra_client_secret%\"}"; entra_client_secret="${entra_client_secret#\"}"
  entra_client_secret="${entra_client_secret%\'}"; entra_client_secret="${entra_client_secret#\'}"
  [[ -n $entra_client_secret ]] || { echo 'falta CLIENT_SECRET en .env' >&2; exit 1; }
fi

tar -C "$REPO" -czf - \
  --exclude='./.git' --exclude='./.env' --exclude='./.env.*' --exclude='*/.env' \
  --exclude='node_modules' --exclude='./.aws' --exclude='./.codex' \
  --exclude='./.local' --exclude='./.claude' --exclude='./.agents' \
  --exclude='pytest-cache-files-*' --exclude='.pytest-tmp-wazuh-agent' \
  --exclude='./output' --exclude='./artifacts' --exclude='./test-results' \
  --exclude='.terraform' --exclude='*.tfplan' --exclude='*.tfstate*' \
  . | ssh_remote "sudo install -d -o root -g root -m 0755 /opt/qapaq/staging && sudo mkdir -m 0755 '$REMOTE_STAGE' && sudo tar -C '$REMOTE_STAGE' -xzf - && sudo find '$REMOTE_STAGE' -type f \\( -name '*.sh' -o -name '*.tsv' -o -name '*.yml' -o -name '*.yaml' -o -name '*.template' -o -name '*.conf' \\) -exec sed -i 's/\\r$//' {} +"

# Staging is unique and does not change the live source tree. The remote helper acquires the
# same nonblocking lock as direct deploy-host.sh, atomically switches /opt/qapaq/src and runs the
# deployment before releasing it. If another deployment is active, activation fails without
# replacing or deleting that deployment's code.
if [[ -n $entra_client_secret ]]; then
  # El secreto se transmite por stdin únicamente; ni .env ni el valor aparecen en argumentos/logs.
  printf 'QAPAQ_ENTRA_CLIENT_SECRET=%s\n' "$entra_client_secret" | ssh_remote \
    "sudo flock -n /run/lock/qapaq-wazuh-deploy.lock env QAPAQ_DEPLOY_LOCK_HELD=1 bash '$REMOTE_HELPER' '$RELEASE_ID' '$SOC_HOSTNAME' '$SKIP_API_BUILD' 1"
  unset entra_client_secret
else
  ssh_remote "sudo flock -n /run/lock/qapaq-wazuh-deploy.lock env QAPAQ_DEPLOY_LOCK_HELD=1 bash '$REMOTE_HELPER' '$RELEASE_ID' '$SOC_HOSTNAME' '$SKIP_API_BUILD' 0"
fi
