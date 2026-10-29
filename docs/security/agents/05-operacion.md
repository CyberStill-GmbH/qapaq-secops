# Operación de agentes: salud, desconectados, volumen y actualizaciones

**Estado:** runbook para cuando haya agentes inscritos. Los comandos son de solo lectura salvo
donde se indica; todos se ejecutan en el manager (`app.jappi.net.pe`) o con el API de Wazuh.
Credenciales del API: archivo materializado desde Key Vault (`WAZUH_API_CREDENTIALS`), usuario
`readonly` salvo para eliminar agentes.

## 1. Indicadores de salud (SLI) y objetivos

| SLI | Fuente | Objetivo | Alerta |
|---|---|---|---|
| Agentes activos / inscritos por perfil | `GET /agents/summary/status` | ≥ 98 % servidores y DC; ≥ 90 % estaciones (apagadas fuera de horario) | Un DC o servidor crítico desconectado > 15 min = **P2**; > 1 h = **P1** (pérdida de visibilidad sobre tier 0) |
| Antigüedad del último keepalive | `lastKeepAlive` | < 2 min conectados | Ver arriba |
| Versión | `GET /agents?select=version` | 100 % `Wazuh v4.14.8` | Cualquier otra versión |
| Cola del agente | `wazuh-agentd.state` (`msg_buffer`) | < 50 % de `queue_size` | Sostenido > 80 % = EPS fuera de perfil |
| EPS por perfil | `wazuh-analysisd.state` y `stats/agents` | Dentro de 2× la estimación de [02](02-perfiles-de-agente.md) §2 | Desvío = revisar §3 |
| Silencio de canal | Último evento por `agent.labels.qapaq_profile` y `win.system.channel` | DC con Security en los últimos 10 min | Silencio = posible manipulación (T1562.002) |

Un DC que deja de enviar Security pero sigue conectado es más grave que uno desconectado: la
regla 101601/101600 cubre el cambio de auditoría o el borrado; el silencio lo cubre la consulta
de §2.3.

## 2. Procedimientos

### 2.1 Revisión diaria (5 min)

```bash
export WAZUH_API_CREDENTIALS=/run/qapaq/wazuh-api-readonly
python3 infra/wazuh/agents/tools/verify_agent.py disconnected --older-than-minutes 30
```

VERIFY: la lista vacía o explicada (estaciones apagadas, portátiles fuera de la VPN). Cada
servidor o DC en la lista abre una alerta P2 en QAPAQ con el dueño del activo.

### 2.2 Agente desconectado

1. ¿Equipo encendido y con red? Preguntar al dueño del activo o revisar Sophos Central/Cato.
2. En el equipo: `Get-Service WazuhSvc` / `systemctl status wazuh-agent`; últimas líneas de
   `ossec.log` buscando `ERROR`.
3. Conectividad: `Test-NetConnection app.jappi.net.pe -Port 1514`. Si falla, la IP pública
   de salida no está en `siem_host.agent_public_cidrs` (Infra QAPAQ).
4. Si conecta pero no autentica (`Invalid key`): el agente fue eliminado o re-inscrito en el
   manager. Reinscribir con el instalador (lee la contraseña vigente de Key Vault).
5. Si no hay explicación operativa en un servidor crítico: tratar como posible evasión
   (T1562.001) y escalar al líder SOC.

### 2.3 Canal silencioso en un DC

En Discover (`wazuh-alerts-*`): `agent.labels.qapaq_profile:dc and data.win.system.channel:Security`
en los últimos 15 min. Sin resultados con el agente conectado: comprobar la GPO de auditoría
(`auditpol /get /category:*`) y el evento 4719 en el DC. Escalar como P1 si la auditoría cambió
sin cambio aprobado.

### 2.4 Inventario y SCA tras instalar

```bash
python3 infra/wazuh/agents/tools/verify_agent.py agent --name <fqdn> --group <grupo>
```

