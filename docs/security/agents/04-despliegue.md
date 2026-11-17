# Despliegue y rollback de agentes Wazuh 4.14.8

**Estado:** paquete preparado y probado en CI (sintaxis, invariantes, `verify-agent-conf`).
**No se desplegó nada**: ni grupos en el manager, ni agentes, ni cambios de firewall. Cada paso
de este runbook lo ejecuta QAPAQ con aprobación del dueño.

## 0. Requisitos previos (bloqueantes)

| # | Requisito | Cómo se verifica | Responsable |
|---|---|---|---|
| R1 | IP públicas de salida de cada sede/VPN en `siem_host.agent_public_cidrs` (DNAT 1514/1515 en el Firewall de Azure). Sin esto el agente no conecta. | `Test-NetConnection app.jappi.net.pe -Port 1515` desde un equipo piloto | Infra QAPAQ (Terraform, fuera de este PR) |
| R2 | Contraseña de inscripción del manager (`authd`, `use_password=yes`) en Key Vault como `wazuh-agent-enrollment-password`. | `az keyvault secret show --vault-name <kv> --name wazuh-agent-enrollment-password --query id` (sin `value`) | Plataforma |
| R3 | Hashes fijados en `deploy/package-manifest.json` (hoy `TO_BE_PROVIDED`). | `status: pinned` en el manifiesto | Operador de construcción (§3) |
| R4 | Política de auditoría avanzada por GPO (§2). | `auditpol /get /category:*` en un piloto | AD QAPAQ |
| R5 | Listas CDB reales (no `.example`) y `group-mapping.json` sin `TO_BE_PROVIDED`. | El aplicador y el instalador las rechazan si no | SOC + dueño (cuestionario) |
| R6 | Aprobación de privacidad para Sysmon 1 y PowerShell 4104 (Ley 29733). | Acta registrada | Dueño / Oficial de datos |

## 1. Arquitectura del paquete

```
infra/wazuh/agents/
├── shared/<grupo>/agent.conf       → /var/ossec/etc/shared/<grupo>/agent.conf (manager)
├── apply-agent-groups.sh           crea grupos e instala agent.conf con verify-agent-conf
├── group-mapping.example.json      OU / nombre → grupo (plantilla)
├── deploy/
│   ├── package-manifest.json       versión 4.14.8 + SHA-256 + verificación de firma
│   ├── Update-QapaqAgentManifest.ps1   construye MSI + Sysmon y fija hashes
│   ├── windows/Install-QapaqWazuhAgent.ps1, Install-QapaqSysmon.ps1, Uninstall-QapaqWazuhAgent.ps1
│   ├── windows/sysmon/qapaq-sysmon.xml
│   └── linux/install-qapaq-wazuh-agent.sh, uninstall-…, update-linux-manifest.sh, audit/qapaq.rules
└── tools/verify_agent.py           verificación desde el API del manager (solo lectura)
```

## 2. Política de auditoría de Windows (GPO)

Sin estas subcategorías los canales Security llegan vacíos. Valores *Éxito/Error* según la
columna. GPO: *Configuración del equipo → Directivas → Configuración de Windows → Configuración
de seguridad → Configuración avanzada de directivas de auditoría*. Habilitar también *Forzar la
configuración de subcategorías* (`SCENoApplyLegacyAuditPolicy`).

| Subcategoría | DC | Servidores | Estaciones | Eventos |
|---|---|---|---|---|
| Validación de credenciales | É/E | É/E | E | 4776 |
| Servicio de autenticación Kerberos / Operaciones de tickets de servicio | É/E | — | — | 4768, 4769, 4771 |
| Administración de cuentas de usuario / grupos de seguridad / equipos | É | É | É | 4720–4767 |
| Inicio de sesión / Bloqueo de cuenta | É/E | É/E | É/E | 4624, 4625, 4740 |
| Inicio de sesión con credenciales explícitas (Otros eventos de inicio) | É | É | É | 4648 |
| Cambio en la directiva de auditoría | É | É | É | 4719 |
| Acceso al servicio de directorio / Cambios del servicio de directorio | É | — | — | 4662, 5136–5141 |
| Otros eventos de acceso a objetos (tareas programadas) | É | É | É | 4698, 4702 |
| Extensión del sistema de seguridad | É | É | É | 4697 |
| Actividad PNP | — | — | É (sensibles) | 6416 |

Además: *Turn on PowerShell Script Block Logging* en DC y estaciones sensibles, y tamaño del log
Security ≥ 512 MB en DC (el agente lee en vivo; el tamaño cubre desconexiones).

## 3. Construir el paquete (una vez por versión)

En un equipo de construcción con acceso a Internet, no en endpoints:

