# ER final de admisión operacional — C-04

Estado: **BASELINE DE DISEÑO de C-04**, establecida el 2026-09-22 por la solicitud
de resolver el MER auditado. Implementación, migración y aceptación ejecutable
pendientes. No acepta el MER global ni modifica U-008, los gates productivos o los
estados de las ADR. Esta especificación sustituye las propuestas de checkpoints,
lotes, referencias raw y cuarentena del MER únicamente para C-04.

## Autoridad y alcance de entrega

Las decisiones heredadas son PostgreSQL 18.6 / Prisma 7.10.0 y límites de
[ADR-016](../adr/016-toolchain-and-capacity-baseline.md), identidad y raw de
[C-05](event-model.md), y entrega al menos una vez de
[ADR-019](../adr/019-source-boundaries-and-authorized-pilots.md). El
[schema C-05](../../packages/contracts/src/security-event/security-event.schema.json)
es la referencia ejecutable del contrato. Las restricciones físicas y los límites
adicionales identificados abajo son decisiones de este diseño, no hechos previos.

C-04 entrega siete tablas funcionales, cliente, migración, puertos de persistencia,
adaptadores, comando transaccional y pruebas PostgreSQL. `_prisma_migrations` es
una tabla técnica adicional permitida. No entrega collectors, almacenamiento raw,
normalización, dispatcher, publicación BullMQ, replay, retención ni reprocess.
No contiene SecurityEvent completo, raw, credenciales, URLs firmadas ni errores
libres de proveedor. Los fixtures serán sintéticos, sin habilitar fuentes reales.

`connectors` posee `sources` y `source_checkpoints`; `telemetry` posee las otras
cinco tablas. Los puertos están en aplicación de cada módulo; sus adaptadores en
infraestructura. `platform/database` posee cliente, migraciones y mecanismo
transaccional, sin convertirse en repositorio de negocio. La coordinación de
admisión pertenece a aplicación de telemetry y usa el puerto público de
connectors. Ningún consumidor importa Prisma ni internals de otro módulo.

## Identidad, granularidad y normalización

Una Source representa **tenant + provider + product + dataset + instanceKey**.
No equivale a la ficha operativa `integrations`: una integración puede originar
varias fuentes. El tenant es un identificador opaco, no necesariamente un UUID
Entra. La identidad natural es inmutable y sensible a mayúsculas; el adaptador
normaliza valores según el proveedor antes del alta. Cambiar dataset o instancia
crea otra Source. El MVP mantiene su gate de Wazuh; registrar no habilita polling.

Cada recepción física, incluida una nueva adquisición por retry o replay, obtiene
un `recordId` UUIDv7 nuevo. `eventUid` identifica el evento lógico de C-05 y **no
es clave única de estas tablas**. Un identificador heurístico no permite descartar
recepciones. `providerEventId` es evidencia opcional, nunca una unicidad universal.

El reintento técnico del **mismo comando PostgreSQL ya preparado** conserva
manifestKey, recordIds, claves de inbox y messageId: no es otra recepción. El
productor debe conservar ese sobre de admisión hasta conocer el resultado. Si
vuelve a consultar la fuente y construye nuevas recepciones, genera nuevas
identidades; C-13 resolverá idempotencia de efectos lógicos sin borrar la historia.
La idempotencia C-04 cubre operaciones de persistencia, no deduplicación semántica.

Cada raw ref identifica un objeto inmutable de **un registro**, nunca un lote ni
un rango implícito dentro de un archivo. `objectRef` es globalmente único y opaco
(`raw:<uuidv7>`), y resuelve una versión inmutable; no es una URL. Una
versión nueva necesita otra referencia. `objectVersion` opcional solo registra
metadata del store: la unicidad no depende de NULL ni de `(ref, version)`.
Igual SHA-256 no implica igual recepción ni autoriza deduplicar.

Una referencia tiene un manifiesto de origen. Varias recepciones de la misma
Source pueden referenciarla, por ejemplo un replay posterior, sin copiar bytes.
Por eso inbox→raw **no es 1:1** y su manifiesto puede diferir del manifiesto de
origen del raw. Solo se permite reutilizar una referencia ya durable de la misma
Source; su digest, tamaño y origen no se reescriben. C-04 prueba esta relación,
pero no implementa el proceso de replay. En recepción normal hay un raw nuevo
y un inbox por registro.

