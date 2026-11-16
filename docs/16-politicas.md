# 16 · Políticas de seguridad (como código)

> Estado: **hecho y verificado en local** (contenedores Wazuh 4.14.8 single-node). En el nodo AWS
> PowerUser se aplica con el mismo script. Las políticas viven en git y se reaplican con scripts
> idempotentes; nada se configura a mano en el dashboard.

## Cómo se aplica

```bash
# En el host de los contenedores (EC2: como root; credencial admin desde /opt/qapaq/secrets/compose.env)
sudo bash infra/wazuh/policies/apply-policies.sh      # aplica todo y termina con la verificación
bash infra/wazuh/policies/verify-policies.sh          # solo lectura: PASS/FAIL/WARN por política
bash infra/wazuh/policies/tests/run-policy-tests.sh   # pruebas en un manager desechable (logtest)
```

En local: `QAPAQ_INDEXER_ADMIN_PASSWORD=<admin del indexer> bash infra/wazuh/policies/apply-policies.sh`.
Los scripts entran a los contenedores con `docker exec`/`docker cp` (autodetectan `*wazuh.manager*` y
`*wazuh.indexer*`; se pueden fijar con `QAPAQ_MANAGER_CONTAINER`/`QAPAQ_INDEXER_CONTAINER`). La
contraseña viaja a curl por stdin: no queda en git, en argumentos ni en logs.

| Área | Script | Archivos |
| --- | --- | --- |
| Grupos de agentes | `wazuh/manager/policy/apply-agent-groups.sh` | `wazuh/manager/policy/shared/<grupo>/agent.conf` |
| Manager y reglas | `wazuh/manager/policy/apply-manager-policy.sh` | `wazuh/manager/ossec.qapaq-policy.xml.tmpl`, `render_ossec_policy.py`, `check_rule_ids.py` |
| Retención del Indexer | `wazuh/indexer/ism/apply-ism-local.sh` | `wazuh/indexer/ism/qapaq-wazuh-*.json` |
| Verificación | `infra/wazuh/policies/verify-policies.sh` | — |

## 1. Políticas de agente (grupos)

El agente se asigna al grupo al enrolarse (`WAZUH_AGENT_GROUP`) o con `agent_groups -a -i <id> -g <grupo>`.
Los DC usan multigrupo `windows-servers,domain-controllers`.

| Grupo | FIM | SCA | Inventario | Logs | Rootcheck |
| --- | --- | --- | --- | --- | --- |
| `linux-servers` | Tiempo real: `/etc/ssh`, `sudoers.d`, `pam.d`, cron, `systemd/system`, `/root/.ssh`. Cada 12 h: `/etc`, binarios, `/boot`. Sin diffs de `shadow`/claves | CIS que trae Wazuh para la distro, cada 12 h | Cada 6 h con paquetes (alimenta vulnerabilidades) | journald filtrado a sshd, sudo, su, login, logind y gestión de usuarios | Sí, 12 h |
| `windows-servers` | Tiempo real: tareas programadas, Startup, scripts GPO. Cada 12 h: `drivers\etc`, `System32` (nivel 0). Registro: Run/RunOnce, Winlogon, IFEO, LSA, Services | CIS de la versión de Windows, 12 h | 6 h con paquetes y hotfixes | Security (filtro por defecto de Wazuh), System, Application, Defender | Sí |
| `windows-workstations` | Igual en menos rutas; programado cada 24 h, sin escaneo al arranque, `max_eps` 25 | CIS, 24 h | 12 h, sin procesos | Igual que servidores | Sí, 24 h |
| `domain-controllers` | Adicional: `SYSVOL\Policies` y `scripts` (programado), registro NTDS/Netlogon/KDC; `NTDS` ignorado | (de windows-servers) | (de windows-servers) | Security ya lo recoge windows-servers; las reglas AD 101300–101307 lo consumen | (de windows-servers) |
| `windows-telemetry-extended` | — | — | — | **Opt-in con gate de privacidad:** Sysmon (1, 3, 6, 10–13, 22, 25, 29) y PowerShell 4104/400 | — |

