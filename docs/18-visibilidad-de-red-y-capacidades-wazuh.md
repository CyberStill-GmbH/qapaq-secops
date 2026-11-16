# 18 · Visibilidad de red y capacidades de Wazuh

Wazuh no ve conexiones de red por sí solo: no es un sensor de red (no inspecciona paquetes ni flujos). Lo
que analiza son **eventos** que alguien le entrega. Este documento describe cómo el SOC QAPAQ le entrega la
red —en el host, en el edge de la propia consola y desde fuentes públicas de reputación— y cómo se
aprovechan los demás módulos de Wazuh para que cada vista de la app (MITRE ATT&CK, Threat Hunting, Docker,
IT Hygiene, Vulnerabilidades) tenga datos con sentido.

Código: [`infra/wazuh/network/`](../infra/wazuh/network/), políticas de grupo en
[`wazuh/manager/policy/shared/`](../wazuh/manager/policy/shared/), reglas como código en
[`detections/`](../detections/README.md) (rango **101800–101899**, dueño `network-visibility` en
`detections/catalog.yaml`).

## Resumen: qué se ve y con qué

| Qué | Fuente | Cómo llega a Wazuh | Reglas |
| --- | --- | --- | --- |
| Puertos en escucha (alta/baja y proceso dueño) | `ss` en el host | command monitoring (`full_command` + `check_diff`) cada 5 min | 101800 |
| Escuchas y conexiones TCP **nuevas** (proceso, uid, origen, destino) | `ss` en el host | command monitoring (`command`, una línea por flujo nuevo) cada 2 min | 101801–101809 |
| Puertos y conexiones establecidas en inventario | syscollector `ports all="yes"` | inventario cada 1 h → IT Hygiene | — |
| `connect/bind/accept` de sesiones humanas, herramientas de red, cuenta web | auditd | `log_format audit` + decoder SOCKADDR | 101810–101818 |
| Sesiones SSH (IP, geo, éxito tras fallos, multi-IP, root) | journald/sshd | grupo linux-servers | 101820–101821 (+ 101750 y 101761–101763 de ingeniería de detección) |
| Contenedores del SOC (start, exec, pull, create) | Docker daemon | wodle docker-listener | 101850–101852 (+ oficiales 87900–87999) |
| Tráfico HTTP a la consola del SOC (IP real, ruta, estado, UA, login) | nginx del edge | JSON en el volumen de logs del manager | 101830–101846 |
| Reputación de IP (Spamhaus DROP, abuse.ch Feodo, Tor) | listas públicas | CDB diaria + reglas que suben el nivel | 101860–101868 |
| Misma IP en Cloudflare WAF, edge y SSH | Cloudflare (lista diaria), edge y sshd en tiempo real | CDB + `if_matched_group`/`same_source_ip` | 101870–101875 |
| Endpoints Windows: Sysmon 3/22, WFP 5156/5157, pfirewall.log | agente Windows (grupo opt-in) | eventchannel y archivo | 101880–101888 |

## Conexiones y puertos

**Cómo.** El grupo `linux-servers` distribuye
[`qapaq-netconn.sh`](../wazuh/manager/policy/shared/linux-servers/qapaq-netconn.sh) (archivo del grupo: el
manager lo empaqueta en `merged.mg` y el agente lo deja en `/var/ossec/etc/shared/`; lo instala
`apply-agent-groups.sh`) y lo ejecuta con dos `<localfile>` de comando del `agent.conf`:

- `listen` cada 300 s, `full_command`, alias `qapaq listening ports`: foto ordenada de escuchas TCP/UDP con el
  proceso dueño y **sin PIDs** (si no, cada reinicio de un servicio sería un «cambio»). La regla 101800 usa
  `check_diff`, la misma lógica que la 533 oficial. El alias es propio porque el `ossec.conf` local del
  agente ya trae el `netstat` por defecto con el alias `netstat listening ports`; sin `net-tools` devuelve
  vacío y, compartiendo alias, la 533 saltaría en cada pasada.
- `events` cada 120 s, `command` (una línea = un evento): emite solo lo **nuevo** respecto a la pasada
  anterior —escuchas y conexiones TCP establecidas— con el estado en `/var/ossec/tmp/qapaq-netconn`. La clave
  de deduplicación ignora el puerto efímero: una conexión larga se informa una vez y un destino que reaparece
  después de cerrarse se informa de nuevo. Primera pasada: inventario de escuchas. Tope de 200 líneas.

