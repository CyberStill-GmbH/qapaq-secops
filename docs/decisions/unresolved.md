# Preguntas y decisiones pendientes

Registro actualizado con U-001…U-007 y U-009…U-012 resueltas total o parcialmente mediante ADR
aceptados o aceptados condicionalmente, con fecha aportada 2026-09-18. Los gates
productivos y valores de configuración pendientes no se presentan como software
desplegado. Las demás preguntas conservan responsables y criterio de cierre.

## U-001 — Límites y aceptación operacional

**Status:** ACCEPTED
**Decision owners:** SOC, Arquitectura y Security Engineering
**Decision date:** 2026-09-18

### Decision

Se aprueba la estructura funcional inicial de QAPAQ SecOps como una plataforma
integral para operaciones SOC, respuesta a incidentes e inteligencia antifraude.

La plataforma se desarrollará como un monolito modular, con NestJS como backend
principal y Python limitado a procesamiento analítico y correlación especializada.

La implementación será incremental, pero los límites de módulos, contratos,
vocabulario y reglas de ownership definidos en esta decisión representan la
arquitectura objetivo del sistema, no un piloto temporal.

### Operational scope

QAPAQ SecOps será responsable de:

- administración de usuarios, roles, permisos y políticas;
- configuración y administración de integraciones;
- gestión lógica de collectors y fuentes de telemetría;
- recepción, validación y normalización de eventos;
- enriquecimiento de eventos y alertas;
- búsqueda e investigación de telemetría;
- reglas de detección y correlación;
- integración de inteligencia de amenazas;
- gestión de alertas;
- gestión de incidentes y casos;
- orquestación y respuesta mediante playbooks;
- automatización de tickets y notificaciones;
- auditoría de acciones administrativas y operacionales;
- dashboards y visualización;
- inteligencia y gestión antifraude.

### Out of scope

QAPAQ SecOps no será responsable de:

- aprovisionamiento de infraestructura física o virtual;
- administración de servidores corporativos;
- administración de redes empresariales;
- aprovisionamiento de Azure, AWS u otros proveedores;
- Terraform o infraestructura como código;
- Kubernetes o la plataforma de ejecución productiva;
- operación física de Active Directory, firewalls, endpoints o Wazuh;
- definición unilateral de políticas regulatorias o periodos de retención.

Estas responsabilidades pertenecen al área de Infraestructura o al área
corporativa correspondiente.

El equipo de desarrollo entregará una aplicación ejecutable localmente,
contenedores y contratos de despliegue. Infraestructura decidirá y administrará
el entorno productivo.

### Approved modules

Se aprueban los siguientes ocho módulos funcionales:

#### 1. Identity, Access & Policy

Responsable de:

- usuarios;
- identidades de servicio;
- autenticación;
- sesiones;
- roles;
- permisos;
- RBAC;
- políticas contextuales;
- autorización por endpoint.

Toda API protegida debe declarar una política explícita.

#### 2. Integrations & Collectors

Responsable de:

- registro y configuración de integraciones;
- referencias a credenciales;
- gestión lógica de collectors;
- estado y salud de las fuentes;
- sincronización con sistemas externos;
- adaptadores para Wazuh, Active Directory, Microsoft Graph, Microsoft 365,
  VPN, Sophos, firewalls, IDS/IPS y otras fuentes.

El módulo administra las integraciones desde la aplicación, pero no administra
la infraestructura donde se ejecutan.

#### 3. Telemetry Ingestion & Processing

Responsable de:

- ingreso de eventos;
- validación;
- esquema canónico;
- normalización;
- deduplicación;
- enriquecimiento;
- timestamps y trazabilidad;
- reintentos;
- backpressure;
- dead-letter o cuarentena;
- envío hacia almacenamiento y detección.

#### 4. Detection & Correlation

Responsable de:

- reglas de detección;
- reglas de correlación;
- ventanas temporales;
- secuencias;
- thresholds;
- coincidencia con IOC;
- severidad y confianza;
- MITRE ATT&CK;
- versionado y pruebas de reglas;
- integración con análisis especializado en Python.

NestJS mantiene el control del dominio. Python devuelve resultados analíticos
mediante contratos versionados y no modifica directamente el estado de la
aplicación.

#### 5. Threat Intelligence

Responsable de:

- integración con MISP;
- sincronización de indicadores;
- normalización de IOC;
- procedencia;
- confianza;
- vigencia y expiración;
- enriquecimiento de eventos y alertas.

Una coincidencia con un IOC constituye evidencia, no una confirmación
automática de compromiso.

#### 6. Alerts, Incidents & Cases

Responsable de:

- creación y deduplicación de alertas;
- triaje;
- investigación;
- evidencia;
- timelines;
- entidades relacionadas;
- incidentes;
- casos;
- notas;
- tareas;
- relación entre eventos, alertas e incidentes;
- cierre y clasificación.