El primer escaneo de syscollector y SCA llega al iniciar el agente (`scan_on_start`), salvo en
portátiles (FIM sin escaneo al arranque; syscollector sí).

## 3. Volumen y costo de ingesta

1. Medir por perfil en el piloto: en el agente, `wazuh-logcollector.state` (eventos por
   `location`); en el manager, `GET /agents/{id}/stats/logcollector`.
2. Identificar el canal dominante. Ajustar primero la **fuente** (XPath del `agent.conf`, regla
   Sysmon de inclusión), después la regla Wazuh. Nunca subir `events_per_second` del
   `client_buffer` para "dejar pasar" un pico: es la protección del manager.
3. Registrar el EPS medido en `profile-catalog.json` (`estimatedEps`) en el mismo PR que el
   ajuste.

Palancas por orden de impacto: 4624 tipo 3 y 4768/4769 sin filtro en DC (excluidos), Sysmon 3/7/22
(apagados o por inclusión), PowerShell 4104 completo (solo DC y sensibles), IIS en servidores
web muy concurridos (filtrar rutas de salud con `<ignore>` en el `localfile`).

## 4. Altas, bajas y cambios de perfil

| Operación | Cómo | Notas |
|---|---|---|
| Alta | Instalador con `-Group`/`--group` o `auto` | El grupo se fija en la inscripción |
| Cambio de perfil | `/var/ossec/bin/agent_groups -a -i <id> -g <grupo> -f` (sobrescribe) | Un agente, un perfil: usar `-f` para que no quede en dos grupos |
| Baja | Desinstalar en el equipo y eliminar en el manager | `DELETE /agents?agents_list=<id>&status=all&older_than=0s` (usuario con permiso de escritura, registrado en el cambio) |
| Limpieza | Agentes `never_connected` > 7 días | Revisión mensual; eliminar solo con ticket |

Al cambiar un equipo de perfil, actualizar también las listas CDB (`qapaq-critical-assets`, etc.)
y las variables `QAPAQ_DETECTION_*` del núcleo: el perfil decide qué se recoge; la lista decide
cuánto pesa.

## 5. Actualizaciones del agente

1. El agente **nunca** es más nuevo que el manager. Los instaladores lo impiden y Linux bloquea
   el paquete (`apt-mark hold` / `dnf versionlock`).
2. Orden: manager primero (fuera de este runbook), luego piloto por perfil, luego olas.
3. Nueva versión = nuevo manifiesto: actualizar `wazuhVersion`, ejecutar los scripts de
   construcción (hashes y firmas), PR, y el instalador ejecuta la actualización in situ (el MSI
   conserva `client.keys`).
4. Wazuh también ofrece actualización remota de agentes desde el manager (WPK). No se usa: un
   WPK no pasa por el manifiesto ni la verificación de hash de QAPAQ.

VERIFY tras una ola: §1 versión al 100 % en la ola y §2.1 sin nuevos desconectados.

## 6. Cambios a perfiles y reglas

Todo cambio pasa por PR: el workflow `wazuh-priority-agents.yml` valida los `agent.conf` con
`verify-agent-conf` y las reglas con los 63 casos `wazuh-logtest`. En el manager se aplica con
`apply-agent-groups.sh` / `apply-priority.sh`, que respaldan y validan antes de dejar el cambio.

## 7. Escalamiento

| Severidad operativa | Ejemplo | Responsable | Escala a |
|---|---|---|---|
| P1 | DC o core sin telemetría > 1 h sin explicación; auditoría desactivada | Analista de turno | Líder SOC → Plataforma |
| P2 | Servidor desconectado > 15 min; EPS de un perfil > 2× | Analista de turno | Líder SOC |
| P3 | Estaciones con versión distinta; SCA sin resultados | Cola SOC | — |

Contactos nominales y horario de guardia: TO_BE_PROVIDED (cuestionario N1/N2).
