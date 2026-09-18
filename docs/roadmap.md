# Plan de implementación posterior

Alcance y orden inicial aceptados por [U-001](decisions/unresolved.md) y
[ADR-015](adr/015-operational-scope-and-ownership.md). Gates técnicos propuestos,
sin fechas ni estimaciones inventadas. La documentación no implementa funcionalidades.

## Base operacional aceptada

Los ocho módulos, ownership y lenguaje común están definidos para la plataforma
completa SOC/respuesta/antifraude. No hace falta construir ni definir un piloto
para cerrar U-001. Las etapas siguientes ordenan construcción, no reducen alcance.

## Preparación técnica

Resolver detalles que bloqueen la primera vertical: contratos Wazuh/Windows,
schema y auditoría. Identidad/scopes están aceptados por U-003, pero su gate de
federación sigue bloqueando endpoints productivos. Versiones/toolchain/límites ya
están aceptados por U-002; la capacidad sigue pendiente de benchmark. Retención/hold y
RPO/RTO se acuerdan con los responsables. La primera fuente ya está elegida;
su licencia/configuración/cobertura real permanecen U-005.

Crear base NestJS/React, fakes, configuración, gates de calidad, dependencias hacia
adentro y auditoría/autorización verificables. Contenedores y contratos de
despliegue serán entregables de software; Infraestructura administra producción.
No generar ocho módulos vacíos por completar el árbol.

## Primera vertical aceptada

Wazuh/Windows authentication event → ingestion → normalization → OpenSearch →
deterministic correlation → alert → triage → incident → audit.

La auditoría transversal acompaña también acceso/configuración/transiciones; no
se pospone por figurar al final. Persistencia raw, aceptación durable, reintentos y
evidencia siguen siendo controles de la implementación. En esta vertical se
indexa antes de la correlación; una topología posterior diferente requiere
documentar el contrato técnico sin alterar el alcance aprobado.

Salida técnica propuesta: trazabilidad de origen a incidente, pruebas de permisos,
estados y auditoría, replay sin efectos duplicados, recuperación de fallos y carga
medida. No convierte el alcance objetivo en un experimento.

## Verticales siguientes, en orden

1. Enrichment con MISP mediante Threat Intelligence.
2. Nuevas fuentes e integraciones.
3. Playbooks en modo dry-run.
4. Respuestas con aprobación explícita.
5. Ticketing y notificaciones.
6. Capacidades antifraude con permisos, entidades y scoring explicable propios.
7. Análisis especializado Python con contratos versionados y estado controlado por NestJS.

Cada vertical incorpora tests/operación/retención pertinentes. Dry-run debe
demostrar ausencia de efectos externos; aprobación se vincula a versión, targets,
parámetros y permiso vigente. No simular éxito de una remediación no ejecutada.

## Evolución técnica

Archivo/restore, cuotas, legal hold y continuidad se prueban antes de habilitar
purga y uso productivo correspondiente. SOAR y Antifraude son alcance aceptado,
no ampliaciones pendientes de justificar; sus contratos e implementación sí son
incrementales. Kafka, Kubernetes, microservicios y ML complejo siguen fuera de
implementación inicial; cualquier nueva necesidad técnica requiere evidencia y ADR.
