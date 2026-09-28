# Requisitos funcionales

Cada requisito expresa una obligación principal. `Auth` usa la forma
`recurso:acción@ámbito`; `deny-by-default` aplica aunque no se repita.

## Identidad y acceso

### RF-001 — Iniciar sesión federada

- **Enunciado:** QAPAQ debe autenticar al usuario humano mediante Entra ID y crear
  una sesión opaca server-side sin exponer tokens al frontend.
- **Actor/disparador/precondiciones:** usuario; solicita acceso; tenant, app
  registration, redirect exacto y política de admisión configurados.
- **Entradas/validaciones:** code OIDC, PKCE S256, `state`, `nonce`, issuer,
  audience, `tid`, `oid`, expiración y grupo de admisión.
- **Resultado/fallos:** sesión activa o rechazo genérico; callbacks repetidos,
  tenant distinto, código vencido o claims inválidos no crean sesión.
- **Datos/auditoría/Auth:** sesión cifrada y versión de autorización; auditar login
  exitoso/rechazado sin tokens. Endpoint callback es protocolar; acceso posterior
  requiere sesión y política.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · U-003/ADR-017 · Entra
  autorizado y Redis/sesiones.
- **Aceptación:** Dado un usuario admitido, cuando completa Authorization Code con
  PKCE, entonces recibe cookie segura y React no recibe tokens; dado issuer o
  `state` inválido, entonces se rechaza y audita.
- **Verificación:** provider spec Entra y E2E de sesión.

### RF-002 — Autorizar cada operación protegida

- **Enunciado:** QAPAQ debe evaluar identidad activa, capability, scope, recurso,
  campos, estado y restricciones antes de leer o mutar un recurso.
- **Actor/disparador/precondiciones:** usuario o identidad técnica; invoca un caso
  de uso; existe política declarada.
- **Entradas/validaciones:** sesión/identidad, grants vigentes, policy version,
  resource ID y scope; IDs manipulados se tratan como no confiables.
- **Resultado/fallos:** permitir solo la operación exacta o denegar sin filtrar
  existencia/datos; no hay wildcard administrativo implícito.
- **Datos/auditoría/Auth:** decisión y razón auditables para accesos sensibles y
  denegaciones; Auth es la capability específica indicada en cada RF.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-017 · catálogo
  final de endpoints/capabilities U-013.
- **Aceptación:** Dado un usuario con capability pero fuera de scope, cuando pide el
  recurso, entonces se deniega; dado capability y scope válidos, se aplica además
  la restricción de campo/estado.
- **Verificación:** specs de política allow/deny y E2E de IDOR.

### RF-003 — Revocar acceso vigente

- **Enunciado:** Access Admin debe poder suspender usuario, revocar grant o sesión
  y hacer efectiva la revocación en operaciones síncronas y diferidas.
- **Actor/disparador/precondiciones:** Access Admin; solicitud autorizada; no puede
  ser el único aprobador de su propia elevación.
- **Entradas/validaciones:** sujeto, motivo, alcance, vigencia y aprobación cuando
  aplique.
- **Resultado/fallos:** incrementa versión de autorización, invalida sesiones/cache
  y revalida descargas/jobs antes del efecto; fallo no informa revocación exitosa.
- **Datos/auditoría/Auth:** grants, sesiones y versión; `users.manage` o
  `roles.manage` dentro del conjunto otorgable; auditar antes/después por referencia.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-017.
- **Aceptación:** Dado un grant revocado, cuando una sesión previa intenta leer o un
  job intenta entregar un export, entonces ambos se deniegan con evidencia.
- **Verificación:** integración de sesión/cache y E2E de revocación.

### RF-004 — Administrar privilegio temporal

- **Enunciado:** Access Admin debe registrar solicitudes JIT, justificación,
  vigencia y aprobación separada para privilegios críticos.
- **Actor/disparador/precondiciones:** solicitante y aprobador distintos; step-up
  vigente; capability otorgable.
- **Entradas/validaciones:** capability, scope, duración, justificación y aprobador;
  impedir autoaprobación y conflicto SoD.
- **Resultado/fallos:** grant temporal activo hasta expiración o rechazo; ningún
  error deja grant parcial.
- **Datos/auditoría/Auth:** solicitud, aprobación y grant; `roles.manage` con scope
  administrativo y step-up; auditar cada transición.
- **Prioridad/estado/origen/dependencias:** MVP para operaciones privilegiadas ·
  CONFIRMADO · ADR-017 · matriz final U-013.
- **Aceptación:** Dada autoaprobación o SoD inválida, cuando se intenta aprobar,
  entonces se deniega; dada aprobación válida, el grant expira automáticamente.
- **Verificación:** specs de dominio y E2E de doble control.

## Fuentes e ingesta

### RF-005 — Registrar configuración lógica de fuente

- **Enunciado:** Platform Admin debe registrar una fuente sin almacenar secretos,
  incluyendo owner, dataset, interfaz, versión y `secretRef`.
- **Actor/disparador/precondiciones:** Platform Admin; inventario aprobado por dueño
  de fuente e Infraestructura.
- **Entradas/validaciones:** campos de `source-inventory.yaml`; IDs únicos,
  allowlist de producto/adapter y referencia de secreto válida.
- **Resultado/fallos:** estado `planned` o `configured`; nunca `enabled` sin gate;
  valores incompletos permanecen `TO_BE_PROVIDED`.
- **Datos/auditoría/Auth:** configuración/checkpoint metadata; `integrations.manage`
  en scope fuente; auditar alta y cambio sin credencial.