El decoder `qapaq-netconn` ([`qapaq_network_decoders.xml`](../infra/wazuh/network/decoders/qapaq_network_decoders.xml))
deja `srcip`, `dstip`, `dstport`, `protocol`, `qapaq.net.process`, `qapaq.net.uid` y `qapaq.net.direction`, así
que las listas CDB y el GeoIP del indexer funcionan sobre estos eventos.

| Regla | Nivel | Qué |
| --- | ---: | --- |
| 101800 | 7 | Cambió la foto de escuchas (alta o baja) |
| 101802 | 0 | Escucha nueva solo en loopback |
| 101803 | 12 | Shell, netcat o intérprete escuchando (bind shell, túnel) |
| 101804 | 0 | Escucha esperada ([`qapaq-expected-listeners`](../infra/wazuh/network/lists/qapaq-expected-listeners), versionada) |
| 101805 | 8 | Escucha nueva **no esperada** |
| 101806 | 0 | Conexión interna (RFC 1918, CGNAT, loopback, link-local) |
| 101807 | 10 | Shell/netcat abre conexión saliente (reverse shell) |
| 101808 | 5 | Saliente a **destino poco común**: fuera de `qapaq-egress-known` (rangos AWS de la región + [`qapaq-egress-static`](../infra/wazuh/network/lists/qapaq-egress-static)) |
| 101809 | 3 | Entrante desde IP pública (caza; `GeoLocation` la agrega el indexer) |

«Destino poco común» es una aproximación sin aprendizaje: Wazuh no guarda historial por destino, así que se
usa una lista de destinos conocidos que se ajusta por PR.

**Límites.** La foto es un muestreo: una conexión que abre y cierra entre dos pasadas (2 min) no aparece (para
sesiones humanas la cubre auditd). Las conexiones **de los contenedores** viven en su propio espacio de red y
no aparecen en `ss` del host (sí el `docker-proxy` que publica sus puertos y las entrantes del ALB); el tráfico
web de la consola se ve en el edge. UDP solo como escucha.

## auditd

**Cómo.** El grupo distribuye
[`qapaq-audit-network.rules`](../wazuh/manager/policy/shared/linux-servers/qapaq-audit-network.rules) y en el host
`qapaq-audit-sync.path` lo aplica en cuanto cambia ([`qapaq-audit-sync.sh`](../infra/wazuh/network/agent/qapaq-audit-sync.sh)).
La carga es **aditiva**: quita y vuelve a poner solo las reglas con clave `qapaq_net_*`; nunca `augenrules
--load`, que vaciaría las reglas who-data que el agente agrega para FIM. Persiste en
`/etc/audit/rules.d/60-qapaq-network.rules`.

Alcance pensado para que el volumen sea el de una persona, no el del servidor:

- `auid>=1000` y `auid!=unset`: solo procesos nacidos de un login (SSH, SSM, consola). Demonios y contenedores
  (dockerd los lanza sin auid) quedan fuera.
- `connect`/`bind` con `a2=16` (AF_INET) o `a2=28` (AF_INET6): descarta sockets UNIX (`docker.sock`, D-Bus).
- `euid=33` (www-data): una conexión saliente de la cuenta web es rara (webshell).
- `-w <binario> -p x` para nc, ncat, socat, nmap, masscan, telnet y tcpdump, solo si existen.

`auditd.conf` con `log_format = ENRICHED` hace que el registro SOCKADDR traiga `SADDR={ saddr_fam=inet
laddr=… lport=… }`; un decoder hermano de `auditd-syscall` lo convierte en `dstip`/`dstport`. La regla oficial
92600 (nivel 0, «Executed python script») captura antes cualquier evento de auditd con `exe` python, por eso
101810 cuelga también de ella.

