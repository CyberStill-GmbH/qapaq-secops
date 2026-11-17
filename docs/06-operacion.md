# 06 · Operación (runbook)

> Estado (2026-11-08): runbook del nodo **vigente** `qapaq-soc-dev` en AWS modo PowerUser
> ([02](02-arquitectura.md)). Los comandos salen de los scripts de `infra/aws-poweruser/scripts`.
> Lo que no se ejecutó de punta a punta se marca **por verificar**. Este documento no contiene
> credenciales: solo nombres de archivos y variables.

## Datos del entorno

| Dato | Valor |
| --- | --- |
| Cuenta / región | `061098277310` / `us-east-1` (permission set `SOC-PowerUser`, sin IAM) |
| URL del SOC | `https://dev.security.qapaq.pe` |
| Manager para agentes | `agents.dev.security.qapaq.pe` TCP 1514/1515 ([AGENTS.md](../infra/aws-poweruser/AGENTS.md)) |
| Acceso al host | SSH `ubuntu@<EIP>` con la clave del operador, solo desde `allowed_admin_cidrs` |
| Raíz en el host | `/opt/qapaq` (`src/`, `config/`, `secrets/`, `pki/`, `wazuh-docker/`, `respond/`, `collectors/`, `backups/`) |
| Proyecto Compose | `qapaq` (contenedores `qapaq-<servicio>-1`) |

Atajo usado en este runbook (en el host, como root):

```bash
COMPOSE="docker compose --env-file /opt/qapaq/secrets/compose.env \
  -f /opt/qapaq/wazuh-docker/single-node/docker-compose.yml \
  -f /opt/qapaq/src/infra/aws-poweruser/host/compose.qapaq.yaml \
  -f /opt/qapaq/src/infra/aws-poweruser/host/compose.respond.yaml"
```

## 1. Regla de oro del despliegue

**Nunca ejecutar `ship.sh` / `deploy-host.sh` mientras otras personas o agentes tengan trabajo en
curso.** Motivos, todos en el código:

- `ship.sh` empaqueta **el árbol de trabajo local** (incluido lo no commiteado) y **reemplaza
  `/opt/qapaq/src` entero**: publica trabajo a medias de otros y borra lo que otro haya copiado al host.
- `deploy-host.sh` reconstruye las imágenes del dashboard y del API desde ese árbol, reinicia el
  manager (`setup-wazuh-content.sh` hace `wazuh-control restart`) y recrea `wazuh-gateway`,
  `wazuh.dashboard`, `api` y `edge`: corta sesiones en curso y deja la plataforma minutos sin servicio.

Antes de desplegar: avisar en [COORDINACION-CLAUDE-CODEX.md](../COORDINACION-CLAUDE-CODEX.md) o al
equipo, partir de un árbol limpio (`git status` vacío o solo lo que se quiere publicar) y preferir el
redespliegue **por componente** (sección 3). `SKIP_API_BUILD=1` conserva las imágenes vigentes del
API y del migrador si `apps/api` tiene trabajo que aún no compila.

## 2. Despliegue completo (nodo nuevo o reconstrucción)

```bash
# 1. Infraestructura: usar el procedimiento manual de Terraform PowerUser de abajo.
#    No ejecutar un apply local ni escoger Apply antes de revisar el artefacto del plan.

# 2. Plugins del dashboard (los exige deploy-host.sh)
bash infra/local/wazuh-dashboard/build-plugins.sh      # deja los zip en plugins-dist/

# 3. Runtime en el mismo nodo (requiere credenciales AWS temporales con permisos EC2 Instance Connect)
terraform -chdir=infra/aws-poweruser init -backend-config=backend.hcl
EC2_INSTANCE_ID="$(terraform -chdir=infra/aws-poweruser output -raw instance_id)" \
AWS_REGION=us-east-1 SOC_HOSTNAME=dev.security.qapaq.pe \
  bash infra/aws-poweruser/scripts/ship.sh
```

### Terraform PowerUser: revisar un plan exacto antes de Apply

El workflow manual [Terraform AWS PowerUser](../.github/workflows/terraform-aws-poweruser.yml)
opera únicamente desde `main`, en `infra/aws-poweruser`, con el backend de dev y el rol OIDC
configurado por el administrador. No tiene disparador automático. El procedimiento conserva el
plan binario que se revisó; Apply no vuelve a calcular otro plan:

