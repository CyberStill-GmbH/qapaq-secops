# Módulos, ownership y vocabulario

Límites funcionales: ACCEPTED mediante [U-001](../decisions/unresolved.md) y
[ADR-015](../adr/015-operational-scope-and-ownership.md), fecha aportada 2026-09-18.
Los nombres de carpetas sugeridos abajo son convenciones técnicas propuestas,
no interfaces implementadas. Esta estructura sustituye la agrupación inicial.

## Ocho módulos funcionales aprobados

### 1. Identity, Access & Policy — access

Usuarios, identidades de servicio, autenticación, sesiones, roles, permisos,
RBAC, políticas contextuales y autorización por endpoint. Toda API protegida
declara política explícita. Posee estado de acceso y asignaciones; no asume
operación del directorio corporativo ni captura de sus eventos.
Microsoft Entra ID autentica humanos; access posee sesión local, grants, scopes,
JIT, aprobaciones y revocación según ADR-017. La organización es QAPAQ y sus
unidades son scopes, no tenants.

### 2. Integrations & Collectors — connectors

Registro/configuración, referencias a credenciales, gestión lógica de collectors,
salud de fuentes y sincronización externa. Adapters para Wazuh, AD, Graph/Microsoft
365, VPN, Sophos, firewalls, IDS/IPS y otros proveedores. Administra integración
desde la aplicación, no infraestructura de ejecución ni productos corporativos.
Posee configuración/checkpoints y capacidades del adapter; entrega datos mediante
contrato de admisión de telemetry.

### 3. Telemetry Ingestion & Processing — telemetry

Admisión, validación, schema canónico, normalización, deduplicación, enrichment,
timestamps, trazabilidad, retries, backpressure, cuarentena y envío a almacenamiento/
detección. Consume contexto e indicadores mediante interfaces públicas.
La consulta/restore sigue propuesta en ADR-008; ADR-018 acepta condicionalmente
la política de retención, custodia y gate productivo;
no decide unilateralmente plazos regulatorios. No eleva una observación a incidente.

### 4. Detection & Correlation — detection

Reglas de detección/correlación, ventanas, secuencias, thresholds, coincidencia IOC,
severidad/confianza, contexto MITRE ATT&CK y versionado/pruebas de reglas. Consume
eventos normalizados e indicadores del módulo de inteligencia; no posee su catálogo.
NestJS mantiene dominio/estado. Python devuelve resultados versionados; no modifica
tablas de aplicación. Distinguir reglas locales de reglas Wazuh de origen.

### 5. Threat Intelligence — threat-intelligence

MISP, sincronización/normalización de indicadores, procedencia, confianza, vigencia,
expiración y contexto para enrichment. Posee indicadores y sus políticas de uso,
no lógica de triaje ni estados de incidentes. Una coincidencia IOC es evidencia,
no confirmación automática de compromiso. MISP sigue siendo adapter del port.

### 6. Alerts, Incidents & Cases — soc

Creación/deduplicación de alertas, triaje, investigación, evidencia, timelines,
entidades relacionadas, incidentes, casos, notas, tareas, relaciones entre eventos/
alertas/incidentes, cierre y clasificación. Posee estado operacional y referencias
de evidencia. Cardinalidades físicas, guardas y permisos por transición siguen
U-008; no se aprueba una relación N:M por inferencia.

### 7. SOAR, Playbooks & Ticketing — soar

Definición/versionado de playbooks, tareas, aprobaciones, acciones automatizadas,
respuesta sobre integraciones, compensación cuando sea posible, tickets,
sincronización ITSM, notificaciones y trazabilidad de ejecución. Acciones
destructivas/de alto impacto requieren permisos específicos y aprobación explícita.
Posee ejecuciones/aprobaciones/tickets; no modifica directamente incidentes ni
configuración ajena. Su inclusión en alcance no habilita acciones reales ahora.

### 8. Antifraud Intelligence — antifraud

Señales antifraude, velocidad, anomalías de autenticación, account takeover, cambios
de dispositivo, reputación IP, patrones transaccionales, scoring explicable y
alertas/casos antifraude. Mantiene reglas, permisos, entidades y vocabulario propios.
Reutiliza ingesta, correlación, enrichment y gestión de casos por contratos públicos;
no accede a repositorios internos de soc/detection. Un score no autoriza por sí
solo bloqueo ni confirma fraude. Lifecycle especializado se define en su contexto.