Hay un manifiesto y un mensaje outbox por lote admitido. La cuarentena es historia
de fallos por recepción: puede haber varios registros para un inbox. Para C-04
manifest, inbox y recordId son obligatorios en cuarentena; se estrecha así la
opcionalidad de la propuesta inicial. El rechazo anterior a admisión no crea
cuarentena parcial ni avanza cursor. C-11 deberá resolver raw sobredimensionado
antes de aceptar ese caso, sin ampliar silenciosamente el contrato C-05.

La repetición de sourceId/dataset o sourceId/manifestId sirve a FKs compuestas;
es redundancia controlada por restricciones. No se afirma 3FN estricta universal.
No se duplica la clasificación de dataset ni se añade dataset_catalog a C-04.

## Diagrama entidad-relación

Renderizado con `mermaid-cli` directamente desde
[`14-c-04-admission-er.mmd`](../diagrams/14-c-04-admission-er.mmd), no dibujado
a mano: los nombres de tabla/columna y las marcas `PK`/`FK`/`UK` son una
proyección exacta de `platform/database/prisma/schema.prisma` y su migración
`20260922000000_c04_admission`. Si el schema cambia, este archivo `.mmd` deja de
coincidir hasta regenerarse — no editar la imagen por separado.

![Diagrama entidad-relación de C-04 (admisión operacional)](assets/c-04-admission-er.png)

Lectura: `Sources` es la raíz de identidad (única por
`tenantId+provider+product+dataset+instanceKey`); cero o un `SourceCheckpoint`
por `(sourceId, dataset)` guarda solo el último cursor confirmado (sin estados
de pipeline). Cada `IngestionManifest` confirmado pertenece a una `Source` y
agrupa de 1 a 500 `EventInbox`, referencias `RawEventReference` propias y
exactamente un `OutboxMessage` de admisión. Un `EventInbox` puede reutilizar un
raw de otro manifiesto de la **misma** `Source` (nunca de otra), nunca de otro
tenant. `QuarantinedEvent` cuelga de la combinación completa de FKs del
`EventInbox` que falló, no de una tabla independiente. Ninguna FK usa cascada
de borrado (`ON DELETE RESTRICT` en todas). El diccionario completo, con tipos,
límites de longitud, CHECKs y justificación de cada UNIQUE, está en la
siguiente sección.

## Diccionario físico

Nombres públicos en camelCase; tablas/columnas SQL en snake_case mediante mapeo
Prisma. Todos los `id` y `messageId` son UUIDv7 generados en aplicación; también
`recordId`, por C-05. PK `id` obligatoria en cada tabla. SQL debe comprobar versión
7 y variante UUID para esos identificadores; el tipo uuid solo no basta. `revision`
se transporta como bigint en TypeScript y cadena decimal en JSON, sin pérdida
por Number.
Todas las fechas son `timestamptz(3)` UTC; `createdAt` usa hora de inserción y
`updatedAt` se actualiza explícitamente en el adaptador. `?` significa nullable;
todo lo demás es NOT NULL. Campos enumerados son `text` con CHECK cerrado para
facilitar evoluciones por migración. No usar borrado o actualización en cascada.

Límites nuevos de C-04: tenant/provider/product/dataset/instanceKey de 1 a 128
caracteres, claves de operación de 1 a 128, versiones y códigos de 1 a 64,
providerEventId/lastTieBreaker de 1 a 512, objectVersion de 1 a 256 y errorPath
de 1 a 256. No se aceptan cadenas vacías ni caracteres de control. Los valores
opcionales ausentes son NULL. SHA-256 es exactamente 64 hexadecimales minúsculos.

### Source → sources

- `id uuid`; `tenantId`, `provider`, `product`, `dataset`, `instanceKey text`.
- `status text = 'planned'`; estados admitidos por esta migración: `planned`,
  `paused`. Configuración, validación y habilitación real corresponden a C-10 y
  requieren ampliar la restricción junto con sus guardas; no fingir ese lifecycle.