- **Prioridad/estado/origen/dependencias:** MVP para Microsoft/Wazuh · CONFIRMADO ·
  ADR-019/024 · contrato real U-005.
- **Aceptación:** Dada una API key o campo obligatorio ausente, cuando se registra,
  entonces se rechaza o conserva `planned`; nunca persiste el secreto.
- **Verificación:** contract spec y prueba negativa de secreto.

### RF-006 — Mostrar cobertura y salud de fuente

- **Enunciado:** QAPAQ debe exponer estado de conexión, último éxito, checkpoint,
  atraso, gaps y cobertura sin interpretar cero alertas como salud.
- **Actor/disparador/precondiciones:** SOC/Platform; consulta dashboard o health;
  existe configuración de fuente.
- **Entradas/validaciones:** métricas internas y señales Wazuh; timestamps UTC y
  vocabulario de estados acotado.
- **Resultado/fallos:** distingue `healthy`, `stale`, `gap`, `denied`, `degraded` y
  `unknown`; backend caído produce desconocido/degradado, no dato falso.
- **Datos/auditoría/Auth:** lee checkpoint/telemetría; `platform.health.read` o
  vista SOC en scope; lecturas administrativas sensibles auditables.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-020/021.
- **Aceptación:** Dado Wazuh inaccesible, cuando se consulta, entonces muestra
  cobertura degradada con último dato conocido y no muestra “sin incidentes”.
- **Verificación:** integración con fallo de dependencia y demostración UI/API.

### RF-007 — Adquirir alertas Wazuh de Microsoft 365

- **Enunciado:** el adapter QAPAQ debe leer de forma incremental y read-only las
  alertas Wazuh del dataset Office 365 autorizado.
- **Actor/disparador/precondiciones:** scheduler/worker; fuente `validated`, permiso
  mínimo, versión y patrón de índice confirmados.
- **Entradas/validaciones:** respuesta Indexer no confiable, paginación/cursor,
  límite, schema/documento y procedencia Wazuh/Microsoft.
- **Resultado/fallos:** entrega registros al límite durable; 401/403/429/timeout se
  clasifican y reintentan acotadamente sin avanzar checkpoint.
- **Datos/auditoría/Auth:** lee Indexer y escribe recepción; identidad técnica
  `wazuh.alerts.read` restringida a dataset; auditar cambios, no cada fetch normal.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-024 · datos reales
  U-005/PBI-006.
- **Aceptación:** Dada actividad sintética autorizada, cuando Wazuh genera alerta,
  entonces QAPAQ la lee con rule ID y lineage; ante 403 no avanza checkpoint.
- **Verificación:** provider spec Wazuh/Microsoft y E2E autorizado.

### RF-008 — Confirmar adquisición durable y checkpoint

- **Enunciado:** QAPAQ debe avanzar el checkpoint solo después de persistir de forma
  durable el registro admitido y su manifiesto.
- **Actor/disparador/precondiciones:** worker; lote validado; store durable disponible.
- **Entradas/validaciones:** source/dataset, cursor/posición, payload/ref, hash y
  timestamps; orden del cursor según contrato de fuente.
- **Resultado/fallos:** `FETCHED → DURABLE → CHECKPOINTED`; crash antes del commit
  reprocesa; APIs pull no reciben ACK externo y webhooks solo obtienen 2xx tras durable.
- **Datos/auditoría/Auth:** raw/ref, manifiesto y checkpoint transaccional; identidad
  técnica de ingesta en scope; auditar gaps/cambios administrativos.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-019.
- **Aceptación:** Dada caída entre fetch y commit, cuando reinicia, entonces relee
  sin perder; dada caída tras commit y antes de checkpoint, reprocesa idempotente.
- **Verificación:** integration spec con fault injection y restart.

### RF-009 — Procesar recepciones idempotentemente

- **Enunciado:** QAPAQ debe asignar `recordId` por recepción y `eventUid` estable
  solo cuando la identidad de origen sea confiable, evitando efectos duplicados.
- **Actor/disparador/precondiciones:** pipeline; registro durable.
- **Entradas/validaciones:** source, dataset, source ID/cursor/posición, schema y
  versión; no deduplicar solo por timestamp, texto o hash.
- **Resultado/fallos:** duplicado confiable incrementa contador y reutiliza efecto;
  identidad incierta conserva recepción separada y marca confianza insuficiente.
- **Datos/auditoría/Auth:** inbox/unique keys y lineage; identidad técnica; auditar
  colisiones/gaps, métricas para duplicados.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-011/019.
- **Aceptación:** Dado el mismo ID estable dos veces, entonces existe un efecto;
  dados eventos sin ID con igual texto/hora, no se descarta uno silenciosamente.
- **Verificación:** contract/integration specs con duplicados y colisiones.

### RF-010 — Detectar gaps y ejecutar replay

- **Enunciado:** Platform/SOC debe poder detectar discontinuidad y solicitar replay
  dentro de la capacidad declarada por dataset.
- **Actor/disparador/precondiciones:** monitor u operador; gap/cursor inválido;
  clasificación `FULL`, `BOUNDED`, `BEST_EFFORT` o `NO_REPLAY` registrada.
- **Entradas/validaciones:** rango, motivo, fuente, límites y autorización; no
  aceptar rango fuera de ventana como recuperable.
- **Resultado/fallos:** replay idempotente o estado de pérdida/cobertura explícito;
  throttling conserva checkpoint y reprograma acotadamente.
- **Datos/auditoría/Auth:** solicitud/job/gap; `integrations.manage` para replay y
  `platform.health.read` para consulta; auditar inicio/resultado.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-019 · ventana real U-005.
