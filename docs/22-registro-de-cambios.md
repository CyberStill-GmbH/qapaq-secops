# 22 · Registro de cambios del despliegue QAPAQ SOC

> Esfuerzo de despliegue del 2026-11-02 al 2026-11-08 en la rama `qapaq/rebrand-serverless`. Agrupado
> por tema; cada línea cita el commit. Lo que otros agentes tienen en curso figura al final.

## 2026-11-02 · Marca QAPAQ y nueva base

- Rebrand de la base de código original a **QAPAQ SecOps** y reparación de identificadores en CI
  (`d32c76b`, `7cb8198`); identidad visual oficial QAPAQ (`4f0b582`).
- Perfil Azure archivado: QAPAQ opera solo en AWS (`8870d20`); documentación reescrita (`25bfcf5`).
- Login QAPAQ con usuario y contraseña junto a Entra (`7d14a5b`), ilustración optimizada a WebP
  (`a4fbee8`), pantalla de carga animada (`10ed341`).
- Frontend de Ankay con la identidad QAPAQ (`e3d0fa4`).

## 2026-11-03 · Del diseño serverless al nodo PowerUser

- API: Qapaqzito con historial y login de contraseña de la cuenta demo administradora (`c6692c6`);
  panel de Qapaqzito en `qapaq_ops` y Terraform serverless (`6ec149d`); verificación con PostgreSQL
  (`d043aa4`, `c01ed00`).
- Terraform serverless con plan/apply por OIDC, ACM y Route 53 (`be42458`, `f4cf77d`, `cb34a36`).
  No se pudo aplicar: la cuenta no permite IAM ni `iam:PassRole`.
- **Stack PowerUser sin IAM** y overlay local del dashboard con edge (`ee5e3c0`); el nodo corre el
  SOC completo (`68462e6`).
- Ingesta de Wazuh sin Entra con gateway de token estático (`d30bd3d`); zonas horarias `±HHMM` de
  Wazuh aceptadas en vez de poner en cuarentena cada alerta (`32a3bc8`).
- Login detrás del edge, IP fija del dashboard, API local en 3089 (`31d259a`); correcciones del login
  (`fd59e12`, `42b14fd`, `cfa7ca8`); aviso de cookies (`27a0b56`).
- Marca: activos visuales (`ff7acbc`), conejo como logo y favicon (`4a7210e`), splash (`3439217`,
  `7213ec1`, `5733a77`).
- Ankay embebido en el SIEM en local (`1012ae6`).
- Qapaqzito: variables `QAPAQ_QAPAQZITO_*` aceptadas, Anthropic con `claude-sonnet-5-5` por defecto
  (`5eeaa5a`, `5c2ba99`).

## 2026-11-04 · Fuentes, políticas, Respond y vistas

- Qapaqzito: el panel sobrevive a los re-render de `<body>` de OSD (`596001a`).
- **Collectors** de solo lectura para Bitdefender GravityZone, Snyk y Cloudflare con reglas Wazuh
  (`82c39b1`); instalador en el host y Office 365 sobre el manager en Docker (`fab88f2`); JSONL
  precreado para no perder el primer lote (`dea6a4f`).
- **Correo de alertas** críticas y altas por Microsoft Graph (`a32df7b`), umbral en nivel 8
  (`9542103`). Bloqueado hasta conceder `Mail.Send`.
- **Políticas como código:** grupos de agentes (`4698a51`), `ossec.conf` del manager e instalación de
  reglas con control de colisión de IDs (`eaf7207`), retención ISM sin S3 y verificación (`46598d5`).
- **Ankay:** SSO desde la sesión QAPAQ, «Volver al SIEM» y capa en español (`ea09db6`); marca de
  Respond (`b45eadc`); textos, marketing del upstream oculto y cookies heredadas (`a85f1af`);
  playbooks exportables con puerta de aprobación (`b84562e`).
- Ingesta: cursor de Wazuh desatascado y alertas de proveedores como alertas de primera clase
  (`833c088`).
- **Monitoreo de la cuenta AWS sin IAM** (EventBridge → SNS → Wazuh, 17 regiones) (`7e7424b`,
  `8ff9f21`); trail de la cuenta porque el de la organización vive en la cuenta de administración
  (`598294a`): llegan eventos reales (p. ej. regla 101616).
- Puertos de agentes abiertos a Internet, aprobado por el dueño (`e9d6eb0`).
- **Cuentas demo por rol** (`75cbf37`).
- **Resumen del SOC** como portada, páginas Integraciones y Políticas, dashboards por proveedor
  (`d339cac`); vistas de la app de Wazuh para roles de solo lectura (`1b1d4eb`, `499a0ba`,
  `3ed6ed4`).
- **Detección como código:** catálogo, herramientas y 24 reglas nuevas (`5381874`), vistas de
  análisis de detección (`8217d9f`).

## 2026-11-08 · Documentación

- Documentación de la plataforma vigente: índice, arquitectura, operación, integraciones, guía de
  usuario, identidad, postura de seguridad, brechas y este registro. Material heredado (Azure, ECS,
  Sophos/Cato, Shuffle por webhook) movido a [`archive/`](archive/README.md).

## 2026-11-11 · Investigación de alertas, acceso y correlación (cambios locales; despliegue pendiente)

- **Auditoría del programa:** tres revisiones paralelas cubrieron ingesta/notificaciones, M365/acceso
  y correlador/informes; una revisión cruzada verificó los criterios y contradicciones documentales.
  El programa ordenado de siete bloques, límites, pruebas y gates queda en [25](25-programa-confiabilidad-e-investigacion.md).
  Se registró B13 en [10](10-decisiones.md): PostgreSQL durable en el perfil EC2 actual; SQS queda
  para el perfil serverless con IAM. También se corrigieron descripciones M365 que aún afirmaban que
  `ActivityFeed.Read` no estaba concedido. La implementación local del punto 1 está preparada para
  revisión; faltan gates externos de PostgreSQL, Indexer, canario y latencia.

- **Dueno del grupo SOC:** la auditoria detecto que la cache local de 60 segundos podia conservar
  el rol despues de una baja confirmada. `directoryOwnerSource` ya no mantiene cache; tras el primer
  sync confirmado, cada autenticacion consulta PostgreSQL y Graph solo resuelve el bootstrap previo.
  API build PASS, 18/18 pruebas de `directory-sync` + `directory-activation` y 28/28 de `role-grants`
  reportadas. Es evidencia
  local, no validacion de permisos efectivos, despliegue ni revocacion multi-replica en entorno.
  Detalle: [04](04-identidad-y-acceso.md).
- **Investigación y exportación:** la vista permite descargar CSV UTF-8 para Excel (punto y coma) y abrir
  la impresión del navegador para PDF. El CSV incluye resumen, entidades, hasta 100 eventos de la consulta
  actual y sus grupos temporales por entidad con una brecha máxima de 15 minutos entre eventos. Al imprimir,
  aparecen todos los grupos calculados, incluidos los grupos plegados o fuera del límite visual inicial;
  esto no incorpora los eventos posteriores que el Indexer no devolvió. No equivale a un expediente integral,
  `.xlsx`, hilo o dirección de correo. Detalle y límites: [08](08-frontend-unificado.md).
- **Correlador Go:** el matcher usa la cadena más reciente que preserva el orden de las etapas y filtra una
  vez los hits por ventana. La prueba de coherencia de evidencia y `go test ./...` pasaron en
  `golang:1.23.12-bookworm`; se aplicó `gofmt`. La mejora no cambia las prioridades ni acredita una
  reducción medida de falsos positivos. Detalle: [17](17-ingenieria-de-deteccion.md).