| Regla | Nivel | Qué |
| --- | ---: | --- |
| 101812 | 12 | Shell/netcat de una sesión abre o acepta una escucha (bind shell) |
| 101813 | 10 | Ejecución de herramienta de red o de captura |
| 101814 | 12 | Shell/netcat se conecta a un destino no local (reverse shell) |
| 101815 | 10 | Escáner (nmap, masscan, zmap…) conectando |
| 101816 | 10 | Cuenta web conecta hacia afuera |
| 101818 | 5 | Proceso de una sesión abre o acepta una escucha |
| 101811 | 1 | Destino interno o loopback (DNS local, etc.; sin alerta) |
| 101817 | 3 | Conexión de una sesión humana a un destino público (caza) |

## SSH

Las sesiones SSH llegan por journald (`linux-servers`): 5715 trae `srcip` y el pipeline de ingesta del indexer
agrega `GeoLocation` (país, ciudad, coordenadas) con la base GeoLite2 que trae el módulo `ingest-geoip` del
Wazuh Indexer —sin otra licencia ni descarga—. Ingeniería de detección mantiene 101750 (éxito tras fuerza
bruta en 30 min) y 101761–101763 (IP no administrativa, fuera de horario). Este programa agrega:

| Regla | Nivel | Qué |
| --- | ---: | --- |
| 101820 | 10 | La misma cuenta entra desde 3+ IPs no administrativas distintas en 1 h |
| 101821 | 12 | SSH directo como root |
| 101865 / 101868 | 13 | SSH exitoso desde IP en listas de reputación / nodo Tor |
| 101871 / 101874 | 13 / 14 | SSH exitoso desde IP que atacó el WAF (7 días) / la consola web (1 h) |

## Docker

El grupo **`linux-docker-hosts`** (adicional; agente 001) activa el wodle `docker-listener`, que se suscribe a
los eventos del daemon. Alimenta la vista **Docker** de la app y las reglas oficiales 87900–87999. QAPAQ sube la
severidad cuando la acción toca un contenedor crítico del SOC (manager, indexer, dashboard, Postgres, API,
edge, backend de Respond): 101850 (shell interactiva, nivel 10), 101851 (cualquier comando, 6) y 101852 (se
crea un contenedor de propósito general o de herramientas —alpine, kali, netshoot—, 8). Los scripts QAPAQ de
despliegue hacen `docker exec` en el manager: durante un despliegue 101851 es esperable.

## Edge

**Cómo.** [`qapaq-edge-logging.conf`](../infra/wazuh/network/edge/qapaq-edge-logging.conf) se monta en el edge como
`conf.d/qapaq-logging.conf` (contexto http: aplica a todos los `server{}` sin tocar `edge.conf`) y escribe
`access.json` y `error.log` en `/var/log/qapaq-edge`, que es el *subpath* `qapaq-collectors/edge` del volumen de
logs del manager (el mismo patrón que `aws-events`, `compose.qapaq.yaml`). El manager los lee con un
`<localfile>` `json` y otro `syslog` (decoder oficial de errores de nginx) entre marcadores `QAPAQ:edge-logs`.

- **IP real.** `edge.conf` confía en `X-Forwarded-For` solo desde la VPC del ALB (`set_real_ip_from
  10.89.0.0/24`, `real_ip_recursive on`), así que `$remote_addr` —el `srcip` del JSON— es el cliente. Se guarda
  también la cadena XFF completa.
- **Login.** `POST /api/auth/password` responde 303 en ambos casos; el edge clasifica con la cabecera
  `Location` (`authError=` = fallo) en `auth_result`. El usuario no se registra (el cuerpo no se loguea): la
  correlación es por IP; el usuario está en la auditoría del API.
- **Privacidad.** Sin cuerpos, cookies ni `Authorization`; en el callback OIDC y el SSO de Ankay se
  registra la ruta sin query (código y `state`). Los health checks del ALB no se registran.
- **Rotación.** `/etc/logrotate.d/qapaq-edge` (diario, 100 MB, 7 copias, `copytruncate`).

**ALB.** Los *access logs* del ALB van a S3; leerlos exige un rol IAM o una política de bucket que la cuenta en
modo PowerUser no puede crear (sin IAM ni PassRole). La fuente HTTP es el edge: ve todo lo que el ALB reenvía,
que es todo salvo lo que el propio ALB descarta (HTTP mal formado, TLS fallido).

## Login consola