#### 7. SOAR, Playbooks & Ticketing

Responsable de:

- definición y versionado de playbooks;
- ejecución de tareas;
- aprobaciones;
- acciones automatizadas;
- respuestas sobre sistemas integrados;
- compensación cuando sea posible;
- creación y sincronización de tickets;
- notificaciones;
- trazabilidad completa de ejecuciones.

Las acciones destructivas o de alto impacto requieren permisos específicos y
aprobación explícita.

#### 8. Antifraud Intelligence

Responsable de:

- eventos y señales antifraude;
- reglas de velocidad;
- anomalías de autenticación;
- account takeover;
- cambios de dispositivo;
- reputación de IP;
- patrones transaccionales;
- scoring explicable;
- alertas y casos antifraude.

Antifraud utilizará capacidades compartidas de ingesta, correlación,
enriquecimiento y gestión de casos, pero mantendrá reglas, permisos, entidades
y vocabulario propios.

### Cross-cutting capabilities

Las siguientes capacidades son transversales y no forman módulos de negocio
independientes:

- auditoría;
- observabilidad;
- logging estructurado;
- métricas;
- tracing;
- gestión de errores;
- validación;
- configuración;
- manejo de secretos;
- documentación de APIs;
- seguridad de aplicación.

Cada módulo debe producir los eventos de auditoría y observabilidad que le
correspondan.

### Data ownership

Cada módulo es propietario de su estado y de sus interfaces de acceso.

Está prohibido:

- consultar directamente repositorios internos de otro módulo;
- modificar tablas pertenecientes a otro módulo;
- compartir entidades ORM como contratos;
- colocar reglas de negocio en controllers;
- permitir que Python modifique directamente tablas de PostgreSQL;
- utilizar OpenSearch como fuente de verdad transaccional.

Los módulos se comunican mediante:

- interfaces públicas de aplicación;
- comandos y consultas explícitos;
- eventos internos cuando exista una razón concreta;
- contratos versionados.

### Operational ownership

| Área | Responsabilidad |
| --- | --- |
| Security Engineering | Implementación, contratos, pruebas y mantenimiento de la plataforma |
| SOC | Reglas de detección, triaje, severidad, workflows e incident response |
| Arquitectura | Límites de módulos, dependencias y decisiones estructurales |
| Infraestructura | Entornos, redes, servidores, disponibilidad y despliegue productivo |
| Riesgos/Antifraude | Reglas, criterios, casos y decisiones del dominio antifraude |
| Auditoría/Compliance | Requisitos de conservación, evidencia, acceso y trazabilidad |

### Canonical operational vocabulary

Se aprueba el siguiente vocabulario:

- **Raw Event:** evento recibido sin normalizar.
- **Normalized Event:** evento validado y adaptado al esquema canónico.
- **Detection:** resultado producido por una regla.
- **Alert Candidate:** detección pendiente de enriquecimiento y deduplicación.
- **Alert:** señal accionable disponible para triaje.
- **Incident:** investigación formal de uno o más eventos o alertas.
- **Case:** contenedor de investigación SOC o antifraude.
- **Evidence:** información trazable que sustenta una investigación.
- **Indicator:** observable procedente de inteligencia de amenazas.
- **Playbook:** definición versionada de una respuesta.
- **Playbook Execution:** ejecución auditable de una versión de playbook.
- **Ticket:** unidad de trabajo interna o sincronizada con un ITSM.

### Canonical processing lifecycle

```text
Raw Event
    -> Validated Event
    -> Normalized Event
    -> Enriched Event
    -> Detection
    -> Alert Candidate
    -> Alert
    -> Incident or Case
    -> Response
    -> Resolution
    -> Closure
```

No todas las detecciones deben convertirse en alertas y no todas las alertas
deben convertirse en incidentes.

### Alert lifecycle

```text
NEW
    -> ENRICHING
    -> TRIAGE
    -> INVESTIGATING
    -> CONFIRMED | FALSE_POSITIVE
    -> CLOSED
```

### Incident lifecycle

```text
OPEN
    -> INVESTIGATING
    -> CONTAINMENT
    -> ERADICATION
    -> RECOVERY
    -> RESOLVED
    -> CLOSED
```

Las transiciones deben:

* estar definidas explícitamente;
* ser validadas por el dominio;
* requerir autorización;
* producir auditoría;
* preservar actor, timestamp y motivo;
* impedir transiciones inválidas.

Antifraud puede definir un lifecycle especializado dentro de su bounded context.

### Implementation order

La primera vertical fue revisada por [ADR-024](../adr/024-microsoft-365-wazuh-mvp-vertical.md)
y será:

```text
Microsoft 365 authorized activity
    -> Wazuh Office 365 integration
    -> Wazuh rules and alert
    -> QAPAQ read-only adapter
    -> SecurityEvent normalization
    -> prioritization
    -> alert
    -> triage
    -> incident
    -> audit and critical notification
```

