# Documentación de QAPAQ SecOps

Este índice separa la guía del producto de los contratos de implementación,
seguridad y entrega. Para una explicación no técnica de QAPAQ y de sus vistas,
empieza en el [README del producto](../README.md). Las imágenes de interfaz son
referencias sintéticas; el código, los contratos y la evidencia de cada entorno
determinan qué está realmente disponible.

## Producto SOC y experiencia de uso

- [Diseño de frontend](frontend-design/README.md): sistema visual, navegación,
  componentes y patrones de interacción.
- [Mapa de vistas y roles](frontend-design/10-vistas-por-rol-y-referencias.md):
  cobertura visible, capacidades y referencias de escritorio/móvil.
- [Pantallas](frontend-design/04-pantallas.md): contenido y aceptación de cada
  vista.
- [Inventario funcional](frontend-design/01-inventario-backend.md): contratos y
  comportamiento disponible por superficie.
- [Evaluación del frontend SOC](frontend-design/09-evaluacion-frontend-soc.md):
  brechas de experiencia y operación.
- [Investigación de incidentes](frontend-design/incidentes-investigacion.md) y
  [eventos](frontend-design/eventos-investigacion.md): flujos de análisis.
- [Avisos de incidentes críticos](architecture/critical-alert-notifications.md):
  canales, acuse, entrega y escenarios de aceptación.

## Arquitectura e integraciones

- [Contexto y límites del sistema](architecture/system-context.md) y
  [arquitectura general](architecture/overview.md).
- [Módulos del producto](architecture/modules.md),
  [flujo de datos](architecture/data-flow.md) y
  [modelo de eventos](architecture/event-model.md).
- [Integraciones](architecture/integrations.md),
  [estrategia de fuentes](architecture/source-integration-strategy.md) y
  [motor Wazuh/OpenSearch](architecture/wazuh-engine-and-opensearch.md).
- [Consulta de eventos en Wazuh](architecture/events-read-through.md) y
  [salud de fuentes](architecture/source-health.md).
- [Modelo de datos](architecture/data-model-mer.md),
  [almacenamiento](architecture/storage.md) y
  [observabilidad](architecture/observability.md).
- [Diferencial SOC frente a Wazuh](development/soc-diferencial-m365.md).

## Identidad, seguridad y cumplimiento

- [Identidad, sesiones y autorización](architecture/identity-and-authorization.md)
  · [RBAC](architecture/rbac.md) · [matriz de permisos](requirements/04-rbac-matrix.md).
- [Seguridad](architecture/security.md),
  [auditoría](architecture/audit.md) y
  [privacidad y custodia](architecture/retention-privacy-custody.md).
- [Threat model](threat-model.md),
  [auditoría de OIDC](security/auditoria-oidc.md) y
  [catálogo de errores](error-catalog.md).
- [Observabilidad interna y análisis SBS](compliance/sbs-observability-rationale.md)
  · [baseline de acceso y observabilidad](architecture/security-access-observability-baseline.md).
- [ADRs](adr/README.md): decisiones aceptadas, condicionales y abiertas.

## Operación, demo y entrega

- [Estado de la demo AWS](architecture/aws-demo.md) y
  [plan Terraform](deployment/aws-demo.md).
- [Checklist para la demo](deployment/release-demo-checklist.md),
  [operación DevOps y secretos](operations/devops-secrets-and-teardown.md) y
  [runbooks](runbooks.md).
- [Entorno local](development/local-environment.md) y
  [entorno de integración](development/integration-environment.md).
- [CI y separación del despliegue](ci-cd.md),
  [guía de despliegue](deployment.md) y
  [verificación](verification.md).
- [Plan de componentes](project-management/component-delivery-plan.md),
  [backlog](project-management/product-backlog.md),
  [sprints de cierre](project-management/plan-operativo-sprints-post-mvp.md) y
  [Definition of Done](project-management/definition-of-done.md).

## Requisitos y vocabulario

- [Requisitos funcionales y no funcionales](requirements.md) ·
  [matrices y trazabilidad](requirements/README.md).
- [Roadmap](roadmap.md), [glosario de integraciones](integrations.md) y
  [referencias consultadas](references.md).
- [Diagramas](diagrams/README.md) y
  [validación documental](validation.md).

## Cómo interpretar los documentos

Las pantallas conceptuales sirven para discutir composición; no acreditan
conectividad ni autorización. Los planes de producto distinguen lo implementado,
lo pendiente de aceptación en un entorno real y lo futuro. Cuando dos documentos
parezcan discrepar, sigue la decisión vigente en su ADR y el contrato actual de
la superficie, y registra la corrección en el documento afectado.
