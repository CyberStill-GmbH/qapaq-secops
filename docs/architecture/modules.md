# Módulos, ownership y vocabulario

Estado: PROPOSAL. Los nombres definen límites lógicos, no carpetas creadas.
[ADR-001](../adr/001-modular-monolith.md) y [ADR-003](../adr/003-hexagonal-architecture.md).

## Ocho módulos iniciales

### access — identity, authorization, users

Posee vínculo de identidad externa, perfil local, estado del usuario, roles,
capabilities, asignaciones y política de sesión. Expone autenticación mediante
port y evaluación de capacidades/scopes. No sincroniza telemetría del directorio:
esa es responsabilidad de connectors. Se fusionan porque identidad, revocación y
asignaciones requieren consistencia y comparten el mismo equipo; separar
subáreas internas para evitar que autenticación absorba reglas de negocio.

### assets — inventario y contexto

Posee activos observados, identificadores externos y resolución de entidades.
No se declara CMDB autoritativa. Relaciona fuentes con un activo con procedencia,
confianza y posibilidad de conflictos; no fusionar equipos solo por hostname.
Publica consultas de contexto; no entrega tablas para joins arbitrarios.

### connectors — integrations y configuración de fuentes

Posee ciclo de conectores, configuración validada, referencias de secreto,
capacidades del adapter y cursores/checkpoints de recolección. Los collectors
invocan la admisión de telemetry. No evalúa reglas de detección ni altera casos.
Un adapter puede implementar varios ports acotados, sin una interfaz universal.

### telemetry — ingestion, normalization, enrichment, retention y búsqueda

Posee recibos/manifiestos de lotes, raw, schemas, normalización y consultas históricas.
Enrichment orquesta consultas de assets y threat intelligence mediante contratos
públicos y marca procedencia/frescura. Retention comparte ownership del ciclo de
datos, con autorización separada para cambiar políticas y aplicar legal hold.
Se mantienen etapas internas reemplazables sin crear cinco bounded contexts.

### detection — detections, rules, correlation, threat-intelligence

Posee versiones y activación de reglas Qapaq, evaluación, ventanas de correlación,
indicadores/contexto y resultados de detección. Threat intelligence se conserva como
subárea con su port; no requiere un módulo separado hasta que tenga ciclo operativo
propio. Distinguir reglas Qapaq de reglas Wazuh referenciadas, que no se editan como
si fueran del mismo motor. Publica candidatos/ocurrencias idempotentes hacia soc.
No importa payloads de vendors ni decide cierre de incidentes.

### soc — alerts, incidents, cases, investigations

Posee triage, asignaciones, vínculos entre entidades, comentarios y referencias a
evidencia. Se agrupan por flujo operacional y consistencia, manteniendo agregados
distintos. Investigations es actividad dentro de un case, no otro contenedor
idéntico. Audit registra acciones, no controla el estado del caso.

### audit — auditoría

Posee contrato de auditoría, registro append-only lógico, verificación de
manifiestos y exportación autorizada. Su writer transaccional participa en la
unidad de trabajo del módulo que muta, mediante un port; no introduce callbacks
hacia todos los módulos. Diferenciar auditoría de diagnósticos y telemetría.

### workspace — reporting, dashboards, notifications, configuration

Posee vistas guardadas, definiciones de reportes, preferencias, entregas y
configuración global no perteneciente a otro dominio. Reportes consumen read APIs
o proyecciones autorizadas; no leen tablas ajenas directamente. Configuración de
conector permanece en connectors y políticas de retención en telemetry.
Agrupación de capacidades de soporte, separable si crecen sus ciclos de vida.

## Capacidades técnicas

Health y observability pertenecen al bootstrap y adapters compartidos, no a
agregados de negocio. SecretProvider es un port técnico restringido. Colas,
relojes y generadores de IDs se abstraen cuando permiten pruebas o reemplazo real.
No crear packages/shared como depósito de entidades de todos los módulos.

## Vocabulario operacional propuesto

- **SecurityEvent / Event**: observación de seguridad normalizada, con referencia verificable al raw. Es evidencia, no veredicto.
- **DetectionResult**: resultado reproducible de regla/version sobre eventos y contexto. Puede ser simple o compuesto.
- **Alert**: señal accionable producida por una detección local o externa normalizada; tiene triage. No toda alerta es incidente.
- **Incident**: situación de seguridad bajo evaluación o confirmada, con responsable, impacto y ciclo de respuesta. La sospecha puede abrir uno sin confirmar compromiso.
- **Case**: expediente de investigación que agrupa referencias a incidentes, alertas, activos, evidencias y comentarios. Puede existir sin incidente; no sustituye sus estados.
- **EvidenceReference**: identificador, procedencia, hash y ubicación lógica restringida de evidencia. Preservar legal hold y cadena de custodia.

Propuesta de cardinalidad: un incidente agrupa cero o más alertas; una alerta puede
vincularse a varios incidentes con motivo. Cases e incidents se relacionan N:M.
Cada relación preserva actor/fecha/razón y no copia raw. Validar esta flexibilidad
con SOC antes de schema de base de datos; [U-008](../decisions/unresolved.md).

Incident: NEW → TRIAGED → INVESTIGATING → CONTAINED → RESOLVED → CLOSED.
Rutas TRIAGED → RESOLVED e INVESTIGATING → RESOLVED cuando la disposición no
requiera contención; no exigir contención ficticia. Reapertura CLOSED → INVESTIGATING requiere capability, motivo
y auditoría. Cierre exige responsable, disposición, resumen y referencias de
evidencia o motivo explícito de ausencia. Transiciones concretas siguen propuestas.

## Contratos entre módulos

access se consume para autorización; assets entrega contexto; connectors produce
lotes hacia telemetry; telemetry entrega eventos versionados a detection; detection
emite resultados hacia soc. soc publica cambios para proyecciones de workspace.
audit recibe acciones de todos mediante contrato estable y sin dependencia inversa.

No crear eventos para consultas síncronas triviales ni compartir entidades ORM.
Cada módulo es dueño exclusivo de sus escrituras. Ver [reglas](dependency-rules.md)
y [diagrama](../diagrams/03-modules.mmd).