```powershell
.\infra\wazuh\agents\deploy\Update-QapaqAgentManifest.ps1 -OutputDir D:\qapaq-build\wazuh-4.14.8
```

```bash
bash infra/wazuh/agents/deploy/linux/update-linux-manifest.sh /srv/qapaq-build/wazuh-4.14.8
```

VERIFY: `package-manifest.json` queda con `"status": "pinned"`; cada artefacto tiene SHA-256 de 64
hex; el MSI y `Sysmon64.exe` tienen firma Authenticode válida de *Wazuh, Inc.* y *Microsoft
Corporation*; los RPM pasan `rpm -K` y el `.deb` coincide con el índice APT firmado. La huella
GPG de Wazuh se fija la primera vez tras compararla con la documentación oficial.

Revisar y fusionar el cambio del manifiesto por PR (es la decisión de confiar en esos binarios) y
copiar el directorio de salida al recurso de despliegue de solo lectura (`\\<srv>\wazuh\4.14.8`,
TO_BE_PROVIDED). **Tiempo:** 20 min.

## 4. Sysmon: licencia y distribución

- Sysmon es software gratuito de Microsoft Sysinternals bajo los *Sysinternals Software License
  Terms*. No se versiona en este repositorio; se descarga de Microsoft al construir y se fija
  por hash.
- `-accepteula` acepta esos términos en nombre de QAPAQ: requiere que el dueño registre la
  aceptación (cuestionario L1).
- La copia en el recurso interno para instalar en equipos propios de QAPAQ se considera uso
  interno; **pendiente de validación legal** antes del despliegue masivo (L2).
- `qapaq-sysmon.xml` es obra propia de QAPAQ (no deriva de configuraciones de terceros).

## 5. Manager: grupos y reglas (sin reinicio para grupos)

```bash
sudo bash infra/wazuh/agents/apply-agent-groups.sh                 # los ocho grupos
sudo QAPAQ_PRIORITY_LISTS_DIR=/etc/qapaq/priority-lists \
     bash infra/wazuh/priority/apply-priority.sh                    # reglas + listas CDB
sudo QAPAQ_PRIORITY_LISTS_DIR=/etc/qapaq/priority-lists QAPAQ_PRIORITY_RESTART=true \
     bash infra/wazuh/priority/apply-priority.sh                    # en la ventana aprobada
```

VERIFY: `agent_groups -l` muestra los ocho `qapaq-*`; `verify-agent-conf` sin errores;
`wazuh-analysisd -t` correcto; `ossec.conf` contiene las cuatro `<list>`. Las listas reales
(`/etc/qapaq/priority-lists`) las materializa el host desde el inventario aprobado; el aplicador
rechaza claves `.example`. **Rollback:** ambos scripts guardan respaldo en
`/var/ossec/backup/qapaq-*`; restaurar el archivo y repetir `verify-agent-conf` /
`wazuh-analysisd -t`.

## 6. Piloto por perfil (obligatorio antes de la ola)

1. Elegir 1–2 equipos por perfil (cuestionario R4). Para DC, un DC no PDC.
2. Validar XPath en el equipo: `wevtutil qe Security /q:"<consulta del agent.conf>" /c:5 /f:text`.
   Si Windows devuelve *consulta no válida*, corregir antes de seguir.
3. Instalar (§7/§8) y medir 72 h: EPS por agente, alertas por regla, falsos positivos.
4. Comparar con la estimación de [02-perfiles-de-agente.md](02-perfiles-de-agente.md) §2 y
   ajustar. Registrar el resultado en el PR del perfil.

Criterio de salida: sin errores de logcollector, EPS dentro de 2× la estimación, ningún
falso positivo de nivel ≥ 12 sin explicación.

## 7. Windows

### GPO (equipos de dominio)