- **Aceptación:** Dado cursor inválido, cuando se procesa, entonces se crea
  `GAP_DETECTED`; si la fuente no permite replay, se registra cobertura insuficiente.
- **Verificación:** provider spec e integración con cursor inválido.

### RF-011 — Cuarentenar y reprocesar registros inválidos

- **Enunciado:** QAPAQ debe aislar entradas malformadas o incompatibles sin detener
  el lote y permitir reproceso controlado tras corregir mapping/schema.
- **Actor/disparador/precondiciones:** pipeline u operador; falla de validación.
- **Entradas/validaciones:** ref/hash, error code, schema/mapping version y source;
  no incluir raw sensible en el mensaje de error.
- **Resultado/fallos:** estado `QUARANTINED`, contador y razón; reproceso crea
  nueva recepción/lineage y no reescribe historia.
- **Datos/auditoría/Auth:** metadata de cuarentena y job; `integrations.manage` para
  reprocesar, lectura raw separada; auditar solicitud/resultado.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-011/019.
- **Aceptación:** Dado payload inválido entre válidos, entonces los válidos avanzan
  y el inválido queda consultable/reprocesable sin filtrar contenido.
- **Verificación:** contract/integration specs de lote mixto.

### RF-012 — Custodiar raw y manifiesto

- **Enunciado:** QAPAQ debe conservar el raw autorizado o su referencia durable con
  SHA-256, clasificación, procedencia y manifest verificable.
- **Actor/disparador/precondiciones:** pipeline; política de dataset permite custodia.
- **Entradas/validaciones:** bytes/ref, hash, content type, source/dataset, tiempos y
  clasificación; límites de tamaño y formato.
- **Resultado/fallos:** referencia inmutable disponible a autorizados; fallo de
  escritura impide marcar `DURABLE`; hash inválido bloquea procesamiento.
- **Datos/auditoría/Auth:** object storage/manifiesto; escritura técnica acotada,
  lectura `evidence.read`/raw scope; acceso individual auditado.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-018/019 · storage
  y retención ratificados para producción.
- **Aceptación:** Dado objeto alterado, cuando se verifica, entonces falla integridad
  y no se presenta como evidencia válida.
- **Verificación:** integración real aislada y prueba de alteración.

## Normalización, detección y búsqueda

### RF-013 — Normalizar a SecurityEvent 1.0.0

- **Enunciado:** el normalizador debe producir un documento válido contra el JSON
  Schema normativo `qapaq.security-event` 1.0.0.
- **Actor/disparador/precondiciones:** pipeline; recepción durable no cuarentenada.
- **Entradas/validaciones:** mapping versionado Wazuh, tipos/límites, enums,
  opcionales/null, extensiones acotadas y UTC.
- **Resultado/fallos:** `NORMALIZED` con schema/mapping version o cuarentena; campos
  desconocidos no se ejecutan ni se convierten en instrucciones.
- **Datos/auditoría/Auth:** SecurityEvent, rawRef/hash y mapping; identidad técnica;
  métricas de validación y cambio de mapping auditado.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · U-010/ADR-011 · schema
  y corpus aún por implementar.
- **Aceptación:** Dado corpus válido/inválido, cuando normaliza, entonces todo válido
  pasa el schema y todo inválido falla con código estable.
- **Verificación:** JSON Schema contract specs y corpus compartido.

### RF-014 — Tratar eventos sin ID nativo

- **Enunciado:** QAPAQ debe registrar identidad derivada y su nivel de confianza
  cuando la fuente no proporcione ID estable, sin prometer deduplicación perfecta.
- **Actor/disparador/precondiciones:** normalizador; `sourceRecordId` ausente.
- **Entradas/validaciones:** cursor/posición, campos allowlisted, dataset y versión;
  excluir secretos y campos volátiles de la identidad.
- **Resultado/fallos:** `identityMethod=DERIVED` y confianza explícita; colisiones
  conservan recepciones y generan señal.
- **Datos/auditoría/Auth:** eventUid/recordId/metadata; técnica; mapping versionado.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-011.
- **Aceptación:** Dado un evento sin ID, entonces no se descarta por semejanza; dada
  colisión derivada, se preservan ambos y se reporta.
- **Verificación:** property/contract specs con orden y colisiones.

### RF-015 — Preservar tiempos y orden incierto

- **Enunciado:** QAPAQ debe conservar `occurredAt`, `observedAt`, `receivedAt` e
  `ingestedAt` en UTC y señalar reloj inválido o evento tardío.
- **Actor/disparador/precondiciones:** normalizador; registro admitido.
- **Entradas/validaciones:** timestamp, zona/offset, precisión y límites temporales;
  no reemplazar silenciosamente tiempo de origen por ingesta.
- **Resultado/fallos:** tiempos originales y normalizados con `timeQuality`; eventos
  fuera de orden se procesan según ventana y no reescriben historia.
- **Datos/auditoría/Auth:** SecurityEvent; técnica; métricas de tardíos/rechazos.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-011.
- **Aceptación:** Dado reloj imposible, entonces se marca/rechaza según mapping;
  dado evento tardío válido, se conserva su ocurrió y su ingesta distintas.
- **Verificación:** contract specs de zonas, DST, futuro y fuera de orden.

### RF-016 — Normalizar severidad con mapping versionado

- **Enunciado:** QAPAQ debe preservar severidad original y calcular severidad
  normalizada mediante mapping identificable y reproducible.
- **Actor/disparador/precondiciones:** normalizador; regla Wazuh y mapping aprobado.
- **Entradas/validaciones:** nivel/severidad original, source/dataset, rule ID y
  mapping version; valores desconocidos no se elevan o reducen silenciosamente.
