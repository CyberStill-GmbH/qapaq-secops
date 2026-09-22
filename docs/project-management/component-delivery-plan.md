# Plan de construcción por componentes — MVP

Estado: BASELINE DE EJECUCIÓN · Horizonte: 2026-09-19 a 2026-10-20. Este plan
convierte los PBI en componentes físicos, dependencias y evidencia verificable. No
afirma que las rutas existan: su estado inicial es PLANNED.

## Regla de planificación

Un componente entra al Sprint Backlog solo cuando tiene ruta, responsabilidad,
contratos de entrada/salida, dependencias, specs y evidencia de salida. Se entrega
verticalmente: código, configuración, migración, observabilidad y pruebas aplicables
forman una unidad. Crear una carpeta o interfaz sin comportamiento verificable no
cuenta como avance.

Los IDs `C-xx` son unidades de construcción, no servicios desplegables. Los módulos
permanecen dentro del monolito modular. Un PBI puede requerir varios componentes y
un componente puede servir a varios PBI.

## Sprint 1 — Base ejecutable y contratos

| ID | Componente y ruta principal | Responsabilidad | PBI | Depende de | Specs y evidencia de salida |
| --- | --- | --- | --- | --- | --- |
| C-01 | Raíz del workspace: `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `tsconfig*`, lint/format | Instalación, scripts y build reproducibles | 001 | Ninguna | Checkout limpio, install congelado, format, lint, typecheck y build PASS |
| C-02 | Entrypoints: `apps/api`, `apps/worker`, `apps/web` | Arranque mínimo, health y composition roots delgados | 001 | C-01, C-03 | Smoke real de cada proceso; API y worker sin imports entre apps |
| C-03 | `platform/configuration` | Validación tipada, profiles y contratos `SecretProvider` | 001, 003 | C-01 | Unit de schema; arranque falla seguro ante configuración ausente/inválida |
| C-04 | `platform/database` y adaptadores de connectors/telemetry | Prisma client, siete tablas de admisión y comando transaccional según ER C-04 | 003, 009, 019 | C-01, C-03, C-05 (contrato), C-06 (PostgreSQL aislado) | Migración real, rollback atómico, carreras, pertenencia, límites y ownership comprobados |
| C-05 | `packages/contracts/security-event` | JSON Schema, catálogos, tipos, validadores y corpus 1.0.0 | 004 | C-01 | Contract specs de corpus válido/inválido y versiones incompatibles |
| C-06 | `platform/testing` y definición de entorno de integración | Arranque/teardown de PostgreSQL, Redis, object storage, OpenSearch y Wazuh reales | 003 | C-01, C-03 | Health, aislamiento y limpieza PASS; versiones y commit registrados |
| C-07 | Reglas del workspace y fixtures de violación | Límites apps/modules/platform, capas y ciclos | 005 | C-01, C-02 | Regla acepta arquitectura válida y rechaza cada bypass preparado |
| C-08 | `modules/connectors` contrato operativo/probe Wazuh | Port `SecurityEventProvider`, health y consulta read-only mínima | 005, 006 | C-03, C-05, C-06 | Contract suite y consulta a Wazuh/Indexer real autorizado |
| C-09 | `.github/workflows` y ownership | Integrar PR #2, pnpm congelado, scans y evidencia sin secretos | 002 | C-01, C-06, C-07 | PR confiable/no confiable; checks requeridos y artifact redactado |

C-02 fue materializado el 2026-09-22: API Nest/Fastify, worker inactivo independiente,
shell React, lifecycle y health sin dependencias simuladas. La evidencia y los
límites ambientales se registran en [entrega C-02](../development/c-02-entrypoints.md).
La aceptación de detalles Proposed de ADR-001 no se modifica.

C-04 tiene [ER final de diseño](../architecture/c-04-admission-er.md), con
[resolución de auditoría](../architecture/c-04-mer-audit.md#resolución-documental-del-mer--2026-09-22).
No está implementado ni aceptado por tener documentación. Adelanta únicamente
persistencia de las siete entidades; C-11 conserva raw durable/orquestación y C-13
conserva claims, deduplicación de efectos, replay y reprocess. Se mantienen los
prerrequisitos de C-06; su suite PostgreSQL debe poder ejecutarse sin los demás
servicios. Los estados futuros se incorporarán con sus respectivas migraciones.

C-03 fue materializado el 2026-09-21 con perfiles explícitos, contratos tipados
para PostgreSQL, Redis, MinIO y Wazuh Indexer, puerto `SecretProvider`, resolución
única por arranque, redacción y fallo seguro. El provider productivo continúa como
dependencia de Infraestructura; el adapter de entorno está limitado a desarrollo y
test y rechaza producción.

Orden obligatorio: C-01 inicia; C-03/C-05 pueden avanzar en paralelo; C-06 habilita
C-04/C-08; C-02 y C-07 cierran la forma del workspace; C-09 se adapta a scripts
reales. No se copia CI documentalmente ni se crea otro workflow si PR #2 ya cubre
la capacidad.

## Sprint 2 — Ingesta durable Microsoft 365/Wazuh, dos días

| ID | Componente y ruta principal | Responsabilidad | PBI | Depende de | Specs y evidencia de salida |
| --- | --- | --- | --- | --- | --- |
| C-10 | `modules/connectors` adapter Wazuh | Registro de fuente, consulta paginada, errores y checkpoint input | 007, 008 | C-05, C-08 | Provider specs contra Microsoft 365/Wazuh e Indexer reales |
| C-11 | `modules/telemetry` admisión durable | Raw/ref/hash, manifiesto/outbox y avance de checkpoint | 009 | C-04, C-06, C-10 | Caída en cada frontera sin pérdida ni cursor adelantado |
| C-12 | `modules/telemetry` normalizador Wazuh | Mapping versionado hacia SecurityEvent y rechazo seguro | 010 | C-05, C-10, C-11 | Corpus autorizado, procedencia/severidad y schema PASS |
| C-13 | `modules/telemetry` resiliencia | Inbox, idempotencia, replay, quarantine y reprocess | 011 | C-11, C-12 | Reinicio, carrera, duplicado y poison event sin efecto duplicado |
| C-14 | `modules/telemetry` proyección y consulta | Indexación OpenSearch y query API tipada/autorizable | 012 | C-12, C-13 | OpenSearch real, caída/recovery, límites y raw oculto por defecto |
| C-15 | `platform/observability` y señales del pipeline | Métricas, logs, traces y health con cardinalidad acotada | 013 | C-10…C-14 | Cada estado healthy/degraded/failed provocado y observado |

Orden crítico: C-10 → C-11 → C-12 → C-13 → C-14. C-15 se añade durante cada
componente y se cierra al final; no se pospone toda la observabilidad a una tarea
aislada. PBI-007 permanece BLOCKED si falta el tenant o Wazuh autorizado, aunque la
infraestructura interna tenga specs reales.

El timebox 2026-10-05/06 presupone que C-01…C-09 y todos los accesos están listos.
El día 1 ejecuta C-10…C-12; el día 2, C-13…C-15 y la Review. Esta distribución es
un forecast intensivo, no permiso para paralelizar dependencias ni reducir la DoD.

## Sprint 3 — Operación SOC y evidencia

| ID | Componente y ruta principal | Responsabilidad | PBI | Depende de | Specs y evidencia de salida |
| --- | --- | --- | --- | --- | --- |
| C-16 | `modules/detection` | Priorización, reason codes y promoción idempotente | 014 | C-05, C-14 | Caso Wazuh promovido/no promovido y repetición sin duplicado |
| C-17 | `modules/soc` | Alert, triaje, incidente/caso y transiciones | 015 | C-16, C-18, C-19 | Unit de invariantes; integration de concurrencia; E2E permitido/denegado |
| C-18 | `modules/access` y BFF en `apps/api` | Entra, sesión, capabilities, scopes y autorización contextual | 016 | C-02, C-03, C-06 | OIDC real autorizado, revocación, recurso/campo permitido y denegado |
| C-19 | `platform/audit` y adapters de archivo | AuditEvent atómico, hash, consulta y reconciliación mínima | 019 | C-04, C-05 | Rollback, tamper/gap, cuenta sin update/delete y consulta redactada |
| C-20 | `modules/soar` y consumer en `apps/worker` | Outbox, entrega Teams, retry, fallback y acuse QAPAQ | 018 | C-02, C-04, C-17, C-19 | Teams Workflow real, timeout ambiguo y repetición sin mensaje duplicado |
| C-21 | `apps/web` | Consulta, detalle, triaje y estados degradados | 017 | C-14, C-17, C-18 | Playwright contra backend real; acceso/raw denegados por API |
| C-22 | `platform/testing/e2e`, performance y release evidence | Vertical, fallos, recovery, benchmark, SBOM y decisión | 020, 021 | C-10…C-21 | Matriz PASS/FAIL/BLOCKED ligada a commit y ambiente |
| C-23 | Reglas, suite de conformidad y guía de proveedor | Probar extensión sin implementar un proveedor ficticio | 022 | C-07, C-08, C-10 | Análisis de acoplamiento y conformidad del adapter Wazuh real |

C-18 y C-19 empiezan al inicio del Sprint porque son dependencias de seguridad, no
pulido final. C-16 alimenta C-17; C-17/C-19 habilitan C-20; C-21 es P1 y no desplaza
C-22. La evidencia C-22 se acumula desde el primer PR y termina con la vertical.

## Contratos entre componentes

| Productor | Contrato | Consumidor | Regla |
| --- | --- | --- | --- |
| C-10 | Documento Wazuh validado + cursor/coverage | C-11/C-12 | Tipos Wazuh permanecen en infraestructura |
| C-11 | RawRef + manifest/checkpoint | C-12/C-13 | Raw durable primero; checkpoint y admisión se confirman en una sola TX |
| C-12 | `qapaq.security-event/1.0.0` | C-14/C-16 | Schema es fuente normativa; raw queda separado |
| C-16 | DetectionCandidate con reason/version | C-17 | Repetición conserva idempotencia |
| C-17 | Alert/Incident + evento de dominio | C-19/C-20/C-21 | Ningún consumidor escribe tablas internas de SOC |
| C-18 | Actor, capability y scope evaluados | API/casos de uso | La UI no sustituye autorización backend |
| C-19 | AuditEvent append-only | Consulta/archivo | Observabilidad no sustituye auditoría |
| C-20 | NotificationAttempt/status | C-17/C-21 | `SENT` no significa acuse humano |

## Corte por capacidad y trabajo paralelo

No se asume que un Developer trainee pueda completar C-01…C-23 dentro del timebox.
En cada Planning se seleccionan componentes completos siguiendo la ruta crítica y
la capacidad declarada. El orden de protección es:

1. contrato y admisión segura: C-01, C-03…C-08, C-10…C-14;
2. flujo SOC seguro: C-16…C-20;
3. evidencia de candidato: C-22;
4. observabilidad completa, UI y extensibilidad: C-15, C-21, C-23 según forecast.

C-02 y C-05, o C-18 y C-19, admiten trabajo paralelo solo si existe otra persona
con ownership explícito. Franco puede cerrar decisiones, accesos y aceptación, pero
no se contabiliza como capacidad de implementación salvo acuerdo en Planning.

Un componente incompleto vuelve al Product Backlog. No se parte su Definition of
Done para conservar la fecha. Si la ruta crítica no cabe, la Review emite `LIMITED`
o `NOT READY` conforme al Sprint 3.

## Plantilla de task técnico

Cada sub-issue de implementación debe declarar:

- componente `C-xx` y PBI;
- ruta y owner;
- comportamiento observable;
- contrato de entrada/salida y versión;
- datos, migración y rollback aplicables;
- dependencias y accesos;
- unit/contract/integration/provider/E2E specs aplicables;
- fallos y controles de seguridad;
- evidencia enlazada a commit/PR/ambiente.

[Product Backlog](product-backlog.md) ·
[Definition of Done](definition-of-done.md) ·
[Auditoría estructural](../architecture/repository-structure-audit.md)
