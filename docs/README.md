# qapaq-secops — arquitectura inicial

Fecha: 2026-09-17. Estado: diseño documental para revisión; no implementación.

Esta entrega modifica únicamente `docs/`. La estructura de aplicaciones,
contratos y controles descritos es propuesta, no software existente. No se han
contactado sistemas de Qapaq ni usado datos reales.

La configuración y documentación de CI añadidas en paralelo pertenecen a otro
trabajo. Se conservan sus cambios; esta revisión de arquitectura no certifica
la ejecución ni los controles del workflow. Consultar su estado en ci-cd.md.

## Leer primero

1. [ARCHITECTURE ASSESSMENT y propuesta](architecture/overview.md).
2. [Requerimientos y aceptación documental](requirements.md).
3. [Módulos y vocabulario](architecture/modules.md).
4. [ADRs y estado de decisiones](adr/README.md).
5. [Preguntas abiertas](decisions/unresolved.md) y [riesgos](architecture/risks.md).

## Diseño

- [Contexto y fronteras de confianza](architecture/system-context.md).
- [Flujos y resiliencia](architecture/data-flow.md).
- [SecurityEvent y contratos](architecture/event-model.md).
- [Almacenamiento y búsqueda histórica](architecture/storage.md).
- [Integraciones y ports](architecture/integrations.md).
- [Seguridad](architecture/security.md), [RBAC](architecture/rbac.md), [auditoría](architecture/audit.md).
- [API y políticas](api-guidelines.md).
- [Observabilidad](architecture/observability.md).
- [Estructura propuesta](architecture/repository-structure.md), [dependencias](architecture/dependency-rules.md), [convenciones](architecture/conventions.md).
- [Estrategia de pruebas](testing-strategy.md).
- [Threat model](threat-model.md).
- [Diez diagramas Mermaid](diagrams/README.md).
- [Plan por etapas](roadmap.md), [operación y despliegue](deployment.md), [runbooks](runbooks.md).
- [Fuentes primarias consultadas](references.md).
- [Verificador existente](verification.md) y [validación documental](validation.md).
- [CI de seguridad y preparación de CD](ci-cd.md).

## Autoridad y trazabilidad

FACT: la nueva solicitud exige monolito modular; TypeScript/Node/NestJS y React;
PostgreSQL operacional; Redis/BullMQ; Wazuh e indexación; Python para analítica
justificada; object storage abstraído. Son requisitos aportados, no instalaciones
observadas. La solicitud informa uso de Microsoft 365, Cato y Sophos; no aporta
inventario, ediciones, credenciales, licencias ni disponibilidad de APIs.

PROPOSAL: límites concretos, flujos, schemas, agrupación de módulos, política de
sesiones y estrategias de almacenamiento presentados aquí. Todos los ADR quedan
`Proposed`: documentar una recomendación no equivale a aceptación organizacional.
DECISION se reservará para un ADR Accepted con responsable y evidencia.
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
retención legal, SLO, versiones ni capacidad de este diseño. Los ejemplos son
sintéticos. Las skills siguen en `.codex/skills/`, enrutadas por el AGENTS.md
existente; no se modifican reglas ni configuración en esta entrega.