1. En GitHub Actions, iniciar **Terraform AWS PowerUser** desde `main` con `action=plan`.
2. Descargar el artefacto `poweruser-plan-<run ID>` (retención de un día) y revisar cada cambio en
   `plan.txt`, incluidos reemplazos y destrucciones. Copiar el SHA-256 del `poweruser.tfplan` que
   aparece en el resumen para la siguiente acción. El artefacto también contiene un manifiesto con
   run ID, commit, raíz/backend, versión y hashes. Tratarlo como sensible y compartirlo solo con
   operadores autorizados.
3. Si el plan es aceptable y `main` no avanzó, iniciar un segundo despacho manual con
   `action=apply`, el mismo `plan_run_id` y `plan_sha256` copiados del run revisado. Apply comprueba
   que el run fuente fue exitoso, que pertenece a este workflow y a `main`, que el commit coincide,
   y que el hash y manifiesto del artefacto son exactos. Si el artefacto venció o `main` avanzó,
   volver a generar y revisar un plan.
4. Terraform aplica solo `poweruser.tfplan`, con lock remoto y timeout de cinco minutos. El backend
   usa el lockfile S3 (`use_lockfile = true`); el propio plan guardado falla si el estado remoto
   cambió después de planificar. Ante cualquier fallo, no regenerar automáticamente ni aprobar un
   plan distinto: ejecutar otro despacho `plan` y revisar el nuevo artefacto.

El workflow conserva la restricción de cuenta `061098277310`, rama `main`, OIDC y concurrencia sin
cancelación. El operador debe verificar por el canal autorizado que el rol OIDC y la variable
`QAPAQ_AWS_POWERUSER_TERRAFORM_ROLE_ARN` están configurados; este workflow no crea IAM.

`deploy-host.sh` es idempotente y hace, en orden: secretos (una sola vez), CA interna de
PostgreSQL, `wazuh-docker` v4.14.8 y sus certificados, configuración del dashboard y del API,
cuentas demo, Qapaqzito, certificado Let's Encrypt (HTTP-01), build, Wazuh + PostgreSQL, roles de base de
datos, migraciones, proxy auth del indexer (`apply-indexer-security.sh`), ingesta
(`setup-ingestion.sh`), contenido del manager (`setup-wazuh-content.sh`), agente del nodo
(`setup-host-agent.sh`), dashboard/API/edge e index patterns y dashboards de proveedores
(`bootstrap-wazuh-app.sh`).

Después, una vez por nodo (cada uno es idempotente):

| Paso | Comando (en el host, root, desde `/opt/qapaq/src`) |
| --- | --- |
| Ankay | En la estación: `bash ankay/build.sh <out>` y copiar el tar del fuente a `/opt/qapaq/respond/frontend-source.tar.gz`; en el host: `SOC_HOSTNAME=dev.security.qapaq.pe bash infra/aws-poweruser/scripts/deploy-respond.sh` |
| Monitoreo AWS | `bash wazuh/aws-events/install-aws-events.sh` (y `host/aws-events.env` = `terraform output -raw aws_events_receiver_env`) |
| Collectors y correo | `bash wazuh/provider-ingestion/install-qapaq-collectors.sh` ([18](18-integraciones.md)) |
| Office 365 | `bash wazuh/office365/apply-office365-docker.sh` (bloqueado por permisos, [18](18-integraciones.md)) |
| Políticas | `bash infra/wazuh/policies/apply-policies.sh` ([16](16-politicas.md)) |
| Vistas de detección | `bash infra/aws-poweruser/scripts/bootstrap-detection-content.sh` ([17](17-ingenieria-de-deteccion.md)) |
| Detecciones | `detections/tools/deploy-detections.sh` ([17](17-ingenieria-de-deteccion.md)) |

## 3. Redespliegue por componente

Copiar solo lo necesario al host (p. ej. `scp`/`rsync` del directorio afectado a `/opt/qapaq/src/...`,
quitando CRLF si viene de Windows) y reiniciar solo ese servicio.

