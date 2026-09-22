# Auditoría del MER frente a los requisitos propuestos de C-04

Fecha: 2026-09-22. Estado: **REVISIÓN**, no aceptación de schema ni implementación.

Actualización: los hallazgos tienen [resolución documental](#resolución-documental-del-mer--2026-09-22)
y un [ER final C-04](c-04-admission-er.md). El resultado siguiente conserva el
diagnóstico inicial; la validación ejecutable de persistencia sigue pendiente.

## Resultado

El MER sirve como contexto global, pero no constituye todavía una especificación
migrable de admisión durable. Los requisitos C-04 mejoran atomicidad, idempotencia
y concurrencia, aunque necesitan resolver identidad, granularidad del raw,
pertenencia entre entidades y ownership antes de fijar restricciones físicas.
No se acepta ni se implementa el resto del MER como consecuencia de esta revisión.

## Procedencia y alcance comprobado

Se actualizó la referencia remota con `git fetch origin main`. Se incorporaron a
la rama de trabajo `develop`, sin cambiar de rama ni hacer merge:

- `docs/architecture/data-model-mer.md`, nuevo documento.
- `docs/README.md`, únicamente el cambio de main que enlaza ese documento.

Origen: `origin/main`, commit `5706f5c6d7356fdef42c835d98afcd800264935f`.
Los blobs importados coinciden con el origen:

- MER: `9421eff691c0f26c875f4af09f8881b62943f4f8`.
- Índice: `1f98f263526e730c8e8dc63e34c9dfbe8fe77652`.

Se comprobó antes de importar que el MER no existía y el índice no tenía cambios
locales. Los cambios pendientes de C-02 se preservaron. El MER importado no se
reescribe: este informe separa hallazgos de propuestas de corrección.

Fuentes contrastadas: MER completo; requisitos C-04 aportados por el usuario
(29 secciones); ADR-004 operacional, ADR-011, ADR-016; plan de componentes;
event-model, schema SecurityEvent 1.0.0, storage, data-flow,
source-integration-strategy, reglas de dependencia y ownership de módulos;
configuración C-03; schema/paquete Prisma y harness de integración existentes.

## Correspondencia semántica, sin asumir equivalencia

- **integrations → Source: separación, no simple renombrado.** El MER §3.2 mezcla
  fuente con configuración operativa: edición, responsables, scope, secret_ref,
  motivos de deshabilitación. Source identifica una fuente lógica mediante tenant,
  proveedor, producto, dataset e instancia, sin referencias de secretos. Conservar
  como propuesta posterior la configuración de integración; no perder sus atributos
  ni trasladarlos automáticamente a Source. Precisar la correspondencia de
  instanceKey con source.instanceId de C-05.
- **integration_checkpoints → SourceCheckpoint: redefinición.** El MER guarda estados
  del pipeline, replay_policy y gap_detected; C-04 requiere solo cursor comprometido,
  versión/generación y revisión optimista. Las políticas de replay y cobertura
  pertenecen a otros contratos, no a la revisión del checkpoint.
- **ingest_batches → IngestionManifest: ampliación.** El MER propone un raw_object_ref
  y hash por lote. C-04 agrupa varias referencias y añade manifestKey, lifecycle y
  contadores. rejected_count no equivale automáticamente a quarantinedCount.
- **raw_object_catalog → RawEventReference: separación de responsabilidades.** El
  catálogo mezcla raw, dataset, tier y schema_version de archivo. C-04 necesita
  fuente, manifest e identidad física del objeto; no implementa tiers ni archivo.
- **quarantine_entries → QuarantinedEvent: ampliación relacional.** El MER conserva
  referencia textual, parser/error y un estado de reproceso. C-04 agrega enlaces
  a raw/inbox/manifest y preservación de intentos. El reproceso funcional sigue fuera.
- **EventInbox: entidad ausente.** El alcance introductorio menciona inbox, pero el
  catálogo no lo define ni garantiza unicidad de admisión.
- **OutboxMessage: entidad general ausente.** Hay notification_outbox y audit_outbox,
  pero son propuestas específicas de otros componentes; no equivalen al outbox de
  admisión ni deben sustituirse globalmente durante C-04.

## Hallazgos de prioridad alta

### A-01 — El checkpoint mezcla progreso y confirmación durable

Evidencia: MER §3.2, integration_checkpoints; source-integration-strategy,
«Checkpoint, ACK y replay»; data-flow, pasos 3 y 4 de admisión.

El MER asigna FETCHED/DURABLE/NORMALIZED/PROCESSED/CHECKPOINTED a una fila de
checkpoint. Además, data-flow describe confirmar metadata y después persistir el
checkpoint desde connectors. Esto difiere del C-04 propuesto, que exige el cursor
en el mismo commit de admisión. No basta con renombrar la tabla.

Corrección propuesta: checkpoint exclusivamente comprometido, revisión condicional
atómica e invariantes de admisión en la misma unidad de trabajo. Actualizar ambas
descripciones del flujo cuando se acepte ese contrato. Los estados de procesamiento
permanecen en manifest/inbox. Probar que una revisión obsoleta revierte también
manifest, raw, inbox y outbox de esa operación.

### A-02 — No existe una cadena relacional de admisión coherente

Evidencia: MER §3.3 y §4.2. El diagrama reconoce expresamente que raw y cuarentena
no tienen batch_id. Quarantine tampoco declara dataset_id, aunque el texto de
§4.2 agrupa ambos recursos bajo esa relación.

Faltan vínculos y restricciones para demostrar qué fuente y manifest originaron
un inbox, raw o cuarentena. En el C-04 propuesto, FKs independientes solo prueban
existencia: no impedirían combinar source A con manifest B y raw C.

Corrección propuesta: definir pertenencia fuente/dataset/tenant y mantenerla con
claves compuestas o un diseño equivalente verificable. No confundir integridad
relacional con autorización. Añadir pruebas negativas de relaciones cruzadas,
incluyendo cuarentena con inbox y raw incompatibles.

### A-03 — Recepción física e idempotencia requieren contratos distintos

Evidencia: C-04 §10; ADR-011; event-model, «Identidad, duplicados y replay».

C-05 exige un recordId UUIDv7 nuevo por recepción física y conserva eventUid.
La unicidad sourceId/idempotencyKey del inbox no explica dónde queda una recepción
repetida ni cómo un replay futuro puede crear una nueva recepción sin duplicar
efectos. El MER no resuelve esa diferencia.

Corrección propuesta: definir por separado reintento de la misma operación,
recepción repetida y replay intencional. Precisar cómo se conserva trazabilidad
del duplicado y qué sucede si una misma clave llega con distinto contenido.
No convertir una identidad derived de baja confianza en descarte automático.
La generación de la clave permanece fuera del repositorio.

### A-04 — Raw por evento y objeto por lote no están reconciliados

Evidencia: MER ingest_batches/raw_object_catalog; C-04 §9/§13;
SecurityEvent schema, `$defs.raw.sizeBytes`, máximo 262144 bytes.

El MER sugiere un objeto por lote; el requerimiento admite 1:1 o 1:N entre raw
e inbox y pide tamaños grandes. Falta determinar a qué bytes corresponden hash,
tamaño y referencia del evento cuando el objeto contiene varios registros.
BigInt es una decisión de representación, no autorización para superar C-05.

Corrección propuesta: cerrar granularidad y localización de cada registro antes
de imponer UNIQUE(raw_event_reference_id). Definir también reutilización del
objeto entre manifests: una FK manifestId obligatoria junto a unicidad global
del objeto puede impedirla. Elegir identidad inmutable o versionada; si se
permite versión nula, explicitar su tratamiento en la unicidad.

### A-05 — La frontera transaccional y su ownership no quedan garantizados

Evidencia: MER §2; repository-structure, límites de áreas técnicas;
plan C-04/C-11/C-13 y requerimiento C-04 §17.

Connectors posee fuentes/checkpoints y Telemetry la admisión. Centralizar todos
los puertos de negocio en platform/database contradiría ese ownership. Una UoW
genérica tampoco impide ejecutar un callback que solo avance el checkpoint.

Corrección propuesta: conservar puertos y semántica en sus módulos, compartir
infraestructura transaccional y exponer una composición pública que coordine la
admisión sin importar internals. Precisar cómo se impide avance independiente y
uso de repositorios fuera de su transacción. Actualizar el plan para distinguir
persistencia anticipada de C-04 de procesamiento futuro C-11/C-13, y conservar
la dependencia del soporte PostgreSQL de C-06.

### A-06 — La afirmación de integridad universal mediante FKs es incorrecta

Evidencia: MER §5, punto 5, frente a §3.6 y la nota común a los diagramas.

El documento afirma que ninguna operación deja inconsistencias sin pasar por
una FK explícita, pero contiene referencias externas a OpenSearch, asociaciones
polimórficas y relaciones aún sin declarar. Una FK tampoco verifica existencia
del objeto externo, hash de sus bytes o pertenencia del aggregate del outbox.

Corrección propuesta: enumerar qué garantiza PostgreSQL y qué exige aplicación,
verificación externa o reconciliación posterior. No declarar integridad raw por
la mera presencia de una referencia y un SHA-256.

## Hallazgos de prioridad media

### A-07 — La explicación de normalización contradice los campos declarados

MER §5.3 afirma que evidence, raw_object_catalog y exports referencian
dataset_catalog para evitar copiar clasificación. Sin embargo, evidence (§3.6)
no declara dataset_id y sí classification; exports también conserva classification.
Los campos dataset_id del catálogo raw y exports no se marcan allí como FK.

No eliminar classification mecánicamente: una clasificación por recurso o una
instantánea histórica puede ser legítima. Primero definir semántica y luego
corregir catálogo, relaciones y afirmación de normalización. Fuera de C-04 no
corresponde implementar tablas de retención/evidencia para arreglar el texto.

### A-08 — El diagrama fija cardinalidades que el texto mantiene pendientes

En §4.4 se dibuja N:M entre alertas, incidentes y casos aunque §3.6/U-008 prohíben
inferirla; la etiqueta UNRESOLVED no neutraliza la cardinalidad dibujada. En §4.5,
notifications–notification_outbox se dibuja 1:1, pero §3.7 no declara unicidad de
notification_id en outbox. Varias FKs opcionales se dibujan como padres obligatorios.

Corrección propuesta: representar asociaciones pendientes en un diagrama conceptual
sin cardinalidad, y reservar el ER físico para relaciones y opcionalidad declaradas.
No resolver U-008 durante C-04 ni deducir 1:1 de «misma transacción».

### A-09 — La clasificación de evidencia mezcla hecho, decisión e inferencia

El MER §3 agrupa FACT y DECISION bajo F. Algunas filas F combinan capacidades
documentadas con decisiones físicas inferidas: raw_object_catalog con tier,
schema_version y claves; cuarentena con estructura relacional aún incompleta.
El estado PROPOSAL global es correcto, pero no convierte sus detalles en hechos.

Corrección propuesta: separar procedencia funcional de decisión física; identificar
por campo la propuesta o supuesto cuando la fuente no lo fija. No promover el MER
completo a DECISION por implementar siete tablas.

### A-10 — Evidencia de fallo y rollback total necesitan mecanismos distintos

C-04 exige conservar evidencia de un manifest fallido y revertir toda admisión
fallida. Un manifest insertado en la transacción revertida no sobrevivirá.

Corrección propuesta: especificar diagnóstico seguro externo a esa transacción,
o un registro de intento separado explícitamente autorizado. No confirmar datos
de admisión para conservar un error. Definir además contadores y sus fases antes
de imponer igualdades: cuarentena y aceptados pueden solaparse temporalmente.

### A-11 — Falta dimensionar la metadata por evento

Storage/data-flow proponen control por lote; C-04 añade referencias, inbox y
posiblemente outbox por evento. No almacenar raw en PostgreSQL es necesario,
pero no demuestra que el volumen operacional sea pequeño.

Corrección propuesta: documentar granularidad del outbox, escrituras e índices por
admisión y presupuesto de crecimiento. Medir sin afirmar EPS soportados. Mantener
retención funcional fuera de C-04, pero registrar su dependencia operacional.

### A-12 — Configuración y aceptación requieren verificaciones específicas

C-03 tiene PostgreSqlConfig, pero su loader completo exige otros servicios.
El harness actual levanta PostgreSQL y Redis conjuntamente. Schema Prisma no
contiene modelos ni migraciones. Ninguna de las siete entidades está implementada.

Corrección propuesta: loader público PostgreSQL aislado, suite PostgreSQL efímera
independiente y job CI sin otros servicios. Definir estados mínimos, límite UTF-8
del envelope outbox, errores sanitizados, tamaños de cursor y timeout transaccional.
El requisito de siete tablas funcionales debe permitir `_prisma_migrations`.
Comprobar CHECK y FKs mediante catálogo/pruebas SQL además del diff de Prisma.

## Hallazgos documentales menores

- El enlace `../../AGENTS.md` del MER no tiene destino en este checkout ni en el
  árbol de main consultado. No puede utilizarse como autoridad disponible.
- Las referencias a §9 para antifraude y §7.2 para condiciones ABAC no corresponden
  a secciones existentes; el documento termina en §7.
- El enlace del panorama completo apunta a 4.3, pero la sección es 4.7.
- §5 habla de ambas columnas de alert_event_refs, mientras §3.6 enumera tres
  campos bajo PK compuesta. Aclarar si eventUid forma parte de la clave o es dato
  dependiente de recordId; no afirmar normalización sin fijar dependencias.

## Actualización del análisis anterior

El MER ya está disponible y fue leído: queda resuelta la falta de documento,
no los defectos del modelo. Se confirman la mezcla de estados del checkpoint,
la referencia inexistente evidence.dataset_id, la afirmación excesiva sobre FKs
y la ausencia de inbox/outbox general. Se precisa que sí existen outboxes
especializados y que integrations no equivale semánticamente a Source.

Continúan pendientes las decisiones sobre raw por evento/lote, deduplicación,
identidad física, estados y pertenencia transaccional. La propuesta de C-04 no
debe copiar todos los campos ni todos los enums del MER. C-05 y las ADR aceptadas
conservan autoridad sobre la propuesta.

## Criterios para cerrar esta auditoría

1. Ratificar el alcance de persistencia C-04 y su relación con C-06/C-11/C-13.
2. Especificar identidad de fuente/dataset, recepción, operación idempotente y raw.
3. Precisar cardinalidades, pertenencia y restricciones de las siete entidades.
4. Definir contrato de admisión y avance atómico, ownership y errores de concurrencia.
5. Corregir las secciones afectadas del MER y los flujos, conservando sus estados.
6. Implementar y demostrar migración, rollback, duplicados y conflictos en PostgreSQL
   real únicamente en una tarea de implementación de C-04.

## Verificación de esta entrega

Se verificaron procedencia Git, igualdad de blobs importados, diff y estado del
repositorio. Esta entrega importa documentos y audita; no ejecuta Prisma,
migraciones, PostgreSQL ni pruebas de persistencia. No modifica código de C-02,
no implementa C-04 ni el resto del MER y no hace commit, push o despliegue.


## Resolución documental del MER — 2026-09-22

Esta sección actualiza el estado de los hallazgos; el análisis y los hashes
anteriores describen la importación original. El MER se ha revisado desde entonces
y ya no debe compararse con esos blobs como si siguiera intacto. La solicitud de
resolver el ER fija una [baseline de diseño C-04](c-04-admission-er.md), sin aceptar
el MER global ni cerrar su implementación.

- A-01: checkpoint solo confirmado y CAS; flujo/diagrama corregidos a una TX antes
  del recibo. Los estados del pipeline no se persisten como progreso del checkpoint.
- A-02: identidad de Source y FKs compuestas explícitas; cuarentena verifica
  inbox/raw/recordId. Reutilizar raw del mismo origen lógico se permite entre
  manifiestos de la misma Source, de forma deliberada, sin permitir cruces de tenant.
- A-03: recordId por recepción; claves de operación separadas de eventUid;
  reintento técnico conserva el sobre. C-13 conserva deduplicación de efectos.
- A-04: raw por registro, referencia inmutable globalmente única, versión opcional
  sin unicidad nullable y límites C-05. Inbox/raw no es 1:1 por reutilización.
- A-05: comando commitAdmission acotado, repositorios internos y ownership definido;
  la futura implementación deberá impedir checkpoint independiente y probarlo.
- A-06: retiradas las garantías universales de FKs; integridad externa exige store
  y verificaciones de C-11. Las referencias polimórficas mantienen sus limitaciones.
- A-07: corregida la atribución inexistente de dataset_id a evidence; clasificación
  propia/snapshot/derivada queda para su entrega, no se inventa otra tabla C-04.
- A-08: opcionalidades corregidas; notas y U-008 no se dibujan como FKs/N:M aceptadas;
  notificación/outbox deja de inferir 1:1. ER C-04 especifica mínimos del comando.
- A-09: requisitos funcionales R separados de propuestas físicas; baseline C-04
  acotada y sin cambio de estados de ADR o aceptación global.
- A-10: rollback total con diagnóstico sanitizado fuera de la TX; no existe
  manifiesto fallido confirmado. Contadores son conjuntos disjuntos al admitir,
  no una mezcla de fases; duplicados semánticos no se descartan en C-04.
- A-11: outbox por lote, fórmula de filas y escenario de crecimiento explícitos;
  medición de índices/WAL y gates de retención pendientes, sin promesa de EPS.
- A-12: estados iniciales, payload cerrado de 4 KiB, límites de cursor/tiempo,
  errores y gates de configuración/harness/migración establecidos.

Los criterios 1–5 quedan resueltos **a nivel de diseño documental**. La migración
Prisma C-04 y el schema de siete tablas ya existen. La suite
`platform/database/test/postgres-c04.integration.spec.ts` demuestra migración desde
base vacía, rollback total después de una escritura fallida y carrera concurrente
contra PostgreSQL real. La aceptación completa de C-04 aún conserva los gates de
comando público de admisión, límites, CAS de checkpoint y evidencia de producción.
Las decisiones globales pendientes de §6 del MER conservan su alcance original.

Evidencia visual: [`c04-migration-test-success.png`](../../c04-migration-test-success.png)
y [`c04-rollback-concurrency-success.png`](../../c04-rollback-concurrency-success.png).
