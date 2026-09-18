# Arquitectura inicial de qapaq-secops

Alcance operacional ACCEPTED por [ADR-015](../adr/015-operational-scope-and-ownership.md),
fecha de decisión aportada 2026-09-18. Realización técnica restante PROPOSAL.
Fuente: [requerimientos](../requirements.md).

## ARCHITECTURE ASSESSMENT

### Hechos y supuestos

La solicitud prescribe un monolito modular SOC y su stack; el repositorio no
contiene una aplicación que permita inferir contratos existentes. El diseño no
representa infraestructura inventariada. ASSUMPTION: una organización operadora
inicial, sin SaaS multitenant; se debe confirmar si hay segregación por equipos,
filiales o unidades. No eliminar control por recurso aunque exista una sola entidad.

### Base aceptada y decisiones técnicas propuestas

U-001 acepta ocho módulos para SOC, respuesta e inteligencia antifraude, con
ownership y vocabulario canónicos. Auditoría y observabilidad son capacidades
transversales, no módulos de negocio. Separar control/data plane por casos de uso, permisos, jobs y
presupuestos de recursos, no por una malla de servicios. Mantener PostgreSQL para
estado operacional, Wazuh/Indexer para telemetría y object storage para raw/archivo.
Usar BullMQ como ejecución recuperable, no como único registro de evidencia.

Proponer SecurityEvent propio, pequeño y versionado, con semántica inspirada en
ECS y un mapeo explícito evaluable hacia OCSF. No afirmar conformidad con ninguno.
Los [ADRs](../adr/README.md) distinguen requisitos prescritos de elecciones de diseño.

### Inconsistencias resueltas y trade-offs

- U-001 fija el lifecycle normalización → enriquecimiento → Detection → Alert Candidate → Alert → Incident or Case → Response → Resolution → Closure. Detección/correlación producen resultados; promoción de candidatos aplica enrichment/deduplicación. No todo resultado llega a alerta o incidente ni se realimenta automáticamente como evento nuevo.
- La primera vertical aceptada indexa en OpenSearch antes de correlación determinista. Si el índice no está disponible, ese análisis espera mientras se preserva ingesta durable. Paralelismo posterior entre indexación/análisis es una opción técnica a decidir, no comportamiento inicial aprobado.
- Preservar raw no significa exponerlo dentro de toda respuesta ni conservarlo para siempre. Se conserva evidencia original restringida durante la retención aprobada; derivados pueden estar redactados.
- Consultar hot/warm/cold mediante un contrato común no significa igual latencia. Cold puede requerir un job de restauración y resultados parciales explícitos.
- Wazuh Indexer y OpenSearch no implican dos clusters obligatorios. Se evalúa reutilización compatible antes de agregar otro motor.
- Monolito no equivale a un único proceso Node. Un worker del mismo release puede aislar jobs; Python será opcional y subordinado a contratos, sin servicio autónomo inicial.
- Auditoría al final de una request no asegura atomicidad. Las mutaciones críticas requieren registro local durable en la misma transacción antes de confirmar éxito.

### Riesgos y preguntas

Prioritarios: pérdida de telemetría por ACK prematuro; abuso de permisos/exports;
manipulación de auditoría; saturación compartida; pérdida de raw por retención
inadecuada; incompatibilidad con APIs/ediciones reales. No se conocen volumen,
licencias, identidad corporativa, retención aprobada, RPO/RTO ni capacidad del equipo.
Cada riesgo tiene tratamiento en [riesgos](risks.md) y [preguntas](../decisions/unresolved.md).

### Simplificaciones

Respetar los ocho módulos aceptados sin crear una cola o port por cada sustantivo.
Reglas SOC y antifraude conservan sus propietarios explícitos;
un solo catálogo de permisos; un solo contrato de eventos. Evitar paquete shared
genérico, event sourcing global, CQRS framework obligatorio, bus distribuido,
service mesh, data lake de consulta interactiva y SOAR completo.

## PROPOSED ARCHITECTURE

React consume solo la API NestJS. Ocho módulos aceptados: Identity, Access &
Policy; Integrations & Collectors; Telemetry Ingestion & Processing; Detection &
Correlation; Threat Intelligence; Alerts, Incidents & Cases; SOAR, Playbooks &
Ticketing; Antifraud Intelligence. La composición conecta adapters con ports.
Auditoría, health/observability, secretos y configuración son capacidades
transversales, no dominios de negocio independientes.

El control plane gestiona acceso, configuraciones, reglas, casos y auditoría. El
data plane ingiere, normaliza, enriquece, detecta e indexa. PostgreSQL registra estado
y metadatos de trabajos/lotes, nunca un row de control por cada evento de alta tasa
sin justificar capacidad. Los blobs originales y sus manifiestos permiten replay.

Usar llamadas de aplicación para decisiones inmediatas; outbox/inbox para efectos
diferidos que requieran recuperación. Un evento interno no crea una promesa
exactly-once. Los consumidores y efectos deben ser idempotentes.

El [contexto](system-context.md), [módulos](modules.md), [flujos](data-flow.md) y
[diagramas](../diagrams/README.md) detallan contratos y ownership.

## REPOSITORY STRUCTURE

Monorepo propuesto con apps/api y apps/web primero; apps/analytics-worker solo
cuando una carga Python esté justificada. packages/contracts se limita a contratos
de frontera; paquetes de seguridad/observabilidad se extraen cuando exista uso
compartido real. [Árbol y convenciones](repository-structure.md).

Esta tarea crea documentación, no esas carpetas ni interfaces ejecutables.

## IMPLEMENTATION PLAN

1. Resolver detalles técnicos de identidad, permisos, retención y Wazuh/Windows; U-001 ya está aceptada y no depende de un piloto.
2. Crear base NestJS/React y gates de calidad en una tarea posterior.
3. Implementar acceso, autorización y auditoría; probar denegaciones y fallos.
4. Primera vertical: autenticación Windows vía Wazuh → ingesta → normalización → OpenSearch → correlación determinista → alerta → triaje → incidente → auditoría.
5. Continuar con MISP, nuevas fuentes, playbooks dry-run y respuestas aprobadas.
6. Incorporar ticketing/notificaciones, antifraude y análisis Python en ese orden; los detalles técnicos se validan sin reducir el alcance aceptado.

Cada etapa tiene condiciones de salida en [roadmap](../roadmap.md). La extracción
futura exige saturación medida o aislamiento necesario, contratos estables, dueño
operacional y beneficio superior al coste distribuido; no una fecha arbitraria.
