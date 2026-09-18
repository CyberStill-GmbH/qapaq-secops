# Preguntas y decisiones pendientes

Registro actualizado con U-001…U-006 y U-009 resueltas en diseño mediante ADR
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

La primera vertical de implementación será:

```text
Wazuh/Windows authentication event
    -> ingestion
    -> normalization
    -> OpenSearch
    -> deterministic correlation
    -> alert
    -> triage
    -> incident
    -> audit
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

### Operational gate

La decisión cierra U-003 sin afirmar que la federación funciona. Los endpoints
productivos permanecen bloqueados hasta que Identity, Security y SOC validen
tenant/app registration, redirects, credenciales, grupo de admisión, Conditional
Access, MFA/authentication strength, matriz/scopes, Graph sync, revocación,
step-up, break-glass y los 27 escenarios mínimos aceptados.

Evidencia de aceptación: instrucción explícita del usuario y texto de resolución
aportado en esta tarea. El diseño, mocks y pruebas sintéticas pueden continuar.

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
Microsoft 365/Entra, Sophos y Cato se integran directamente mediante adapters
independientes cuando inventario, licencia, acceso y prueba real estén aprobados.

Infraestructura opera productos, cuentas, conectividad y secretos. SOC Development
implementa conectores y lógica de plataforma. Pilot A valida Wazuh; Pilot B valida
un dataset Microsoft directo y correlación multifuente. La decisión completa está
en [ADR-019](../adr/019-source-boundaries-and-authorized-pilots.md), la
[estrategia canónica](../architecture/source-integration-strategy.md) y el
[inventario](../integrations/source-inventory.yaml).

U-005 queda resuelta en diseño respecto a fronteras, ownership, orden, raw,
procedencia, ACK, checkpoints, replay y duplicidad. La ingesta productiva sigue
bloqueada hasta completar valores reales y superar los 15 escenarios autorizados.

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

PROPOSAL / UNRESOLVED. Python queda permitido/requerido para cargas justificadas,
no activo en MVP automáticamente. ¿Qué análisis aporta valor frente a Wazuh/TS?
Desarrollo/SOC deben aportar caso y benchmark. Cierre: schemas conformes,
presupuesto y validación de proceso acotado; otro transporte requiere revisar ADR-007.

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

PROPOSAL / UNRESOLVED. Núcleo v1, categorías, mappings de severidad, identidad de
eventos sin ID nativo y versiones ECS/OCSF deben contrastarse con corpus sintético
representativo. Desarrollo/SOC son dueños sugeridos. Cierre: diccionario,
schemas ejecutables y contract tests, sin autoafirmar compatibilidad.

## U-011 — CI y política de releases

UNKNOWN / UNRESOLVED. La solicitud de CI/CD concreta CodeQL, Dependabot, npm audit,
Trivy y Gitleaks; el flujo local usa runners hospedados de GitHub. Ver
[implementación y activación](../ci-cd.md). Faltan registro y destino de publicación,
ambientes, identidad de despliegue, aprobaciones, health checks, migraciones,
rollback y criterios de excepción. No existe evidencia de infraestructura provisionada.
Impacto: no habilitar publicación o despliegue con contratos/credenciales supuestos;
puede continuar CI. Desarrollo/Seguridad/Infraestructura acuerdan esos contratos.
Cierre: destino y política documentados y aceptados, pipeline probado sin secretos
en PR no confiable y evidencia de release y rollback.

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
U-009 se resolvió como CONDITIONALLY ACCEPTED mediante ADR-020: fija continuidad,
recovery y soporte, pero los objetivos solo dejan de ser provisionales después de
aprobación y ejercicios medidos.