| Regla | Nivel | Qué |
| --- | ---: | --- |
| 101830 | 0 | Base (cada petición) |
| 101831 / 101832 / 101833 | 8 | SQLi / XSS / path traversal (literal y codificado en URL) |
| 101834 | 10 | RCE, inyección de comandos, Log4Shell, Shellshock |
| 101835 | 6 | User-Agent de escáner (sqlmap, nuclei, nikto…) |
| 101836 | 5 | Sondeo de rutas ajenas (`.env`, `.git`, WordPress, `*.php`…) |
| 101837 | 10 | Campaña: 10+ peticiones maliciosas de una IP en 5 min |
| 101838 / 101839 | 1 | 4xx / 5xx (base de los picos; nivel 1 y no 0, ver nota) |
| 101840 | 7 | 40+ 4xx de una IP en 2 min |
| 101841 | 9 | 30+ 5xx en 2 min (caída de un backend o DoS) |
| 101842 / 101843 | 5 / 3 | Login fallido / exitoso en la consola (por IP y geo) |
| 101844 | 10 | 6+ fallos de una IP en 5 min |
| 101845 | 13 | Éxito tras fuerza bruta desde la misma IP |
| 101846 | 9 | 20+ fallos desde IPs distintas en 10 min (spraying) |

Nota de diseño: analysisd evalúa primero las reglas hijas de nivel 0; un 4xx de nivel 0 taparía a las reglas
de ataque (casi todo ataque recibe 4xx). Las reglas de frecuencia, además, necesitan que el padre deje
historial. Por eso las bases 4xx/5xx son nivel 1 (bajo el umbral de alerta 3: no se indexan).

## Reputación

**Fuentes** (verificadas en noviembre de 2026; solo IPv4: las claves CDB usan `:` como separador):

| Lista | Fuente | Licencia / términos | Uso |
| --- | --- | --- | --- |
| `qapaq-ti-blocklist` | Spamhaus **DROP** (`drop_v4.json`) | Libre para cualquier uso con atribución a The Spamhaus Project; no más de una descarga por hora (aquí, diaria) | Redes secuestradas o de operadores criminales |
| `qapaq-ti-blocklist` | abuse.ch **Feodo Tracker** (lista recomendada) | CC0 (términos de abuse.ch §3.4) | C2 de botnets activos |
| `qapaq-ti-tor` | Tor Project, *bulk exit list* | Datos públicos del Tor Project | Nodos de salida de Tor |
| `qapaq-egress-known` | AWS `ip-ranges.json` (us-east-1 + GLOBAL) + `qapaq-egress-static` | Publicación oficial de AWS | Destinos de salida conocidos |
| `qapaq-cf-waf-attackers` | Alertas del WAF de Cloudflare en el indexer (5+ en 7 días) | Datos propios | Correlación Cloudflare → SOC |
| (opcional) | FireHOL **level1** (`QAPAQ_TI_FIREHOL=1`) | Agregado de dshield, feodo, fullbogons y spamhaus_drop; los términos de DShield no son explícitos para uso comercial | Apagado por defecto |

URLhaus y ThreatFox (abuse.ch) no se usan: su uso comercial requiere suscripción. La lista de ejemplo
`malicious-ioc/malicious-ip` que trae Wazuh tampoco: es estática.

**Cómo.** `qapaq-threat-intel.timer` (diario, 05:20 UTC ± 15 min) corre `deploy-network.sh lists`:
[`qapaq_threat_intel.py`](../infra/wazuh/network/threat-intel/qapaq_threat_intel.py) descarga, descarta lo que no
es global (FireHOL trae bogons y RFC 1918), expande cada CIDR a prefijos de octeto (la búsqueda
`address_match_key` de Wazuh entiende `198.51.100.` como /24, no CIDR arbitrarios) y, si una fuente falla, usa
su última copia buena (`/var/lib/qapaq-threat-intel`). Si alguna lista cambió: respaldo, `wazuh-analysisd -t`,
reinicio del manager (CDB se compila al arrancar), verificación del agente 001 y *rollback* ante cualquier
fallo. Cada lista lleva claves **canario** de TEST-NET (RFC 5737: 203.0.113.211/.212/.221/.231 y 192.0.2.0/24)
que nunca aparecen en tráfico real y permiten probar las reglas con `wazuh-logtest` en el manager productivo.

