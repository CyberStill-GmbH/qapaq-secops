# Requerimientos y alcance documental

La especificación detallada y canónica para planificación, implementación y
aceptación se encuentra en
[docs/requirements/](requirements/README.md). Esta página conserva el resumen de
entrada y las restricciones históricas; ante diferencias de detalle, prevalecen
los ADR aceptados y la especificación trazable enlazada.

Fuente: solicitud de arquitectura de qapaq-secops del 2026-09-17 y restricción
posterior «solo crea ahora la documentación en docs/». Esta última excluye crear
el skeleton ejecutable. Estado: requisitos de entrada; implementación pendiente.

La resolución posterior [U-001/ADR-015](adr/015-operational-scope-and-ownership.md)
aprueba alcance objetivo integral SOC/respuesta/antifraude, módulos y ownership.
Prevalece sobre la agrupación y vocabulario propuestos inicialmente.
La resolución [U-002/ADR-016](adr/016-toolchain-and-capacity-baseline.md) acepta
versiones, workspace, ORM, herramientas, límites iniciales y metodología de
capacidad. No acredita todavía instalación, compatibilidad ni rendimiento.
La resolución [U-003/ADR-017](adr/017-identity-and-authorization.md) acepta Entra
ID, modelo single-tenant, sesión BFF, RBAC/scopes, privilegios y gate productivo.
No acredita federación ni licenciamiento configurados.
La resolución [U-004/ADR-018](adr/018-retention-privacy-custody.md) acepta
condicionalmente clasificación, baseline de retención, custodia y gate de purga.
No acredita ratificación legal ni lifecycle implementado.
La resolución [U-005/ADR-019](adr/019-source-boundaries-and-authorized-pilots.md)
acepta QAPAQ SecOps como SOC central y adapters independientes. El orden inicial
fue sustituido por [ADR-024](adr/024-microsoft-365-wazuh-mvp-vertical.md): Microsoft
365 es la única fuente empresarial del MVP y Wazuh su motor base de recolección,
ruleset y alertas. No acredita ediciones, licencias, APIs, permisos ni conectividad.
La resolución [U-006/ADR-021](adr/021-observability-and-audit-separation.md)
acepta la separación de observabilidad, auditoría y telemetría, OpenTelemetry como
contrato neutral y archivo de auditoría firmado. No acredita backends, llaves,
storage WORM, canales ni pruebas productivas.
La resolución [U-011/ADR-023](adr/023-ci-release-deployment-separation.md)
separa CI, candidatos, publicación y despliegue; habilita las dos primeras y
bloquea las restantes hasta recibir el contrato de Infraestructura.
La resolución [U-009/ADR-020](adr/020-operations-and-continuity.md) acepta
condicionalmente criticidad, objetivos, modos, recovery y soporte. No acredita
RPO/RTO/SLO alcanzados ni cobertura humana 24x7.
La resolución [U-007/ADR-007](adr/007-python-analytics.md) acepta Python como
capacidad dormante y lo excluye del runtime MVP hasta superar su gate.
El requerimiento confirmado por la Jefatura de Riesgos No Financieros se registra
en [U-012/ADR-022](adr/022-microsoft-teams-critical-alert-notifications.md): Teams
Workflows es el canal primario para alertas `CRITICAL`, con entrega asíncrona,
acuse exclusivo en QAPAQ y fallback independiente obligatorio.

## Requisitos trazables

- R-01: plataforma SOC interna para Financiera Qapaq; mantenible por equipo pequeño, monolito modular sin microservicios iniciales. [Diseño](architecture/overview.md), ADR-001.
- R-02: TypeScript/Node/NestJS; React/TypeScript; hexagonal, SOLID y DDD pragmático. Versiones y toolchain aceptados por ADR-016. [Dependencias](architecture/dependency-rules.md), ADR-002/003.
- R-03: control plane y data plane separados lógicamente, módulos extraíbles por necesidad real. [Módulos](architecture/modules.md).
- R-04: PostgreSQL para datos operacionales, no telemetría masiva. [Storage](architecture/storage.md), ADR-004.
- R-05: Wazuh como motor base real de recolección, ruleset y alertas del MVP;
  QAPAQ conserva SecurityEvent, priorización complementaria y lifecycle SOC. ADR-005/019/024.
- R-06: Redis/BullMQ, backpressure, reintentos acotados, idempotencia, replay y fallos aislados; sin Kafka inicial. [Flujos](architecture/data-flow.md), ADR-006/014.
- R-07: Python reservado como capacidad analítica dormante; no se despliega en el MVP y solo se activa con caso, benchmark, contratos y gate aprobados, sin reemplazar NestJS. [Analítica](architecture/python-analytics.md), ADR-007.
- R-08: conservar raw separado con referencia y SHA-256; normalizar contra
  `qapaq.security-event` 1.0.0; gobernar identidad, taxonomía y severidad; y usar
  ECS 9.5.0/OCSF 1.9.0 solo mediante perfiles validados. [Modelo](architecture/event-model.md), ADR-011.
- R-09: hot/cold/evidence, retención por dataset, hold, purga verificable y consulta histórica sin acoplar al consumidor al tier. ADR-008/018.
- R-10: adapter Wazuh real en el MVP y adapters independientes para fuentes futuras;
  Cato/Sophos no se implementan sin contrato y prueba autorizada. [Integraciones](architecture/integrations.md), ADR-010/019/024.
