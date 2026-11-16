# Agentes Wazuh hacia el SOC QAPAQ (nodo PowerUser)

Manager: **`agents.dev.security.qapaq.pe`** (A → EIP del nodo; el ALB de `dev.security.qapaq.pe`
no transporta estos puertos). Versión: **Wazuh 4.14.8**.

| Puerto | Uso | Protección |
| --- | --- | --- |
| TCP 1515 | Enrolamiento (authd) | Contraseña obligatoria (`use_password=yes`); sin ella el manager responde `Invalid password` |
| TCP 1514 | Comunicación del agente (remoted, solo TCP) | Clave por agente emitida en el enrolamiento (`connection=secure`) |

La apertura en el SG la controla `agent_cidrs` (Terraform). Hoy está abierta a Internet (0.0.0.0/0, aprobado por el dueño el 2026-11-03) solo para 1514/1515.
Cambiarla es decisión explícita del dueño. Usar CIDR acotados cuando se conozcan.

## Contraseña de enrolamiento

Se genera en el host y nunca se versiona:

```bash
ssh -i <clave> ubuntu@<EIP> 'sudo cat /opt/qapaq/secrets/wazuh-authd.pass'
```

Distribuirla por un canal seguro (gestor de secretos o MDM), no por correo ni chat.

## Grupos disponibles

`linux-pilot`, `windows-pilot`, `windows-sysmon-pilot`, `windows-domain-controller` (configuración
centralizada en `infra/wazuh/*/agent-groups`). Sin grupo, el agente queda en `default`.

## Linux (Debian/Ubuntu)

```bash
curl -fsSL https://packages.wazuh.com/key/GPG-KEY-WAZUH | sudo gpg --dearmor -o /usr/share/keyrings/wazuh.gpg
echo 'deb [signed-by=/usr/share/keyrings/wazuh.gpg] https://packages.wazuh.com/4.x/apt/ stable main' \
  | sudo tee /etc/apt/sources.list.d/wazuh.list
sudo apt-get update
sudo WAZUH_MANAGER=agents.dev.security.qapaq.pe WAZUH_AGENT_GROUP=linux-pilot \
  apt-get install -y wazuh-agent=4.14.8-1
sudo apt-mark hold wazuh-agent
# La contraseña va en archivo (no en el historial ni en argumentos):
sudo install -o root -g wazuh -m 0640 /ruta/segura/authd.pass /var/ossec/etc/authd.pass
sudo systemctl enable --now wazuh-agent
```

RHEL/Amazon Linux: igual con el repositorio `https://packages.wazuh.com/4.x/yum/` y
`sudo WAZUH_MANAGER=… yum install -y wazuh-agent-4.14.8-1`.

## Windows (PowerShell como administrador)

```powershell
$msi = "$env:TEMP\wazuh-agent-4.14.8-1.msi"
Invoke-WebRequest https://packages.wazuh.com/4.x/windows/wazuh-agent-4.14.8-1.msi -OutFile $msi
# Verificar el hash publicado por Wazuh antes de instalar.
msiexec.exe /i $msi /q WAZUH_MANAGER="agents.dev.security.qapaq.pe" WAZUH_AGENT_GROUP="windows-pilot"
# Contraseña en archivo, solo legible por administradores:
Copy-Item \\ruta\segura\authd.pass "C:\Program Files (x86)\ossec-agent\authd.pass"
icacls "C:\Program Files (x86)\ossec-agent\authd.pass" /inheritance:r /grant:r "Administrators:R" "SYSTEM:R"
NET START WazuhSvc
```

Controladores de dominio: grupo `windows-domain-controller`. Con Sysmon instalado: `windows-sysmon-pilot`.

## Verificación

En el SIEM (`https://dev.security.qapaq.pe`) → Wazuh → Agentes: el agente aparece `active`. Desde el
host: `GET /agents` de la API del manager (127.0.0.1:55000).

## Estado probado (2026-11-03)

- El propio nodo está enrolado como agente `001 qapaq-soc-dev-node` (grupo `linux-pilot`, `active`)
  con la contraseña generada (`scripts/setup-host-agent.sh`).
- Enrolamiento con contraseña incorrecta: `agent-auth: ERROR: Invalid password`.