- **Qapaqzito con progreso SSE:** el código local añade `POST /api/assistant/chat/stream` con eventos
  `started`, `progress` (`model_started`, `tool_started`, `tool_finished`), y `complete` o `error`; el
  panel muestra el progreso operativo a medida que llega. `complete` contiene la respuesta final tras
  scrub, validación de citas, auditoría e intento de guardado; no expone razonamiento ni deltas de texto.
  `/api/assistant/chat` sigue como fallback JSON. El soporte objetivo es EC2/nginx con `proxy_buffering off`;
  no se asume compatibilidad de buffering en API Gateway/Lambda ni se verificó `messages.stream` para
  Anthropic o Bedrock. Los builds de `@qapaq/assistant` y `@qapaq/api`, el typecheck aislado del cliente SSE
  y la suite Vitest integrada (94 archivos, 1.148 pruebas) pasaron según la ejecución local. El
  en esa corrida el typecheck completo del plugin no corrió por falta de `QAPAQ_TOOLS_DIR`. Sin despliegue ni validación
  visual publicada. Detalle:
  [15](15-qapaqzito-asistente.md).
- **Notificaciones:** no se encontró una falla determinista de cursor u outbox en la revisión local. La
  política predeterminada agrupa las repeticiones, retiene P3/P4 para el digest y manda P2 con más de una
  hora al resumen; Teams requiere una URL de Workflow configurada. Para diagnóstico del host se necesitan
  salud operativa, salud de fuente, estado del canal e historial de avisos.
- **Entrega de Wazuh:** implementación local con inbox PostgreSQL de hints minimizados, clave de
  idempotencia, claims `SKIP LOCKED`, lease/fencing, reintentos y fallo terminal. El API valida HMAC
  y ventana temporal, y solo responde `202` después del commit; el worker consulta el documento
  original en Indexer y reutiliza el normalizador/promotor del pull. El emisor `integratord` sigue
  siendo best-effort; el pull queda como reconciliación. No se declara activo: falta prueba
  PostgreSQL ejecutable en este entorno, fixture/mapping autorizado de Indexer, URL/secreto
  sincronizados, canario y medición de latencia. Detalle en [25](25-programa-confiabilidad-e-investigacion.md).
- **Correo enviado/recibido:** la investigación agrupa eventos disponibles en el Indexer por entidad y
  proximidad temporal (15 minutos); no lee cuerpos, Message-IDs, hilos ni dirección enviado/recibido del
  buzón. Una vista de grupos específicos de correo e informe integral quedan pendientes de contrato,
  permisos Graph y validación de extremo a extremo.
- **Despliegue:** no se pudo consultar AWS desde este entorno: AWS CLI intentó usar el proxy local
  `127.0.0.1:9`; el sitio público tampoco fue accesible. Los cambios locales y archivos de configuración
  de dashboard modificados no cuentan como desplegados ni como verificados visualmente.

## 2026-11-11 · Punto 1 del programa: ingesta push durable de Wazuh (cambios locales)

- **Implementación:** API con validación HMAC/ventana temporal y allowlist de hint mínimo; PostgreSQL
  inbox con idempotencia, `SKIP LOCKED`, lease/fencing, reintentos, fallo terminal y métricas; worker
  consulta el documento original por el conector Indexer y comparte normalización/promoción con pull.
  El `202` queda después del commit. Se añadieron pruebas unitarias del controller y worker,
  contrato y adapter PostgreSQL, lookup del conector y emisor Python.
- **Validado localmente:** `pnpm.cmd --filter @qapaq/api... build`, `pnpm.cmd --filter @qapaq/database
  validate`, build/typecheck de `@qapaq/database` y build de `@qapaq/soc` (resultados del agente de adapter),
  typecheck estricto de los tests API/configuración/DB; Vitest unitario pasó 77 pruebas en 5 archivos;
  17 pruebas Python pasaron con `python -m unittest discover -s wazuh/manager/integrations/tests -p 'test_*.py'`;
  el receptor Node pasó 11 pruebas y omitió 1 que requiere OpenSSL. `custom-qapaq` ahora se filtra desde
  nivel 3 para los grupos QAPAQ/M365. El despliegue prepara el localfile y el receptor AWS en ese orden;
  la activación push está en un script separado, con gate explícito, comparación local de HMAC y
  validación/rollback, y no se invoca desde el deploy.
- **Validación PostgreSQL local:** Docker 29.8.1 inició un contenedor PostgreSQL 18.6 aislado. La
  corrida completa previa al fix dio 99 aprobadas y 1 fallo de advisory-lock P2; las 7 pruebas de la
  inbox push pasaron. Tras cambiar ambos locks a `$executeRaw`, la repetición completa pasó en
  19 archivos y 102/102 pruebas. La validación multi-réplica en el perfil objetivo y el canario
  autorizado siguen pendientes.
  No hay fixture/mapping real redactado del Indexer, canario sintético autorizado,
  URL/secreto sincronizados con el Manager, medición de latencia, policy verificada de retención ni
  despliegue. Por ello B13 sigue como Gate y el fast path no se declara activo. Ver [07](07-deteccion-ml-y-soar.md),
  [18](18-integraciones.md) y [25](25-programa-confiabilidad-e-investigacion.md).

## 2026-11-11 · Puntos 2 y 3: frescura y notificaciones (validación local; canario pendiente)

- **Semántica de tiempo:** `occurredAt` conserva el timestamp fuente; `observedAt` refleja el
  `collectedAt` del documento leído desde Indexer; `receivedAt` usa la hora del runtime QAPAQ al
  normalizar. La inbox guarda `received_at` al confirmar el receipt durable. Se añadió una prueba
  que verifica la semántica y que replay con tiempos de recepción distintos conserva `recordId`.
- **Frescura:** `GET /api/sources/health` calcula lag `newestEventAt → completedAt` y entrega
  percentiles, tamaño de muestra y clock skew a la UI. Solo usa polls exitosos y no vacíos, sobre
  hasta 50 observaciones recientes; tiempos fuente futuros se cuentan como skew y se excluyen. En
  Operaciones, la inbox expone receipt→handler (`received_at → processed_at`) p50/p95/p99 para
  recibos procesados de las últimas 24 h, además de backlog y terminales. Está en prueba: no mide
  Indexer→Manager ni end-to-end, no hay canario/SLO; la suite PostgreSQL local ya pasó, pero falta
  validación multi-réplica en el perfil objetivo.
- **Notificaciones:** los envíos Web Push toman todos los destinatarios; Teams sigue limitando las
  menciones a 25. El límite horario corresponde a P2: su plaza se reserva atómicamente en PostgreSQL
  entre réplicas; P1 está fuera del cupo. El settlement local ya confirma una hora tras entrega o
  fallback, libera fallos transitorios conocidos y retiene resultado ambiguo con lease de 2 min;
  cada retry reutiliza la clave idempotente. Se añadió migración `20261111143000_notification_p2_reservation_leases`.
  El agente reportó SOAR 51/51, typecheck/build de database y SOAR, y `prisma validate` aprobados.
  La suite PostgreSQL corre contra un contenedor 18.6 aislado; la corrida completa previa al fix
  dio 99 aprobadas y 1 fallo de advisory-lock P2. Después de `$executeRaw`, la suite completa pasó
  en 19 archivos y 102/102 pruebas. También faltan validación multi-réplica, canario y proveedor
  autorizado; no hay SLO
  validado. Más detalle: [25](25-programa-confiabilidad-e-investigacion.md).

## 2026-11-11 · Punto 4: UX de investigación (cambios locales)

- **Selección de entidades:** la UI y el filtro de timeline ahora comparten la selección limitada a
  ocho entidades, evitando que un pivote no visible siga afectando la consulta. El agente ejecutó
  Vitest con configuración temporal explícita para `common/investigation.test.ts` y
  `server/investigation.test.ts`: 2 archivos, 20/20 casos; la configuración se eliminó al terminar.
- **Origen de la alerta:** `_id` exacto cuando está disponible; de lo contrario, fallback heurístico
  por `ruleId + description` en ±5 min, luego por `ruleId` en ±5 min, seleccionando el evento más
  cercano. No requiere coincidencia única, así que no prueba identidad exacta del documento.
