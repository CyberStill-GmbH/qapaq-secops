# ADR-030 — Arquitectura resiliente y escalamiento progresivo de Qapaq SecOps

- Estado: Accepted como arquitectura objetivo; implementación por etapas y con gates.
- Fecha: 2026-10-13.
- Responsables: Product Owner, Arquitectura, SOC, Seguridad e Infraestructura.
- Relacionados: ADR-020, ADR-024, ADR-026, ADR-028 y ADR-029.

## Contexto

Qapaq SecOps debe procesar señales de seguridad sin trasladar picos de carga a
Wazuh, las fuentes externas, la base operacional o la experiencia del analista.
El repositorio ya establece una aplicación modular con API, worker y web; una
cola Redis/BullMQ para trabajos recuperables; almacenamiento operacional y de
telemetría; y KrakenD Community Edition detrás de balanceadores para rutas de
integración. Falta describir una arquitectura de extremo a extremo que una esas
decisiones y ordene su adopción resiliente.

Esta decisión define una topología lógica objetivo. No declara que los balanceadores,
réplicas, alta disponibilidad, capacidad o tiers de almacenamiento ya estén
desplegados. La forma física final depende del inventario y las pruebas del ambiente.

## Decisión

La arquitectura seguirá el diagrama C4 de despliegue en
[`15-resilient-deployment.mmd`](../diagrams/15-resilient-deployment.mmd) y estas
fronteras:

1. **Acceso de usuarios:** un balanceador de entrada con health checks distribuye
   solicitudes HTTPS entre réplicas sin estado de la web y de la API/BFF QAPAQ. La
   sesión y la autorización residen en servicios de QAPAQ, no en memoria local de
   una réplica. Las rutas de API aplican autenticación, cuotas y controles acordes
   al usuario y al recurso.
2. **Integraciones:** un balanceador interno distribuye el tráfico de proveedores
   entre instancias KrakenD stateless. KrakenD aplica rutas allowlist, límites de
   tráfico, timeouts, circuit breakers y telemetría. Pollers y adapters conservan
   la semántica específica del proveedor. Las rutas de personas y las rutas de
   integración son políticas separadas; KrakenD no es un worker ni un registro de
   eventos. Los webhooks entrantes usan su ruta protegida de ingress cuando el
   proveedor lo requiera.
3. **Ejecución asíncrona:** scheduler y pollers distribuyen consultas en ventanas
   escalonadas, con jitter, leases por fuente/dataset, límites de concurrencia y
   cuotas. Las réplicas no ejecutan dos veces el mismo intervalo si el lease está
   vigente. Redis/BullMQ entrega jobs pequeños con referencias; no transporta
   grandes volúmenes de raw ni reemplaza el registro durable.
4. **Admisión durable:** antes de avanzar un cursor o emitir un acuse que prometa
   recepción, QAPAQ conserva el raw/manifiesto según la política aplicable y registra
   en PostgreSQL la admisión, deduplicación, checkpoint, inbox/outbox y auditoría
   requerida. Cada consumidor puede reintentarse de forma idempotente. Un fallo de
   Redis permite reconciliar jobs desde el registro durable sin perder evidencia.
5. **Qapaq SecOps Core:** normaliza señales al contrato canónico, enriquece,
   deduplica con cautela, correlaciona, prioriza y crea alertas/casos conforme a las
   políticas del SOC. Wazuh mantiene la recolección, agentes, decoders y detecciones
   nativas; el Core no replica su ruleset. El Wazuh Indexer se consulta con mínimo
   privilegio. OpenSearch QAPAQ indexa proyecciones versionadas para investigación;
   PostgreSQL conserva la autoridad transaccional de los objetos operativos.
6. **Investigación Ayni Qapaq:** las alertas relevantes abren o se relacionan con
   investigaciones colaborativas con asignados, tareas, notas, evidencias,
   timeline y resolución. Ayni reutiliza el modelo SOC y el audit trail de QAPAQ;
   no crea una segunda alerta ni un segundo motor de búsqueda.
7. **Respuesta orquestada:** desde una alerta o investigación, una persona con
   permisos puede solicitar un playbook disponible. QAPAQ valida scope, versión,
   aprobación, parámetros y límites; un worker llama a Shuffle mediante credenciales
   de servicio. El resultado queda correlacionado y auditado en QAPAQ. Un timeout
   ambiguo queda `UNKNOWN` hasta reconciliarse; no se reintenta a ciegas.
8. **Retención por tiers:** eventos recientes consultables permanecen en HOT;
   conjuntos menos activos migran a WARM; archivo de largo plazo va a COLD en object
   storage cifrado, catalogado y con restauración autorizada. La matriz por fuente,
   dataset y clase de evidencia debe alinearse con SBS, Legal, Compliance y políticas
   internas antes de fijar plazos o habilitar borrado automático. Redis nunca es
   almacenamiento de archivo.

## Carga y experiencia del analista

- Las réplicas web/API escalan según métricas de saturación, latencia y conexiones,
  no solo por CPU promedio. Los workers escalan según tasa de llegada, backlog,
  antigüedad del job y tiempo estimado de drenaje, con topes por proveedor y por
  clase de trabajo.
- La indexación usa lotes acotados, concurrencia limitada, IDs deterministas cuando
  existe una clave de origen estable, mappings versionados, alias de escritura y
  reconciliación de fallos parciales. Se priorizan alertas y ventanas recientes;
  trabajos de histórico y exports no bloquean la ingesta crítica.