Las reglas de reputación cuelgan de **todas las hojas** de cada fuente (en Wazuh una regla hija solo se evalúa
si su padre fue la regla que ganó): 101865, por ejemplo, es hija de 5715, 101750, 101761–101763, 101820 y 101821.

| Regla | Nivel | Qué |
| --- | ---: | --- |
| 101860 / 101861 | 12 | Login exitoso (cualquier fuente con `authentication_success`) desde IP listada / Tor |
| 101862 / 101863 | 8 / 6 | Petición a la consola desde IP listada / Tor |
| 101864 | 12 | El host abre conexión a IP listada (C2) |
| 101865 / 101868 | 13 | SSH exitoso desde IP listada / Tor |
| 101866 | 12 | Sesión humana (auditd) conecta a IP listada |
| 101867 | 10 | Conexión entrante establecida desde IP listada |

## Correlación

Cloudflare guarda la IP en `cloudflare.firewall.client_ip`; analysisd solo correlaciona campos con el mismo
nombre, así que el puente es la lista diaria `qapaq-cf-waf-attackers`. Edge y SSH comparten `srcip` y se
correlacionan en tiempo real.

| Regla | Nivel | Cadena |
| --- | ---: | --- |
| 101870 | 12 | IP bloqueada por el WAF ataca la consola |
| 101871 | 13 | IP bloqueada por el WAF inicia sesión (SSH o consola) |
| 101872 | 8 | IP bloqueada por el WAF falla autenticación |
| 101873 | 10 | Ataque web a la consola → intento SSH (1 h) |
| 101874 | 14 | Ataque web a la consola → SSH exitoso (1 h) |
| 101875 / 101876 | 12 | SSH con usuario inexistente (5710) / contraseña fallida (5760) → login en la consola (1 h) |

## Windows

El grupo opt-in **`windows-telemetry-extended`** (gate de privacidad: Ley 29733, N2) ya recogía Sysmon 3 y 22;
ahora suma Windows Filtering Platform 5156/5157 y `pfirewall.log`. Los grupos base excluyen 5156/5157 del canal
Security por volumen. Logcollector descarta un `<localfile>` cuya ubicación coincide **exactamente** con otro
(`remove_duplicates` compara con `strcmp`), así que la segunda suscripción usa `security` en minúsculas: el
canal de Windows no distingue mayúsculas y es la misma bitácora con otra consulta. Requiere la subcategoría de
auditoría *Filtering Platform Connection* y el registro del firewall por GPO. `pfirewall.log` lo decodifica el
ruleset oficial (`windows-firewall`, reglas 4101/4151).

| Regla | Nivel | Qué |
| --- | ---: | --- |
| 101880 / 101881 | 0 / 1 | WFP permitida / bloqueada (evita el nivel 5 genérico de 60104 en cada bloqueo) |
| 101882 | 10 | 20+ bloqueos WFP de un origen a puertos distintos en 2 min (escaneo) |
| 101883 / 101884 | 12 / 6 | WFP hacia / desde IP listada |
| 101885 | 12 | Sysmon 3 hacia IP listada |
| 101886 | 8 | LOLBin (rundll32, mshta, certutil…) conecta a destino público |
| 101887 | 6 | Sysmon 22: DNS dinámico o túnel (duckdns, ngrok, trycloudflare…) |
| 101888 | 10 | pfirewall.log: descarte de tráfico de IP listada |

No hay agentes Windows en el entorno: estas reglas se prueban solo en el manager desechable.

## Lo que aporta cada módulo de Wazuh al SOC QAPAQ

**Recolección de logs (logcollector).** Es la puerta de entrada de todo lo anterior: journald, auditd, la
bitácora JSON del edge, los collectors de proveedores y los comandos `ss`. Le da al SOC una sola tubería —con
*buffer* en el agente y cifrado hasta el manager— para fuentes que de otra forma estarían dispersas en el host y
en los contenedores.

**Command monitoring.** Convierte el estado del host (puertos y conexiones) en eventos. Es la forma nativa de que
Wazuh «vea la red» del host sin un sensor aparte, con diferencias (`check_diff`) o eventos por línea. Requiere
`logcollector.remote_commands=1` en el agente: quien controla el manager puede ejecutar comandos como root en
el agente a través de esos `<localfile>` (riesgo aceptado: el manager es parte del perímetro del SOC; el wodle
`command` remoto sigue deshabilitado).

