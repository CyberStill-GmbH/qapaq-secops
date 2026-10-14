# Roadmap de Qapaq SecOps

El roadmap lleva la base existente hacia la plataforma descrita en
[ADR-029](adr/029-qapaq-secops-product-direction.md) y
[ADR-030](adr/030-resilient-platform-architecture.md). Prioriza cerrar una
vertical real, endurecer su operación y ampliar capacidades con evidencia. No
asigna fechas o cargas de trabajo que aún no estén aprobadas.

## Base disponible en el repositorio

El workspace contiene entrypoints para API, worker y web, módulos para acceso,
conectores, telemetría, detección, SOC y SOAR/notificaciones, contratos comunes,
persistencia y observabilidad. La experiencia SOC ya contempla alertas, eventos,
fuentes, usuarios y una investigación de incidentes con tareas, bitácora y timeline.
Hay código y pruebas para partes del flujo de ingesta, normalización, admisión
durable y auditoría.

Esta base habilita la evolución; no prueba por sí sola permisos de un tenant real,
entrega de Microsoft 365, disponibilidad del Indexer, alta disponibilidad,
recuperación de producción ni ejecución de playbooks. El estado por capacidad se
consulta en el [mapa funcional](requirements/01-capability-map.md), el
[inventario de backend](frontend-design/01-inventario-backend.md) y la evidencia
del ambiente.

## Etapa 1 — Cerrar el MVP de monitoreo e investigación

**Resultado:** una alerta trazable desde una fuente autorizada hasta una decisión
SOC documentada.

1. Completar el recorrido Microsoft 365 → Wazuh → Qapaq SecOps con tenant, permisos,
   licencia, reglas, retención y acceso al Indexer verificados.
2. Demostrar autenticación institucional, roles, scopes, denegaciones y revocación
   en un ambiente de integración autorizado.
3. Confirmar admisión durable, raw/manifiesto, cursor/checkpoint, normalización,
   cuarentena y replay sin pérdida desde el último commit durable.
4. Validar el flujo de alerta, priorización, triaje, incidente, auditoría y
   notificación crítica con los permisos y límites definidos.
5. Registrar cobertura y frescura de fuente con estados `healthy`, `stale`,
   `partial` y `degraded`; una desconexión nunca aparece como ausencia de amenazas.

**Salida:** pruebas end-to-end con fuente real, evidencia con commit/configuración,
runbook, límites conocidos y gates de seguridad aceptados. Sin el acceso externo, el
resultado permanece `BLOCKED`; no se sustituye con una demo sintética.

## Etapa 2 — Resiliencia, balanceo y capacidad medida

**Resultado:** atender variación de tráfico y mantenimiento sin perder el trabajo
ya admitido.

1. Definir el balanceador de acceso, health/readiness y réplicas sin estado de la
   web y API Qapaq.
2. Habilitar el pool de KrakenD detrás de balanceador interno para integraciones y
   webhooks, con allowlist, TLS, identidades técnicas, cuotas y circuit breakers.
3. Escalonar polling por fuente con jitter, leases, concurrencia limitada, respeto
   de `Retry-After` y checkpoint durable; desplegar workers sin solapar una misma
   ventana.
4. Usar Redis/BullMQ para jobs pequeños y desacoplar adquisición, indexación,
   notificaciones y trabajos diferidos. Reconciliar pendientes desde PostgreSQL si
   la cola se reinicia.
5. Medir volumen, tamaño de evento, consultas concurrentes, errores parciales,
   drenaje y crecimiento del índice. Fijar sizing solo después del benchmark.
6. Publicar versiones inmutables con rolling/canary, esquema expand-contract,
   drenaje, rollback y observación de cobertura durante la actualización.

**Salida:** caída y reemplazo de cada réplica demostrados, capacidad con headroom
acordado, backlog recuperable y un plan de despliegue validado por Infraestructura.

## Etapa 3 — Ayni Qapaq, coordinación e historial SOC

**Resultado:** cada incidente atendido deja contexto reutilizable para el equipo.

1. Consolidar la experiencia Ayni en la consola Qapaq utilizando el modelo SOC ya
   existente de incidentes, tareas, notas, evidencia y timeline.