| Componente | Cómo | Impacto |
| --- | --- | --- |
| Dashboard (qapaq_ops, qapaq_i18n, marca) | `build-plugins.sh` en la estación → copiar `plugins-dist/` → `$COMPOSE build wazuh.dashboard && $COMPOSE up -d --no-deps --force-recreate wazuh.dashboard` → `bash infra/aws-poweruser/scripts/bootstrap-wazuh-app.sh` | UI ~1–2 min; el `build.number` deriva del contenido para invalidar la caché de bundles |
| API | `$COMPOSE --profile tools build api migrator && $COMPOSE --profile tools run --rm migrator migrate && $COMPOSE up -d --no-deps --force-recreate api` | Sesiones en PostgreSQL se conservan; el estado en memoria (tope de intentos, códigos) se pierde |
| Edge | Renderizar `edge.conf.template` con `envsubst '${SOC_HOSTNAME}'` a `/opt/qapaq/config/edge.conf.new`, probar con `nginx -t` en un contenedor desechable (como hace `deploy-respond.sh`), instalarlo y `docker exec qapaq-edge-1 nginx -s reload` | Sin corte si `nginx -t` pasa |
| Ankay | `deploy-respond.sh` (solo toca Respond, el puente SSO y el edge) | Respond ~1 min |
| Reglas y listas | `detections/tools/deploy-detections.sh` o `setup-wazuh-content.sh` (ambos validan con `wazuh-analysisd -t` y revierten) | Reinicio del manager (~30 s) |
| Collectors | `install-qapaq-collectors.sh` | Reinicio del manager |
| Receptor AWS | `$COMPOSE up -d --no-deps --force-recreate aws-events` | SNS reintenta hasta ~1 h |
| Indexer security / ISM | `apply-indexer-security.sh` (respaldo en `/opt/qapaq/backups/indexer-security/`), `wazuh/indexer/ism/apply-ism-local.sh` | Sin corte |

## 4. Credenciales temporales de AWS (STS)

El operador entra con SSO al permission set `SOC-PowerUser`; las claves son **temporales** (STS) y
vencen a las pocas horas. Terraform falla con `ExpiredToken` cuando caducan.

1. Abrir el portal de acceso AWS de QAPAQ (URL: **por verificar**, la entrega el administrador de
   la organización) → cuenta `061098277310` → `SOC-PowerUser` → «Access keys».
2. Copiar `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` al `.env` local del
   repositorio (está en `.gitignore`; `ship.sh` nunca lo copia) o exportarlas en la shell. Con AWS
   CLI v2 también sirve `aws configure sso` + `aws sso login --profile <perfil>`.
3. Comprobar: `aws sts get-caller-identity` debe mostrar `AWSReservedSSO_SOC-PowerUser_*`.
4. Nunca pegar las claves en el repositorio, en tfvars, en el host ni en un chat. El host no
   necesita credenciales AWS: no tiene rol ni claves.

## 5. Secretos en el host

Todos en `/opt/qapaq/secrets` (0700, root; archivos 0600). Se generan en el host o se copian por SSH;
nunca pasan por Git, Terraform ni user_data. Solo nombres:

| Archivo | Contenido (variables) |
| --- | --- |
| `compose.env` | `INDEXER_ADMIN_PASSWORD` (break-glass del indexer), `KIBANASERVER_PASSWORD`, `WAZUH_API_PASSWORD`, `POSTGRES_ADMIN_PASSWORD`, `QAPAQ_MIGRATOR_PASSWORD`, `QAPAQ_RUNTIME_PASSWORD`, `SHUFFLE_OPENSEARCH_PASSWORD`, `SHUFFLE_ADMIN_USERNAME`, `SHUFFLE_ADMIN_PASSWORD`, `SHUFFLE_ENCRYPTION_MODIFIER` |
| `api.env` | `QAPAQ_POSTGRES_PASSWORD`, `QAPAQ_ENTITY_REF_KEY`, `QAPAQ_VAPID_PRIVATE_KEY`, `QAPAQ_ENTRA_CLIENT_SECRET` (relleno de la identidad demo), `QAPAQ_DEMO_ADMIN_PASSWORD_HASH`, `QAPAQ_DEMO_ACCOUNTS`, `QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN`, `QAPAQ_QAPAQZITO_API_KEY` |
| `demo-admin-password.txt` | Contraseña de la cuenta demo administradora |
| `demo-accounts.txt` | Cuentas demo por rol (`usuario rol contraseña`), fuente de `QAPAQ_DEMO_ACCOUNTS` |
| `gateway.env` | `QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN`, `WAZUH_INDEXER_BASIC_AUTH_B64`, `QAPAQ_READER_PASSWORD` |
| `services.env` | Claves de proveedores copiadas desde el `.env` local: `QAPAQ_CLAUDE_API`, `BITDEFENDER_*`, `SNYK_*`, `CLOUDFLARE_API_TOKEN`, `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `ALERT_EMAIL_*` |
| `collectors/` | Un archivo por secreto de collector (`bitdefender-api-key`, `snyk-token`, `cloudflare-api-token`, `entra-*`, `alert-email-*`…) |
| `wazuh-authd.pass` | Contraseña de enrolamiento de agentes |
| `respond-sso/` | Token edge↔puente y API key de servicio de Ankay |
| `ca.key` | Clave de la CA interna (PostgreSQL, gateway) |

Rotación: el token del gateway se rota borrando `gateway.env` y la línea del token en `api.env`,
y relanzando `setup-ingestion.sh` + recrear `api` y `wazuh-gateway`. La clave de Qapaqzito se rota en
`services.env`: cada `deploy-host.sh` la vuelve a copiar. Las contraseñas de las cuentas demo se
cambian en `demo-accounts.txt` borrando la línea `QAPAQ_DEMO_ACCOUNTS` de `api.env` antes de
redesplegar (**por verificar** de punta a punta).

### Inicialización de canales de aviso

Procedimiento para un nodo nuevo o para activar un canal (detalle en
[18 · Integraciones](18-integraciones.md#inicialización-de-canales-de-aviso)):

1. En `/opt/qapaq/secrets/services.env` deja, si existen, `QAPAQ_TEAMS_WORKFLOW_URL` (webhook del
   Workflow; es una credencial) y `QAPAQ_ALERT_MAIL_SENDER` (buzón remitente del respaldo por correo).
2. Ejecuta `deploy-host.sh`: copia ambas a `secrets/api.env` y registra solo si están o faltan.
   La migración `20261113120000_notification_channel_revision` debe estar aplicada antes de que
   arranque el API nuevo (la aplica el migrador del despliegue).
3. Al arrancar, el API crea la fila de cada canal que no la tenga (`system:bootstrap`, auditado
   como `notifications.channel.initialized`) y escribe una línea `notifications.channel.status`
   por canal. Compruébalo sin exponer secretos:
   en los logs del servicio `api` del compose, filtra `notifications.channel` (**por verificar**
   en el nodo: aún no se ha desplegado). `setup` indica lo que falta: `configure`, `enable`, `verify` o `ready`.
   `notifications.channels.no_p1_delivery` significa que ni Teams ni correo pueden entregar un P1.
4. En la consola, **Notificaciones → Canales**: sigue la guía «Puesta en marcha de Microsoft
   Teams» (configurar → activar → enviar prueba → verificar la tarjeta en el canal). «Aceptada por
   el proveedor» es el HTTP 2xx de Microsoft, no la publicación ni la lectura.
5. `GET /api/operations/health` (sección `soc`) deja de reportar
   `NOTIFICATION_TEAMS_NOT_CONFIGURED` y `NOTIFICATION_NO_P1_CHANNEL`.

La base manda sobre el entorno: una vez creada la fila, redesplegar con otra URL en
`services.env` **no** reemplaza el webhook ni reactiva un canal apagado; se cambia desde la consola.

### Activación del Analista IA

Apagado por defecto. Detalle en [27 · Implementación](27-aisoc-mcp-evaluacion-y-plan.md#implementación-2026-11-14).

1. Confirma que la migración `20261113130000_ai_investigations` está aplicada (la aplica el migrador
   del despliegue). Sin ella y con el analista apagado, el API arranca y la consola muestra «no
   habilitado»; con el analista activo, el API no arranca.
2. Proveedor: el de Qapaqzito (`QAPAQ_QAPAQZITO_PROVIDER`, `QAPAQ_QAPAQZITO_API_KEY` en `services.env`). No hay
   secretos nuevos.
3. En `api.env`: `QAPAQ_ANALYST_ENABLED=true` y, para usar modelo, `QAPAQ_ANALYST_DAILY_CEILING_USD`
   (p. ej. `2`). Sin techo todo se resuelve con reglas deterministas (costo 0).
4. Reinicia `api`; en los logs busca `analyst.started` (`inference=true|false`).
5. Consola (administración de plataforma, sesión de menos de 30 min): **Analista IA →
   Configuración** → activar, modo `shadow` primero, techo ≤ el del despliegue. Las personas que ya
   tenían sesión deben volver a iniciarla para recibir `investigations.*`.
6. Verifica `GET /api/ai-investigations/budget` y que aparezcan investigaciones en **Operación**.

Rollback: `QAPAQ_ANALYST_ENABLED=false` y reiniciar `api`. La migración es aditiva; no se revierte.

## 6. Respaldos y restauración

Sin IAM no hay DLM ni subida automática a S3 desde el host: los respaldos son **manuales** y su
automatización es una brecha abierta ([19](19-brechas-y-roadmap.md) #8).

| Qué | Cómo | Dónde queda |
| --- | --- | --- |
| Disco completo | Snapshot EBS desde la estación: `aws ec2 create-snapshot --volume-id <vol> --description qapaq-soc-dev-<fecha>` (PowerUser lo permite; **por verificar** en esta cuenta) | EBS snapshots, cifrados con la CMK |
| PostgreSQL (estado del motor y auditoría) | `$COMPOSE exec -T postgres pg_dump -U qapaq_admin -Fc qapaq_secops > /opt/qapaq/backups/pg-<fecha>.dump` | Host; copiar a la estación y subir al bucket de evidencia |
| Configuración y secretos | `tar czf` de `/opt/qapaq/secrets`, `/opt/qapaq/config`, `/opt/qapaq/pki` y `wazuh-docker/single-node/config` | Fuera del host, cifrado; **nunca** al repositorio |
| Reglas y `ossec.conf` | Los instaladores ya respaldan antes de cambiar: `/var/ossec/etc/qapaq-backup-*` (en el manager) y `/opt/qapaq/backups/` | Host |
| Seguridad del indexer | `apply-indexer-security.sh` respalda en `/opt/qapaq/backups/indexer-security/<fecha>` | Host |
| Alertas del indexer | Sin repositorio de snapshots (la ISM se aplica sin S3); la retención es la de [16](16-politicas.md) | — |

Restauración (**por verificar**, sin ensayo registrado): crear un volumen desde el snapshot y
reemplazar el del nodo, o nodo nuevo con `terraform apply` + `ship.sh`, restaurar
`/opt/qapaq/secrets` antes de `deploy-host.sh` (para no regenerar secretos) y luego
`pg_restore -U qapaq_admin -d qapaq_secops --clean` dentro del contenedor `postgres`.

## 7. Baja (teardown)

```bash
ssh -i <clave> ubuntu@<EIP> 'cd /opt/qapaq/wazuh-docker/single-node && sudo docker compose -p qapaq down -v'  # opcional
# Vaciar antes los buckets con force_destroy = false (evidencia; revisar logs del ALB y del trail)
terraform -chdir=infra/aws-poweruser destroy -var-file=environments/dev.tfvars
```

La baja elimina también los 17 temas SNS, las reglas de EventBridge y el trail de la cuenta; el SOC
deja de ver la actividad AWS. Avisar antes a quien dependa de esas alertas.

## 8. Costos

Estimado a precio de lista on-demand en `us-east-1` (no es factura):

| Componente | USD/mes (aprox.) |
| --- | --- |
| EC2 `r7i.xlarge` 24×7 | ~195 |
| EBS gp3 100 GB + snapshots manuales | ~10 |
| EIP, KMS (2 CMK), Route 53, S3, SNS, CloudTrail (primer trail de gestión sin cargo) | ~10–15 |
| Transferencia de salida | variable, bajo |
| **Subtotal del nodo** | **~240** |
| ALB (horas + LCU) | +~20 |
| WAFv2 (web ACL + 4 reglas + peticiones) | +~10 |

El Budget de Terraform (`monthly_budget_usd`) está en **150 USD**, por debajo del costo esperado:
alertará cada mes. Ajustarlo a ~280 y fijar `budget_email` (hoy vacío, sin suscriptor). El
consumo de Claude (Qapaqzito) se factura aparte en la cuenta de Anthropic.

## 9. Comprobaciones de salud

| Qué | Cómo | Esperado |
| --- | --- | --- |
| Borde y API | `curl -s https://dev.security.qapaq.pe/health/live`; target group del ALB | 200; target `healthy` |
| Contenedores | `$COMPOSE ps` | Todos `running`/`healthy` |
| Agentes | Wazuh → Agentes, o `curl -k -u wazuh-wui:… https://127.0.0.1:55000/agents` en el host | `001 qapaq-soc-dev-node` `active` |
| Ingesta del motor | «Salud de fuentes» en la consola | «Wazuh Indexer · alertas» en verde |
| Collectors y correo | `systemctl list-timers 'qapaq-*'`; `journalctl -u qapaq-collector-<proveedor>` | Última ejecución reciente, sin error |
| Monitoreo AWS | `docker inspect -f '{{.State.Health.Status}}' qapaq-aws-events-1`; suscripciones SNS confirmadas (17) | `healthy`; ninguna `PendingConfirmation` |
| Integraciones | Página «Integraciones» | Estado por servicio y último evento |
| Certificado | `certbot certificates` | Vigente; el hook recarga el edge al renovar |
| Disco | `df -h /` | < 80 % |