- `createdAt`, `updatedAt timestamptz(3)`.
- UNIQUE natural `(tenantId, provider, product, dataset, instanceKey)`.
- UNIQUE auxiliar `(id, dataset)` para las FKs de pertenencia.

### SourceCheckpoint → source_checkpoints

- `id uuid`, `sourceId uuid`, `dataset text`, `cursor text`,
  `cursorVersion text`, `sourceGeneration text?`, `lastOccurredAt timestamptz(3)?`,
  `lastTieBreaker text?`, `revision bigint`, `committedAt`, `createdAt`, `updatedAt`.
- `cursor` opaco de 1 a 8192 bytes UTF-8; `sourceGeneration` máximo 128 caracteres.
  No contiene tokens/secretos y no se registra en logs. No interpretar su orden
  como comparación lexicográfica ni imponer orden entre tiempos de C-05.
- UNIQUE `(sourceId, dataset)` y FK `(sourceId, dataset)` → Source `(id, dataset)`.
- `revision >= 1`; ausencia equivale a expectedRevision=0. Primera inserción=1;
  las siguientes actualizan con CAS `WHERE revision = expectedRevision` e
  incrementan en uno. Cero filas afectadas es CONCURRENCY_CONFLICT.
- No tiene estado FETCHED/NORMALIZED/PROCESSED: contiene únicamente el último
  cursor confirmado. Nunca se crea desde un fetch todavía no durable.

### IngestionManifest → ingestion_manifests

- `id`, `sourceId uuid`, `dataset`, `manifestKey text`, `status text = 'durable'`,
  `admissionDigest text`, `admissionFormatVersion text = '1'`,
  `cursorFrom text?`, `cursorTo text?`, `cursorVersion text?`,
  `sourceGeneration text?`, `checkpointRevision bigint?`, `receivedAt`, `durableAt`,
  `completedAt timestamptz(3)?`, `eventCount`, `acceptedCount`, `duplicateCount`,
  `quarantinedCount integer`, `createdAt`, `updatedAt`.
- `cursorFrom/To` tienen el mismo límite que checkpoint. Ambos NULL para admisión
  sin cursor; `cursorFrom` puede ser NULL en la primera admisión con cursor.
- `cursorVersion` y `checkpointRevision` son obligatorios si cursorTo existe,
  y NULL si no existe; sourceGeneration solo puede existir con cursorTo y tiene
  máximo 128 caracteres. Si cursorTo es NULL, cursorFrom también debe ser NULL.
  checkpointRevision >=1 conserva la revisión resultante de ese comando para
  devolver el mismo recibo aunque el checkpoint ya haya avanzado. Su revisión
  esperada es checkpointRevision-1. Son snapshot inmutable del commit.
- `admissionDigest` es SHA-256 del comando validado, con codificador determinista
  v1: objetos de claves ASCII conocidas ordenadas alfabéticamente, listas de raws,
  recepciones y cuarentenas ordenadas por su UUID, opcionales representados por
  null, UUID minúsculos, fechas ISO UTC a milisegundos, bigint como cadena decimal
  y JSON compacto UTF-8. Se rechazan Unicode mal formado y claves desconocidas.
  Incluye todos los campos de entrada y expectedRevision; excluye el propio digest
  y tiempos/estados generados por persistencia. El adaptador calcula el digest,
  no confía en uno aportado por el llamador. CHECK formato SHA-256 y versión='1'.
  Conserva la identidad del comando aunque luego cambie el estado de procesamiento.
- UNIQUE `(sourceId, manifestKey)`; UNIQUE auxiliar `(sourceId, id)`;
  FK `(sourceId, dataset)` → Source `(id, dataset)`.
- CHECK `1 <= eventCount <= 500`, contadores no negativos y
  `eventCount = acceptedCount + quarantinedCount + duplicateCount`.
- En C-04 `duplicateCount = 0`: las nuevas recepciones no se descartan. Una
  repetición del comando devuelve el manifiesto existente, sin sumar contadores.
  durableAt es la hora lógica de admisión dentro de la TX, no una medición del
  instante exacto del commit. `acceptedCount` cuenta inbox sin cuarentena inicial y
  `quarantinedCount` inbox con cuarentena inicial, conjuntos disjuntos. Estos
  contadores son una foto de admisión, no cambian por fallos de parser posteriores.