Esta vertical solo determina el orden inicial de construcción. No reduce ni
redefine el alcance completo de QAPAQ SecOps.

Las siguientes verticales incorporarán progresivamente:

1. enriquecimiento con MISP;
2. nuevas fuentes e integraciones;
3. playbooks en modo dry-run;
4. respuestas con aprobación;
5. ticketing y notificaciones;
6. capacidades antifraude;
7. análisis especializado en Python.

### Acceptance conditions

Esta decisión se considera resuelta porque:

* el alcance funcional de la plataforma está definido;
* los límites con Infraestructura están definidos;
* los ocho módulos tienen responsabilidades explícitas;
* el ownership organizacional está asignado;
* existe un vocabulario operacional común;
* los lifecycles principales están definidos;
* se estableció la propiedad de datos;
* se definieron los mecanismos permitidos entre módulos;
* la primera vertical tiene un orden de implementación;
* las decisiones técnicas todavía abiertas serán resueltas mediante ADRs
  independientes.

### Consequences

* La arquitectura completa puede documentarse desde este momento.
* Los módulos pueden diseñarse sin esperar la implementación de la primera
  vertical.
* La construcción continuará incrementalmente mediante vertical slices.
* Un módulo no puede asumir responsabilidades asignadas a otro.
* Los cambios de ownership o límites requerirán actualizar esta decisión o
  registrar un ADR que la sustituya.
* Las decisiones sobre transporte, Wazuh/OpenSearch, esquema canónico,
  retención y comunicación con Python continúan en sus ADRs correspondientes.

Evidencia de aceptación: instrucción explícita del usuario y texto de resolución
aportado en esta tarea. Se conserva la fecha de decisión indicada por el usuario.
Registro arquitectónico: [ADR-015](../adr/015-operational-scope-and-ownership.md).

## U-002 — Versiones, tooling y capacidad

**Status:** ACCEPTED

**Decision owners:** Development + Platform

**Decision date:** 2026-09-18, fecha aportada por el usuario

### Decision

Se acepta una baseline reproducible para desarrollo, pruebas y benchmarking:
Node.js 24.21.0 LTS, TypeScript 6.0.3, NestJS 12.x con Fastify 5.12.1,
React 19.3.0 con Vite 8.3.0, Python 3.14.7, PostgreSQL 18.6, Redis 8.10.1,
BullMQ 5.81.5, Prisma ORM 7.10.0, OpenSearch 3.7.x, pnpm 12.4.2 y uv 0.12.15.

Se aceptan pnpm workspaces, ESM para el nuevo backend NestJS, Prisma restringido
a infrastructure/persistence, toolchain de calidad, límites iniciales de HTTP,
ingesta, consultas, pools y concurrencia, política at-least-once con consumidores
idempotentes, entornos locales de referencia y metodología/gates de benchmark.

La decisión completa, límites y evidencia se encuentran en
[ADR-016](../adr/016-toolchain-and-capacity-baseline.md) y
[toolchain y capacidad](../architecture/toolchain-and-capacity.md).

### Capacity status

La capacidad numérica continúa **PENDING MEASUREMENT**. Los perfiles L1/L2/L3 son
escenarios de benchmark, no capacidad soportada. Solo podrá publicarse el mayor
perfil que supere todos los gates en hardware/configuración registrados y conserve
al menos 30% de margen respecto al punto de saturación observado.

Los resultados se registrarán en `docs/performance/baseline-YYYY-MM-DD.md` con
EPS sostenido/burst, tamaños, duración, reglas, volumen, concurrencia, hardware,
configuración, versiones, commit y fecha. Una cifra sin ese contexto no es válida.

### Closure

U-002 queda resuelta respecto a runtimes, frameworks, ORM, workspace, tooling,
version pinning, límites, paginación, batches, conexiones, concurrencia inicial,
resiliencia, benchmark y regla de publicación. Fallar un benchmark no reabre la
decisión: identifica el cuello de botella o reduce el perfil oficialmente soportado.

Evidencia de aceptación: instrucción explícita del usuario y texto de resolución
aportado en esta tarea. La aceptación documental no demuestra instalación,
compatibilidad end-to-end ni capacidad productiva.

## U-003 — Identidad y autorización

**Decision status:** ACCEPTED

**Operational status:** BLOCKED UNTIL FEDERATION TESTS PASS

**Decision owners:** Security + SOC + Identity

**Decision date:** 2026-09-18, fecha aportada por el usuario

### Decision

QAPAQ SecOps será una aplicación interna single-tenant federada con Microsoft
Entra ID como único IdP humano ordinario. Filiales, agencias, unidades, áreas y
equipos serán scopes, no tenants. La identidad estable será `tid + oid`.