## 10. Problemas conocidos

| Síntoma | Causa | Solución |
| --- | --- | --- |
| «Tu sesión se cerró porque entraste desde otro lugar» (`sessionNotice=superseded`) | **Sesión única** por cuenta: un login nuevo reemplaza las sesiones activas de esa misma cuenta, también la del dashboard | No compartir cuentas: cada persona o agente usa su cuenta demo por rol ([04](04-identidad-y-acceso.md)). Los scripts de arranque usan la identidad de servicio `qapaq-bootstrap` por proxy auth, nunca un login de persona |
| Docker Desktop en Windows no arranca o queda colgado | Estado corrupto en `%LOCALAPPDATA%\Docker\run` y del motor de secretos | `scripts/dev/repair-docker-desktop.ps1`. En WSL2, `vm.max_map_count` ≥ 262144 para el indexer |
| El API local no responde desde el edge local | `host-gateway` añade una dirección IPv6 inalcanzable | Alias solo IPv4 `qapaq-api-host:192.168.65.254` (`infra/local/compose.wazuh-dashboard-qapaq.yaml`) |
| `env: 'sh\r'` o scripts que fallan en el host | Árbol copiado desde Windows con CRLF (`core.autocrlf`) | `ship.sh` y `deploy-respond.sh` quitan CRLF de `*.sh`, `*.yml`, `*.conf`, plantillas; al copiar a mano, `sed -i 's/\r$//'` |
| El panel de Qapaqzito desaparece tras navegar | OSD vuelve a renderizar `<body>` y se lleva el contenedor del panel | Corregido en `596001a` (se vuelve a adjuntar); si reaparece, recargar la página |
| `connect() failed` hacia un upstream resuelto en tiempo de ejecución (Respond, aws-events) | nginx intenta direcciones IPv6 que la red Docker no enruta (causa exacta **por verificar**) | `resolver 127.0.0.11 valid=30s ipv6=off` en el edge de AWS y en el local; no quitarlo |
| La UI muestra la versión anterior tras desplegar | OSD cachea bundles un año bajo `/{build.number}/` | El Dockerfile deriva `build.number` del contenido; forzar recarga si persiste |
| Vistas de la app de Wazuh en rojo para roles de solo lectura | Index patterns sin crear o sin campos | `bootstrap-wazuh-app.sh` (se ejecuta en cada despliegue) |
| Primer lote de un collector no aparece | logcollector abre un JSONL inexistente desde el final | Los instaladores precrean el JSONL antes de reiniciar el manager (`dea6a4f`) |