- **Límites visibles:** el informe recorre páginas de hasta 100 eventos, con tope de 10.000;
  muestra progreso monotónico, permite cancelar y reintentar, y genera CSV, XLSX OOXML y expediente
  HTML imprimible como PDF. El progreso y los artefactos viven en el navegador; no hay job durable ni
  renderer PDF server-side. Los grupos combinan entidad y proximidad temporal, pero no demuestran
  hilo, dirección de correo ni causalidad.
- **M365:** algunos esquemas de eventos del Activity Feed admiten metadatos opcionales como
  `MailboxOwnerUPN`, `recipientList` o `InternetMessageId`/`NetworkMessageId`; no son universales.
  La proyección QAPAQ ahora conserva una lista allowlisted de metadatos, con destinatarios acotados;
  el agrupado por ID exacto se mantiene separado de los grupos temporales. Falta fixture
  aprobado/redactado y validación autorizada; no implica lectura/cobertura de buzones ni análisis
  M365 real. Contrato y permiso: [25](25-programa-confiabilidad-e-investigacion.md).
- **Saneamiento del visor:** revisión cruzada detectó que `full_log` corto podía aparecer en el JSON
  expandible, ya que la prueba previa solo cubría documentos cuyo tamaño disparaba truncamiento. El
  servidor ahora elimina recursivamente `full_log` y `previous_output`, mantiene las exclusiones
  M365, cuenta bytes UTF-8 y clona la fuente sin mutarla. Regresión del servidor: 18/18 aprobadas;
  falta build completo del plugin OSD y validación en Dashboard desplegado.

## Pendientes del roadmap (corte 2026-11-11)

- Detección de conexiones de red y más capacidades nativas de Wazuh.
- Monitoreo de proveedores con timers `qapaq-provider-*` y salud de M365.
- Medición real de latencia y calidad de Qapaqzito antes de ajustar presupuestos o declarar ahorro.
- Validación de precisión/recall y ajuste de reglas de correlación con corpus SOC adjudicado; el
  evaluador offline ya está disponible, pero no hay corpus incluido y no se atribuye reducción de FP.
- Silencio de fuentes y priorización KEV/EPSS siguen como propuestas: [19](19-brechas-y-roadmap.md).

## 2026-11-11 - Validacion local de puntos 5 a 7; despliegue pendiente

- **Owners SOC:** `directoryOwnerSource` ya no mantiene cache local. Tras el primer sync confirmado,
  cada autenticacion consulta el roster durable de PostgreSQL; Graph es fallback solo antes de esa
  primera confirmacion. API build PASS y 18/18 pruebas de `directory-sync` + `directory-activation`
  fueron reportadas. Falta validacion en PostgreSQL/replicas, permisos efectivos y entorno.
- **Privacidad M365:** `eventOf` sanitiza `office365.Parameters`, `office365.ModifiedProperties` y
  `office365.response`; la consulta related los excluye. Pruebas de plugin comun + servidor 21/21.
  Sigue pendiente fixture autorizado/redactado, contrato de datos y retencion; no se valido tenant ni
  despliegue.
- **Correlador:** API/Prometheus/report incluyen conteos TP/FP/revisados/no revisados, ventana y
  truncamiento del feed. La cohorte de alertas usa `OccurredAt`; los veredictos se agrupan por fecha
  de adjudicacion y ventana, con filtro de futuro. `go test ./...` pasó en `golang:1.23.12-bookworm`
  y se aplicó `gofmt`. Esto no mide precision/recall ni reduccion de FP. El matcher acepta empates de timestamps
  con resolucion de segundos; cambiarlo a orden estricto podria perder senales, por lo que queda
  condicionado a corpus y evaluacion.
- **Informes:** la UI local genera CSV/XLSX OOXML/HTML imprimible desde páginas completas hasta 10.000
  resultados, con progreso, cancelación y reintento. No hay job durable, artefacto con ACL ni renderer
  server-side PDF; no se afirma continuidad tras cerrar sesión.

## 2026-11-11 - Suite integrada y validaciones finales locales

- La corrida final `pnpm.cmd exec vitest run --config vitest.config.ts --configLoader native --pool=threads --maxWorkers=1 --testTimeout=30000` pasó:
  94 archivos y 1.161 pruebas. El primer intento en sandbox no pudo crear procesos hijos; la repetición
  con permisos de ejecución y la configuración de un solo worker terminó verde.
- Con PostgreSQL 18.6 efímero y `DATABASE_URL`, `pnpm.cmd run test:integration --configLoader native --pool=threads --maxWorkers=1 --testTimeout=30000` pasó 19/19 archivos y 102/102 pruebas. El contenedor temporal se retiró; se dejaron intactos los servicios Wazuh existentes.
- `python apps/api/scripts/generate-qapaqzito-knowledge.py --check` y API build reportados PASS.
  Typechecks de database/SOAR reportados PASS; suite Wazuh Python 17/17, receptor AWS Node 11 PASS
  y 1 omitida por OpenSSL.
- Esto no cambia los gates: la suite PostgreSQL completa tras el fix pasó 19/19 archivos y 102/102
  pruebas; falta cerrar validación multi-réplica, plugin build completo y validacion/despliegue en
  entorno. No se declara
  release.

## 2026-11-11 · Cierre de reintentos push tras revisión cruzada

- Los hints ausentes en Indexer y los errores retryables ya no se terminalizan después de ocho
  intentos. El retry usa backoff exponencial con jitter determinista por clave de idempotencia, desde
  250 ms hasta un máximo de 60 s; conserva el receipt pending indefinidamente hasta su promoción.
- Un redelivery HMAC válido reabre un `failed-terminal` solo cuando la misma clave y el mismo
  `managerName`, `alertId` y `occurredAt` coinciden exactamente. Restablece el intento y programa
  disponibilidad inmediata; jamás reabre `processed`. Respuesta del endpoint identifica ese caso
  como `requeued` sin exponer el documento ni el payload de alerta.
- Se conserva `oldestUnresolvedAt` para alertar backlog; si Indexer o la promoción permanecen caídos,
  receipts se acumulan y necesitan monitoreo/capacidad. El pull mantiene el solape de 120 s como
  reconciliación secundaria. No se desplegó ni se probó contra un Indexer real.
- Revisión posterior: suite unitaria completa 94/94 archivos, 1.161/1.161; suite PostgreSQL completa
  19/19 archivos, 102/102; API build PASS. La ventana de retry queda pendiente de prueba de carga y
  canario real, por lo que no se declara SLO ni despliegue.

## 2026-11-11 · Quiet window de notificaciones con reserva entre réplicas

- El despacho ahora reclama de forma atómica `(tenantId, groupKey)` con advisory lock PostgreSQL,
  token de fencing y lease de dos minutos. La migración `20261111150000_notification_group_dispatch_reservations`
  persiste la reserva.
- Aceptación Teams o fallback confirma el quiet window; un rechazo conocido lo libera; el resultado
  ambiguo lo conserva por el lease de reconciliación. Un token viejo no puede confirmar ni liberar
  una reserva tomada después.
- El mensaje que pierde la carrera se guarda como `suppressed`, razón `grouped`, con `supersededBy`
  y queda en `listUndigested` para el digest. No se pierde silenciosamente.
- La prueba PostgreSQL bloquea el primer transporte, compite con un segundo store/replica para la
  misma regla y confirma que solo se ejecuta un envío y que el perdedor queda visible para digest.
  Prueba focalizada: `modules/soar/test/postgres-dispatch.integration.spec.ts`, 4/4.

## 2026-11-11 · Serialización de despliegues a Wazuh

- Los workflows mutadores del nodo demo, Terraform demo y control de costos comparten
  `qapaq-secops-demo-wazuh-host-mutations` y no cancelan una ejecución activa. El lock S3 de Terraform
  sigue limitado a su backend y no se presenta como lock para SSH/SSM. GitHub conserva como máximo
  una ejecución pendiente por grupo y puede reemplazar una pendiente anterior; la garantía es que
  no se solapan ejecuciones activas de este grupo, no que cada despacho quede en cola.