**Syscollector (IT Hygiene).** Inventario cada hora de hardware, SO, paquetes, interfaces, procesos, puertos
(con `all="yes"`, también conexiones establecidas), usuarios, grupos y servicios. Es lo que muestra IT Hygiene y
lo que consume la detección de vulnerabilidades; responde «qué escuchaba y con quién hablaba este host» sin
entrar a él.

**Detección de vulnerabilidades.** El manager cruza los paquetes del inventario con el feed CTI de Wazuh y
publica el estado en `wazuh-states-vulnerabilities-*`. Con syscollector cada hora, la vista Vulnerabilidades
refleja los parches el mismo día; la priorización QAPAQ (listas `qapaq-vuln-kev` y `qapaq-vuln-noise`) separa lo
explotable del ruido.

**SCA (CIS).** El agente evalúa el benchmark CIS de su distro (Ubuntu 24.04 en el nodo) cada 12 h. Da una medida
de *hardening* comparable en el tiempo y alertas cuando un control pasa de *passed* a *failed*.

**FIM con who-data.** Las rutas de persistencia, credenciales y PAM (`/etc/ssh`, `sudoers`, `pam.d`, cron,
systemd, `passwd`/`shadow`, `authorized_keys` de root y de `/home/*`, `/etc/audit` y `/opt/qapaq/secrets`) se
vigilan con auditd: el evento dice **quién** (usuario de login, efectivo, proceso, PID) hizo el cambio, no solo
qué cambió. El resto de `/etc` y los binarios se escanea cada 12 h. Los secretos del SOC se vigilan sin guardar
diferencias (`nodiff`).

**Rootcheck.** Busca rootkits conocidos, archivos y puertos ocultos e interfaces en modo promiscuo cada 12 h, con
las capas de Docker excluidas (la 521 daba falsos positivos sobre overlayfs).

**Docker listener.** Eventos del daemon (ciclo de vida, `exec`, imágenes, redes, volúmenes) para la vista Docker
y para detectar acceso interactivo a los contenedores que guardan alertas y secretos.

**Reglas, decoders y listas CDB (analysisd).** Donde se juntan todas las fuentes: correlación por IP, usuario o
campo, ventanas de tiempo y listas de reputación sin servicios externos. Todo vive como código en `detections/`
con pruebas de `wazuh-logtest`.

**MITRE ATT&CK y Threat Hunting.** Cada regla QAPAQ lleva su técnica; la vista MITRE agrupa las alertas por
táctica/técnica y Threat Hunting permite pivotar por `data.srcip`, `data.dstip`, `GeoLocation.*`,
`agent.name` o `rule.groups` (`qapaq_netconn`, `qapaq_audit_net`, `qapaq_edge`, `qapaq_ti_hit`, `qapaq_correlation`).

**GeoIP.** No es un módulo del manager: lo aplica el pipeline de ingesta del indexer sobre `data.srcip` (y otros
campos de IP) con la base GeoLite2 que trae `ingest-geoip`. Se aprovecha tal cual.

**Active response.** Sigue **opt-in**: ningún bloqueo automático. La contención la decide un analista en QAPAQ
Respond con aprobación (docs/13); estas reglas y listas dan el contexto para decidir.

**Archives.** `logall`/`logall_json` siguen en `no`: solo se indexan alertas (nivel ≥ 3). Activarlos duplicaría
el volumen del indexer con eventos de nivel 0 y 1 (cada línea del edge, cada flujo interno). Para una
investigación puntual se habilita temporalmente y se vuelve a apagar.

## Costos

- **Indexer.** Solo alertas: el tráfico normal del edge, los flujos internos y las escuchas esperadas se analizan
  y no se guardan. Lo nuevo es del orden de decenas a cientos de alertas por día, dominado por el ruido de
  Internet contra la consola (niveles 5–8).
- **Agente.** `ss` cada 2 y 5 min y auditd acotado a sesiones humanas: CPU despreciable. Syscollector cada hora
  sincroniza por diferencias.