Se adopta OIDC Authorization Code con PKCE S256 y BFF NestJS con sesiones opacas
server-side. React no recibe ni almacena tokens de Entra. MFA será obligatorio en
producción; privilegios críticos requieren autenticación resistente a phishing,
JIT, step-up, justificación, vigencia, separación de funciones y doble aprobación.

QAPAQ SecOps administra RBAC con capabilities, scopes y políticas por recurso y
contexto, deny-by-default. Roles son bundles sin privilegio universal. Raw,
exports, administración de acceso, publicación de reglas y SOAR crítico tienen
capabilities separadas. Las identidades de servicio no usan roles humanos.

La decisión completa, valores iniciales, roles, autoridad, revocación y pruebas
se encuentran en [ADR-017](../adr/017-identity-and-authorization.md) y
[identidad y autorización](../architecture/identity-and-authorization.md).
ADR-025 la endurece con una sesión humana, red QAPAQ obligatoria, passkey Entra y
protección de intentos; no crea un `SUPERADMIN`.

### Operational gate

La decisión cierra U-003 sin afirmar que la federación funciona. Los endpoints
productivos permanecen bloqueados hasta que Identity, Security y SOC validen
tenant/app registration, redirects, credenciales, grupo de admisión, Conditional
Access, MFA/authentication strength, matriz/scopes, Graph sync, revocación,
step-up, break-glass y los 35 escenarios mínimos vigentes por ADR-025.

Evidencia de aceptación: instrucción explícita del usuario y texto de resolución
aportado en esta tarea. El diseño y specs puras pueden continuar; federación solo
se prueba contra Entra autorizado, sin mocks como evidencia.

## U-004 — retención, privacidad y custodia

**Decision status:** CONDITIONALLY ACCEPTED

**Automatic deletion status:** BLOCKED UNTIL RETENTION SCHEDULE IS APPROVED

**Decision owners:** Legal, Compliance, Security, SOC e Infraestructura

**Decision date:** 2026-09-18, fecha aportada por el usuario

QAPAQ SecOps adopta retención diferenciada por dataset, clasificación, finalidad,
trigger y autoridad. Se aceptan como baseline técnica provisional la clasificación,
los plazos, tiers HOT/COLD/EVIDENCE, privacidad en ingesta, holds, custodia, WORM,
backups, restore, purge receipts, deletion ledger, exports y gobierno de residencia
descritos en [ADR-018](../adr/018-retention-privacy-custody.md) y la
[política canónica](../architecture/retention-privacy-custody.md).

No existe un plazo universal atribuido a la SBS. Legal y Compliance deben ratificar
o reemplazar cada fila mediante matriz normativa trazable. Hasta aprobar inventario,
periodos/triggers, regiones, backups, holds, sanitización y custodia, y superar las
20 pruebas de aceptación, la eliminación automática productiva permanece bloqueada.
Solo se permite lifecycle sintético y purga productiva manual, aprobada y auditada.

U-004 queda resuelta en diseño; el gate operacional no se interpreta como decisión
pendiente ni como evidencia de capacidades implementadas.

## U-005 — fuentes piloto e inventario real

**Decision status:** CONDITIONALLY ACCEPTED

**Production ingestion status:** BLOCKED UNTIL AUTHORIZED PILOTS PASS

**Decision owners:** SOC Development, Infraestructura y dueños de cada fuente

**Decision date:** 2026-09-18, fecha aportada por el usuario

QAPAQ SecOps es la plataforma SOC central. Wazuh es un componente para agentes,
HIDS, FIM, configuración, inventario, vulnerabilidades y sus propias alertas; no
es la aplicación completa, la única correlación ni la única ruta de ingesta.
Sophos, Cato y futuras rutas directas se integran post-MVP mediante adapters
independientes cuando inventario, licencia, acceso y prueba real estén aprobados.
En el MVP, Microsoft 365 llega mediante la integración soportada de Wazuh.

Infraestructura opera productos, cuentas, conectividad y secretos. SOC Development
implementa adapters y lógica de plataforma. ADR-024 sustituye el orden anterior:
Microsoft 365 es la única fuente empresarial del MVP y Wazuh es su motor base de
recolección, reglas y alertas; QAPAQ consume el Indexer y gobierna SecurityEvent,
casos, RBAC, auditoría y notificaciones. La decisión completa está en
[ADR-019](../adr/019-source-boundaries-and-authorized-pilots.md),
[ADR-024](../adr/024-microsoft-365-wazuh-mvp-vertical.md), la
[estrategia canónica](../architecture/source-integration-strategy.md) y el
[inventario](../integrations/source-inventory.yaml).

U-005 queda resuelta en diseño respecto a fronteras, ownership, orden revisado,
raw, procedencia, checkpoints, replay y duplicidad. La ingesta productiva sigue
bloqueada hasta completar valores reales y superar el gate Microsoft 365/Wazuh.