- `ship.sh` ahora sube a un directorio de release único; no borra `/opt/qapaq/src`. Un lock `flock`
  de host cubre la activación del symlink y `deploy-host.sh`; una ejecución concurrente falla antes
  de sustituir el árbol activo. Si el despliegue falla, el symlink de código vuelve a la release
  anterior. Los datos de releases se conservan para análisis/rollback. En la primera activación,
  cuando `/opt/qapaq/src` aún es un directorio real, se mueve a `releases/legacy-*` antes de poner
  el symlink; ese cambio inicial puede dejar una breve ausencia de la ruta, aunque el lock impide
  que otro despliegue la cambie a la vez.
- Se mantiene explícita la cuenta PowerUser `061098277310` y el destino demo de workflows
  `123456789012`; no se mezclan perfiles ni estados Terraform. No se ejecutó ningún deploy. La
  revisión remota del otro despliegue sigue pendiente de identidad, SSM y estado/lock válidos.

## 2026-11-11 · Progreso durante exportación de informes

- CSV y el expediente imprimible ahora serializan por bloques de 250 filas, ceden el hilo de UI entre
  bloques y permiten cancelar antes de entregar el archivo o abrir el diálogo de impresión. Se
  conserva la salida previa byte por byte; una regresión de BOM/separadores entre bloques se detectó
  y corrigió con prueba de paridad.
- Validación focalizada de informes/exportaciones: 10/10 pruebas; suite unitaria completa: 94/94
  archivos y 1.161/1.161; PostgreSQL 18.6 temporal: 19/19 archivos y 102/102. El build/typecheck
  completo de OSD seguía pendiente en esta corrida porque faltaba `QAPAQ_TOOLS_DIR` con la versión exacta de OUI/TypeScript.
  No se ha validado visualmente en el Dashboard desplegado.

## 2026-11-12 · Inspección AWS de solo lectura; despliegue sin confirmar

- STS confirmó la cuenta PowerUser `061098277310` en `us-east-1`. La instancia `qapaq-soc-dev-node`
  (`i-042136f7d23a8ccf2`) está `running`; no aparecieron operaciones CloudFormation activas ni
  comandos SSM recientes.
- La instancia no aparece registrada como nodo administrado por SSM. Por eso esta inspección no
  puede descartar un despliegue manual por SSH ni confirmar qué proceso sigue activo. No se inició
  otro despliegue y no se reinició ningún servicio. La inspección no cubrió la cuenta demo
  `123456789012`.
- `terraform fmt -check -recursive` y `terraform validate -no-color` pasan en `infra/aws-poweruser`.
  `terraform plan` contra el backend de esa raíz terminó con código 0 y produjo temporalmente cinco
  acciones `create`, cero `update` y cero `delete`: endpoint EC2 Instance Connect, SG/reglas
  asociadas y una regla SSH para un CIDR permitido. Se revisaron las cinco direcciones y se eliminó
  el plan temporal; no se aplicó. Este plan es de infraestructura y no publica los cambios de
  API/Dashboard. El proceso PowerShell envolvente devolvió código 1 tras la limpieza, así que queda
  pendiente repetirlo en el flujo autorizado que genere evidencia persistente antes del apply.
- A21 nombra `terraform-demo.yml` como pipeline oficial, pero ese workflow opera `infra/aws` en
  `123456789012`; no opera esta raíz `infra/aws-poweruser` con backend de `061098277310`. La raíz
  PowerUser documenta Terraform seguido de `ship.sh`, así que queda por resolver el pipeline
  autorizado para este entorno antes de aplicar. Evidencia ampliada en [25](25-programa-confiabilidad-e-investigacion.md).

## 2026-11-12 · Observabilidad de latencia de notificaciones (cambio local; integración pendiente)

- `GET /api/operations/health` incorpora `soc.outboxToProviderAcceptanceMs`: p50/p95/p99 en ms,
  muestra y ventana fija de 24 h, solo a través de `observability.read_soc`. Mide desde la creación
  durable del outbox hasta la primera evidencia de aceptación HTTP 2xx del proveedor; no significa
  lectura humana ni confirma un SLO. La consulta PostgreSQL limita el muestreo a 10.000 mensajes,
  mantiene el tenant en el join y cuenta timestamps excluidos por skew. Detalle y límites en [25](25-programa-confiabilidad-e-investigacion.md).
- Evidencia local reportada: `operations-health.spec.ts` 10/10; suites API/BFF/SOAR 125/125;
  `prisma validate` y builds/typechecks de database, SOAR y API pasan. La prueba de integración
  `platform/database/test/postgres-c20.integration.spec.ts` ejecutada en PostgreSQL temporal
  aislado pasó 1 archivo y 7/7 pruebas. El spec usó base separada a la del benchmark y la eliminó.
- El benchmark opt-in del punto 1 procesó 9.000/9.000 receipts en PostgreSQL 18.6: 6.000 a 10/s
  por 600 s y 3.000 a 50/s por 60 s; backlog final 0. p95 autenticación/controlador→commit:
  11,86 ms global, 13,38 ms sostenido y 9,42 ms burst. p95 `received_at→processed_at` del consumer
  sintético: 49 ms. `PASS_LOCAL_COMPONENT_BENCHMARK`; no midió Indexer→alerta SOC (`NOT_MEASURED`)
  y no acredita SLO desplegado. Script, comando de reproducción, SHA base y límites: [26](26-benchmark-ingesta-push.md).
- La corrida local usó Node.js 24.21.0, pnpm 12.4.2, PostgreSQL 18.6, sobre host Windows; el
  checkout partía de `HEAD d9d2f025017e978f9f2f697dc06441f1c1c1ca1c` con cambios sin commit. No hay
  medición en entorno, canario, despliegue ni SLO acreditado.

## 2026-11-12 · Latencia origen→recepción del inbox Wazuh

- `WazuhPushInboxStore.metrics()` ahora calcula p50/p95/p99 desde `occurred_at` validado del hint
  hasta `received_at` persistido en PostgreSQL; la consulta cubre receipts de 24 h y limita el
  muestreo a 10.000 filas recientes más una centinela. Excluye timestamps futuros por skew y expone
  el conteo excluido y si se alcanzó el límite. El índice nuevo acelera la búsqueda por
  `received_at DESC, id DESC`.
- La vista Operaciones distingue este tramo de `received_at→processed_at`, cuyo fin significa
  handler completado y no necesariamente una alerta nueva. `GET /api/operations/health` conserva
  `observability.read_soc`; no se exponen hints, IDs, eventos ni identidades.
- La tabla inbox es deployment-scoped y no incluye `tenant_id`; el controller solo carga el agregado
  cuando el `tenantId` del actor coincide con el de la fuente Wazuh. La regresión BFF con dos tenants
  verifica que para el segundo el store no se consulta y la métrica no se devuelve.
- Validación: database validate/typecheck y API typecheck PASS; `operations-health.spec.ts` 10/10,
  `bff.spec.ts` 105/105; `postgres-wazuh-push-inbox.integration.spec.ts` 9/9 en PostgreSQL 18.6
  temporal, con skew, ventana, percentiles y aislamiento tenant verificados. El tramo no demuestra
  Indexer visible→SOC alerta persistida, Manager→API, latencia de red, multi-réplica ni SLO
  desplegado. Detalle en [25](25-programa-confiabilidad-e-investigacion.md).

## 2026-11-12 · Apply PowerUser y límites de evidencia del release

- Se añadió `.github/workflows/terraform-aws-poweruser.yml`: ejecución manual `plan`/`apply`, solo
  desde `main`, OIDC con cuenta permitida `061098277310`, raíz `infra/aws-poweruser`, backend
  `aws-poweruser/dev/terraform.tfstate` y concurrencia no cancelable. El flujo aplica solo el plan
  recién creado en esa ejecución. El administrador aún debe provisionar el rol OIDC y configurar la
  variable de repositorio `QAPAQ_AWS_POWERUSER_TERRAFORM_ROLE_ARN`; si falta la variable, la ejecución
  se detiene antes de pedir credenciales y, si falta la confianza del rol, falla la asunción OIDC.
  El workflow no crea ni cambia IAM.