## Capacidades transversales y responsabilidades auxiliares

Auditoría, observabilidad, logging/métricas/tracing, errores, validación,
configuración, secretos, documentación de API y seguridad de aplicación no son
módulos de negocio independientes. Cada módulo produce su auditoría/observabilidad.
El almacenamiento técnico de audit tiene custodio y writer restringido; hacerlo
transversal no significa que todos puedan modificar sus registros.

Se retiran assets y workspace como bounded modules de la propuesta anterior.
Las entidades/activos relacionados se acceden por contratos de contexto y soc;
la persistencia concreta de inventario es diseño pendiente, no una CMDB nueva.
Dashboards/reporting son vistas autorizadas sobre contratos de los módulos.
Notificaciones/ticketing pertenecen a soar. Configuración pertenece al módulo
dueño y a capacidades técnicas, nunca a un repositorio global de reglas de negocio.

## Propiedad de datos y ownership operacional

Cada módulo posee su estado e interfaces. Prohibidos repositorios internos ajenos,
escrituras en tablas ajenas, entidades ORM compartidas, negocio en controllers,
Python escribiendo PostgreSQL y OpenSearch como fuente transaccional.

Security Engineering implementa, prueba y mantiene; SOC define detección, triaje,
severidad, workflows e incident response; Arquitectura gobierna límites; Infraestructura
opera producción; Riesgos/Antifraude gobierna ese dominio; Auditoría/Compliance
define requisitos de conservación, acceso, evidencia y trazabilidad. Detalle en U-001.

## Vocabulario canónico aceptado

- Raw Event: evento recibido sin normalizar.
- Normalized Event: evento validado/adaptado al esquema canónico; SecurityEvent es el contrato técnico propuesto para representarlo.
- Detection: resultado de una regla; DetectionResult es su contrato técnico propuesto.
- Alert Candidate: detección pendiente de enrichment y deduplicación.
- Alert: señal accionable disponible para triaje.
- Incident: investigación formal de uno o más eventos o alertas.
- Case: contenedor de investigación SOC o antifraude.
- Evidence: información trazable que sustenta una investigación.
- Indicator: observable procedente de inteligencia de amenazas.
- Playbook: definición versionada de una respuesta.
- Playbook Execution: ejecución auditable de una versión de playbook.
- Ticket: unidad de trabajo interna o sincronizada con ITSM.

## Lifecycles aceptados

Procesamiento: Raw Event → Validated Event → Normalized Event → Enriched Event →
Detection → Alert Candidate → Alert → Incident or Case → Response → Resolution →
Closure. Las salidas no son obligatorias: no toda detección genera alerta ni toda
alerta genera incidente. Correlación es una capacidad que produce detecciones;
el schema/versionado y transporte siguen sus ADR técnicos.

Alert: NEW → ENRICHING → TRIAGE → INVESTIGATING → CONFIRMED | FALSE_POSITIVE → CLOSED.
[Diagrama del ciclo de alerta](../diagrams/11-alert-lifecycle.mmd).

Incident: OPEN → INVESTIGATING → CONTAINMENT → ERADICATION → RECOVERY → RESOLVED →
CLOSED. No conservar atajos ni reapertura de la propuesta anterior como si fueran
aprobados. U-008 define excepciones/guardas mediante decisión independiente.

Toda transición se define explícitamente, valida dominio y autorización, produce
auditoría, conserva actor/timestamp/motivo e impide saltos inválidos. Antifraude
puede definir lifecycle especializado sin cambiar el SOC silenciosamente.

## Comunicación

Interfaces públicas de aplicación, comandos/consultas explícitos, eventos internos
justificados y contratos versionados. access provee política; connectors ingresa
a telemetry; threat-intelligence entrega contexto; detection produce resultados;
soc gestiona investigación; soar ejecuta respuesta autorizada y ticketing;
antifraud consume capacidades compartidas manteniendo ownership.

[Reglas de dependencias](dependency-rules.md) · [Diagrama](../diagrams/03-modules.mmd).