- CHECK `status = 'durable'`, `durableAt IS NOT NULL`, `completedAt IS NULL`.
  La migración futura que incorpore procesamiento definirá sus transiciones.

### RawEventReference → raw_event_references

- `id`, `sourceId`, `manifestId uuid`, `objectRef text`, `objectVersion text?`,
  `sha256 text`, `mediaType text`, `sizeBytes integer`, `receivedAt`, `createdAt`.
- UNIQUE `objectRef`; UNIQUE auxiliar `(sourceId, id)`;
  FK `(sourceId, manifestId)` → Manifest `(sourceId, id)`.
- CHECK ref `raw:` seguido de UUIDv7 canónico minúsculo (40 caracteres ASCII);
  este subconjunto cumple el máximo 1024 de C-05 y acota su índice único.
  mediaType de 3 a 128; sha256 válido; `0 <= sizeBytes <= 262144`, conforme a C-05.
  La validación de
  aplicación adicional rechaza credenciales, URLs firmadas y referencias vacías.
- Metadata inmutable tras insert. Una FK no prueba existencia, integridad,
  disponibilidad ni custodia del objeto externo. El adapter del store de C-11
  deberá verificarlas antes del comando; C-04 recibe un comprobante tipado.

### EventInbox → event_inbox

- `id`, `sourceId`, `manifestId`, `rawEventReferenceId`, `recordId uuid`,
  `providerEventId text?`, `idempotencyKey text`, `status text = 'admitted'`,
  `attemptCount integer = 0`, `availableAt`, `processingStartedAt timestamptz(3)?`,
  `processedAt timestamptz(3)?`, `lastErrorCode text?`, `createdAt`, `updatedAt`.
- UNIQUE `recordId`; UNIQUE `(sourceId, idempotencyKey)`; la clave identifica
  esta recepción preparada, no eventUid. UNIQUE auxiliar
  `(sourceId, manifestId, id, rawEventReferenceId, recordId)` para cuarentena.
- FK `(sourceId, manifestId)` → Manifest `(sourceId, id)`;
  FK `(sourceId, rawEventReferenceId)` → Raw `(sourceId, id)`.
  Se permite raw de otro manifiesto de origen de la misma Source expresamente;
  no se permite raw de otra Source/tenant. El comando valida reutilización durable.
- En C-04 CHECK status admitted, attemptCount=0 y processingStartedAt,
  processedAt, lastErrorCode NULL. `availableAt` se fija al admitir. La presencia
  de cuarentena excluye trabajo procesable; los claims futuros deberán filtrarla.

### OutboxMessage → outbox_messages

- `id`, `messageId`, `sourceId`, `aggregateId uuid`, `aggregateType`,
  `messageType`, `schemaVersion`, `idempotencyKey text`, `payload jsonb`,
  `status text = 'pending'`, `attemptCount integer = 0`, `availableAt`, `createdAt`,
  `processingStartedAt timestamptz(3)?`, `publishedAt timestamptz(3)?`,
  `lastErrorCode text?`.
- UNIQUE `messageId`; UNIQUE `idempotencyKey`; UNIQUE `(aggregateType, aggregateId)`
  para un mensaje de admisión por manifiesto. `sourceId` se añade a la propuesta
  para comprobar pertenencia; FK `(sourceId, aggregateId)` → Manifest `(sourceId,id)`.
- En C-04 CHECK aggregateType=`IngestionManifest`, messageType=`AdmissionDurable`,
  schemaVersion=`1`, status=pending, attemptCount=0 y los tres campos opcionales
  NULL. Generalizar este outbox requiere migración; no sustituye audit_outbox ni
  notification_outbox y no les inventa cardinalidades.
- Payload v1 cerrado: objeto con **solo** `manifestId` (UUID de aggregateId).
  CHECK SQL sobre tipo, clave única y valor coherente con aggregateId. No lista
  eventos, raws ni errores. Límite nuevo: `octet_length(payload::text) <= 4096`
  en PostgreSQL y JSON UTF-8 transmitido <=4096 en aplicación. Ambas medidas se
  prueban; son inferiores a los 256 KiB de BullMQ. El consumidor futuro resuelve
  las referencias mediante un puerto paginado, no acceso SQL entre módulos.