- Apply Terraform completado en la cuenta PowerUser: exactamente **5 creates, 0 changes y 0
  destroys**. Incluye el endpoint EC2 Instance Connect `eice-0eaf1a225d0c59616` y sus recursos de SG;
  no reemplazó recursos declarados existentes. No se ejecutó `ship.sh` ni se publicó/desplegó código
  de API, Dashboard o aplicación. Terraform actualizó infraestructura únicamente.
- **Qapaqzito:** mantiene límites locales de 4 rondas, 8 consultas de herramientas, 4096 tokens de salida
  por llamada y 8192 acumulados, además de topes de contexto/historial; pruebas reportadas: módulo
  `@qapaq/assistant` 32/32 y API assistant/historial 34/34, con typechecks aprobados. Sin canario de
  proveedor ni medición real de consumo/calidad: no se cuantifica ahorro ni se declara calidad
  preservada. Detalle: [15](15-qapaqzito-asistente.md).
- **Evaluador del correlador:** `evaluate-corpus` escribe el informe y devuelve código 4 si el corpus
  no alcanza evidencia suficiente; código 3 sigue reservado para violaciones de guardrails. El
  agregado `overallCandidate` deduplica IDs estables compartidos entre familias; IDs con anotaciones
  o predicciones incompatibles se rechazan. `go test ./...` pasó; las pruebas usan corpus sintético.
  No hay corpus SOC adjudicado ni reducción real de FP demostrada. Semántica y requisitos: [17](17-ingenieria-de-deteccion.md).

## 2026-11-12 · Revisión final local antes del envío de aplicación

- Se corrigió un defecto de investigación: los controles de continuar/reintentar no invocaban la carga
  de la página siguiente. La prueba de interacción verifica que ambos handlers se ejecuten. Además,
  `readOwners()` ahora consulta solo el OID del propietario, evitando depender de lectura de perfil
  para resolver las concesiones del grupo SOC.
- Se corrigió una fuga de Qapaqzito: `thinking` se desenmascaraba y podía llegar por POST e historial.
  Ninguna ruta guarda ni devuelve ese bloque; la migración `20261112120000_remove_qapaqzito_thinking`
  elimina el campo legado. El progreso de usuario usa `steps` y eventos SSE curados.
- Revalidación: suite unitaria 94 archivos/1.170 pruebas; PostgreSQL temporal `@qapaq/database` 13
  archivos/86 pruebas con cleanup PASS; conversación/migración Qapaqzito PostgreSQL 6/6; API build,
  assistant typecheck, Prisma validate, evaluación Go en contenedor Go 1.23.12 y workflow checks 12/12
  PASS. La suite de integración general registró 27 PASS y 77 omitidas; estas últimas no cuentan como
  pruebas de servicio real.
- Plugins `qapaq_ops` y `qapaq_i18n` compilados para OSD 2.19.6. `qapaqOps-2.19.6.zip` SHA-256
  `9eb3805e5fa40e14410e1e61dd79120a977cbed59be24c31a5d26680f0fe444`; `qapaqI18n-2.19.6.zip`
  SHA-256 `e28ca99c79f0a3da63d0785ae6c8dc67969040efe2ac9bdf0f33a6863fb3f5a9`. No hubo prueba de
  navegador contra la instancia publicada.
- **Estado AWS:** Terraform ya aplicó cinco recursos y no destruyó ni cambió recursos existentes. El
  envío de aplicación sigue pendiente: el perfil `qapaq` local está vencido, `default` no firma y el
  único perfil autenticado probado es de otra cuenta. No se usó esa identidad ni se desplegó el código.
  No se requiere OIDC para `ship.sh`; hace falta que la sesión local obtenga credenciales válidas de
  `061098277310` y el lock remoto permitirá abortar si ya hay otro deploy activo.
- Siguen abiertos el canario real Wazuh→Indexer→SOC, muestra M365/Graph autorizada, aceptación real de
  Teams, prueba multi-réplica, medición adjudicada de FP y verificación de la consola ya desplegada.

## 2026-11-12 · Estado posterior: release dev activada y UI pendiente de smoke visual

- Esta entrada supersede los estados anteriores de "aplicación pendiente" de este mismo día. La
  release `20261112T154837-f241` quedó activa en la EC2 existente (`i-042136f7d23a8ccf2`); no se
  creó una segunda instancia. El despliegue reconstruyó y recreó dashboard/API/edge bajo el lock del
  host y reportó migraciones al día, servicios saludables y finalización de release. Se retuvo la
  release previa para rollback.
- AWS consultado después del deploy: STS confirmó la cuenta `061098277310`; la instancia seguía
  `running`, el ALB `qapaq-soc-dev-alb` `active` y su target EC2 en puerto 443 `healthy`. Terraform
  plan indicó que la infraestructura coincidía con el estado declarado (sin cambios). Esto prueba
  salud del host y target, no renderización de la aplicación en un navegador.
- Route 53 resuelve `dev.security.qapaq.pe` como alias del ALB esperado y su listener HTTPS reenvía al
  target group del edge. AWS CLI 2.38.0 en Windows falló al abrir EIC; el CLI Linux 2.40.1 de la
  imagen local `qapaq-ship-toolbox:awscli2` sí abrió el túnel. No se cambió infraestructura.
- Inspección remota de solo lectura: `/opt/qapaq/src` resuelve a
  `/opt/qapaq/releases/20261112T154837-f241`; dashboard, API y edge están `running`. El bundle
  instalado en `qapaqOps/target/public` contiene `Canales`, `Sin prueba reciente` y `fallback_email`
  (`BUNDLE_MARKERS=OK`). Desde el propio host, `/qapaq/login` y `/health/live` respondieron HTTP 200.
  El navegador aún requiere smoke autenticado para confirmar render e interacción tras iniciar
  sesión; el endpoint de login anónimo solo prueba que el edge entrega la página.
- El ZIP local `infra/local/wazuh-dashboard/plugins-dist/qapaqOps-2.19.6.zip` (539.568 bytes,
  generado 2026-11-12 10:45 hora de Lima; SHA-256
  `c9de50d52c1411c3c4c52fa66dfcc684d93bb1a434cb786a94a74b2348be885d`) contiene en el bundle
  público los strings `Canales`, `Sin prueba reciente` y `fallback_email` de los cambios actuales.
  El flujo de release copió ese ZIP y construyó/recreó el dashboard; la inspección del contenedor
  confirma esos marcadores en el bundle instalado. Falta completar navegación autenticada e
  interacción en el dashboard.
- La consulta HTTPS desde Windows no completó conexión/TLS (`SEC_E_NO_CREDENTIALS` en Schannel y
  conexión rechazada desde Python). El edge local respondió HTTP 200 desde el host. La UI
  autenticada sigue **sin smoke de navegador**; no se marca como fallo de la instancia.
- Los cambios se desplegaron desde el worktree local. Permanecen sin commit ni push a `main`; la
  rama remota y el checkout de GitHub aún no representan esta release.
- Validación repetida del worktree después de la release: suite unitaria `95 archivos / 1.172
  pruebas` PASS; `scripts/ci/c04-evidence.ts` con PostgreSQL aislado `13 archivos / 86 pruebas`
  PASS; runner del plugin `qapaq_ops` `16 archivos / 137 pruebas` PASS; `go test ./...` en Go 1.23.12
  PASS; workflow checks `12/12` y `git diff --check` PASS. Estas pruebas no sustituyen un smoke
  visual ni los canarios externos enumerados abajo.
- Permanecen abiertos los gates de canario Wazuh end-to-end, aceptación real de Teams, tenant M365
  aprobado, evaluación del correlador con corpus SOC adjudicado, multi-réplica y smoke de navegador.
  La release dev no significa que todos los cambios funcionales solicitados estén terminados.

## 2026-11-12 - Carril urgente independiente para alertas P1