- **Resultado/fallos:** `originalSeverity`, `normalizedSeverity`, versión y razón;
  ausencia de mapping produce `UNCLASSIFIED`/cuarentena según contrato.
- **Datos/auditoría/Auth:** SecurityEvent/mapping; publicación de mapping requiere
  `rules.update` y revisión; auditar cambio.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-011/024.
- **Aceptación:** Dado el mismo input y mapping, produce igual severidad; al cambiar
  mapping, eventos históricos conservan versión anterior.
- **Verificación:** table-driven contract specs.

### RF-017 — Mantener lineage entre niveles semánticos

- **Enunciado:** QAPAQ debe diferenciar actividad Microsoft, alerta Wazuh,
  SecurityEvent, alerta QAPAQ, incidente y notificación, enlazando sus IDs.
- **Actor/disparador/precondiciones:** pipeline/SOC; transformación o promoción.
- **Entradas/validaciones:** source IDs, related IDs, semantic level y versiones.
- **Resultado/fallos:** grafo trazable sin contabilizar dos veces el mismo hecho;
  vínculo faltante impide declarar lineage completo.
- **Datos/auditoría/Auth:** referencias y relaciones; lectura según recurso/scope;
  promociones y cambios sensibles auditados.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-019/024.
- **Aceptación:** Dada alerta Wazuh derivada, entonces el analista puede recorrer
  hasta la actividad disponible sin confundirla con alerta QAPAQ.
- **Verificación:** E2E de trazabilidad e inspección de IDs.

### RF-018 — Evaluar prioridad complementaria

- **Enunciado:** Detection debe evaluar una alerta Wazuh válida y producir un
  candidato con prioridad/confianza explicables sin duplicar el ruleset base.
- **Actor/disparador/precondiciones:** worker; SecurityEvent normalizado.
- **Entradas/validaciones:** severidad, regla, activo/contexto autorizado, mapping y
  versión de política; datos externos son no confiables.
- **Resultado/fallos:** candidato, razón y versión; error se reintenta/cuarentena y
  no crea alerta parcial.
- **Datos/auditoría/Auth:** detection result; identidad técnica; publicación de
  política requiere `rules.enable`/aprobación y auditoría.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-024.
- **Aceptación:** Dado evento y política versionada, entonces el resultado es
  determinista y explica factores; deshabilitar política evita nuevos resultados.
- **Verificación:** unit specs deterministas y E2E.

### RF-019 — Deduplicar y crear alerta QAPAQ

- **Enunciado:** SOC debe promover candidatos accionables a una alerta única según
  clave/política versionada, conservando conteo y eventos relacionados.
- **Actor/disparador/precondiciones:** pipeline; candidato válido.
- **Entradas/validaciones:** identidad, ventana, regla, activo y semantic level;
  prohibido deduplicar solo por texto/hora.
- **Resultado/fallos:** alerta `NEW` o actualización material; retries no crean otra
  alerta/incidente; colisión incierta se conserva para revisión.
- **Datos/auditoría/Auth:** alerta, relaciones/outbox; técnica para crear; cambios y
  supresión auditables.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · U-001/ADR-024.
- **Aceptación:** Dado mismo candidato reprocesado, entonces existe una alerta;
  candidatos distintos no se fusionan sin clave aprobada.
- **Verificación:** integración de idempotencia/concurrencia.

### RF-020 — Buscar eventos y alertas autorizados

- **Enunciado:** un analista debe buscar SecurityEvents/alertas por filtros
  permitidos dentro de su scope, con paginación y límites explícitos.
- **Actor/disparador/precondiciones:** L1/L2/Auditor; sesión y capability vigentes.
- **Entradas/validaciones:** rango temporal, source, severidad, rule/asset alias,
  cursor y sort allowlisted; límites U-015.
- **Resultado/fallos:** resultados filtrados y cursor opaco; timeout/índice caído se
  muestra como fallo/degradación, no lista vacía concluyente.
- **Datos/auditoría/Auth:** proyección OpenSearch; `events.read`/`alerts.read` en
  scope; acceso raw separado; consultas sensibles auditables.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · U-001/ADR-017.
- **Aceptación:** Dado recurso fuera de scope, no aparece ni por ID; dado índice
  caído, la respuesta distingue indisponibilidad de cero resultados.
- **Verificación:** integration spec de queries y E2E de scope/IDOR.

## Operación SOC

### RF-021 — Gestionar lifecycle de alerta

- **Enunciado:** L1/L2 debe acusar, asignar y transicionar una alerta solo por las
  rutas válidas, con motivo y control de concurrencia.
- **Actor/disparador/precondiciones:** L1/L2; alerta en estado compatible.
- **Entradas/validaciones:** alertId, transición, motivo, versión y assignee/scope.
- **Resultado/fallos:** lifecycle `NEW→ENRICHING→TRIAGE→INVESTIGATING→CONFIRMED|
  FALSE_POSITIVE→CLOSED`; transición/stale version inválida se rechaza.
- **Datos/auditoría/Auth:** alerta/timeline; `alerts.acknowledge` o acción exacta;
  cada transición auditada.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · U-001/ADR-015.
- **Aceptación:** Dadas dos actualizaciones concurrentes, una detecta conflicto;
  cerrar desde estado no permitido falla sin mutar.
- **Verificación:** unit specs de máquina de estados y E2E.

### RF-022 — Crear incidente o caso desde alerta

- **Enunciado:** L1/L2 autorizado debe crear incidente/caso y relacionar alertas
  sin convertir toda alerta automáticamente.