- **Manager.** Listas CDB de ~26.000 claves (≈ 600 KB). Un reinicio diario de ~30 s si alguna lista cambió (la de
  Tor cambia casi todos los días); los agentes guardan los eventos en su *buffer* mientras tanto.
- **Red y terceros.** Cinco descargas diarias de fuentes públicas (~3 MB). Sin servicios pagos.

## Despliegue y reversión

En el host (EC2 PowerUser), como root, desde la copia del repo en `/opt/qapaq/src` (no usar `deploy-host.sh` ni
`ship.sh`):

```bash
cd /opt/qapaq/src
bash wazuh/manager/policy/apply-agent-groups.sh                      # verify-agent-conf + grupos y archivos
docker exec qapaq-wazuh.manager-1 /var/ossec/bin/agent_groups -a -i 001 -g linux-docker-hosts -q
bash infra/wazuh/network/agent/install-linux-network-visibility.sh --docker   # auditd, comandos remotos, docker
bash infra/wazuh/network/deploy-network.sh check                      # qué cambiaría
bash infra/wazuh/network/deploy-network.sh manager                    # decoders, reglas, listas, <localfile>
bash infra/wazuh/network/edge/deploy-edge-logging.sh                  # bitácora del edge (recrea solo el edge)
install -m 0644 infra/wazuh/network/threat-intel/qapaq-threat-intel.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now qapaq-threat-intel.timer
bash infra/wazuh/network/tests/run-network-tests.sh --manager qapaq-wazuh.manager-1   # logtest en productivo
bash infra/wazuh/network/tests/run-network-tests.sh                   # todas las suites en un manager desechable
```

Cada paso de manager deja un respaldo en `etc/qapaq-backup-<ts>-network/` dentro del contenedor, valida con
`wazuh-analysisd -t` antes de reiniciar y restaura si el manager no arranca o el agente 001 no vuelve a
`Active`. Revertir a mano: copiar `rules`, `lists`, `decoders` y `ossec.conf` del respaldo y `wazuh-control
restart`; para el edge, quitar los dos montajes de `compose.qapaq.yaml` y `docker compose … up -d --no-deps
edge`; en el agente, `systemctl disable --now qapaq-audit-sync.path`, borrar
`/etc/audit/rules.d/60-qapaq-network.rules` y quitar `logcollector.remote_commands=1`.

## Cómo extenderlo a endpoints

- **Linux (servidores de QAPAQ):** enrolar con `WAZUH_AGENT_GROUP=linux-servers` (y `linux-docker-hosts` si corre
  Docker) y correr una vez `install-linux-network-visibility.sh`. Ajustar `qapaq-expected-listeners` y
  `qapaq-egress-static` por PR con los servicios de cada rol; si un rol tiene escuchas muy distintas, crear un
  grupo por rol con su propia lista.
- **Windows:** `windows-servers` o `windows-workstations` + `windows-telemetry-extended` tras la aprobación de
  privacidad, Sysmon con la configuración revisada, `auditpol /set /subcategory:"Filtering Platform
  Connection" /success:enable /failure:enable` y el registro del firewall por GPO.
- **macOS:** el agente trae syscollector (puertos) y logcollector del *unified log*; las reglas de conexiones
  habría que escribirlas sobre `com.apple.network` (no incluido).
- **Red sin agente:** si se suma un sensor (Suricata/Zeek en un *mirror* de VPC) sus eventos JSON entran por el
  mismo patrón de `<localfile>` json y las listas de reputación se reutilizan tal cual.

## Pruebas

[`run-network-tests.sh`](../infra/wazuh/network/tests/run-network-tests.sh) corre los fixtures (casos
verdaderos y benignos) de los nueve casos de uso: en un manager desechable `wazuh/wazuh-manager:4.14.8` sin red
con todo el ruleset QAPAQ y, con `--manager`, en el manager productivo con `wazuh-logtest` (sesión aislada; no
genera alertas; omite Windows, cuyos fixtures necesitan la adaptación de la regla 60000 que solo se hace en el
desechable). `detections/tools/qapaq_detections.py lint` valida metadatos, rangos y MITRE. Los fixtures de auditd
usan un espacio donde auditd real escribe el separador `\x1d` (GS) del formato enriquecido: el lint cuenta
`\x1d` como salto de línea y el decoder no depende de ese carácter.
