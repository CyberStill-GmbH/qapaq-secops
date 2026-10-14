# Documentación de Qapaq SecOps

Este índice lleva desde la visión del producto hasta sus decisiones, arquitectura,
controles y operación. El [README principal](../README.md) presenta Qapaq SecOps en
lenguaje de producto; esta documentación describe cómo se diseña, construye y
verifica.

## Comienza aquí

- [Visión de producto y alcance](adr/029-qapaq-secops-product-direction.md): qué es
  Qapaq SecOps, qué aporta Ayni Qapaq y cómo evolucionará el SOAR.
- [Arquitectura resiliente](architecture/qapaq-secops-resilient-architecture.md):
  flujos, roles de KrakenD, balanceadores, polling, colas, indexación, tiers y
  etapas de implementación.
- [Modelo C4](architecture/c4-model.md): contexto, contenedores, componentes y
  topología lógica de despliegue.
- [Roadmap](roadmap.md): orden de entregas, dependencias y gates.
- [Estado de demo e infraestructura](architecture/aws-demo.md): evidencia del
  ambiente, separada de la arquitectura objetivo.

## Producto y experiencia SOC

- [Ayni Qapaq](product/ayni-qapaq.md): propósito y recorrido de investigación
  colaborativa, desde la alerta hasta el aprendizaje posterior.
- [Diseño de consola](frontend-design/README.md): lenguaje visual, navegación,
  componentes y patrones de interacción.
- [Vistas y roles](frontend-design/10-vistas-por-rol-y-referencias.md): permisos y
  cobertura visible por perfil.
- [Investigación de incidentes](frontend-design/incidentes-investigacion.md):
  ciclo, notas, tareas, timeline y hallazgos.
- [Eventos de seguridad](frontend-design/eventos-investigacion.md): búsqueda y
  pivotes de análisis.
- [Contratos funcionales por vista](frontend-design/01-inventario-backend.md):
  superficie, API y estado de implementación conocido.

## Arquitectura e integración

- [Contexto y límites](architecture/system-context.md) ·
  [flujo de datos](architecture/data-flow.md) ·
  [módulos](architecture/modules.md).
- [Fuentes y adapters](architecture/source-integration-strategy.md) ·
  [KrakenD](architecture/provider-api-gateway.md) ·
  [Wazuh/OpenSearch](architecture/wazuh-engine-and-opensearch.md).
- [Almacenamiento y retención](architecture/storage.md) ·
  [privacidad y custodia](architecture/retention-privacy-custody.md) ·
  [modelo de eventos](architecture/event-model.md).
- [Continuidad y recuperación](architecture/operations-and-continuity.md) ·
  [rendimiento](performance/README.md) ·
  [observabilidad](architecture/observability.md).
- [Diagramas fuente](diagrams/README.md): los archivos Mermaid versionados son
  la representación editable de las vistas C4 y de comportamiento.

## Seguridad y gobierno

- [Modelo de seguridad](architecture/security.md) ·
  [identidad y autorización](architecture/identity-and-authorization.md) ·
  [RBAC](architecture/rbac.md).
- [Auditoría](architecture/audit.md) ·
  [amenazas](threat-model.md) ·
  [retención y custodia](architecture/retention-privacy-custody.md).
- [Controles SBS y observabilidad](compliance/sbs-observability-rationale.md):
  análisis técnico; las obligaciones y plazos deben validarse con Compliance y
  Legal para cada finalidad/dataset.
- [ADRs](adr/README.md): decisiones aprobadas, condicionales y abiertas. Los ADR
  son registros de decisión y no se reescriben retrospectivamente; nuevas
  decisiones los complementan o sustituyen de forma explícita.

## Construcción y operación

- [Entorno local](development/local-environment.md) ·
  [integración](development/integration-environment.md) ·
  [CI y releases](ci-cd.md).
- [Guía de despliegue](deployment.md) ·
  [demo AWS](deployment/aws-demo.md) ·
  [recuperación de Terraform](deployment/terraform-apply-recovery.md).
- [Runbooks](runbooks.md) ·
  [secretos y teardown](operations/devops-secrets-and-teardown.md) ·
  [verificación](verification.md).
- [Plan de componentes](project-management/component-delivery-plan.md) ·
  [backlog](project-management/product-backlog.md) ·
  [Definition of Done](project-management/definition-of-done.md).

## Requisitos y vocabulario

- [Alcance y fuentes](requirements/00-scope-and-sources.md) ·
  [mapa de capacidades](requirements/01-capability-map.md) ·
  [requisitos](requirements/02-functional-requirements.md).
- [Requisitos no funcionales](requirements/03-non-functional-requirements.md) ·
  [matriz RBAC](requirements/04-rbac-matrix.md) ·
  [trazabilidad](requirements/06-traceability-matrix.md).
- [Glosario](requirements/08-glossary.md) ·
  [inventario de fuentes](integrations/source-inventory.yaml).

## Cómo leer el estado

Cada documento operativo debe indicar si describe la **base implementada**, un
**objetivo aceptado**, una **propuesta pendiente** o una **prueba aún bloqueada**.
Un diagrama o contrato no prueba que exista un despliegue. La evidencia de código,
CI, integración y ambiente determina qué está disponible.

Los ADR, informes de cierre, evidencias de sprint y auditorías fechadas son
registros históricos: se conservan intactos. Si una decisión cambia, se publica un
nuevo ADR, se actualizan las guías vigentes y se deja un vínculo explícito desde el
índice. Cuando una guía antigua contradiga una decisión vigente, prevalece el ADR
más reciente que declare la sustitución.