Script de inicio de equipo (se ejecuta como SYSTEM) desde el recurso de solo lectura:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\<srv>\wazuh\4.14.8\deploy\windows\Install-QapaqWazuhAgent.ps1 -Group auto -GroupMappingPath \\<srv>\wazuh\4.14.8\group-mapping.json -SecretSource ProtectedFile -ProtectedFilePath C:\ProgramData\QAPAQ\enroll.bin
```

### Intune

Win32 app con el mismo contenido (`.intunewin`), comando de instalación igual al anterior y regla
de detección: valor `DisplayVersion` = `4.14.8` en la clave de desinstalación *Wazuh Agent*.

### Servidores en Azure o con Azure Arc

```powershell
.\Install-QapaqWazuhAgent.ps1 -Group qapaq-srv-core -KeyVaultName <kv> -PackageDir \\<srv>\wazuh\4.14.8
```

La identidad administrada de la VM/Arc necesita el rol *Key Vault Secrets User* solo sobre ese
secreto (o el vault de inscripción).

### Contraseña de inscripción: cómo nunca queda en texto plano

| Fuente | Cuándo | Garantías |
|---|---|---|
| `ManagedIdentity` | VM de Azure o servidor con Azure Arc | Token de IMDS/Arc en memoria; secreto leído por REST; no toca disco salvo `authd.pass` |
| `AzPowerShell` | Operador con sesión `Connect-AzAccount` | `SecureString` hasta escribir `authd.pass` |
| `ProtectedFile` | Estaciones por GPO/Intune (sin identidad Azure) | Archivo entregado por la ola con ACL SYSTEM/Administradores; el script rechaza ACL amplias |

En todos los casos: la contraseña **no** se pasa como `WAZUH_REGISTRATION_PASSWORD` (quedaría en
argv y en el log del MSI); se escribe en `authd.pass` con ACL solo SYSTEM/Administradores, se
usa una vez y se sobrescribe y borra al obtener `client.keys`. Tras cada ola se **rota** la
contraseña en Key Vault y en el manager: los agentes inscritos no la necesitan más (usan su
clave en `client.keys`). Un `ProtectedFile` se genera por ola y se retira al cerrarla.

VERIFY (el script lo hace y deja `%ProgramData%\QAPAQ\wazuh-agent\install-summary.json`):
servicio `WazuhSvc` en ejecución, `client.keys` no vacío, `wazuh-agent.state` con
`status='connected'`. Código 2 = inscrito sin conexión (revisar R1).

### Sysmon

```powershell
.\Install-QapaqSysmon.ps1 -PackageDir \\<srv>\wazuh\4.14.8
```

VERIFY: servicio `Sysmon64` en ejecución y eventos en `Microsoft-Windows-Sysmon/Operational`.

## 8. Linux (deb/rpm)

```bash
sudo bash install-qapaq-wazuh-agent.sh --group qapaq-linux-server \
  --package-dir /srv/wazuh/4.14.8 --key-vault <kv> --audit-rules
```

El script verifica SHA-256, instala con `WAZUH_MANAGER`, `WAZUH_REGISTRATION_SERVER`,
`WAZUH_AGENT_GROUP` y `WAZUH_AGENT_NAME`, bloquea la versión (`apt-mark hold` /
`dnf versionlock`), inscribe con `authd.pass` (0640 root:wazuh, borrado con `shred`) y verifica
la conexión. Requiere `auditd` para `--audit-rules` y para FIM *whodata*.

## 9. Verificación desde el manager

```bash
WAZUH_API_CREDENTIALS=/run/qapaq/wazuh-api-readonly \
  python3 infra/wazuh/agents/tools/verify_agent.py agent --name srv-core01.<dominio> --group qapaq-srv-core
```

Comprueba: estado `active`, keepalive < 120 s, versión `Wazuh v4.14.8`, grupo esperado,
inventario syscollector con SO y paquetes, y políticas SCA evaluadas. Código 2 = hallazgos (el
primer escaneo de syscollector/SCA puede tardar hasta su intervalo).

## 10. Rollback

| Nivel | Acción | Comando |
|---|---|---|
| Configuración de un grupo | Restaurar el `agent.conf` previo | `cp /var/ossec/backup/qapaq-groups-<ts>/<grupo>.agent.conf /var/ossec/etc/shared/<grupo>/agent.conf && verify-agent-conf -f …` |
| Reglas de prioridad | Restaurar respaldo de `apply-priority.sh` y reiniciar | ver §5 |
| Agente Windows | Desinstalar conservando evidencia | `.\Uninstall-QapaqWazuhAgent.ps1 [-RemoveSysmon]` |
| Agente Linux | Desinstalar conservando evidencia | `sudo bash uninstall-qapaq-wazuh-agent.sh [--remove-audit-rules]` |
| Registro en el manager | Eliminar el agente | `curl -k -X DELETE "https://localhost:55000/agents?agents_list=<id>&status=all&older_than=0s" -H "Authorization: Bearer $TOKEN"` |

Criterio para revertir una ola: > 2 % de agentes sin conexión 1 h después, EPS > 2× lo
estimado, o impacto en el rendimiento del equipo reportado por el área.

## 11. Escalamiento

| Situación | Primer contacto | Escalar a |
|---|---|---|
| Agente no inscribe (1515) | Operador del despliegue | Infra QAPAQ (firewall, R1) |
| Canal vacío tras instalar | SOC | AD QAPAQ (GPO de auditoría) |
| Volumen o costo fuera de rango | SOC | Líder SOC (`qapaq.soc.lead`) |
| Secreto expuesto | Líder SOC | Plataforma: rotar en Key Vault y manager de inmediato |

Contactos nominales: TO_BE_PROVIDED (cuestionario N2).
