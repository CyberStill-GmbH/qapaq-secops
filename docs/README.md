# qapaq-secops — arquitectura inicial

Arquitectura documental: U-001/ADR-015, U-002/ADR-016, U-003/ADR-017 y
U-010/ADR-011 aceptados; U-004/ADR-018, U-005/ADR-019, U-006/ADR-021,
U-009/ADR-020 y U-011/ADR-023 aceptados condicionalmente; U-007/ADR-007,
U-012/ADR-022 y la revisión de vertical ADR-024 aceptados, con fecha
aportada 2026-09-18; ADR-025 fue aceptado condicionalmente por los requisitos de
Franco Clavo del 2026-09-28; ADR-026 acepta KrakenD CE on-premises como gateway
de APIs de proveedores. Capacidad pendiente de medición; identidad, eliminación,
ingesta, auditoría/observabilidad y continuidad conservan gates
operacionales. La rama `develop` incluye una baseline ejecutable sin lógica de
negocio ni acceso a sistemas corporativos de Qapaq.

La configuración y documentación de CI añadidas en paralelo pertenecen a otro
trabajo. Se conservan sus cambios; esta revisión de arquitectura no certifica
la ejecución ni los controles del workflow. Consultar su estado en ci-cd.md.

## Leer primero

1. [ARCHITECTURE ASSESSMENT y propuesta](architecture/overview.md).
2. [Requerimientos y aceptación documental](requirements.md).
3. [Módulos y vocabulario](architecture/modules.md).
4. [ADRs y estado de decisiones](adr/README.md).
5. [Preguntas abiertas](decisions/unresolved.md) y [riesgos](architecture/risks.md).
6. [Toolchain, límites y capacidad](architecture/toolchain-and-capacity.md).
7. [Identidad, sesiones y autorización](architecture/identity-and-authorization.md).
8. [Retención, privacidad y custodia](architecture/retention-privacy-custody.md).
9. [Fuentes y pilotos autorizados](architecture/source-integration-strategy.md).
10. [Operación y continuidad](architecture/operations-and-continuity.md).
11. [Modelo C4](architecture/c4-model.md).
12. [Separación de observabilidad y auditoría](adr/021-observability-and-audit-separation.md).
13. [Plan Scrum del MVP](project-management/README.md).
14. [Especificación RF/RNF y matrices de trazabilidad](requirements/README.md).
15. [Auditoría de estructura](architecture/repository-structure-audit.md).
16. [Plan de construcción por componentes](project-management/component-delivery-plan.md).
17. [Entorno local ejecutable y troubleshooting](development/local-environment.md).
18. [Entorno C-06 de integración](development/integration-environment.md).
19. [Baseline de acceso, secretos y observabilidad SOC](architecture/security-access-observability-baseline.md).
20. [Decisión para evitar tercerización de observabilidad ante SBS](compliance/sbs-observability-rationale.md).
21. [Catálogo de errores para usuarios y soporte](error-catalog.md).
22. [KrakenD on-premises y admisión antes de BullMQ](architecture/provider-api-gateway.md).
23. [Arquitectura cloud demo AWS, estado real, tradeoffs y fuentes](architecture/aws-demo.md).
24. [Operación DevOps, secretos externos y retiro del demo](operations/devops-secrets-and-teardown.md).

## Diseño

- [Contexto y fronteras de confianza](architecture/system-context.md).
- [Modelo C4: contexto, contenedores, componentes y código](architecture/c4-model.md).
- [Flujos y resiliencia](architecture/data-flow.md).
- [SecurityEvent y contratos](architecture/event-model.md).
- [Almacenamiento y búsqueda histórica](architecture/storage.md).
- [Motor Wazuh y OpenSearch: detección, correlación y almacenamiento](architecture/wazuh-engine-and-opensearch.md).
- [Modelo entidad-relación (MER) y normalización](architecture/data-model-mer.md).
- [ER final C-04: admisión operacional](architecture/c-04-admission-er.md) y
  [auditoría con resolución documental](architecture/c-04-mer-audit.md).