### QuarantinedEvent → quarantined_events

- `id`, `sourceId`, `manifestId`, `inboxId`, `rawEventReferenceId`, `recordId uuid`,
  `errorCode text`, `errorPath text?`, `contractVersion text?`, `parserVersion text?`,
  `status text = 'quarantined'`, `attemptCount integer = 0`, `quarantinedAt`,
  `lastReprocessedAt timestamptz(3)?`, `createdAt`, `updatedAt`.
- FK `(sourceId, manifestId, inboxId, rawEventReferenceId, recordId)` → Inbox
  `(sourceId, manifestId, id, rawEventReferenceId, recordId)`. Así no se puede
  combinar un inbox válido con el raw/recordId de otro. La FK asegura también la
  pertenencia al manifiesto de recepción, aunque el raw tenga un origen anterior.
- Códigos de catálogo controlado; errorPath es una ruta estructural sanitizada,
  sin valores del evento ni nombres dinámicos que revelen datos. C-04 persiste
  códigos aportados por el llamador, no inventa un parser ni errores de contrato.
- CHECK status quarantined, attemptCount=0, lastReprocessedAt NULL. Registros
  append-only en esta entrega; nuevos fallos pueden añadir filas. Resolver o
  reprocesar pertenece a C-13 y preservará el historial mediante una migración
  explícita. No hay UNIQUE de inbox/raw que borre fallos anteriores.

## Relaciones, borrado e índices

El [diagrama canónico](../diagrams/14-c-04-admission-er.mmd) expresa cardinalidad
SQL. Una Source tiene cero o un checkpoint y cero o muchos manifiestos; un raw
tiene exactamente un manifiesto de origen. Un manifiesto confirmado tiene de
1 a 500 inbox y exactamente un outbox por el comando, aunque una FK sola no
impone esos mínimos. La regla de cuarentena compuesta está definida arriba.

Todas las FKs usan ON DELETE RESTRICT / ON UPDATE RESTRICT; IDs e identidades
son inmutables. C-04 no expone delete ni purge. El rol runtime no tendrá DDL;
las migraciones usarán credenciales separadas. Esto no equivale a protección
contra un administrador SQL. La retención y legal hold necesitan C-13 y el gate
de ADR-018 antes de operar a escala; no hay cascadas que eliminen evidencia.

Además de los índices únicos de PK y restricciones, crear únicamente:

- Manifest `(sourceId, receivedAt, id)` para historial paginado por fuente.
- Raw `(sourceId, manifestId, id)` para manifiesto de origen.
- Inbox `(sourceId, manifestId, id)` para lectura de lote y FK;
  `(sourceId, rawEventReferenceId)` para pertenencia y referencias al objeto.
- Outbox `(status, availableAt, id)` para lectura ordenada de pendientes.
- Quarantine `(sourceId, manifestId, inboxId, rawEventReferenceId, recordId)`
  para su FK y consulta de historial del inbox con los prefijos conocidos.

No agregar índices GIN de payload, SHA-256 ni providerEventId sin consulta y EXPLAIN
que los justifiquen. Los índices únicos que ya cubren un prefijo de FK no se
duplican. El claim y sus índices adicionales se diseñan junto con C-13, no ahora.

## Contrato transaccional obligatorio

El puerto público es un comando acotado `commitAdmission`, no un callback que
permite escribir cualquier repositorio. Recibe sourceId/dataset, manifestKey,
recepciones con identidad estable, comprobantes raw nuevos o IDs raw existentes,
cuarentenas iniciales opcionales y cambio de cursor opcional con expectedRevision,
cursorVersion, sourceGeneration, lastOccurredAt y lastTieBreaker.
Devuelve IDs, cantidades y revisión confirmada. Las entidades y errores públicos
son tipos propios; jamás Prisma.TransactionClient, Prisma.JsonValue ni errores SQL.

1. Validar límites, identidades, pertenencia declarada y comprobantes antes de
   abrir TX. C-11 realiza todo IO raw fuera de la TX. Ningún HTTP/store/cola dentro.
