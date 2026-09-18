# Preguntas y decisiones pendientes

Registro actualizado con U-001 ACCEPTED, cuya fecha de decisión aportada es
2026-09-18. U-001 asigna ownership funcional; los responsables técnicos y datos
faltantes de las demás preguntas no se infieren. Las preguntas abiertas no
bloquean la aceptación del alcance operacional ni esta entrega documental.

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

## U-002 — versiones, tooling y capacidad

UNKNOWN / UNRESOLVED. NestJS/React/PostgreSQL/Redis/BullMQ son ahora requisitos,
no candidatos; faltan versiones, ORM, gestor workspace, runtimes, recursos y carga.
Desarrollo/Platform deben aportar compatibilidad, EPS/pico, tamaños y concurrencia.
Cierre: toolchain fijado, benchmark y límites de payload/query/lotes acordados.
No prometer capacidad ni crear comandos de calidad ficticios.

## U-003 — identidad y autorización

UNKNOWN / UNRESOLVED. ¿IdP/MFA y modelo de sesión? ¿Una entidad o ámbitos por
unidad/equipo/filial? ¿Quién puede asignar qué capabilities, exportar raw y aprobar
operaciones críticas? Seguridad/SOC/Identity deben validar matriz y revocación.
Cierre: política de acceso y federación comprobable. Bloquea endpoints productivos,
no diseño/fakes. Roles del documento son bundles propuestos.

## U-004 — retención, privacidad y custodia

UNKNOWN / UNRESOLVED. ¿Plazos por dataset/raw/audit/backups? ¿Requisitos aplicables,
residencia, clasificación, holds, purga y export? Legal/Compliance/SOC e
Infraestructura definen política y capacidades de object storage.
Cierre: política aprobada y restauración/hold demostrados antes de borrado automático.
No inferir obligaciones regulatorias por ser una entidad financiera.

## U-005 — fuentes piloto e inventario real

UNKNOWN / UNRESOLVED. Microsoft 365/Cato/Sophos son uso informado, Wazuh es componente
central requerido; faltan ediciones, datasets, APIs, licencias, scopes, cuotas,
cursores, destinos y versiones Indexer/Manager. SOC/dueños de fuentes aportan
inventario sin secretos al repo. Cierre: ficha y prueba autorizada del piloto,
incluida semántica de raw/ACK/replay y fuentes que no pueden garantizar cero pérdida.

## U-006 — auditoría y observabilidad

UNKNOWN / UNRESOLVED. ¿Proveedor de métricas/logs/traces, custodio de audit,
capacidad de archivo inmutable, llaves, buffer máximo y destino de alertas?
Seguridad/Infraestructura definen comportamiento de fallo y soporte.
Cierre: prueba de audit rollback, archivo/reconciliación y alertas ante atraso.

## U-007 — analítica Python

PROPOSAL / UNRESOLVED. Python queda permitido/requerido para cargas justificadas,
no activo en MVP automáticamente. ¿Qué análisis aporta valor frente a Wazuh/TS?
Desarrollo/SOC deben aportar caso y benchmark. Cierre: schemas conformes,
presupuesto y validación de proceso acotado; otro transporte requiere revisar ADR-007.

## U-008 — workflow SOC y SOAR

PROPOSAL / UNRESOLVED, alcance reducido tras U-001. Los lifecycles principales,
el ownership SOAR/Antifraude y la aprobación explícita de acciones de alto impacto
están aceptados. Faltan cardinalidades concretas, guardas por transición,
evidencias de cierre, excepciones/reapertura, grants L1/L2, catálogo de acciones,
idempotencia externa y mecanismos de aprobación. Resolverlos mediante contratos
y ADR independientes sin reabrir el alcance aprobado ni asumir transiciones extra.

## U-009 — operación y continuidad

UNKNOWN / UNRESOLVED. ¿RPO/RTO, SLO, ventanas de mantenimiento, backups,
capacidad de drenaje, propietarios y soporte fuera de horario?
Infraestructura/Platform/SOC acuerdan servicio y ensayan restore. Bloquea
producción, no desarrollo aislado. No introducir Terraform ni cloud concreto.

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