- R-11: Entra ID humano, BFF con sesión opaca y roles dinámicos/capabilities con scopes, controles de objeto/campo, JIT y separación de funciones. [Identidad](architecture/identity-and-authorization.md), ADR-009/017.
- R-12: distinguir eventos, logs y auditoría; auditoría transaccional append-only,
  hash chain, archivo firmado, custodia y WORM selectivo. ADR-012/018/021.
- R-13: SecretProvider y referencias a secretos, sin passwords/tokens/API keys en PostgreSQL. ADR-013.
- R-14: distinguir Event, Alert, Incident, Case; ciclo de investigación y evidencia. [Módulos](architecture/modules.md).
- R-15: SOAR, Playbooks & Ticketing como módulo aprobado de entrega incremental, con permiso, aprobación explícita para alto impacto, razón y auditoría; no SOAR completo en esta tarea. [Seguridad](architecture/security.md).
- R-16: vistas SOC y permisos frontend sin sustituir backend. [Contexto](architecture/system-context.md).
- R-17: OpenTelemetry/OTLP, logs estructurados, métricas de cardinalidad acotada,
  health y contexto entre request/jobs, con backend administrado por
  Infraestructura. [Observabilidad](architecture/observability.md), ADR-021.
- R-18: unit, contract, integration, provider y E2E specs; dependencias reales
  aisladas y Microsoft 365/Wazuh autorizados. Fakes no son evidencia de Done.
  [Pruebas](testing-strategy.md), [Definition of Done](project-management/definition-of-done.md).
- R-19: GitHub Actions separa CI, candidato, publicación y despliegue; usa pnpm, build-once, digest, SBOM, attestation, gates y evidencia. Publicación/CD esperan contrato de Infraestructura; no Terraform. [CI/CD](ci-cd.md), ADR-023.
- R-20: solo datos sintéticos, sin empleados, secretos, IP internas, dominios privados ni configuraciones reales.

- R-21: Antifraud Intelligence aprobado, con reglas, permisos, entidades y vocabulario propios; reutiliza contratos de ingesta, correlación y casos. [U-001](decisions/unresolved.md).
- R-22: primera vertical Microsoft 365 → integración nativa Wazuh → ruleset/alerta
  Wazuh → adapter read-only → SecurityEvent → priorización → alerta → triaje →
  incidente → auditoría/Teams; Microsoft 365 es la única fuente empresarial del
  MVP y Wazuh su motor base. [ADR-024](adr/024-microsoft-365-wazuh-mvp-vertical.md).
- R-23: notificar toda alerta `CRITICAL` mediante Microsoft Teams Workflows desde
  outbox/worker después del commit, con payload minimizado, reintentos, deduplicación,
  auditoría, acuse en QAPAQ, escalamiento y canal secundario probado. Requerimiento
  confirmado por la Jefatura de Riesgos No Financieros. [ADR-022](adr/022-microsoft-teams-critical-alert-notifications.md).
- R-24: separar CI, construcción certificada, publicación y despliegue; usar pnpm,
  promover el mismo digest y conservar evidencia. CI/candidatos son responsabilidad
  de SOC/Development; publicación/CD esperan el contrato de Infraestructura.
  [ADR-023](adr/023-ci-release-deployment-separation.md).
- R-25: ejecutar un plan Scrum de tres Sprints entre 2026-09-19 y 2026-10-30,
  con Product Backlog único, Sprint Goals, Definition of Done y evidencia real.
  [Plan Scrum](project-management/README.md).

## Calidad y restricciones

Seguridad y trazabilidad no se posponen al final. Cada límite externo debe tener
autorización, validación, límites de consumo, timeouts, comportamiento degradado y
evidencia de pruebas. La metodología y los gates de rendimiento están aceptados;
la capacidad numérica permanece PENDING MEASUREMENT. RPO/RTO/SLO son targets
provisionales pendientes de ejercicios; volumen y capacidad siguen sin demostrarse. Ver
[preguntas](decisions/unresolved.md).

No se construyen ML complejo, Kubernetes, Kafka, microservicios, motor de base de
datos, IdP propio, infraestructura cloud ni integraciones simuladas presentadas
como funcionales. Ninguna política aquí se presenta como certificación regulatoria.

## Aceptación de esta entrega

- Los diez documentos de arquitectura solicitados existen y se enlazan entre sí.
- Veinticuatro ADR canónicos; ADR-007/011/015/016/017/022/024 Accepted y
  ADR-018/019/020/021/023 Conditionally Accepted.
- Trece diagramas Mermaid coherentes; los niveles C4 1…4 distinguen arquitectura objetivo de implementación existente.
- Estructura, dependencias, convenciones, testing, threat model, riesgos y preguntas documentados.
- Baselines aceptadas diferenciadas de tooling instalado, capacidad medida, ratificación legal y lifecycle implementado; ninguna integración declarada probada.
- Cambios confinados a docs/; sin código de aplicación ni infraestructura.
- Enlaces locales y sintaxis de diagramas comprobados; limitaciones de verificación registradas.