2. Abrir TX READ COMMITTED. Consultar el manifiesto por sourceId+manifestKey.
   Si existe, comparar admissionDigest y admissionFormatVersion con el comando
   validado; devolver el recibo inmutable del manifiesto sin escribir. La misma
   clave con otro contenido es PERSISTENCE_CONSTRAINT_VIOLATION, no éxito.
3. Si no existe, insertar manifiesto durable, raws nuevos, inbox y cuarentenas
   iniciales, y el único outbox. Validar refs existentes bajo la misma Source.
   Comprobar número de inbox, partición de contadores y bytes totales del lote.
4. Si hay cursorTo, crear/actualizar checkpoint mediante CAS en la **misma TX**.
   Verificar que cursorFrom, cursorVersion y sourceGeneration correspondan al
   checkpoint esperado; cambios de generación exigen una política de C-10, no
   reset automático. Sin cursorTo no se toca el checkpoint.
5. Commit; solo después emitir recibo. Error en cualquier paso revierte todo,
   incluido outbox y checkpoint. No se retorna aceptación desde un finally.

Los mutadores de repositorios y la capacidad transaccional son internos a los
adaptadores; ningún puerto público permite adelantar checkpoint solo. El coordinador
de telemetry invoca el puerto público acotado de connectors dentro del mecanismo
de unidad de trabajo, ensamblado en el composition root. Su mutador exige una capacidad opaca de TX
activa, creada solo por el coordinador interno: sin constructor público, verificada
en runtime y rechazada fuera de commitAdmission. Las dependencias se prueban
con reglas de arquitectura; la atomicidad con PostgreSQL real. FKs/CHECK no prueban
por sí solos que todas las escrituras sucedieron mediante este comando.

Dos comandos iguales concurrentes: uno confirma; el otro hace rollback al chocar
con UNIQUE, consulta el resultado en una **nueva TX**, compara y devuelve el mismo
recibo. Dos comandos distintos con la misma revisión: uno confirma y el otro
revierte con CONCURRENCY_CONFLICT; no se actualiza expectedRevision a escondidas.
Un conflicto de recordId/idempotencyKey con otro manifiesto es PERSISTENCE_DUPLICATE,
no se reasigna la recepción ni se admite un lote parcial. Ante commit ambiguo por
pérdida de conexión, el llamador reintenta el mismo comando; no genera otra clave.

Límites nuevos de C-04: espera de conexión transaccional <=2 s, lock_timeout <=2 s,
statement_timeout <=5 s y timeout total de TX <=10 s, inferior a los 15 s síncronos
de ADR-016. Aplicar el menor límite si C-03 configura uno más restrictivo. Sin
reintentos internos ilimitados; reconexión/reintento requiere presupuesto del llamador.

Errores públicos cerrados: `PERSISTENCE_UNAVAILABLE`,
`PERSISTENCE_CONSTRAINT_VIOLATION`, `PERSISTENCE_DUPLICATE`, `PERSISTENCE_NOT_FOUND`,
`PERSISTENCE_CONCURRENCY_CONFLICT`, `PERSISTENCE_TRANSACTION_FAILED`. En este texto
CONCURRENCY_CONFLICT abrevia el quinto. La causa original queda solo en diagnóstico
interno sanitizado; nunca SQL, parámetros, cursor, raw, payload ni credenciales en
el error público. El log de rollback contiene código y correlationId seguro.
Un manifiesto fallido no sobrevive al rollback: no se inserta uno fuera de la TX
para aparentar evidencia durable. El diagnóstico no garantiza custodia de auditoría.

## Dimensiones y presupuesto operacional

Se heredan máximo 500 eventos o 5 MiB **descomprimidos** por lote, 256 KiB por raw
y evento normalizado, y pool API 10 / worker 5 / reserva 5. El límite HTTP 1 MiB
permanece: 5 MiB de lote no autoriza un request HTTP de ese tamaño. El comando
suma sizeBytes por **recepción**, también cuando se reutiliza raw; no hace suma
de objetos distintos que permita eludir el límite. Rechaza antes de TX el exceso.

Para N recepciones nuevas, B lotes y Q filas de cuarentena: N raws + N inbox +
B manifests + B outbox + Q quarantine = **2N + 2B + Q filas nuevas**; hasta B
actualizaciones de checkpoint adicionales. La reutilización raw reduce la primera
N. Con 500 registros/lote, Q=0 y raw nuevo: 1002 inserts y hasta un update por lote,
además de índices y WAL. C-04 debe comprobar las cantidades contra filas persistidas.