- Consultas interactivas son paginadas y acotadas por tiempo, scope y tamaño.
  La interfaz carga listas primero y solicita detalle, timeline, eventos relacionados
  y raw solo cuando el analista los abre y tiene autorización. Lazy loading no omite
  controles de acceso ni filtros del servidor.
- Backpressure reduce o pausa trabajo de baja prioridad cuando almacenamiento,
  indexación o colas se acercan a sus límites. El sistema informa cobertura y atraso;
  no elimina señales silenciosamente ni adelanta checkpoints.

## Despliegues y continuidad

La API, web, workers y KrakenD se publican como artefactos inmutables. El rollout es
rolling o canary con readiness, drenaje de trabajos, capacidad N+1 cuando aplique,
compatibilidad de esquema hacia atrás, rollback y observación posterior. Migraciones
siguen expand-contract; no se combina un cambio incompatible de productor, consumidor,
índice y esquema en un solo paso. Una actualización de pollers evita duplicar leases y
retoma desde el último checkpoint durable.

Cuando falla una capa, la plataforma degrada la función afectada y conserva el resto:
si cae el Indexer se mantiene la admisión durable y se pausa/reconcilia indexación;
si cae Redis no se confirman jobs no durables y se reconstruye la cola desde PostgreSQL;
si cae una fuente se marca stale esa cobertura y otras fuentes siguen; si Shuffle cae,
la alerta y la investigación permanecen disponibles y las acciones quedan pendientes
o desconocidas según el punto de fallo. La recuperación debe demostrar replay,
reconciliación, drenaje y ausencia de efectos externos duplicados.

## Etapas de implementación sobre la base existente

1. **Consolidar la fuente de verdad:** verificar módulos, contratos, migraciones,
   tests y estado de los repositorios. Mantener el monolito modular API/Web/Worker y
   cerrar discrepancias documentales antes de expandir la topología.
2. **Cerrar la vertical MVP:** validar Microsoft 365 → Wazuh → QAPAQ en un tenant
   autorizado; medir admission, checkpoint, normalización, alertas y triaje. No usar
   eventos sintéticos como prueba de integración productiva.
3. **Preparar el borde:** aprobar DNS, TLS, WAF/controles perimetrales según ambiente,
   balanceador de acceso, health checks y réplicas de API/web. Validar logout, sesión,
   CSRF, RBAC, límites y drenaje.
4. **Habilitar KrakenD para integraciones:** mantenerlo en el límite de proveedores
   definido por ADR-026; desplegar el pool mínimo de nodos y balanceador interno,
   configuración inmutable, allowlist, identidad técnica, telemetría y fault tests.
5. **Robustecer polling y colas:** introducir ventanas escalonadas, leases, jitter,
   cuotas, backpressure y reconstrucción desde outbox/checkpoints. Medir Redis,
   persistencia y drenaje con interrupciones controladas.
6. **Escalar indexación:** validar el índice canónico QAPAQ y Wazuh Indexer como
   responsabilidades separadas; introducir bulk indexing, mappings/aliases,
   deduplicación y pruebas de reindexado/replay. Definir sizing por benchmark.
7. **Entregar Ayni Qapaq:** ampliar las capacidades de incidentes ya existentes
   (asignación, tareas, notas, timeline y auditoría), conectar cada investigación con
   alertas/evidencia por referencia y probar concurrencia y scopes.
8. **Integrar Shuffle:** implementar adapter, catálogo y estado de ejecución,
   approvals, autenticación de callbacks, reconciliación, revocación y dry-run antes
   de habilitar acciones productivas.
9. **Aprobar HOT/WARM/COLD:** Legal/Compliance/SBS/Internal Security ratifican
   finalidad, retención, residencia, custodia, holds y borrado. Probar archivo,
   restore selectivo, permisos y costos antes de automatizar transición o purga.
10. **Promover a producción:** pasar benchmark con margen acordado, restore y
    ejercicios de falla; revisar el plan de despliegue de IaC sobre un state y una
    cuenta reconciliados. Plan/Apply siguen gates del equipo responsable.

## Gates de aceptación

- capacidad medida para picos de entrada, búsquedas concurrentes, polling y replay;
- fallos de una réplica, nodo KrakenD, Redis, PostgreSQL, OpenSearch, fuente y Shuffle;
- no pérdida de eventos ya admitidos, cursor monotónico y replay sin duplicar acciones;
- aislamiento por rol/scope en búsquedas, Ayni, exportaciones y playbooks;
- retención/restauración aprobadas y evidencia de restore;
- alertas de cobertura, lag, oldest-job-age, index rejection, quota y circuit breaker;
- rollback probado para aplicación, configuración KrakenD, mapping y migración de datos.

Hasta que cada gate tenga evidencia, esta topología es **objetivo de diseño**, no
afirmación de alta disponibilidad productiva.

## Consecuencias

La arquitectura permite escalar API y procesamiento según demanda sin hacer que
Redis, KrakenD o OpenSearch sustituyan la autoridad de PostgreSQL y del almacén de
evidencia. Añade operación de balanceadores, cuotas, clusters, índices y archivo; por
ello cada réplica y tier necesita owner, métricas, pruebas, presupuesto y runbook.

## Referencias

[ADR-020 — continuidad](020-operations-and-continuity.md) ·
[ADR-026 — KrakenD](026-on-premises-krakend-provider-api-gateway.md) ·
[ADR-029 — producto](029-qapaq-secops-product-direction.md) ·
[Arquitectura completa](../architecture/qapaq-secops-resilient-architecture.md) ·
[C4 deployment](../diagrams/15-resilient-deployment.mmd).