- [Integraciones y ports](architecture/integrations.md).
- [Seguridad](architecture/security.md), [RBAC](architecture/rbac.md), [auditoría](architecture/audit.md).
- [Identidad y autorización aceptadas](architecture/identity-and-authorization.md).
- [Retención, privacidad y custodia](architecture/retention-privacy-custody.md).
- [Fuentes y pilotos autorizados](architecture/source-integration-strategy.md) e [inventario](integrations/source-inventory.yaml).
- [Operación y continuidad](architecture/operations-and-continuity.md).
- [API y políticas](api-guidelines.md).
- [Observabilidad](architecture/observability.md).
- [Endurecimiento de acceso, secretos y stack Grafana OSS/Loki/Prometheus](architecture/security-access-observability-baseline.md).
- [Control interno de logs SOC y análisis SBS](compliance/sbs-observability-rationale.md).
- [Catálogo de errores](error-catalog.md).
- [Diseño de frontend e inventario de componentes](frontend-design/README.md) — **propuesta**, no decisión aceptada; incluye la [evaluación de brechas UI/UX y administración SOC](frontend-design/09-evaluacion-frontend-soc.md).
- [API Gateway KrakenD de proveedores](architecture/provider-api-gateway.md).
- [Arquitectura cloud demo AWS y estado de despliegue](architecture/aws-demo.md).
- [Terraform AWS demo: fase 1 de red y seguridad](deployment/aws-demo.md).
- [Estructura objetivo](architecture/repository-structure.md), [auditoría estructural](architecture/repository-structure-audit.md), [dependencias](architecture/dependency-rules.md), [convenciones](architecture/conventions.md).
- [Estrategia de pruebas](testing-strategy.md).
- [Harness C-06 y estado de aceptación](architecture/c-06-integration-testing.md).
- [Auditoría de completitud C-06](architecture/c-06-completeness-audit.md).
- [Requisitos funcionales, no funcionales y matrices](requirements/README.md).
- [Threat model](threat-model.md).
- [Diagramas Mermaid de arquitectura y lifecycles](diagrams/README.md).
- [Plan por etapas](roadmap.md), [operación y despliegue](deployment.md), [runbooks](runbooks.md).
- [Notificaciones de alertas críticas](architecture/critical-alert-notifications.md).
- [Analítica Python dormante](architecture/python-analytics.md).
- [Fuentes primarias consultadas](references.md).
- [Verificador existente](verification.md) y [validación documental](validation.md).
- [CI de seguridad y preparación de CD](ci-cd.md).
- [Plan Scrum, componentes, backlog, Definition of Done y Sprints](project-management/README.md).
- [Daily Scrum y registro operativo](project-management/daily-scrum.md).
- [Entorno local y recuperación de Docker Desktop](development/local-environment.md).

## Autoridad y trazabilidad

FACT: la nueva solicitud exige monolito modular; TypeScript/Node/NestJS y React;
PostgreSQL operacional; Redis/BullMQ; Wazuh e indexación; Python para analítica
justificada; object storage abstraído. Son requisitos aportados, no instalaciones
observadas. La solicitud informa uso de Microsoft 365, Cato y Sophos; no aporta
inventario, ediciones, credenciales, licencias ni disponibilidad de APIs.