Ruido y recursos: `process_priority` 10 y `max_eps` 50 en FIM, sincronización a 10 EPS, exclusiones de
logs, temporales, `mtab`, `resolv.conf`, `ld.so.cache`, `System32\config`, `LogFiles`, `wdi` y claves
de Defender/BAM. `windows-telemetry-extended` se crea **vacío**: Sysmon 1 y PowerShell 4104 pueden
contener líneas de comando y secretos, y asignarlo exige aprobación de privacidad y retención (N2;
`infra/wazuh/active-directory/README.md`). La verificación avisa si tiene agentes.

## 2. Manager (`ossec.conf`)

| Política | Valor | Motivo |
| --- | --- | --- |
| Detección de vulnerabilidades | `enabled=yes`, `index-status=yes`, feed cada 60 min, `<indexer>` habilitado | Estado en `wazuh-states-vulnerabilities-*` a partir del inventario de paquetes |
| Umbral de alertas | `log_alert_level` 3 | Default de Wazuh; el push a QAPAQ filtra desde nivel 7 (`custom-qapaq`) |
| Correo de Wazuh | `email_notification=no` | Los avisos los envía el notificador QAPAQ (N6, ADR-022) |
| Active Response | **Ninguna respuesta automática** por defecto | docs/07 y docs/13: toda acción con efectos pasa por Ankay con aprobación del Líder SOC |
| Auto-bloqueo opcional | `QAPAQ_AR_AUTO_BLOCK=1`: `firewall-drop` local, 600 s (`QAPAQ_AR_TIMEOUT`), reglas 5712/5763 (fuerza bruta SSH confirmada por frecuencia) | Solo Linux: el ejecutable no existe en Windows y las reglas solo salen de sshd. `QAPAQ_AR_WHITELIST` agrega IP/CIDR a `white_list`. Encenderlo exige registrar la excepción en docs/10 |
| Lista `qapaq-break-glass` | Declarada en `<ruleset>`; si falta o está vacía se crea con un centinela `.invalid` | La usan las reglas QAPAQ de Office 365 |
| Lista `qapaq-internet-facing-projects` | Igual; clave = proyecto Snyk, valor = zona/host de Cloudflare | La usan 101730–101731 (Snyk expuesto, [17](17-ingenieria-de-deteccion.md)) |

Las integraciones (`<integration>`, syslog, wodles de proveedores) no las toca este script: son de
`wazuh/manager/ossec.qapaq-integrations.xml.tmpl`, `wazuh/office365` y `wazuh/provider-ingestion`.

Seguridad del cambio: respaldo en `etc/qapaq-backup-<ts>-policy/`, validación con
`wazuh-analysisd/modulesd/remoted/execd -t` antes de reiniciar y restauración automática si algo
falla. wazuh-docker copia `/wazuh-config-mount/etc/ossec.conf` sobre `etc/ossec.conf` en cada
arranque del contenedor; si ese origen es escribible en el host, el script le aplica la misma
política (original en `.qapaq-orig`). Si no, hay que reaplicar tras recrear el contenedor.

## 3. Reglas de detección QAPAQ

`apply-manager-policy.sh` instala `wazuh/office365/rules`, `infra/wazuh/*/rules` y las reglas del programa de
detección (`detections/*/*/rule.xml` como `qapaq_soc_*.xml`) después de
comprobar con `check_rule_ids.py` que los IDs son únicos entre archivos QAPAQ, que están en el rango
de usuario 100000–120000 y que no pisan IDs del ruleset oficial ni de otros archivos de `etc/rules`.

| Archivo | IDs |
| --- | --- |
| `qapaq_office365_rules.xml` | 100502–100530 |
| `qapaq_endpoint_rules.xml` | 101100 |
| `qapaq_launch_provider_rules.xml` | 101200–101215 |
| `qapaq_provider_service_rules.xml` | 101216–101222 |
| `qapaq_active_directory_rules.xml` | 101300–101307 |
| `qapaq_soc_*.xml` (programa de detección, `detections/*/*/rule.xml`) | 101700–101760 ([17](17-ingenieria-de-deteccion.md)) |