- El runtime ejecuta despachadores urgentes y normales en paralelo. El claim PostgreSQL aplica filtros SQL: urgente = alerta creada/escalada P1 o incidente abierto critico; normal excluye esos mensajes y conserva P2/P3/P4, incluyendo el limite existente de envios P2.
- Los carriles comparten outbox durable, pero cada fila se reclama una sola vez con `SKIP LOCKED`, lease y fencing token; se mantiene la clave idempotente del intento. Los `kick` existentes despiertan tambien el carril urgente, incluso si la pasada normal esta bloqueada en una llamada de transporte.
- Se agregaron pruebas de orden/filtrado en memoria, regresion de API con P2 lento y claim PostgreSQL de P1/criticos frente a P2. La prueba PostgreSQL requiere `DATABASE_URL`; no se ejecuto un despliegue con este cambio.

## 2026-11-12 · Typecheck oficial y build del plugin qapaq_ops

- Se reescribieron los modificadores de tipo dentro de imports con `import type` separado y se
  reemplazó `satisfies` por un objeto anotado `RelatedCursor`, sintaxis compatible con TypeScript
  4.0. El typecheck real también exigió tipar la proyección de `Object.entries` y `_source` del
  helper de pruebas, sin cambiar su comportamiento.
- `tools/typecheck.mjs` ahora toma OUI desde el path real del volumen: `@elastic/eui/oui.d.ts` y lo
  aliasa como `@opensearch-project/oui`. En OSD 2.19.6 el paquete instalado bajo `@elastic/eui`
  declara nombre OUI y versión 1.19.0.
- Typecheck PASS con Node 18.19.0, volumen Docker `qapaq-osd-build:/work`,
  `QAPAQ_TOOLS_DIR=/work/osd`: `typecheck qapaq_ops: OK (TypeScript 4.0.2, OUI 1.19.0, React 16.14)`.
  Runner `plugin_helpers` OSD 2.19.6 PASS (1 bundle compilado); tests del plugin: 16 archivos,
  137/137 PASS; `git diff --check` PASS.
- ZIP local recién generado `qapaqOps-2.19.6.zip`: 539.645 bytes, SHA-256
  `29dab14b6930bda67c27f078c3ac6cb512333ee3b59aecfbb389b4b67bb09b7c`. Es evidencia de build
  local posterior; no fue desplegado ni sustituye el smoke autenticado de navegador pendiente.
- Para que la latencia urgente no dependa del volumen de mensajes P2/P3/P4, se agrega un indice parcial por disponibilidad/ID con el predicado P1/critico idéntico al SQL. El claim urgente usa una consulta literal separada para que PostgreSQL pueda reconocer el indice parcial; se evita mantener un campo clasificador en paralelo. La spec hace `EXPLAIN ANALYZE` con 5.000 P2 y valida que el indice urgente sea elegido.

## 2026-11-12 · Verificación OIDC PowerUser y recuperación de paneles

- AWS STS confirmó la cuenta `061098277310`, pero el rol SSO disponible no permite `iam:ListOpenIDConnectProviders` ni `iam:GetOpenIDConnectProvider`; no se pudo comprobar la existencia ni la trust policy del proveedor/rol OIDC. El conector GitHub tampoco permite leer variables del repositorio. En `main` no está el workflow `terraform-aws-poweruser.yml` y no hay ejecuciones PowerUser registradas; el workflow local está sin seguimiento. Por ello OIDC para Terraform PowerUser **no está verificado ni conectado a una ejecución en GitHub**.
- El bootstrap no borra dashboards del usuario: importa objetos QAPAQ por IDs estables, aunque limpia tres index patterns heredados. Los objetos `qapaq-det-*` no se importan durante `deploy-host.sh`; antes dependían de una ejecución manual. La lectura live por EIC confirmó 12 dashboards en Global y cinco en el tenant por defecto. Global contiene los seis `qapaq-det-*`, los cinco dashboards de proveedor y `qapaq-dashboard-aws`; el tenant por defecto contiene los cinco dashboards de proveedor. No se consultaron los objetos privados de la sesión personal.
- Corrección local preparada: fijar `securitytenant: global` en imports y verificaciones, seleccionar Global como tenant predeterminado del Indexer para nuevos inicios de sesión, ordenar Global primero en el selector e importar automáticamente las seis vistas de detección en cada release. Cambiar el tenant predeterminado no cambia la sesión ya abierta; el usuario debe elegir Global o iniciar una sesión nueva. Los saved objects existentes se conservan. Esta corrección todavía no está desplegada.
- No se hizo `terraform apply` ni se reimportaron objetos en producción. La consulta live fue de solo lectura. `bash -n` pasó para los cinco scripts tocados; `git diff --check` pasó. El cambio local de configuración/importación aún no está desplegado.
## 2026-11-12 · Estado runtime live `20261112T182253-7624`: push, correlador y Cintel

- En el release live, API QAPAQ y el servicio separado `services/qapaq-correlator` reportaron estado
  healthy. Esto comprueba salud de proceso; no demuestra reducción de falsos positivos. La evaluación
  de calidad sigue pendiente de corpus SOC adjudicado y lectura de `/readyz`/métricas con evidencia
  del entorno.
- La integración `custom-qapaq` del Manager está activada, pero la llamada HTTPS falla por CA no
  configurada para el runtime Python. No existe receipt durable de esa llamada; el fast path push no
  está entregando alertas y todavía no se ha verificado una corrección ni un canario posterior. El
  siguiente gate es configurar confianza TLS sin desactivar la verificación, probar desde Manager,
  y confirmar `202`, receipt, promoción idempotente y alerta visible con un evento aprobado.
- Cintel no está integrado ni desplegado en AWS: `services/cintel-worker` solo contiene el paquete
  CLI vendorizado, sin imagen/worker, servicio Compose, ruta API, cola ni workflow de release. La
  integración sigue sujeta a la autorización de licencia y a los gates de privacidad/aislamiento de
  [la evaluación Cintel](security/cintel-integracion-qapaq.md).
- En EC2 no hay un worker BullMQ/SQS independiente: la inbox/outbox PostgreSQL y sus despachadores
  pertenecen al proceso API; `apps/worker` continúa lifecycle-only y no figura en el Compose EC2.
  Los workers que Shuffle/Orborus crea son parte de Ankay, no Cintel ni procesamiento de
  informes.

## 2026-11-12 · Motivos de promoción, despacho Teams y exportación Qapaqzito

- **Promoción:** `GET /api/sources/health` y Salud de fuentes desglosan eventos por debajo del umbral QAPAQ y suprimidos por política. El endpoint manual mantiene `outcome: not_promoted` y añade el motivo tipado. No se cambió la priorización.
- **Teams:** las pasadas automáticas de outbox usan hasta cinco envíos concurrentes con los claims/leases, idempotencia, fencing, reservas P2 y agrupación existentes. Los drains manuales y el helper mantienen concurrencia uno por defecto. La métrica de Operaciones registra `responseAt`, excluye respuestas de correo y datos históricos sin marca de respuesta.
- **Qapaqzito:** el prompt dirige al botón Crear informe bajo la respuesta y distingue XLSX de la vista imprimible que el navegador guarda como PDF. El documento de producto aclara permisos, requisito de evidencia para expedientes y límites del cliente.
- **Investigación M365:** los informes PDF/XLSX agrupan por identificador de mensaje exacto y resumen buzones auditados, destinatarios allowlisted, operaciones y truncamiento. Solo las operaciones de envío explícitas clasifican salida; la auditoría actual no demuestra recepción ni identifica siempre al actor humano. Citas de [Qapaqzito](15-qapaqzito-asistente.md) y criterios en [confiabilidad](25-programa-confiabilidad-e-investigacion.md).
- **Validación local:** pruebas unitarias de assistant (33), API/ingesta/SOAR/detección (152), plugin qapaq_ops (154), typechecks de API, database, SOAR y assistant, typecheck OSD 2.19.6, e integración PostgreSQL temporal (25) aprobados. Una primera integración detectó semántica de error distinta al paralelizar el helper; se conservó secuencial por defecto y el runtime solicita concurrencia explícita. La integración PostgreSQL se repitió tras ese ajuste (25/25) y los typechecks finales de API, database, SOAR y assistant pasaron.
- **Estado:** cambios locales en la rama de trabajo. No se han desplegado ni se afirma aceptación real de Teams. Continúan pendientes el canario Wazuh→Indexer→QAPAQ, la recepción por Workflow y la medición p95 en el entorno.

