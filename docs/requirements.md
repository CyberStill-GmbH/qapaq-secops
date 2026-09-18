# Requerimientos y alcance documental

Fuente: solicitud de arquitectura de qapaq-secops del 2026-09-17 y restricción
posterior «solo crea ahora la documentación en docs/». Esta última excluye crear
el skeleton ejecutable. Estado: requisitos de entrada; implementación pendiente.

La resolución posterior [U-001/ADR-015](adr/015-operational-scope-and-ownership.md)
aprueba alcance objetivo integral SOC/respuesta/antifraude, módulos y ownership.
Prevalece sobre la agrupación y vocabulario propuestos inicialmente.
La resolución [U-002/ADR-016](adr/016-toolchain-and-capacity-baseline.md) acepta
versiones, workspace, ORM, herramientas, límites iniciales y metodología de
capacidad. No acredita todavía instalación, compatibilidad ni rendimiento.

## Requisitos trazables

- R-01: plataforma SOC interna para Financiera Qapaq; mantenible por equipo pequeño, monolito modular sin microservicios iniciales. [Diseño](architecture/overview.md), ADR-001.
- R-02: TypeScript/Node/NestJS; React/TypeScript; hexagonal, SOLID y DDD pragmático. Versiones y toolchain aceptados por ADR-016. [Dependencias](architecture/dependency-rules.md), ADR-002/003.
- R-03: control plane y data plane separados lógicamente, módulos extraíbles por necesidad real. [Módulos](architecture/modules.md).
- R-04: PostgreSQL para datos operacionales, no telemetría masiva. [Storage](architecture/storage.md), ADR-004.
- R-05: Wazuh como pieza central; usar sus capacidades y evitar un SIEM sustituto. Indexación OpenSearch/Wazuh Indexer. ADR-005.
- R-06: Redis/BullMQ, backpressure, reintentos acotados, idempotencia, replay y fallos aislados; sin Kafka inicial. [Flujos](architecture/data-flow.md), ADR-006/014.
- R-07: Python para procesamiento justificado, sin reemplazar NestJS. Contratos Node/Python. [Modelo](architecture/event-model.md), ADR-007.
- R-08: conservar raw, normalizar SecurityEvent, analizar ECS/OCSF. [Modelo](architecture/event-model.md), ADR-011.
- R-09: hot/warm/cold, retención gobernada y consulta histórica sin acoplar al consumidor al tier. ADR-008.
- R-10: AD, Microsoft 365/Graph, Cato, Sophos, Wazuh, firewalls, IDS/IPS, servidores/endpoints; MISP futuro. [Integraciones](architecture/integrations.md), ADR-010.
- R-11: roles dinámicos y capabilities, política por API, scopes y controles de objeto/campo. [RBAC](architecture/rbac.md), ADR-009.
- R-12: distinguir eventos, logs y auditoría; acciones críticas auditables y protección frente a manipulación. ADR-012.
- R-13: SecretProvider y referencias a secretos, sin passwords/tokens/API keys en PostgreSQL. ADR-013.
- R-14: distinguir Event, Alert, Incident, Case; ciclo de investigación y evidencia. [Módulos](architecture/modules.md).
- R-15: SOAR, Playbooks & Ticketing como módulo aprobado de entrega incremental, con permiso, aprobación explícita para alto impacto, razón y auditoría; no SOAR completo en esta tarea. [Seguridad](architecture/security.md).
- R-16: vistas SOC y permisos frontend sin sustituir backend. [Contexto](architecture/system-context.md).
- R-17: logs estructurados, métricas, health y correlación entre request/jobs. [Observabilidad](architecture/observability.md).
- R-18: unit, integration, contract y E2E; fakes sin infraestructura real de Qapaq. [Pruebas](testing-strategy.md).
- R-19: GitHub Actions con SAST/dependencias/secret scanning y contenedores si aplican; no Terraform. [Despliegue](deployment.md).
- R-20: solo datos sintéticos, sin empleados, secretos, IP internas, dominios privados ni configuraciones reales.

- R-21: Antifraud Intelligence aprobado, con reglas, permisos, entidades y vocabulario propios; reutiliza contratos de ingesta, correlación y casos. [U-001](decisions/unresolved.md).
- R-22: primera vertical Wazuh/Windows authentication → ingesta → normalización → OpenSearch → correlación determinista → alerta → triaje → incidente → auditoría; orden de construcción, no límite del alcance.

## Calidad y restricciones

Seguridad y trazabilidad no se posponen al final. Cada límite externo debe tener
autorización, validación, límites de consumo, timeouts, comportamiento degradado y
evidencia de pruebas. La metodología y los gates de rendimiento están aceptados;
la capacidad numérica permanece PENDING MEASUREMENT. Disponibilidad, RPO/RTO,
volumen real y plazos de retención son UNKNOWN: no se prometen valores. Ver
[preguntas](decisions/unresolved.md).

No se construyen ML complejo, Kubernetes, Kafka, microservicios, motor de base de
datos, IdP propio, infraestructura cloud ni integraciones simuladas presentadas
como funcionales. Ninguna política aquí se presenta como certificación regulatoria.

## Aceptación de esta entrega

- Los diez documentos de arquitectura solicitados existen y se enlazan entre sí.
- Dieciséis ADR con Context, Decision, Alternatives, Consequences y Trade-offs, estado y condición de revisión; ADR-015 y ADR-016 Accepted.
- Once diagramas Mermaid coherentes con las decisiones y propuestas documentadas.
- Estructura, dependencias, convenciones, testing, threat model, riesgos y preguntas documentados.
- Baseline aceptada diferenciada de tooling instalado, compatibilidad comprobada y capacidad medida; ninguna integración declarada probada.
- Cambios confinados a docs/; sin código de aplicación ni infraestructura.
- Enlaces locales y sintaxis de diagramas comprobados; limitaciones de verificación registradas.