- **Actor/disparador/precondiciones:** analista; alerta visible y confirmada según
  política; capability de creación.
- **Entradas/validaciones:** título, tipo, severidad, scope, alert IDs y motivo.
- **Resultado/fallos:** incidente/caso `OPEN` con timeline y relaciones; retry usa
  idempotency key y no duplica.
- **Datos/auditoría/Auth:** caso/incidente y links; `incidents.create`/`cases.create`
  en scope; auditar creación.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · U-001.
- **Aceptación:** Dado retry de la misma solicitud, entonces se devuelve el mismo
  recurso; alerta fuera de scope se rechaza.
- **Verificación:** integration/E2E de idempotencia y autorización.

### RF-023 — Incorporar notas y evidencia

- **Enunciado:** L1/L2 debe añadir notas y referencias de evidencia al caso con
  autor, tiempo, clasificación y custodia.
- **Actor/disparador/precondiciones:** analista; caso accesible y no bloqueado.
- **Entradas/validaciones:** texto limitado/sanitizado, evidence ref/hash, tipo y
  clasificación; no aceptar secretos o HTML ejecutable.
- **Resultado/fallos:** timeline append-only lógico; evidencia inválida no se marca
  incorporada; corrección referencia original.
- **Datos/auditoría/Auth:** note/evidence metadata; `cases.update` y
  `evidence.read/write` separados por scope; auditar acceso/cambio.
- **Prioridad/estado/origen/dependencias:** MVP mínimo · CONFIRMADO · U-001/ADR-018.
- **Aceptación:** Dado script/secret en entrada, se rechaza o sanitiza sin ejecución;
  evidencia alterada falla hash.
- **Verificación:** security/integration specs.

### RF-024 — Gestionar lifecycle del incidente

- **Enunciado:** L2 debe transicionar incidente por estados aprobados con motivo,
  evidencia de cierre y autorización contextual.
- **Actor/disparador/precondiciones:** L2/Manager; incidente vigente.
- **Entradas/validaciones:** transición, resolución, evidencia y versión; reapertura
  permanece pendiente U-008.
- **Resultado/fallos:** `OPEN→INVESTIGATING→CONTAINMENT→ERADICATION→RECOVERY→
  RESOLVED→CLOSED`; no salta guardas ni borra historia.
- **Datos/auditoría/Auth:** incidente/timeline; capability exacta, cierres críticos
  pueden exigir aprobación; auditar transición.
- **Prioridad/estado/origen/dependencias:** MVP acotado · CONFIRMADO; reapertura
  PENDIENTE · U-001/U-008.
- **Aceptación:** Dado cierre sin evidencia/motivo, se rechaza; transición válida
  conserva actor, timestamp y versión.
- **Verificación:** unit specs y E2E de lifecycle.

### RF-025 — Presentar tablero operacional

- **Enunciado:** QAPAQ debe mostrar colas, severidades, aging, estado de fuentes,
  backlog y gaps usando solo datos autorizados.
- **Actor/disparador/precondiciones:** L1/L2/Manager/Platform; sesión vigente.
- **Entradas/validaciones:** filtros/scope y métricas acotadas; no usar IDs sensibles
  como labels.
- **Resultado/fallos:** vista coherente con timestamp de actualización; datos
  parciales se marcan degradados; UI no sustituye autorización backend.
- **Datos/auditoría/Auth:** proyecciones/SLI; capabilities de lectura por recurso;
  configuración del tablero auditada.
- **Prioridad/estado/origen/dependencias:** MVP P1 · CONFIRMADO · U-001/ADR-021.
- **Aceptación:** Dada fuente stale, el tablero la muestra; un Viewer no ve raw ni
  recursos fuera de scope aunque manipule la petición.
- **Verificación:** E2E de roles y demostración.

## Teams, auditoría y administración

### RF-026 — Solicitar notificación crítica durable

- **Enunciado:** al confirmar una alerta `CRITICAL`, SOC debe persistir alerta y
  `NotificationRequested` en la misma transacción antes de enviar a Teams.
- **Actor/disparador/precondiciones:** pipeline/SOC; alerta crítica válida.
- **Entradas/validaciones:** alertId, incidentId opcional, policy/version y payload
  allowlisted; excluir raw, secretos y PII innecesaria.
- **Resultado/fallos:** outbox `PENDING`; rollback de alerta revierte salida; Teams
  nunca bloquea commit de alerta.
- **Datos/auditoría/Auth:** alerta/outbox/audit; identidad técnica; auditar solicitud.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · U-012/ADR-022.
- **Aceptación:** Dado fallo Teams, la alerta existe y salida queda durable; dado
  rollback de alerta, no queda salida huérfana.
- **Verificación:** integration spec transaccional.

### RF-027 — Entregar y reintentar notificación Teams

- **Enunciado:** el worker debe entregar por adapter con `notificationId` estable,
  registrar aceptación/fallo y aplicar reintentos acotados.
- **Actor/disparador/precondiciones:** worker; salida `PENDING`, workflow y secretRef autorizados.
- **Entradas/validaciones:** payload minimizado, URL resuelta fuera del repo,
  timeout y códigos; no seguir destinos no allowlisted.
- **Resultado/fallos:** `PENDING→SENDING→SENT|FAILED_RETRYABLE|FAILED_TERMINAL`;
  timeout ambiguo puede repetir tarjeta, nunca alerta/caso.
- **Datos/auditoría/Auth:** attempt/outbox; identidad técnica solo envío; auditar
  request/sent/fail/retry sin URL.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-022 · Team,
  workflow, política final y canal secundario pendientes.