## 2026-11-12 · Exportación progresiva de Qapaqzito

- XLSX: el navegador con File System Access escribe OOXML en el destino elegido, por bloques con backpressure, progreso y cancelación. La interfaz confirma el cierre exitoso; el fallback Blob se limita a 50 MiB y se identifica como generación en memoria.
- PDF: Qapaqzito construye la vista HTML y añade filas por lotes de 250 con progreso visible; abre el diálogo de impresión al terminar. La conversión a PDF sigue a cargo del navegador; no crea un PDF parcial ni renderer server-side. El prompt da una instrucción directa para abrir **Crear informe** y no permite responder que Qapaqzito carece de exportación; los estados de finalización distinguen vista imprimible, XLSX y CSV.
- Robustez: el writer deriva el número de tablas del HTML que prepara. Así acepta tanto una respuesta de Qapaqzito sin tablas como un expediente válido sin eventos, sin asumir que ambos siempre tengan el mismo armazón.
- ZIP: pruebas inspeccionan firmas, flags, data descriptors, CRC32, tamaños, nombres UTF-8, offsets y directorio central. La cancelación debe abortar el destino.
- Validación local: plugin `qapaq_ops` 20/20 archivos y 160/160 pruebas; suite assistant/Qapaqzito 2/2 archivos y 33/33 pruebas; typecheck OSD 2.19.6 (TypeScript 4.0.2, OUI 1.19.0, React 16.14) OK; Prettier y `git diff --check` OK. No equivale a revisión visual ni despliegue.
- Bandeja de notificaciones: el frontend consume la forma real de `GET /api/notifications` (metadatos superiores `title`, `priority`, `summary`, `whyItMatters`, `nextStep`, `source`, `entity`, `ruleId`; evidencia `delivery`; resultado `accepted`). Se preserva el contexto ya enmascarado; `accepted` significa que el canal aceptó la solicitud, no que una persona la recibió o leyó. `suppressed` y `superseded` no se presentan como enviados. El botón primario registra en QAPAQ el acuse humano del último intento que admite esa transición.
- Fallo de informes: la UI distingue acceso denegado, Indexer no disponible y respuesta inconsistente; informa que no se creó un archivo parcial y orienta a reintentar o revisar Salud de fuentes.

## 2026-11-12 · CA explícita para Wazuh push (sin deploy)

- `custom-qapaq.py` exige `QAPAQ_INGEST_CA_FILE` y conserva la verificacion TLS obligatoria. Compose monta el bundle publico del host como solo lectura en Manager; `deploy-host.sh`, `deploy-respond.sh` y `deploy-provider-monitoring.sh` lo validan antes del primer uso de Compose. La URL HTTPS, Certbot/rotacion y secretos no cambian.
- En `infra/aws-poweruser`, Terraform declara que no hay rol IAM ni lectura de Secrets Manager; los secretos locales viven en `/opt/qapaq/secrets`. La CA viene del trust bundle del host, sin nuevo acceso a AWS.
- Las pruebas locales verifican configuracion, mount y fallo cerrado. No se hizo deploy, handshake real ni canario; siguen pendientes `202`, receipt y alerta visible.

## 2026-11-12 · Acuse de notificación con auditoría atómica

- `POST /api/notifications/:id/acknowledge` realiza compare-and-set desde `sent`, `indeterminate` o `fallback`, y agrega `soar.notification.acknowledged` con actor, correlación, recurso `notification` y metadata `{ previousStatus }` dentro de la misma transacción. En PostgreSQL la transacción usa el pool del store de intentos y `PrismaAuditStore(tx)` sobre ese mismo `tx`; no cruza los pools Prisma del runtime.
- El store en memoria serializa acuses y escrituras, deja el intento sin cambios si falla el append y rechaza saves stale del dispatcher tras `acknowledged`. PostgreSQL aplica CAS en el acuse y protege el estado reconocido en `save`.
- Añadidas pruebas HTTP para éxito, duplicado concurrente y rollback, además de integración PostgreSQL para carrera entre réplicas, AuditEvent único y protección ante save stale. No se desplegó ni se cambió push.

## 2026-11-12 · Reintentos acotados del emisor Wazuh (local, sin deploy)

`custom-qapaq` reintenta fallos de red, timeout y HTTP 408/425/429/5xx hasta tres intentos de 2 s, con pausas de 250/500 ms y firma nueva para el mismo hint idempotente. No reintenta errores 4xx permanentes ni TLS/CA inválida. La suite local pasó 22 pruebas y 19 subtests; no demuestra el handshake ni receipt live. El despliegue y canario siguen pendientes.

## 2026-11-12 · Clasificación de errores al exportar informes

La colección del informe ya no convierte respuestas HTTP 4xx de validación/ruta en una falsa caída del Indexer ni las reintenta tres veces. `401/403` se clasifican como falta de acceso; `400/404/422` y otros 4xx permanentes como consulta rechazada. Los fallos de transporte, `429` y respuestas transitorias de servidor conservan los reintentos acotados. Se añadió una regresión para garantizar que un `400` termina en el primer intento y no se etiqueta como indisponibilidad.

Validación local: suite del plugin `qapaq_ops`, 21 archivos y 167 pruebas aprobadas. El texto visible «reduce la ventana» no aparece en el código actual; se observa en el bundle previo del dashboard. Este ajuste todavía no se ha desplegado, así que no cambia la pantalla servida hasta que se publique un artefacto nuevo.

## 2026-11-12 · Cobertura de revisión del correlador: semántica y ventana

`reviewCoverage` cuenta como revisadas las alertas con veredicto humano `true_positive`, `false_positive`, `benign` o `duplicate`; `duplicate` no se agrega a las métricas de TP/FP ni a la lógica de supresión. La ventana reportada usa el mínimo entre la ventana de política y el feed efectivamente consultado (696 h por defecto). El fixture de integración sin alertas `qapaq-correlator:*` ahora espera `null/NO_DATA`, como exige denominador cero. La suite completa Go pasó en `golang:1.23.12-bookworm`. El KPI mide revisión, no calidad ni reducción comprobada de falsos positivos; no hay corpus SOC adjudicado.

## 2026-11-12 · Verificación local cruzada del bloque actual

Plugin `qapaq_ops`: 21 archivos y 167 pruebas aprobadas; typecheck OSD 2.19.6 aprobado. API BFF/SOAR: 6 archivos y 162 pruebas aprobadas; typechecks de API, SOAR, database y audit aprobados. Emisor Wazuh: 22 pruebas y 19 subtests aprobados. Las dos suites de integración PostgreSQL C-20 pasaron 12/12 contra PostgreSQL 18.0 temporal. Estos resultados son locales y no sustituyen CI, smoke autenticado ni despliegue.

## 2026-11-13 · Guardado PostgreSQL del dispatcher con filtro válido

La primera integración con PostgreSQL real encontró que `PrismaNotificationAttemptStore.save` pasaba una clave compuesta de `WhereUniqueInput` a `updateMany`, que solo admite el `WhereInput` escalar. Prisma rechazaba la llamada y el dispatcher no podía persistir estados de intentos. El guardado ahora usa igualdad sobre `tenantId` e `idempotencyKey` más el predicado `status != acknowledged`, conservando el compare-and-set ante snapshots stale y la protección del acuse. PostgreSQL C-20 de `modules/soar` y `platform/database` pasó 12/12 en un contenedor PostgreSQL 18.0 limitado a loopback; se retiró al terminar.

## 2026-11-13 · Salud de leases vencidos del outbox