Como escenario aritmético, 100 EPS sostenidos producen 8 640 000 recepciones/día
y, con lotes completos de 500, 17 314 560 filas nuevas/día sin cuarentena. **No es
capacidad soportada ni proyección real de carga**. El tamaño medio puede obligar a
lotes menores por 5 MiB, aumentando B. No derivar GB/día multiplicando solo raw.

La aceptación ejecutable registrará bytes heap/índices con pg_total_relation_size,
WAL, latencias p50/p95/p99 del commit, lock waits, fallos, conexiones, N/B/Q y tamaño
medio de metadata. La estimación diaria será N por tamaño medio medido por recepción
más B por tamaño medio por lote y Q por cuarentena, sumando índices/WAL y reserva.
Retención, archivado y particionado requieren medición y decisión posterior antes
de producción; no se crean particiones ni TTL ficticios para justificar escala.
Los escenarios L1/L2/L3 siguen siendo benchmarks pendientes de ADR-016; las pruebas
de C-04 no certifican el rendimiento del pipeline completo ni EPS soportados.

## Encaje en componentes y evidencia para cerrar C-04

C-01/C-03 y el harness PostgreSQL aislado de C-06 son prerrequisitos de ejecución;
C-05 es dependencia contractual de recordId/raw. C-04 requiere extraer acceso
público a configuración PostgreSQL sin exigir Redis/MinIO/Wazuh y disponer de una
suite PostgreSQL efímera independiente. No reducir el alcance general de C-06.

C-11 implementará store/raw durable, orquestación y recuperación de huérfanos;
C-12 parser/normalizador; C-13 claims, retries, deduplicación de efectos, replay y
reprocess. Usarán esta base y migrarán los estados que necesiten. Las siete tablas
adelantan persistencia, no cierran esos componentes ni PBI por anticipado.

Para aceptar la implementación son obligatorias evidencias reproducibles:

1. Migración desde vacío en PostgreSQL 18.6 y reaplicación por historial sin drift;
   exactamente siete tablas funcionales más `_prisma_migrations`. Client generado
   Prisma 7.10.0. CHECK/índices/FKs inspeccionados en catálogo y probados por SQL,
   además del diff Prisma: no todo SQL personalizado queda representado en Prisma.
2. Commit completo y rollback inyectado después de cada escritura y antes del CAS;
   estado vacío/sin cambio comprobado en **las siete tablas**, cursor incluido.
   La prueba de rollback no significa downgrade productivo ni `db push`.
3. Carrera misma operación→un manifiesto/mensaje y mismo recibo; misma clave con
   contenido diferente→rechazo; dos cursores desde una revisión→un éxito y un
   conflicto sin filas parciales; primera creación de checkpoint también concurrente.
   Fixtures del codificador demuestran digest estable ante reordenamiento de
   objetos/listas y distinto ante cualquier cambio de campo significativo.
4. Rechazo de cruces de Source/tenant/dataset, cuarentena con otro inbox/raw/recordId,
   IDs no UUIDv7, hash/tamaño inválidos, límites UTF-8, payload abierto y delete padre.
   Reutilizar raw de otro manifiesto de la misma Source es un caso válido explícito.
5. Nueva recepción del mismo providerEventId/eventUid conserva nuevo recordId;
   reejecutar el mismo comando no crea otra recepción. Cuarentena conserva historia
   y los contadores iniciales no se reinterpretan como estado final de procesamiento.
6. Commit ambiguo y reintento resuelven por identidad estable; timeout/conexión
   fallida no filtran datos. Configuración y harness no requieren otros servicios.
7. Typecheck, límites de módulos y pruebas verifican que no se filtra Prisma ni
   existe un avance de checkpoint público independiente. Medición de metadata con
   lote máximo y cleanup de DB efímera incluso tras fallo; CI adjunta evidencia
   redactada con versiones y commit. No ejecutar reset/down sobre bases compartidas.

La [auditoría](c-04-mer-audit.md) mantiene la evidencia histórica y separa hallazgos
resueltos en diseño de estos criterios aún pendientes de ejecución.
