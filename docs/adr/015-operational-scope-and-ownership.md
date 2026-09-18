# ADR-015 — Alcance operacional, módulos y ownership

Estado: Accepted · Fecha de decisión: 2026-09-18, indicada por el usuario.
Enmienda: ADR-024 sustituye únicamente el orden de la primera vertical.
Decision owners: SOC, Arquitectura y Security Engineering.
Evidencia: el usuario aportó la resolución de U-001 y ordenó incorporarla como
resuelta. [Texto íntegro aceptado](../decisions/unresolved.md).

## Context

U-001 condicionaba los límites operacionales a definir un piloto y proponía una
agrupación de ocho módulos que no representaba todo el alcance objetivo. El usuario
aclara que la primera vertical determina orden de implementación, no alcance ni
condición de aceptación. Se incorpora SOC, respuesta e inteligencia antifraude.

## Decision

Aceptar los ocho módulos funcionales de U-001: Identity, Access & Policy;
Integrations & Collectors; Telemetry Ingestion & Processing; Detection & Correlation;
Threat Intelligence; Alerts, Incidents & Cases; SOAR, Playbooks & Ticketing;
Antifraud Intelligence. Auditoría, observabilidad, configuración y seguridad son
capacidades transversales, no módulos de negocio independientes.

Aceptar ownership organizacional, vocabulario, lifecycles, propiedad de datos y
contratos públicos/versionados de U-001. NestJS controla dominio/estado; Python
devuelve resultados analíticos y no escribe tablas operacionales. Infraestructura
decide/opera producción; Desarrollo entrega aplicación local, contenedores y
contratos de despliegue en etapas posteriores, no como parte de esta tarea documental.

Primera vertical vigente: Microsoft 365 → recolección/ruleset/alerta Wazuh →
adapter QAPAQ → SecurityEvent → priorización → alerta → triaje → incidente →
auditoría/Teams, conforme a ADR-024.
No reduce el alcance completo. La auditoría sigue aplicándose también a las
acciones anteriores que la requieren; su posición en la lista no posterga controles.

## Alternatives

Condicionar U-001 a un piloto mantiene ambigua la arquitectura objetivo. Conservar
assets/audit/workspace como módulos independientes y Threat Intelligence dentro
de detection contradice la estructura aceptada. Implementar todos los módulos
simultáneamente agrega código vacío: se conserva entrega incremental.

## Consequences

Esta decisión sustituye la agrupación y vocabulario anteriores donde discrepen,
incluida la propuesta de ADR-001. No acepta automáticamente los detalles técnicos
de ADR-001…014: transporte, schemas, retención, Wazuh/OpenSearch y comunicación
Python siguen sus decisiones independientes. U-008 conserva solo detalles no
resueltos de contratos, guardas y acciones.

SOAR y Antifraude pertenecen al alcance objetivo, aunque se implementen después.
Acciones destructivas o de alto impacto requieren permisos específicos y aprobación
explícita. Cambiar ownership/límites exige actualizar esta decisión o un ADR sucesor.

## Trade-offs

El alcance objetivo completo permite diseñar contratos estables pero amplía la
superficie de permisos y pruebas. La entrega incremental contiene el coste inicial
sin borrar módulos del alcance ni presentar capacidades futuras como implementadas.

## Validación

Comprobar coherencia de módulos, vocabulario, lifecycles y ownership documental.
No se exige construir el primer vertical para aceptar U-001. Las pruebas del
software se exigirán en sus etapas; aceptación de arquitectura no certifica ejecución.