DECISION: U-001 y [ADR-015](adr/015-operational-scope-and-ownership.md) aceptan
alcance, ocho módulos, ownership, vocabulario, lifecycles y orden inicial por
instrucción explícita del usuario. SOC, SOAR y Antifraude integran el alcance
objetivo; la primera vertical no lo limita ni condiciona esta aceptación.
DECISION: U-002 y [ADR-016](adr/016-toolchain-and-capacity-baseline.md) fijan
versiones, workspace, ORM, herramientas, límites y benchmark. No demuestran que
el toolchain esté instalado ni aceptan una cifra de EPS.
DECISION: U-003 y [ADR-017](adr/017-identity-and-authorization.md) fijan Entra ID,
single-tenant, BFF/sesiones, RBAC con scopes, JIT y segregación. Producción sigue
bloqueada hasta completar el gate de federación/autorización.
DECISION: U-004 y [ADR-018](adr/018-retention-privacy-custody.md) aceptan
condicionalmente la baseline de retención, privacidad y custodia. El diseño puede
continuar; el borrado automático productivo requiere ratificación y pruebas.
DECISION: U-005 y [ADR-019](adr/019-source-boundaries-and-authorized-pilots.md)
aceptan QAPAQ SecOps como producto SOC central, adapters independientes y pilotos
Wazuh/Microsoft. La ingesta productiva requiere inventario y pilotos autorizados.
DECISION: U-007 y [ADR-007](adr/007-python-analytics.md) excluyen Python del
runtime MVP y conservan una capacidad futura sujeta a caso, benchmark y gate.
DECISION: U-010 y [ADR-011](adr/011-security-event-normalization.md) aceptan
`qapaq.security-event` 1.0.0, JSON Schema Draft 2020-12 como fuente normativa y
ECS 9.5.0/OCSF 1.9.0 solo como perfiles validados. La implementación permanece
pendiente del gate de schema, mappings, corpus, replay, cuarentena e integridad raw.
DECISION: [ADR-024](adr/024-microsoft-365-wazuh-mvp-vertical.md) revisa el orden
inicial: Microsoft 365 es la única fuente empresarial del MVP; Wazuh es el sistema
base de recolección, ruleset y alertas; QAPAQ gobierna SecurityEvent y el lifecycle
SOC. Cato, Sophos y nuevas APIs quedan post-MVP.
DECISION: U-006 y [ADR-021](adr/021-observability-and-audit-separation.md)
separan observabilidad, auditoría y telemetría; aceptan OpenTelemetry como contrato
neutral y auditoría transaccional con archivo firmado. Producción exige pruebas de
rollback, archivo, reconciliación y alertas.
DECISION: U-009 y [ADR-020](adr/020-operations-and-continuity.md) aceptan
condicionalmente objetivos de continuidad, degradación y soporte. Producción exige
restore/recovery medidos; sin guardia SEV1 se declara servicio 8x5 limitado.
DECISION: U-011 y [ADR-023](adr/023-ci-release-deployment-separation.md)
habilitan CI y candidatos de release, y bloquean publicación/despliegue hasta el
contrato de Infraestructura.
DECISION: U-012 y [ADR-022](adr/022-microsoft-teams-critical-alert-notifications.md)
incorporan al MVP la notificación `CRITICAL` por Teams Workflows mediante outbox y
worker; QAPAQ conserva el acuse y exige fallback probado.
DECISION: [ADR-025](adr/025-security-access-observability-hardening.md) fija una
sesión humana, red QAPAQ, passkeys Entra, protección de intentos, alta write-only de
credenciales, errores accionables y Grafana OSS/Loki/Prometheus autogestionados.
El stack se elige para conservar control de logs/información SOC y evitar contratar
el servicio externo regulado por SBS 504-2021 arts. 22–25; no es mandato de la SBS.
DECISION: [ADR-026](adr/026-on-premises-krakend-provider-api-gateway.md) selecciona
KrakenD CE on-premises delante de APIs consumidas directamente. El gateway aplica
controles de transporte; QAPAQ conserva semántica, raw/checkpoint/outbox y solo
publica referencias en Redis/BullMQ después de admisión durable. El MVP no cambia
`Microsoft 365 → Wazuh`; QAPAQ consulta Wazuh Indexer mediante KrakenD.
PROPOSAL: schemas, transportes y demás detalles técnicos no cubiertos por
ADR-007/015/016/017/018/019/020/021/022/023. ADR-001…014 no se aceptan en bloque.
ASSUMPTION y UNKNOWN se identifican donde afectan el diseño; las preguntas usan
estado UNRESOLVED y un criterio verificable de cierre.

La numeración solicitada ADR-001…014 reemplaza la numeración de cinco archivos
vacíos anteriores. Los tres nombres heredados que cambiaron de tema conservan
una nota de traslado, no un segundo ADR. Consultar siempre el título y el índice:
las referencias numéricas antiguas de las skills no se actualizaron porque esta
tarea está restringida a docs/. ADR-003 ahora es hexagonal, ADR-005 telemetría y
ADR-009 autorización.

Los documentos planos anteriores se conservan como enlaces a las páginas
canónicas; no mantener dos versiones de un mismo diseño.

## Reglas de uso

Leer solo documentos pertinentes y ADR asociados. No inferir endpoints desplegados,
obligaciones legales no validadas ni capacidad medida. Los SLO de ADR-020 son targets, no resultados. Los ejemplos son
sintéticos. Las skills siguen en `.codex/skills/`, enrutadas por el AGENTS.md
existente; no se modifican reglas ni configuración en esta entrega.