- **Aceptación:** Dado timeout y retry, conserva notificationId; agotado el máximo,
  queda visible y escalado sin perder alerta.
- **Verificación:** provider spec Teams y fault injection.

### RF-028 — Acusar y escalar alerta crítica

- **Enunciado:** el analista debe acusar la alerta dentro de QAPAQ; vencido el
  objetivo ratificado, el sistema debe recordar y escalar por política.
- **Actor/disparador/precondiciones:** L1/L2 o scheduler; alerta crítica pendiente.
- **Entradas/validaciones:** alertId, actor, scope y policy version; un click de
  Teams solo abre deep link autenticado.
- **Resultado/fallos:** `SENT→ACKNOWLEDGED` o escalamiento durable; Teams `SENT` no
  significa leído/acuse; canal secundario ausente mantiene gate bloqueado.
- **Datos/auditoría/Auth:** alerta/notificación/escalamiento; `alerts.acknowledge`
  en scope; auditar acuse y escalamiento.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO; umbral/fallback
  PENDIENTES · ADR-022/U-012.
- **Aceptación:** Dado usuario fuera de scope, deep link no abre la alerta; dado
  vencimiento, se registra recordatorio/escalamiento sin cerrar la alerta.
- **Verificación:** E2E autorizado y prueba de scheduler.

### RF-029 — Auditar acciones sensibles atómicamente

- **Enunciado:** cada mutación sensible debe persistir `AuditEvent` junto con el
  estado de dominio; si falla auditoría, la mutación revierte.
- **Actor/disparador/precondiciones:** cualquier caso de uso sensible.
- **Entradas/validaciones:** actor, acción, recurso, scope, decisión, motivo,
  outcome, request/trace ID y referencias redactadas.
- **Resultado/fallos:** evento append-only con secuencia/hash y outbox; denegaciones
  sin transacción usan writer durable; nunca snapshot/secreto completo.
- **Datos/auditoría/Auth:** audit store/archive; productor usa insert limitado;
  lectura `audit.read`, export separado.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · U-006/ADR-021.
- **Aceptación:** Dado fallo de insert audit, la mutación no existe; runtime no puede
  update/delete audit.
- **Verificación:** integración PostgreSQL con rol runtime y rollback.

### RF-030 — Consultar raw bajo control reforzado

- **Enunciado:** L2/Auditor autorizado debe solicitar raw por referencia solo con
  capability, scope, propósito y política vigentes.
- **Actor/disparador/precondiciones:** usuario; caso/investigación vinculada; step-up
  si política lo exige.
- **Entradas/validaciones:** rawRef, recurso relacionado, motivo y clasificación;
  revalidar acceso al entregar.
- **Resultado/fallos:** contenido o descarga temporal minimizada; acceso revocado,
  hash inválido o hold incompatible bloquea entrega.
- **Datos/auditoría/Auth:** object storage; `evidence.read`/raw explícito, nunca por
  `events.read`; auditar acceso individual.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · ADR-017/018.
- **Aceptación:** Dado Viewer o Platform Admin sin capability, se deniega; si se
  revoca durante generación, no se entrega.
- **Verificación:** E2E de acceso/revocación e integridad.

### RF-031 — Exportar evidencia de forma controlada

- **Enunciado:** un usuario autorizado debe generar export temporal con manifest,
  hash, filtros, actor, propósito y expiración.
- **Actor/disparador/precondiciones:** L2/Auditor; capability export separada,
  step-up/aprobación según sensibilidad.
- **Entradas/validaciones:** scope, rango, campos, formato, propósito y clasificación;
  límites U-015.
- **Resultado/fallos:** job auditable y artifact cifrado/expirable; fallo o
  revocación cancela entrega; no URL pública permanente.
- **Datos/auditoría/Auth:** export metadata/object; `evidence.export` o
  `audit.export`; auditar solicitud, generación, acceso y expiración.
- **Prioridad/estado/origen/dependencias:** MVP acotado · CONFIRMADO · ADR-017/018.
- **Aceptación:** Dado export fuera de scope o sin propósito, se rechaza; export
  válido incluye manifest/hash y expira según política ratificada.
- **Verificación:** integration/E2E y prueba de expiración.

### RF-032 — Administrar reglas y configuración con control

- **Enunciado:** el rol autorizado debe versionar configuración QAPAQ o reglas
  complementarias, probarlas y publicarlas mediante aprobación aplicable.
- **Actor/disparador/precondiciones:** Detection Engineer/Platform Admin; grant
  vigente y separación entre prueba/publicación crítica.
- **Entradas/validaciones:** versión, cambio, corpus, resultado, justificación y
  aprobador; no aceptar payload proveedor como regla/instrucción.
- **Resultado/fallos:** draft/tested/enabled/disabled; fallo de prueba no publica;
  rollback conserva versión anterior.
- **Datos/auditoría/Auth:** rule/config versions; capabilities `rules.*` o
  `integrations.manage` exactas; auditar transición.
- **Prioridad/estado/origen/dependencias:** MVP acotado · CONFIRMADO · U-001/ADR-017.
- **Aceptación:** Dada regla sin specs o autoaprobación prohibida, no se habilita;
  rollback restaura comportamiento versionado.
- **Verificación:** contract specs, inspección y demostración.

### RF-033 — Aplicar modos operativos seguros

- **Enunciado:** QAPAQ debe transicionar explícitamente entre `NORMAL`, `DEGRADED`,
  `INGEST_ONLY`, `READ_ONLY`, `RECOVERY` y `MAINTENANCE` según condición y autoridad.
