# qapaq-secops — arquitectura inicial

Arquitectura documental: U-001/ADR-015, U-002/ADR-016 y U-003/ADR-017 aceptados;
U-004/ADR-018, U-005/ADR-019 y U-009/ADR-020 aceptados condicionalmente, con fecha
aportada 2026-09-18. Capacidad pendiente de medición; identidad, eliminación, ingesta y continuidad conservan gates
operacionales. Sin implementación.

Esta entrega modifica únicamente `docs/`. Las decisiones aceptadas y propuestas
describen arquitectura, no software existente. No se han
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
6. [Toolchain, límites y capacidad](architecture/toolchain-and-capacity.md).
7. [Identidad, sesiones y autorización](architecture/identity-and-authorization.md).
8. [Retención, privacidad y custodia](architecture/retention-privacy-custody.md).
9. [Fuentes y pilotos autorizados](architecture/source-integration-strategy.md).
10. [Operación y continuidad](architecture/operations-and-continuity.md).
11. [Modelo C4](architecture/c4-model.md).

## Diseño

- [Contexto y fronteras de confianza](architecture/system-context.md).
- [Modelo C4: contexto, contenedores, componentes y código](architecture/c4-model.md).
- [Flujos y resiliencia](architecture/data-flow.md).
- [SecurityEvent y contratos](architecture/event-model.md).
- [Almacenamiento y búsqueda histórica](architecture/storage.md).
- [Integraciones y ports](architecture/integrations.md).
- [Seguridad](architecture/security.md), [RBAC](architecture/rbac.md), [auditoría](architecture/audit.md).
- [Identidad y autorización aceptadas](architecture/identity-and-authorization.md).
- [Retención, privacidad y custodia](architecture/retention-privacy-custody.md).
- [Fuentes y pilotos autorizados](architecture/source-integration-strategy.md) e [inventario](integrations/source-inventory.yaml).
- [Operación y continuidad](architecture/operations-and-continuity.md).
- [API y políticas](api-guidelines.md).
- [Observabilidad](architecture/observability.md).
- [Estructura propuesta](architecture/repository-structure.md), [dependencias](architecture/dependency-rules.md), [convenciones](architecture/conventions.md).
- [Estrategia de pruebas](testing-strategy.md).
- [Threat model](threat-model.md).
- [Diagramas Mermaid de arquitectura y lifecycles](diagrams/README.md).
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
DECISION: U-009 y [ADR-020](adr/020-operations-and-continuity.md) aceptan
condicionalmente objetivos de continuidad, degradación y soporte. Producción exige
restore/recovery medidos; sin guardia SEV1 se declara servicio 8x5 limitado.
PROPOSAL: schemas, transportes y demás detalles técnicos no cubiertos por
ADR-015/016/017/018/019/020. ADR-001…014 no se aceptan en bloque.
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