2. Relacionar alertas y eventos mediante referencias estables; evitar copias
   mutables de los objetos que pertenecen a Wazuh o a otras fuentes.
3. Completar asignación, colaboración, búsqueda contextual, escalamiento,
   resolución, cierre y preservación de antecedentes con trazabilidad de actor.
4. Probar concurrencia, cambios de permisos, notas append-only, separación por
   scope y revisión de casos históricos.

**Salida:** un analista puede abrir una investigación desde una alerta, compartir
el trabajo y dejar el expediente listo para revisión/auditoría sin perder
procedencia.

## Etapa 4 — Automatización SOAR no-code

**Resultado:** iniciar desde una alerta o investigación un playbook autorizado y
conocer su estado sin perder el control en Qapaq SecOps.

1. Integrar Shuffle por el worker/outbox de Qapaq; nunca revelar webhook o secreto
   en el navegador.
2. Mantener catálogo allowlist, versión, parámetros, target, capability, scope y
   aprobaciones en Qapaq.
3. Comenzar con dry-run; verificar autenticación de callback, anti-replay,
   idempotencia, timeout ambiguo, reconciliación, revocación y rollback.
4. Incorporar acciones financieras de bajo riesgo con owners y límites aprobados;
   requerir step-up o doble control para efectos altos/críticos.
5. Usar Active Response de Wazuh solo como mecanismo ejecutor permitido a través
   del adapter correspondiente; no delegar policy ni ledger al motor de ejecución.

**Salida:** el analista ve el estado del playbook desde el expediente, las
ejecuciones pueden auditarse y un resultado `UNKNOWN` se reconcilia antes de una
nueva acción.

## Etapa 5 — Búsqueda escalable y retención financiera

**Resultado:** consultar el histórico con coste, cobertura, custodia y latencia
visibles.

1. Separar la lectura read-only de Wazuh Indexer de los índices propios Qapaq.
2. Adoptar bulk indexing acotado, IDs estables, mappings versionados, aliases,
   partición/rollover medidos, control de rechazos y reindexación con rollback.
3. Implementar carga diferida en la consola: listas paginadas primero; detalle,
   timeline, evidencia raw e histórico frío bajo demanda, scope y permisos del
   servidor.
4. Definir HOT/WARM/COLD por dataset, finalidad, sensibilidad y uso operativo.
   Probar catálogo, restore selectivo, holds, backups, borrado consistente y
   costos de recuperación.
5. Legal, Compliance, SBS e Internal Security ratifican la interpretación,
   residencia, retención y custodia aplicables antes de activar TTL o purga
   automática. No inferir plazos regulatorios desde esta arquitectura.

**Salida:** resultados parciales se declaran como tales; el material archivado se
recupera con autorización y vencimiento; las políticas aprobadas son reproducibles
y auditables.

## Etapa 6 — Expansión XDR y aprendizaje operativo

**Resultado:** ampliar cobertura sin duplicar ingestión o reglas ni saturar fuentes.

Priorizar cada nueva fuente por riesgo, autorización, valor para SOC, acceso real,
cuota, soporte y coste de operación. Cada integración obtiene owner, dataset,
adapter, mapping, suite de conformidad, alerta de salud, retención y procedimiento
de replay antes de habilitarse.

Las lecciones de Ayni alimentan mejoras de detecciones, procedimientos y playbooks
mediante revisión aprobada, control de versión y medición de falsos positivos,
cobertura y efectividad. No se cambian automáticamente reglas ni respuestas en
producción sin decisión humana, pruebas y rollback.

## Orden de promoción a producción

Ninguna etapa pasa a producción solo por completar código o construir una imagen.
Antes se revisan CI, permisos, secretos, red, plan Terraform, estado remoto, cuotas,
logs, backups, restore, rollback, soporte, coste y owner. La arquitectura resiliente
describe los gates detallados; el [plan de continuidad](architecture/operations-and-continuity.md)
define el orden de recuperación.

Los calendarios y cierres de sprint se conservan en los
[registros históricos de proyecto](project-management/README.md). Este roadmap
expresa el orden vigente de producto, sin reescribir dichos registros.