- **Actor/disparador/precondiciones:** monitor u operador autorizado; condición
  observada/runbook.
- **Entradas/validaciones:** dependencia, impacto, evidencia, owner y duración.
- **Resultado/fallos:** bloquea operaciones inseguras y conserva las seguras; no
  confirma efectos externos desconocidos; transición visible/auditable.
- **Datos/auditoría/Auth:** estado operacional y motivo; `platform.manage` propuesto
  dentro de scope; automática solo para reglas aprobadas.
- **Prioridad/estado/origen/dependencias:** MVP · CONFIRMADO · U-009/ADR-020.
- **Aceptación:** Dado store de escritura indisponible, no se aceptan mutaciones;
  dado modo recovery, privilegios quedan bloqueados hasta reconciliar.
- **Verificación:** fault injection, runbook y E2E de modos.

## Capacidades posteriores o pendientes

### RF-034 — Incorporar un proveedor adicional

- **Enunciado:** tras aprobación, SOC/Desarrollo debe añadir un adapter aislado que
  implemente `SecurityEventProvider` y la suite de conformidad sin cambiar dominio.
- **Actor/disparador/precondiciones:** Product Owner/dueño de fuente; inventario,
  licencia, API, scopes y piloto aprobados.
- **Entradas/validaciones:** contrato real de Cato/Sophos/Microsoft directo.
- **Resultado/fallos:** adapter versionado con checkpoint/replay/fallos propios;
  ausencia de acceso mantiene PBI bloqueado.
- **Datos/auditoría/Auth:** config/raw/eventos; identidad técnica mínima; cambios auditados.
- **Prioridad/estado/origen/dependencias:** Posterior · CONFIRMADO como extensibilidad,
  proveedor concreto PENDIENTE · ADR-010/024.
- **Aceptación:** Dado adapter real, suite común pasa sin DTO vendor en dominio.
- **Verificación:** provider/contract/E2E specs reales.

### RF-035 — Ejecutar acción SOAR aprobada

- **Enunciado:** una futura acción externa debe vincular plan/versión/parámetros,
  autorización y aprobación a un command idempotente reconciliable.
- **Actor/disparador/precondiciones:** L2/Manager; catálogo, guardas y U-008 cerrados.
- **Entradas/validaciones:** target allowlisted, motivo, aprobación, timeout y clave.
- **Resultado/fallos:** intención/resultado/`UNKNOWN`; nunca retry ciego tras timeout.
- **Datos/auditoría/Auth:** command/outbox/result; capability por acción/scope y
  step-up; auditar solicitud/aprobación/resultado.
- **Prioridad/estado/origen/dependencias:** Posterior · PENDIENTE · U-008.
- **Aceptación:** Dado timeout ambiguo, se marca `UNKNOWN` y reconcilia antes de retry.
- **Verificación:** contract/provider specs y simulacro autorizado.

### RF-036 — Invocar analítica Python aprobada

- **Enunciado:** solo tras gate, NestJS debe enviar input versionado a un worker
  Python aislado y tratar su resultado como no confiable y revisable.
- **Actor/disparador/precondiciones:** pipeline/analista; caso, benchmark, algoritmo,
  schemas, límites y rollback aprobados.
- **Entradas/validaciones:** schema/version/checksum, dataset sintético y budgets.
- **Resultado/fallos:** resultado versionado o timeout/rechazo; Python no modifica
  PostgreSQL ni decide estado del dominio.
- **Datos/auditoría/Auth:** job/input ref/output; identidad técnica sin egress/secrets;
  auditar activación y aceptación/rechazo.
- **Prioridad/estado/origen/dependencias:** Posterior · CONFIRMADO como capacidad
  dormante / activación PENDIENTE · U-007/ADR-007.
- **Aceptación:** Dado capability no activada, no existe runtime; activada, input o
  output inválido se rechaza sin mutar dominio.
- **Verificación:** benchmark, contract, security e integration specs del gate.

## Endurecimiento transversal solicitado el 2026-09-28

### RF-037 — Impedir sesiones humanas concurrentes

- **Enunciado:** mantener como máximo una sesión humana activa por usuario y
  rechazar atómicamente un segundo login.
- **Actor/disparador/precondiciones:** usuario/Entra callback; identidad admitida.
- **Entradas/validaciones:** `tid+oid`, sesión/slot vigente y transacción PostgreSQL.
- **Resultado/fallos:** crea sesión o `AUTH_SESSION_ALREADY_ACTIVE`; no revela la previa.
- **Datos/auditoría/Auth:** sesión/revocación; auditar sin cookie/token.
- **Prioridad/estado/origen/dependencias:** MVP P0 · CONFIRMADO · ADR-025 · C-18/C-25.
- **Aceptación:** dos callbacks concurrentes producen una sesión; logout, expiración
  o revocación permiten el siguiente login sin slot huérfano.
- **Verificación:** integration de carrera/fallo y E2E multisesión.

### RF-038 — Restringir acceso a red QAPAQ con passkey

- **Enunciado:** todo usuario debe acceder desde CIDR QAPAQ y poder usar passkey
  FIDO2 de Entra dentro de OIDC, conservando MFA/admisión/RBAC.
- **Actor/disparador/precondiciones:** usuario; named location, proxy y passkey habilitados.
- **Entradas/validaciones:** IP efectiva por proxy confiable, tenant y contexto de
  autenticación aprobado; nunca clave WebAuthn local.