Las pruebas `wazuh-logtest` de cada módulo corren en `tests/run-policy-tests.sh` sobre un manager
desechable. Se corrigió `linux-pilot.agent.conf`: usaba `<syscollector>`, que `verify-agent-conf`
rechaza; ahora es `<wodle name="syscollector">`.

## 4. Retención del Indexer (ISM)

El nodo PowerUser no tiene rol IAM: **no hay repositorio S3 de snapshots** y no se usa
`qapaq-wazuh-retention` (que hace snapshot a `qapaq-s3` y queda para `infra/aws` con IAM). docs/05 no
fija un plazo local; se toma **90 días** en hot y borrado.

| Política | Índices | Retención |
| --- | --- | --- |
| `qapaq-wazuh-alerts-90d` | `wazuh-alerts-*` | 90 d en hot, luego se borra (`QAPAQ_ALERTS_RETENTION_DAYS`) |
| `qapaq-wazuh-monitoring-15d` | `wazuh-monitoring-*`, `wazuh-statistics-*` | 15 d (`QAPAQ_MONITORING_RETENTION_DAYS`) |
| `qapaq-wazuh-archives-7d` | `wazuh-archives-*` (solo si se activa `logall_json`) | 7 d (igual que `wazuh/archive`) |

Los índices de estado `wazuh-states-*` (inventario y vulnerabilidades) no se tocan. El script
adjunta la política a los índices existentes sin política; si ya tienen otra, avisa y solo la
cambia con `QAPAQ_ISM_TAKEOVER=1`. En nodo único deja en 0 las réplicas del índice interno de ISM
para que el clúster siga en verde.

**Gate N7:** el borrado a 90 días es de la demo. En producción el borrado espera a que Legal firme la
matriz de docs/05 y a que exista un snapshot previo (`qapaq-wazuh-retention` con S3).

**Respaldo sin S3:** snapshot EBS del volumen del nodo desde la consola o la CLI con el permission
set PowerUser (`ec2:CreateSnapshot` no requiere IAM propio; DLM sí, por eso no se automatiza). Un
repositorio `fs` necesitaría `path.repo` en `opensearch.yml` y un volumen aparte; no aporta frente
al snapshot EBS en un solo disco.

## 5. Roles del Indexer (mínimo privilegio)

La verificación compara los roles vivos con `wazuh/indexer/security/roles.qapaq.yml` y falla si alguno
tiene acciones de escritura o administración, o si analista, auditor o lector pueden leer
`wazuh-archives-*`. No se cambió ningún rol.

| Rol QAPAQ | Rol del Indexer | Acceso |
| --- | --- | --- |
| `qapaq.soc.analyst` | `qapaq_soc_analyst` | Lectura de `wazuh-alerts-*` y `restored-wazuh-alerts-*`; tenant global de solo lectura |
| `qapaq.soc.lead` | `qapaq_soc_lead` | Lectura de alertas, `wazuh-archives-*`, `restored-*` y resultados de AD; puede guardar objetos del dashboard |
| `qapaq.auditor` | `qapaq_auditor` | Lectura de alertas y `restored-*`. La cadena de auditoría QAPAQ vive en la base de datos, no en el Indexer |
| `qapaq.platform.admin` | `all_access` | Administración (más el usuario `admin` de emergencia) |
| API QAPAQ (`qapaq_reader`) | `qapaq_reader_role` | Lectura de alertas y resultados de AD |

Pendientes que la verificación marca como WARN, sin cambios: `all_access` conserva el backend role
`admin` que trae wazuh-docker (el edge borra las cabeceras `x-proxy-roles` que manda el cliente) y
`kibana_user` conserva `kibanauser`. El analista no lee `wazuh-states-vulnerabilities-*`: para ver
el módulo de vulnerabilidades en el dashboard hay que decidir si se le da lectura.
