#!/bin/bash
# Bootstrap base del nodo QAPAQ SecOps (sin secretos). El runtime lo instala el operador con
# infra/aws-poweruser/scripts/deploy-host.sh por SSH.
set -euxo pipefail
exec > >(tee -a /var/log/qapaq-cloud-init.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg jq openssl unattended-upgrades

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

# Requisito del Wazuh Indexer.
echo 'vm.max_map_count=262144' > /etc/sysctl.d/99-wazuh.conf
sysctl --system

install -d -m 0755 /opt/qapaq
install -d -m 0700 /opt/qapaq/secrets
touch /var/lib/qapaq-cloud-init.done
