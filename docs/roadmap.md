# Plan de implementación posterior

Alcance y orden inicial aceptados por [U-001](decisions/unresolved.md) y
[ADR-015](adr/015-operational-scope-and-ownership.md). Gates técnicos propuestos,
sin fechas ni estimaciones inventadas. La documentación no implementa funcionalidades.

El timebox ejecutable de 2026-09-19 a 2026-10-20, sus Sprint Goals y Product
Backlog están en el [plan Scrum](project-management/README.md). ADR-024 sustituye
el orden inicial de fuentes sin reducir el alcance objetivo post-MVP.

## Base operacional aceptada

Los ocho módulos, ownership y lenguaje común están definidos para la plataforma
completa SOC/respuesta/antifraude. No hace falta construir ni definir un piloto
para cerrar U-001. Las etapas siguientes ordenan construcción, no reducen alcance.

## Preparación técnica

Materializar `qapaq.security-event` 1.0.0, su JSON Schema Draft 2020-12, catálogos,
mapping Wazuh/Microsoft 365 probado y corpus mínimo aplicable según U-010. Identidad/scopes están aceptados por U-003, pero su gate de
federación sigue bloqueando endpoints productivos. Versiones/toolchain/límites ya
están aceptados por U-002; la capacidad sigue pendiente de benchmark. U-004 acepta
la baseline de retención, pero Legal/Compliance deben ratificarla antes del TTL
productivo; ADR-020 fija targets provisionales y gate de recovery. ADR-024 sustituye
los pilotos A/B por una única vertical Microsoft 365 → Wazuh → QAPAQ; licencia,
configuración, dataset y cobertura real permanecen como gate.

Habilitar CI de PR y construcción de candidatos según ADR-023. Migrar el scanner
de dependencias de npm a pnpm junto con el workspace; no crear un lockfile npm
artificial. Publicación y despliegue esperan el contrato de Infraestructura.

Crear base NestJS/React, servicios reales aislados, configuración, gates de calidad, dependencias hacia
adentro y auditoría/autorización verificables. Contenedores y contratos de
despliegue serán entregables de software; Infraestructura administra producción.
No generar ocho módulos vacíos por completar el árbol.

## Primera vertical aceptada

Microsoft 365 → Wazuh collection/rules/alert → QAPAQ read-only ingestion →
SecurityEvent 1.0.0 validado → priorización → alert → notificación crítica por Teams → triage →
incident → audit.

La auditoría transversal acompaña también acceso/configuración/transiciones; no
se pospone por figurar al final. Persistencia raw, aceptación durable, reintentos y
evidencia siguen siendo controles de la implementación. En esta vertical se
indexa antes de la correlación; una topología posterior diferente requiere
documentar el contrato técnico sin alterar el alcance aprobado.

Cuando la alerta sea `CRITICAL`, el MVP crea outbox después de persistirla y el
worker entrega a Teams Workflows según ADR-022. El acuse permanece en QAPAQ y la
salida productiva depende del canal secundario y de las veinte pruebas.

Salida técnica propuesta: trazabilidad de origen a incidente, pruebas de permisos,
estados y auditoría, replay sin efectos duplicados, recuperación de fallos y carga
medida. No convierte el alcance objetivo en un experimento.

## Vertical de fuente del MVP

Microsoft 365 es la única fuente empresarial y Wazuh el motor base de recolección,
ruleset y alertas. QAPAQ consume el Indexer, normaliza y gestiona el lifecycle SOC.
Sophos, Cato, conectores Microsoft directos y correlación multifuente siguen después.
La vertical no pasa a `enabled` por configuración: debe recorrer sistemas reales,
superar ADR-024 y conservar procedencia, checkpoint, replay y aislamiento.

## Verticales siguientes, en orden

1. Enrichment con MISP mediante Threat Intelligence.
2. Nuevas fuentes e integraciones.
3. Playbooks en modo dry-run.
4. Respuestas con aprobación explícita.
5. Ticketing y notificaciones adicionales a la alerta crítica ya incluida en MVP.
6. Capacidades antifraude con permisos, entidades y scoring explicable propios.
7. Después del MVP, evaluar el primer caso Python offline; activarlo solo si supera
   baseline, benchmark, presupuesto, aislamiento, rollback y 18 pruebas.

Cada vertical incorpora tests/operación/retención pertinentes. Dry-run debe
demostrar ausencia de efectos externos; aprobación se vincula a versión, targets,
parámetros y permiso vigente. No simular éxito de una remediación no ejecutada.

## Evolución técnica

Archivo/restore, cuotas, legal hold, deletion ledger y los 20 escenarios de ADR-018
se prueban antes de habilitar purga automática. SOAR y Antifraude son alcance aceptado,
no ampliaciones pendientes de justificar; sus contratos e implementación sí son
incrementales. El runtime Python y ML quedan fuera del MVP por U-007; investigación y benchmarks
no desplegados sí están permitidos. Kafka, Kubernetes, microservicios y ML complejo siguen fuera de
implementación inicial; cualquier nueva necesidad técnica requiere evidencia y ADR.

Antes de producción: restore de PostgreSQL/búsqueda, replay, drenaje, revocación,
SOAR en dry-run contra adapter autorizado, ownership y soporte 8x5/24x7 explícitos. Los 25 escenarios de ADR-020
son gate; no basta que la aplicación arranque o que exista un backup.

La construcción posterior al timebox, sus responsables Codex/Claude y el DoD por
incremento están en el [plan de cierre operativo post-timebox](project-management/plan-operativo-sprints-post-mvp.md).
La matriz de pantallas y capacidades por perfil, con el estado real de cada vista, está
en [vistas por rol](frontend-design/10-vistas-por-rol-y-referencias.md). Estos planes
organizan gates ya aceptados; no promueven capacidades futuras a runtime.