`GET /api/operations/health` ahora expone, por tenant, el número de mensajes `processing` con lease vencido y la edad del vencimiento más antiguo. La consulta usa subconsultas tenant-scoped en un solo round-trip; dos índices parciales por estado soportan conteo, mínimo y rango de lease sin recorrer mensajes publicados. La sección SOC se degrada con `OUTBOX_LEASE_EXPIRED` y Operaciones muestra los valores sin datos de destinatarios ni contenido.

Se agregaron pruebas para el adapter en memoria, la respuesta HTTP/contrato y una integración PostgreSQL que cubre leases activos/vencidos, aislamiento de tenant y uso de ambos índices parciales con carga. Validación ejecutada: API/SOC 128/128, plugin 169/169, PostgreSQL SOC 15/15 en PostgreSQL 18.6 efímero de loopback, typechecks de API/SOC/database, `gofmt -d` y `git diff --check` PASS. `go test ./...` también pasó en `golang:1.23.12-bookworm`.

## 2026-11-13 · Informes M365 y métrica de revisión del correlador

La investigación escribe el XLSX por bloques al archivo elegido en navegadores con File System Access; la descarga Blob en memoria queda como alternativa con tope de 50 MiB. Las filas autorizadas siguen en memoria durante la consulta. Los grupos por ID exacto conservan hasta 100 destinatarios distintos y examinan como máximo 101 para marcar exceso, sin construir una colección temporal ilimitada; el conteo se identifica como mínimo cuando hay recorte. El PDF conserva su vista HTML imprimible local. `qapaq_ops`: 21 archivos, 169/169 pruebas; typecheck OSD no se ejecutó porque no está disponible `QAPAQ_TOOLS_DIR`.

Se corrigió el HELP de Prometheus: `reviewCoverage` enumera también `duplicate`, que cuenta como revisado y no como TP/FP; `false_positive` agrupa `false_positive` y `benign`. La documentación separa cobertura de revisión de precisión, recall y tasa de FP. `gofmt -d` quedó limpio y `go test ./...` pasó en `golang:1.23.12-bookworm`; esto no demuestra reducción medida de falsos positivos ni aceptación de un corpus SOC real.

## 2026-11-13 · Plan PowerUser revisable y frescura del feedback Go

- Terraform PowerUser ahora separa `plan` y `apply`: el plan produce un artefacto privado de un día con salida legible, manifiesto y SHA-256. Un despacho manual de Apply debe citar el run, hash y commit exactos; valida el workflow de origen, rama `main`, repositorio, artefacto y hashes antes de asumir OIDC, y aplica el binario guardado bajo el lock remoto. No se recalcula el plan durante Apply ni existe un disparador automático.
- El correlador añade una señal separada del refresh de feedback en `/readyz` y Prometheus: `pending`/`ready`/`failed`/`stale`, edad y último éxito cuando existe. Un refresh fallido o más viejo que `max(3 × intervalo, 30 s)` degrada readiness. No cambia emisión, matcher o supresión y no acredita salud live mientras este código no se despliegue.
- Runbooks alineados con el plan guardado y la publicación al EC2 existente mediante EC2 Instance Connect/`ship.sh`; el nodo se actualiza bajo su lock, sin crear una instancia duplicada. Se eliminó el comando local directo `terraform apply` de la guía PowerUser.
- Validación local: suite de política de workflows 13/13 PASS, YAML parseado; typecheck OSD 2.19.6 PASS con el volumen Docker fijado; `go test ./...` y `gofmt` PASS en `golang:1.23.12-bookworm`; `git diff --check` PASS. La revisión de CI, OIDC efectivo, canario y runtime quedan pendientes.
- **Despliegue:** no se ejecutó Terraform ni `ship.sh`. La identidad AWS de `.env` falló STS y los perfiles locales probados tampoco autenticaron; el servicio live conserva el release previamente documentado.

## 2026-11-13 · Inicialización explícita de los canales de aviso (local, sin deploy)

- **Arranque:** `NotificationChannelRegistry.initialize()` crea la fila de cada canal sin fila (`system:bootstrap`, auditada como `notifications.channel.initialized`, solo con máscara). Si el despliegue trae `QAPAQ_TEAMS_WORKFLOW_URL` y hay clave, la guarda cifrada; configurado ⇒ activo, sin configurar ⇒ apagado y visible como pendiente. Una fila existente no se toca (la base manda). Antes no se escribía nada y un canal sin configurar figuraba `enabled`.
- **Visibilidad:** una línea de arranque `notifications.channel.status` por canal (sin destino) y `notifications.channels.no_p1_delivery`; `GET /api/operations/health` añade `NOTIFICATION_TEAMS_NOT_CONFIGURED` y `NOTIFICATION_NO_P1_CHANNEL`.
- **Concurrencia:** migración `20261113120000_notification_channel_revision` (columna `revision`, aditiva). `PUT …/channels/teams` y `enable|disable` aceptan `expectedRevision` → `STATE_CONFLICT`. La salud de los envíos se guarda aparte: ya no reescribe la fila completa ni puede pisar un cambio de la consola hecho en otra réplica.
- **Push:** el canal `push` apagado ya no avisa a dispositivos en el despacho.
- **Consola (`qapaq_ops`):** guía «Puesta en marcha de Microsoft Teams» en la pestaña Canales, `push` como «Avisos al navegador» con activar/probar, aviso cuando ni Teams ni correo pueden entregar, y distinción entre falta de permiso y API que no sirve los canales.
- **Despliegue:** `deploy-host.sh` copia `QAPAQ_ALERT_MAIL_SENDER` de `services.env` a `api.env` como el webhook de Teams. Sin variables `QAPAQ_*` nuevas.
- **Validación local:** specs de API/SOAR/base/configuración y del plugin en verde; typecheck de API, `@qapaq/soar` y `@qapaq/database`. **Sin desplegar:** no se aplicó la migración a ninguna base real ni se probó contra Teams/Graph reales. Procedimiento en `docs/06` §5 y `docs/18`.

## 2026-11-14 · Analista IA conectado al API (local, sin deploy)

- Bucle del Analista IA dentro del API (apagado por defecto, `QAPAQ_ANALYST_*`), adaptador de Claude
  sin reintentos, lector de evidencia con el alcance de Qapaqzito sin modelo, acciones con la identidad
  `svc:qapaq-ai-analyst`, escalación sin duplicados (asocia a incidente abierto del grupo en 72 h),
  barrido de alertas e incidentes sin expediente, pedidos de revisión por el outbox
  (`soc.alert.review_requested`) y resumen diario.
- API `/api/ai-investigations` con el contrato de la consola; capacidades `investigations.read|run`
  (analista, líder, admin) y `investigations.configure` (admin). Herramientas MCP del analista.
- Política `qapaq-analyst-2026-11-14.1` (paquete con contexto ampliado). Sin commit; sin evidencia de
  proveedor real. Ver docs/27 «Implementación (2026-11-14)».

## 2026-11-14 · Analista IA: panel «Actividad» (local, sin deploy)

- `GET /api/ai-investigations/activity` (`investigations.read`): estado del host **en memoria del
  proceso que responde** (`AnalystHost.status()`), cola actual por prioridad, conteos del **día de
  Lima** en curso (`today.from`–`today.to`, incluido el costo estimado de invocaciones creadas en esa
  ventana; `/budget` sigue en día UTC), atraso sin expediente (caché 60 s; lectura incompleta ⇒
  `null`) y feed de 24 h (≤ 50, sin texto del modelo, títulos enmascarados).
- Store: `activityCounts`, `recentJobs`, `escalationOutcomes`, `existingKeys` (memoria y PostgreSQL,
  sin migración: usan índices existentes).
- Consola: pestaña «Actividad» (por defecto) con la mascota `qapaq-ai-analyst-qapaqzito-160.webp` /
  `qapaq-ai-analyst-qapaqzito.webp` (2x), KPI del día, cola, atraso y feed con sondeo de 5 s.
- Validación local: specs API/assistant/arquitectura, plugin, typecheck (incluido el del plugin con
  TS 4.0.2), lint, boundaries e integración PostgreSQL 18.6 efímera del store. Sin deploy.