### Decisión: Microsoft 365 pasa a `enabled` sin el gate técnico completo de PBI-006

**Decision status:** DECIDED / ADMINISTRATIVE, NOT TECHNICALLY VERIFIED

**Decision owner:** Franco Clavo Santander (Product Owner), relayed por Cesar
Adrian Guevara Salcedo

**Decision date:** 2026-09-24

Franco confirmó que la única entrega relevante para Microsoft 365 es el
`credential_ref` de app registration ya creado el 2026-09-22
(`secret://qapaq/microsoft/entra-app`, `docs/integrations/source-inventory.yaml`).
No hay `approved_scopes`, `approval_ticket`, `dataset`, `api_version` ni
`region` reales entregados hoy, y no se registró una conexión mínima real de
lectura contra Microsoft 365. Con esa base, Franco decidió declarar
`status: enabled` para la fuente Microsoft 365 en el inventario.

Esto **no** satisface el gate completo de **PBI-006** ("Cerrar contrato
operativo Microsoft 365/Wazuh"), cuyos criterios de aceptación en el
[Product Backlog](../project-management/product-backlog.md) exigen registrar
dataset, tenant/region, API, permisos, secretRefs, frecuencia, retención,
owner y aprobación, y demostrar "una conexión mínima real" de lectura antes de
aceptar el PBI. `enabled` aquí es una decisión administrativa del Product
Owner sobre el estado operativo de la fuente, no una declaración de que
PBI-006 está `DONE`; PBI-006 permanece abierto en el Product Backlog hasta
que existan esos valores y esa conexión real. Cualquier informe o Daily que
cite este `enabled` debe distinguir ambas cosas para no dar a entender una
verificación técnica que no ocurrió.

### Diagnóstico real de PBI-007 — 2026-09-28

**Decision status:** BLOCKED, con evidencia real de causa raíz

El app registration de Microsoft Entra creado el 2026-09-22
(`secret://qapaq/microsoft/entra-app`) se probó en vivo contra Microsoft Graph
y la Office 365 Management API. El `client_credentials` grant emite token en
ambos casos (`200`), pero el claim `roles` viene vacío: el app registration no
tiene ningún permiso de aplicación concedido. Una llamada real de solo lectura
al endpoint que usa el módulo `o365` de Wazuh
(`GET /activity/feed/subscriptions/list`) confirma el bloqueo con evidencia
directa del servidor: `401 AF10001 — "The permission set () sent in the
request does not include the expected permission."`

Esto descarta credenciales inválidas o mal configuradas: el app registration
autentica correctamente. Falta exclusivamente agregar el permiso de
aplicación `ActivityFeed.Read` (Office 365 Management APIs) y otorgar
**admin consent** sobre el tenant — una acción en Azure Portal que ningún
cambio de código puede sustituir. Detalle completo, pasos exactos y la
configuración objetivo del módulo `o365` de Wazuh (sin versionar secretos)
están en [PBI-007 — diagnóstico real de Microsoft 365 en Wazuh](../project-management/pbi-007/README.md).

PBI-007 permanece `BLOCKED`. Este diagnóstico es evidencia reutilizable, no
un cierre: evita repetir la investigación cuando se otorgue el consentimiento
pendiente.

## U-006 — auditoría y observabilidad

**Decision status:** CONDITIONALLY ACCEPTED

**Production status:** BLOCKED UNTIL ROLLBACK, ARCHIVE AND ALERT TESTS PASS

**Decision owners:** Security, Compliance, Infraestructura y Platform

**Decision date:** 2026-09-18, fecha aportada por el usuario

QAPAQ separa observabilidad operacional, audit trail de seguridad y telemetría
externa. API y workers usan OpenTelemetry/OTLP, W3C Trace Context, logs JSON y
métricas compatibles con Prometheus hacia un Collector administrado por
Infraestructura; el backend concreto no forma parte del dominio.

La auditoría crítica es transaccional en PostgreSQL, append-only para el rol
runtime y se archiva mediante outbox en storage WORM con cadena SHA-256,
manifests firmados, custodia externa de llaves y reconciliación. No admite
sampling ni depende de logs, traces, OpenSearch o stdout.

Se aceptan los buffers y thresholds iniciales, el comportamiento fail-closed,
la detección de rollback, el routing a dos destinos independientes y los 24
escenarios del gate definidos en
[ADR-021](../adr/021-observability-and-audit-separation.md),
[observabilidad](../architecture/observability.md) y
[auditoría](../architecture/audit.md).

U-006 queda resuelta en diseño. Endpoint OTLP, productos backend, storage WORM,
custodios nominales, signing service, llaves, canales y guardia son configuración
productiva que Infraestructura/Security debe registrar antes de superar el gate;
su ausencia no reabre la separación arquitectónica ni autoriza producción.

## U-007 — analítica Python

**Decision status:** ACCEPTED — DORMANT CAPABILITY

**MVP runtime status:** NOT ENABLED

**Activation status:** BLOCKED UNTIL USE CASE AND BENCHMARK PASS

**Decision owners:** Development + SOC + Security

**Decision date:** 2026-09-18, fecha aportada por el usuario

Python queda permitido exclusivamente para analítica especializada que demuestre
valor frente a Wazuh, TypeScript y OpenSearch. No se despliega en el MVP. El primer
candidato posterior es `Authentication Behavior Anomaly Scoring`, offline, batch y
acotado; produce candidates explicables que TypeScript revalida y nunca ejecuta
SOAR ni crea alertas directamente.

U-007 queda resuelta en [ADR-007](../adr/007-python-analytics.md) y el
[diseño canónico](../architecture/python-analytics.md). `apps/analytics` solo se
crea después de dataset autorizado, baseline, aprobación SOC, benchmark, contratos,
presupuesto, aislamiento, rollback y 18 pruebas. Antes solo se permite
`research/analytics` no desplegado.

## U-008 — workflow SOC y SOAR

PROPOSAL / UNRESOLVED, alcance reducido tras U-001. Los lifecycles principales,
el ownership SOAR/Antifraude y la aprobación explícita de acciones de alto impacto
están aceptados. Faltan cardinalidades concretas, guardas por transición,
evidencias de cierre, excepciones/reapertura, capabilities por transición, catálogo de acciones,
idempotencia externa y mecanismos de aprobación. Resolverlos mediante contratos
y ADR independientes sin reabrir el alcance aprobado ni asumir transiciones extra.

## U-009 — operación y continuidad

**Decision status:** CONDITIONALLY ACCEPTED

**Production status:** BLOCKED UNTIL RESTORE AND RECOVERY TESTS PASS

**Decision owners:** Infraestructura, Platform, SOC y Security Management

**Decision date:** 2026-09-18, fecha aportada por el usuario

QAPAQ SecOps se diseña para ingesta/detección automatizada 24x7, degradación,
checkpoints, idempotencia, replay, backups verificables y drenaje medido. Se aceptan
condicionalmente criticidad, RPO/RTO/SLO provisionales, error budgets, modos,
mantenimiento, restore, severidad, soporte, ownership, runbooks y 25 pruebas en
[ADR-020](../adr/020-operations-and-continuity.md) y la
[política canónica](../architecture/operations-and-continuity.md).

Software 24x7 no equivale a SOC humano 24x7. Sin guardia SEV1 formal, escalamiento
y autoridad, producción debe declararse `LIMITED PRODUCTION / 8x5`. U-009 queda
resuelta en diseño; producción sigue bloqueada hasta aprobar objetivos/owners,
demostrar restore/replay/drenaje y ejecutar runbooks críticos. No decide cloud ni IaC.

## U-010 — contrato SecurityEvent

**Decision status:** ACCEPTED / IMPLEMENTATION REQUIRED

**Decision date:** 2026-09-18, fecha aportada por el usuario

[ADR-011](../adr/011-security-event-normalization.md) adopta
`qapaq.security-event` 1.0.0 como contrato canónico interno, con JSON Schema Draft
2020-12 normativo. Separa recepción física (`recordId`) de identidad lógica
(`eventUid`), impide descarte automático con deduplicación heurística, versiona
taxonomía y severidad, referencia raw separado mediante SHA-256 y pone entradas
inválidas en cuarentena reprocesable.

ECS 9.5.0 y OCSF 1.9.0 son perfiles de interoperabilidad, no el contrato interno.
No se declara compatibilidad sin proyección y corpus validados. El mapping candidato
`wazuh.alerts.severity/1.0.0` debe probarse antes de activar reglas o notificaciones
críticas. La clasificación permanece `UNASSIGNED` hasta completar U-004.

U-010 queda resuelta como decisión y pendiente de implementación. Su gate exige
schema ejecutable, diccionario/taxonomía y mapping Wazuh/Microsoft 365 probados,
corpus sintético, contract tests en CI, replay/idempotencia, cuarentena/reproceso,
hash raw, cobertura ECS/OCSF y aprobación SOC/Desarrollo y Seguridad.

## U-011 — CI y política de releases

**Decision status:** CONDITIONALLY ACCEPTED / PARTIALLY RESOLVED

**CI status:** ENABLED FOR MVP

**Release candidate status:** ENABLED

**Publish/deployment status:** BLOCKED UNTIL INFRASTRUCTURE CONTRACT

**Decision date:** 2026-09-18, fecha aportada por el usuario

[ADR-023](../adr/023-ci-release-deployment-separation.md) separa CI de PR,
construcción/certificación de candidatos y publicación/despliegue. SOC/Development
puede implementar las dos primeras; Infrastructure debe entregar registro,
ambientes, identidad, conectividad, mecanismo, aprobadores, health checks y soporte
antes de las dos últimas.

El workspace usa `pnpm install --frozen-lockfile` y `pnpm audit`; no se crea un
`package-lock.json` artificial para ejecutar npm. El workflow actual ya descubre
pnpm y ejecuta controles del workspace. No se crea CD con valores o credenciales
ficticios.

U-011 permanece parcialmente resuelta hasta demostrar los ocho escenarios de
cierre: aislamiento de PR, CI completa, candidato certificado, contrato aceptado,
promoción del mismo digest a staging, detección por health, rollback y evidencia.

### Decisión: protección de rama en `main` no es requisito de este timebox

**Decision status:** DECIDED

**Decision owner:** Franco Clavo Santander (Product Owner), relayed por Cesar
Adrian Guevara Salcedo

**Decision date:** 2026-09-24

El bloqueo "protección de rama en `main` no configurada", registrado desde el
2026-09-21 en el Daily Scrum como riesgo de proceso, queda cerrado. Franco
determinó que exigir un PR obligatorio antes de escribir en `main` es
intrascendente en este timebox porque: (1) Cesar tiene control total del
código como único Developer del MVP, (2) el repositorio es privado, y (3) los
otros dos colaboradores configurados en GitHub son cuentas propias de Cesar,
no terceros con intereses distintos. No hay hoy un escenario real de push no
autorizado o de revisión cruzada entre partes independientes que la
protección de rama estuviese previniendo.

Esta decisión es válida mientras se mantengan esas tres condiciones. Se
revisa antes de aceptar un colaborador externo real (otro Developer,
Infraestructura empujando directamente, o un pipeline de terceros con
permiso de escritura), momento en el que la ausencia de protección de rama
vuelve a ser un riesgo activo y debe reevaluarse junto con U-011. No cambia
el resto del gate de CI (`discover`, `codeql`, `secrets`, `filesystem`,
`pnpm-audit`, `quality`, `entrypoints`, `c04-postgres`, `containers`, `gate`),
que sigue aplicando a cada push independientemente de si hay o no un PR.

### Decisión de evidencia C-04 con el entorno C-06

**Decision status:** DECIDED / CI VERIFIED

**CI evidence status:** VERIFIED ON `develop` (`c213073e6afff723690d78377d7e8170a712a63a`)

**Decision owners:** Development + Platform

**Decision date:** 2026-09-23

El perfil `base` de `IntegrationEnvironment` ofrece PostgreSQL 18.6 real con puerto
dinámico y limpieza del contenedor, por lo que es una base funcional suficiente
para ejecutar la suite de persistencia C-04. También inicia Redis y MinIO, aunque
la suite C-04 solo requiere PostgreSQL. Esta suficiencia funcional no acredita
todavía la reproducibilidad ni el cumplimiento de la Definition of Done en CI.

Se adoptó la alternativa **`postgres`**, que inicia solo PostgreSQL. El digest del
índice OCI de `docker.io/library/postgres:18.6` se consultó con
`docker buildx imagetools inspect` el 2026-09-23 y quedó fijado en
[`integration-environment.lock.json`](../../platform/testing/integration-environment.lock.json).
El runtime consume ese lock, arranca por digest y vuelve a comprobar el digest
local al recoger evidencia. Un digest ausente o diferente impide `PASS`. Los
digests de Redis, MinIO, OpenSearch y Wazuh siguen `null`; se resolverán antes de
aceptar evidencia de los perfiles que los ejecutan. No son requisito de C-04.

Para adjuntar evidencia **aceptada** de C-04 desde CI se requiere:

1. Arrancar el perfil `postgres` con el digest fijado y verificarlo tras el pull.
2. Ejecutar la suite PostgreSQL C-04 con `DATABASE_URL` efímera. El job
   `c04-postgres` ya la invoca directamente; el `vitest.integration.config.ts`
   general continúa limitado a `platform/testing/test`.
3. Adjuntar el artifact redactado con commit, versión/digest, comando, resultado y
   limpieza `PASS`. El job y el gate exigen que la suite y el artifact se produzcan;
   la ejecución real en CI debe terminar con el gate en `success`.

Tras aislar el caché roto de Secrets Engine y reiniciar Docker Desktop/WSL, la
ejecución local `c06-96005944-b033-45be-98ad-86661b4a1b09` confirmó digest,
health PostgreSQL, cinco pruebas C-04 y cleanup `PASS`. El artifact local registra
el commit `f03ec2a157e86cc128646d0d815d38f7bfa968d6` y `workingTreeDirty=true`;
por ello demuestra el comportamiento del árbol actual, no certifica ese commit.
La integración C-06 local también pasó con nueve pruebas de PostgreSQL/Redis.
La [ejecución CI 35945693397](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/35945693397)
del commit integrado `c213073e6afff723690d78377d7e8170a712a63a` terminó en
`success`, incluido el gate y el job C-04. Publicó el artifact
`c04-postgres-c213073e6afff723690d78377d7e8170a712a63a` con la evidencia
del perfil `postgres` fijado por digest, cinco pruebas y limpieza. Con ello quedó
verificada la ruta de evidencia C-04 desde CI.

### Cierre de C-04 — 2026-09-24

**Decision status:** DECIDED / DONE

El 2026-09-24 se cerraron los dos gates que este apartado dejaba abiertos para
el comando público C-04: rechazo por cruce de Source/tenant/dataset y límites
de identificadores/tamaño/conteo. Detalle completo, incluida la distinción
entre lo verificado localmente hoy (typecheck, boundaries, 205 specs unitarias
en verde, incluidas 18 nuevas de `validateAdmissionCommand`) y lo pendiente de
confirmación por el próximo run de CI (los dos casos nuevos de pertenencia
contra PostgreSQL real, no ejecutables en esta sesión por falta de Docker
local), en [C-04 — Cierre 2026-09-24](../architecture/c-04-admission-er.md#cierre-2026-09-24).

El smoke de object storage/Wazuh exigido por Sprint 1 (PBI-003) permanece
pendiente, pero queda reclasificado como alcance de C-06/C-08, no como gate de
cierre de C-04: la columna de evidencia de C-04 en el
[plan de componentes](../project-management/component-delivery-plan.md) nunca
lo exigió; solo lo mencionaba este apartado como contexto de Sprint 1.

## U-012 — notificación de alertas críticas en Microsoft Teams

Estado: **RESOLVED / ACCEPTED** por [ADR-022](../adr/022-microsoft-teams-critical-alert-notifications.md),
2026-09-18. Fuente: requerimiento confirmado por la Jefatura de Riesgos No Financieros.

Microsoft Teams Workflows es el canal corporativo primario para alertas
`CRITICAL`; QAPAQ conserva la fuente de verdad, el acuse y el lifecycle. La alerta
se confirma antes de crear la salida transaccional; un worker de la capacidad de
notificaciones de `soar` entrega después mediante adapter y `secretRef`. No se
usan Connectors heredados ni llamadas al webhook desde Detection.

La arquitectura queda cerrada. Para habilitar producción permanecen pendientes
el nombre final de Team/canal, membresía y propietarios, ratificación del máximo
de acuse, canal secundario y evidencia de las veinte pruebas. Son datos del gate,
no una decisión arquitectónica abierta.

## Historial

El registro inicial solo tenía U-001…007 y trataba tecnologías como candidatos.
La nueva solicitud aporta stack y proveedores previstos; se actualizan esas
premisas sin afirmar que estén desplegados. Esa primera entrega no aceptó ADRs.
Posteriormente el usuario aportó la resolución explícita de U-001 con fecha
2026-09-18: se registra ACCEPTED y ADR-015 Accepted; se reemplaza la agrupación
propuesta anterior. Las decisiones técnicas ADR-001…014 no se aceptan en bloque.
La primera vertical ordena construcción y no condiciona el cierre de U-001.
U-004 se resolvió después como CONDITIONALLY ACCEPTED mediante ADR-018: su baseline
permite continuar el diseño, pero el borrado automático queda bloqueado hasta la
ratificación legal, operacional y las pruebas de lifecycle.
U-005 se resolvió como CONDITIONALLY ACCEPTED mediante ADR-019: QAPAQ SecOps es el
producto central y cada proveedor tiene adapter independiente. Los datos reales y
la ingesta productiva permanecen bloqueados hasta pilotos autorizados.
U-006 se resolvió como CONDITIONALLY ACCEPTED mediante ADR-021: OpenTelemetry
desacopla observabilidad del proveedor y el audit trail usa PostgreSQL
transaccional más archivo WORM firmado. Producción permanece bloqueada hasta
configurar dependencias y superar las 24 pruebas.
U-007 se resolvió como ACCEPTED — DORMANT CAPABILITY mediante ADR-007: Python
queda fuera del runtime MVP y solo se activa por caso medible, benchmark y gate.
U-009 se resolvió como CONDITIONALLY ACCEPTED mediante ADR-020: fija continuidad,
recovery y soporte, pero los objetivos solo dejan de ser provisionales después de
aprobación y ejercicios medidos.
U-011 se resolvió parcialmente mediante ADR-023: CI y candidatos están
habilitados; publicación y despliegue quedan bloqueados por el contrato de
Infraestructura y ocho pruebas.
U-012 se resolvió como ACCEPTED mediante ADR-022 por requerimiento de la Jefatura
de Riesgos No Financieros: Teams Workflows es el canal primario para alertas
críticas, con outbox, worker, acuse en QAPAQ y fallback obligatorio.