- **Resultado/fallos:** inside continúa; outside, header forjado o fuerza insuficiente se deniegan.
- **Datos/auditoría/Auth:** clasificación de red y fuerza, sin IP completa en labels.
- **Prioridad/estado/origen/dependencias:** MVP P0 · CONFIRMADO/GATED · ADR-025.
- **Aceptación:** inside/outside/VPN/proxy directo/passkey PASS; no hay bypass local
  ni `SUPERADMIN` universal.
- **Verificación:** provider spec Entra/CA y E2E de borde.

### RF-039 — Limitar intentos de ingreso

- **Enunciado:** Entra aplica Smart Lockout y QAPAQ limita endpoints anónimos sin
  permitir enumeración ni bloqueo dirigido por username.
- **Actor/disparador/precondiciones:** actor anónimo; storage distribuido disponible.
- **Entradas/validaciones:** IP normalizada, pre-sesión y operación; umbral medido.
- **Resultado/fallos:** `429` genérico con `Retry-After`, backoff/jitter y expiración.
- **Datos/auditoría/Auth:** contadores efímeros/métricas agregadas, sin password/UPN.
- **Prioridad/estado/origen/dependencias:** MVP P0 · CONFIRMADO/GATED · ADR-025.
- **Aceptación:** spray, burst, cuenta inexistente y caída del limiter fallan seguros.
- **Verificación:** security/load test y evidencia Smart Lockout.

### RF-040 — Ingresar credencial de integración una sola vez

- **Enunciado:** Platform Admin registra/rota credencial por el control plane QAPAQ
  write-only; KrakenD solo recibe materialización runtime cuando la ruta la necesita;
  ninguna API/UI humana puede recuperar después su valor.
- **Actor/disparador/precondiciones:** Platform Admin con step-up, aprobación y fuente inventariada.
- **Entradas/validaciones:** valor solo en request TLS, tipo/tamaño/owner/namespace.
- **Resultado/fallos:** SecretProvider guarda y devuelve `secretRef`, fingerprint y
  metadata; un fallo no persiste plaintext ni habilita la fuente.
- **Datos/auditoría/Auth:** referencia/versión/owner; `integration.secret.rotate` con SoD.
- **Prioridad/estado/origen/dependencias:** MVP P0 · CONFIRMADO/GATED · ADR-013/025.
- **Aceptación:** no existe GET/export; logs, DB, audit y colas no contienen secreto;
  solo la identidad del adapter resuelve su namespace.
- **Verificación:** contract/security/provider specs y secret scan.

### RF-041 — Explicar errores de forma accionable

- **Enunciado:** API/UI presentan código, explicación segura, acción,
  `correlationId`, `helpRef` y retry cuando corresponda.
- **Actor/disparador/precondiciones:** cualquier usuario/caso de uso.
- **Entradas/validaciones:** error normalizado y catálogo versionado.
- **Resultado/fallos:** mensaje útil sin stack, secreto, topología ni enumeración;
  fallback `UNEXPECTED_ERROR` si no existe mapping.
- **Datos/auditoría/Auth:** detalle técnico solo en Loki redactado.
- **Prioridad/estado/origen/dependencias:** MVP P1 · CONFIRMADO · ADR-025/catálogo.
- **Aceptación:** escenarios conocidos enlazan ayuda; texto proveedor nunca aparece.
- **Verificación:** contract, UX, accesibilidad y redaction tests.

### RF-042 — Operar observabilidad SOC autogestionada

- **Enunciado:** Platform/SOC consulta métricas y logs en Grafana OSS con Prometheus
  y Loki autogestionados, sin sustituir audit trail.
- **Actor/disparador/precondiciones:** SOC/Platform; Entra, red QAPAQ y stack saludables.
- **Entradas/validaciones:** señales OTLP/Prometheus allowlisted y de baja cardinalidad.
- **Resultado/fallos:** dashboards/alertas distinguen healthy, no-data, stale,
  degraded y failed; caída total alerta por canal independiente.
- **Datos/auditoría/Auth:** Loki/Prometheus; roles de consulta/admin separados.
- **Prioridad/estado/origen/dependencias:** MVP P0 · CONFIRMADO/GATED · ADR-021/025.
- **Aceptación:** fallos inyectados aparecen/alertan; secretos/PII no aparecen;
  backup/restore y control de acceso se demuestran.
- **Verificación:** integration/E2E, threat test, restore y revisión Compliance.

### RF-043 — Consumir APIs de proveedores mediante KrakenD

- **Enunciado:** toda API que QAPAQ consuma directamente atraviesa KrakenD CE
  on-premises antes de la admisión y eventual publicación en Redis/BullMQ.
- **Actor/disparador/precondiciones:** connector worker o proveedor webhook; fuente,
  ruta, upstream, secretRef y scopes aprobados.
- **Entradas/validaciones:** ruta/método/host allowlisted, TLS, OAuth/API key runtime,
  tamaño, timeout, cuota y correlation context.
- **Resultado/fallos:** respuesta llega al adapter para validación; 401/403/429/5xx,
  timeout o circuit breaker degradan la fuente sin adelantar checkpoint.
- **Datos/auditoría/Auth:** gateway no guarda body/raw/secreto; raw, manifiesto,
  inbox, checkpoint y outbox quedan durables antes de encolar referencias.
- **Prioridad/estado/origen/dependencias:** MVP P0 · CONFIRMADO/GATED · ADR-026 ·
  balanceador, KrakenD, SecretProvider y C-28.
- **Aceptación:** no existe acceso directo del adapter al upstream ni pipe
  `KrakenD → BullMQ`; M365 mantiene `M365 → Wazuh` y QAPAQ consulta el Indexer por
  KrakenD; una API directa futura usa ruta aislada.
- **Verificación:** contract/provider/security/E2E, fault injection y benchmark.
