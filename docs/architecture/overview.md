# Arquitectura inicial de qapaq-secops

Estado: PROPOSAL · Fecha: 2026-09-17 · Fuente: [requerimientos](../requirements.md).

## ARCHITECTURE ASSESSMENT

### Hechos y supuestos

La solicitud prescribe un monolito modular SOC y su stack; el repositorio no
contiene una aplicación que permita inferir contratos existentes. El diseño no
representa infraestructura inventariada. ASSUMPTION: una organización operadora
inicial, sin SaaS multitenant; se debe confirmar si hay segregación por equipos,
filiales o unidades. No eliminar control por recurso aunque exista una sola entidad.

### Decisiones propuestas

Agrupar 24 responsabilidades en ocho módulos cohesivos y capacidades técnicas
transversales. Separar control/data plane por casos de uso, permisos, jobs y
presupuestos de recursos, no por una malla de servicios. Mantener PostgreSQL para
estado operacional, Wazuh/Indexer para telemetría y object storage para raw/archivo.
Usar BullMQ como ejecución recuperable, no como único registro de evidencia.

Proponer SecurityEvent propio, pequeño y versionado, con semántica inspirada en
ECS y un mapeo explícito evaluable hacia OCSF. No afirmar conformidad con ninguno.
Los [ADRs](../adr/README.md) distinguen requisitos prescritos de elecciones de diseño.

### Inconsistencias resueltas y trade-offs

- Las dos pipelines del adjunto invierten detección/correlación. Se adopta normalización → enriquecimiento → detección de candidatos → correlación → detección compuesta → alertas; reglas simples pueden emitir alertas directamente. Sin ciclos automáticos de alertas hacia la misma ingesta.
- Indexación ocurre en paralelo al análisis, con recuperación independiente. Que una alerta exista no garantiza que todos sus eventos ya sean buscables; la UI muestra cobertura/estado.
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

No crear un módulo, cola o port por cada sustantivo. Un único ownership de reglas;
un solo catálogo de permisos; un solo contrato de eventos. Evitar paquete shared
genérico, event sourcing global, CQRS framework obligatorio, bus distribuido,
service mesh, data lake de consulta interactiva y SOAR completo.

## PROPOSED ARCHITECTURE

React consume solo la API NestJS. Ocho módulos: access, assets, connectors,
telemetry, detection, soc, audit y workspace. La composición conecta adapters
con ports de aplicación. Dependencias de vendors viven fuera de dominio.
Health/observability, SecretProvider y colas son capacidades técnicas, no dominios
de negocio independientes.

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

1. Validar preguntas que bloquean identidad, permisos, retención y fuente piloto.
2. Crear base NestJS/React y gates de calidad en una tarea posterior.
3. Implementar acceso, autorización y auditoría; probar denegaciones y fallos.
4. Vertical pequeña: fuente piloto de lectura → raw durable → eventos normalizados → búsqueda/alerta → incidente.
5. Incorporar restauración histórica, fuentes adicionales y correlación según evidencia.
6. Evaluar Python y automatización controlada después de medir necesidades.

Cada etapa tiene condiciones de salida en [roadmap](../roadmap.md). La extracción
futura exige saturación medida o aislamiento necesario, contratos estables, dueño
operacional y beneficio superior al coste distribuido; no una fecha arbitraria.
