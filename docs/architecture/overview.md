# Arquitectura inicial de qapaq-secops

Alcance operacional ACCEPTED por [ADR-015](../adr/015-operational-scope-and-ownership.md)
y baseline técnica ACCEPTED por
[ADR-016](../adr/016-toolchain-and-capacity-baseline.md). Identidad/autorización
ACCEPTED por [ADR-017](../adr/017-identity-and-authorization.md). Retención,
privacidad y custodia CONDITIONALLY ACCEPTED por
[ADR-018](../adr/018-retention-privacy-custody.md), con fecha de decisión aportada
2026-09-18. Implementación pendiente. Fuente:
[requerimientos](../requirements.md).

## ARCHITECTURE ASSESSMENT

### Hechos y supuestos

La solicitud prescribe un monolito modular SOC y su stack; el repositorio no
contiene una aplicación que permita inferir contratos existentes. El diseño no
representa infraestructura inventariada. ADR-017 acepta una organización QAPAQ,
sin SaaS multitenant; equipos, filiales y unidades se expresan como scopes. No
eliminar control por recurso aunque exista una sola organización.

### Base aceptada y decisiones técnicas propuestas

U-001 acepta ocho módulos para SOC, respuesta e inteligencia antifraude, con
ownership y vocabulario canónicos. Auditoría y observabilidad son capacidades
transversales, no módulos de negocio. Separar control/data plane por casos de uso, permisos, jobs y
presupuestos de recursos, no por una malla de servicios. Mantener PostgreSQL para
estado operacional, OpenSearch/Indexer autorizado para búsqueda y object storage
para raw/archivo; Wazuh es una fuente y puede aportar su Indexer.
Usar BullMQ como ejecución recuperable, no como único registro de evidencia.

U-002 acepta el [toolchain, límites y método de capacidad](toolchain-and-capacity.md):
Node/NestJS/Fastify para API, React/Vite para web, PostgreSQL/Prisma para estado,
Redis/BullMQ para jobs y Python/uv para analítica justificada. Los perfiles de carga
son escenarios de medición; ninguna cifra de EPS está aceptada todavía.

U-003 acepta Entra ID single-tenant, BFF con sesión opaca, RBAC con scopes y
privilegios JIT con separación de funciones. La decisión permite diseñar; el gate
de federación/autorización bloquea habilitar endpoints productivos.

U-004 acepta una baseline provisional por dataset, tiers HOT/COLD/EVIDENCE,
privacidad desde ingesta, holds, custodia, backups y purga verificable. Legal y
Compliance deben ratificar la matriz antes del borrado automático productivo.

U-005 acepta QAPAQ SecOps como plataforma SOC central. Wazuh, Microsoft, Sophos y
Cato son fuentes/adapters independientes; la ingesta productiva queda bloqueada
hasta inventario y pilotos Wazuh/Microsoft autorizados.

U-009 acepta objetivos provisionales de continuidad, clases C1…C4, modos
degradados, recovery, error budgets y soporte. El software puede operar 24x7; sin
guardia SEV1 formal, el servicio humano se declara `LIMITED PRODUCTION / 8x5`.

Proponer SecurityEvent propio, pequeño y versionado, con semántica inspirada en
ECS y un mapeo explícito evaluable hacia OCSF. No afirmar conformidad con ninguno.
Los [ADRs](../adr/README.md) distinguen requisitos prescritos de elecciones de diseño.

### Inconsistencias resueltas y trade-offs

- U-001 fija el lifecycle normalización → enriquecimiento → Detection → Alert Candidate → Alert → Incident or Case → Response → Resolution → Closure. Detección/correlación producen resultados; promoción de candidatos aplica enrichment/deduplicación. No todo resultado llega a alerta o incidente ni se realimenta automáticamente como evento nuevo.
- La primera vertical aceptada indexa en OpenSearch antes de correlación determinista. Si el índice no está disponible, ese análisis espera mientras se preserva ingesta durable. Paralelismo posterior entre indexación/análisis es una opción técnica a decidir, no comportamiento inicial aprobado.
- Preservar raw no significa exponerlo dentro de toda respuesta ni conservarlo para siempre. Se conserva evidencia original restringida durante la retención aprobada; derivados pueden estar redactados.
- Consultar hot/warm/cold mediante un contrato común no significa igual latencia. Cold puede requerir un job de restauración y resultados parciales explícitos.
- Wazuh no es la frontera obligatoria para Microsoft, Sophos o Cato. Si un dataset llega directo y por Wazuh, se define una ruta canónica o relación causal.
- Wazuh Indexer y OpenSearch no implican dos clusters obligatorios. Se evalúa reutilización compatible antes de agregar otro motor.
- Monolito no equivale a un único proceso Node. Un worker del mismo release puede aislar jobs; Python será opcional y subordinado a contratos, sin servicio autónomo inicial.
- Auditoría al final de una request no asegura atomicidad. Las mutaciones críticas requieren registro local durable en la misma transacción antes de confirmar éxito.

### Riesgos y preguntas

Prioritarios: pérdida de telemetría por ACK prematuro; abuso de permisos/exports;
manipulación de auditoría; saturación compartida; pérdida de raw por retención
inadecuada; incompatibilidad con APIs/ediciones reales. No se conocen volumen,
licencias/configuración de Entra, matriz ratificada, RPO/RTO demostrados ni capacidad del equipo.
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

Monorepo pnpm aceptado con `apps/api`, `apps/worker`, `apps/web` y
`apps/analytics`; esta última solo ejecutará analítica Python justificada.
`packages/contracts`, `database`, `observability`, `configuration` y `testing`
mantienen límites explícitos. [Árbol y convenciones](repository-structure.md).

Esta tarea crea documentación, no esas carpetas ni interfaces ejecutables.

## IMPLEMENTATION PLAN

1. Completar gates de identidad, retención, fuentes y continuidad; U-001…005/U-009 ya tienen decisión documental.
2. Materializar el monorepo, lockfiles, baseline NestJS/React/Python y gates de calidad en una tarea posterior.
3. Implementar acceso, autorización y auditoría; probar denegaciones y fallos.
4. Primera vertical: autenticación Windows vía Wazuh → ingesta → normalización → OpenSearch → correlación determinista → alerta → triaje → incidente → auditoría.
5. Ejecutar Pilot B Microsoft; después incorporar Sophos, Cato, MISP y playbooks dry-run.
6. Incorporar ticketing/notificaciones, antifraude y análisis Python en ese orden; los detalles técnicos se validan sin reducir el alcance aceptado.

Cada etapa tiene condiciones de salida en [roadmap](../roadmap.md). La extracción
futura exige saturación medida o aislamiento necesario, contratos estables, dueño
operacional y beneficio superior al coste distribuido; no una fecha arbitraria.
