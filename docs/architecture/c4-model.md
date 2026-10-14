# Modelo C4 de QAPAQ SecOps

Estado: vistas arquitectónicas documentales. Consolidan decisiones aceptadas y
objetivos sujetos a gates; no afirman que la topología, las réplicas o las
integraciones estén desplegadas. Fuente de verdad: [ADRs](../adr/README.md),
[decisiones abiertas](../decisions/unresolved.md) y el inventario del ambiente.

## Propósito y alcance

El modelo C4 explica QAPAQ SecOps con cuatro niveles de zoom:

1. **Contexto:** personas, plataforma y sistemas externos.
2. **Contenedores:** unidades ejecutables o stores conceptuales del producto.
3. **Componentes:** módulos funcionales y capacidades internas del backend.
4. **Código:** estructura hexagonal propuesta dentro de un módulo representativo.

Las vistas describen arquitectura objetivo y fronteras de confianza. No son un
inventario de hosts, pods, cuentas, regiones, licencias o endpoints. En C4,
“contenedor” significa una unidad ejecutable o almacén con responsabilidad propia;
no obliga a usar Docker ni Kubernetes.

## Nivel 1 — Contexto del sistema

[Diagrama de contexto](../diagrams/01-system-context.mmd).

QAPAQ SecOps es el sistema de interés y la plataforma SOC central. Analistas y
administradores operan alertas, incidentes, reglas y respuesta; Auditoría consulta
evidencia; Riesgos/Antifraude gobierna su dominio; Infraestructura opera productos,
dependencias, conectividad y secretos.

Microsoft Entra ID autentica humanos. En el primer MVP, Microsoft 365 es la única
fuente empresarial y Wazuh recolecta esa actividad, aplica ruleset y entrega alertas
base a QAPAQ mediante acceso read-only al Indexer. Sophos, Cato y adapters directos
adicionales son post-MVP. Microsoft Teams Workflows recibe una
proyección minimizada de alertas críticas; QAPAQ conserva estado y acuse. MISP es una integración futura. Una
flecha de fuente a QAPAQ representa un dataset autorizado, no disponibilidad real,
licencia, credencial ni garantía de replay.

Decisiones que gobiernan esta vista:

- U-001/ADR-015: alcance, actores, módulos y ownership.
- U-003/ADR-017: Entra ID single-tenant y BFF.
- U-005/ADR-019: QAPAQ como producto central y fronteras independientes.
- ADR-024: Microsoft 365 como fuente MVP y Wazuh como motor base de alertas.
- U-007/ADR-007: Python es capacidad futura y no un contenedor del runtime MVP.
- U-009/ADR-020: Infraestructura opera dependencias; QAPAQ observa su estado.
- U-012/ADR-022: Teams Workflows es el canal primario de alertas críticas.
- ADR-026: KrakenD CE on-premises gobierna APIs de proveedores directas.
- ADR-029: Qapaq SecOps es el producto SIEM/XDR; Wazuh aporta el motor integrado.
- ADR-030: balanceo de acceso, pool KrakenD, polling coordinado, cola recuperable,
  indexación escalable y tiers forman la topología objetivo resiliente.

## Nivel 2 — Contenedores

[Diagrama de contenedores](../diagrams/02-containers.mmd).

### Consola Qapaq SecOps

La consola presenta alertas, cobertura y espacios de trabajo como Ayni Qapaq. Carga
listas paginadas y detalles bajo demanda. No llama proveedores ni stores, no recibe
tokens Entra y no decide autorización.

### API / BFF

NestJS/Fastify mantiene sesión opaca, aplica políticas, expone casos de uso
síncronos y consulta estado. Las mutaciones críticas persisten auditoría local.

### Worker / scheduler

Node/NestJS consume alertas Wazuh, ejecuta pipeline, priorización/correlación
complementaria y jobs recuperables, incluida
la entrega asíncrona de notificaciones. Comparte
release y módulos con la API; es separación de carga/entrypoint, no microservicio.

### Analytics futura

U-007 elimina Python del runtime MVP, por lo que no aparece como contenedor en la
vista vigente. La frontera futura está documentada, pero `apps/analytics` solo se
incorpora al C4 después de aprobar caso, benchmark, contratos, aislamiento y
despliegue. [Detalle](python-analytics.md).

### Stores

- PostgreSQL: estado operacional, políticas, checkpoints, audit local, commands,
  outbox/inbox y metadatos.
- Redis/BullMQ: entrega de jobs; no es registro único de evidencia o acciones.
- OpenSearch QAPAQ: proyección SecurityEvent derivada para búsqueda; no fuente de
  verdad transaccional. Wazuh Indexer permanece externo y se consulta read-only.
  [Detalle del motor Wazuh y OpenSearch](wazuh-engine-and-opensearch.md).
- Object storage: raw, archivo, evidencia, manifests y exports temporales con
  retención, custodia y holds.

SecretProvider y fuentes permanecen externos. La selección/topología productiva de
proveedores continúa sujeta a gates; el diagrama no crea recursos cloud. El
OpenTelemetry Collector y el signing service también son servicios corporativos
externos administrados por Infraestructura/Security: QAPAQ exporta OTLP y solicita
firmas, pero no administra backends ni obtiene llaves privadas.
Teams Workflow también es externo: Infraestructura/Microsoft 365 administra
canal, workflow, propietarios y secreto; el worker solo consume su contrato.
KrakenD es un pool de infraestructura on-premises o red privada aprobada, stateless
y replicado detrás de balanceador. El worker lo usa para Wazuh Indexer y APIs
directas; el gateway no accede a stores ni a BullMQ. La respuesta pasa luego por
el adapter y la admisión durable de QAPAQ.

## Nivel 3 — Componentes

[Diagrama de componentes](../diagrams/03-modules.mmd).

Los ocho componentes funcionales son los módulos aceptados:

- Identity, Access & Policy.
- Integrations & Collectors.
- Telemetry Ingestion & Processing.
- Detection & Correlation.
- Threat Intelligence.
- Alerts, Incidents & Cases.
- SOAR, Playbooks & Ticketing.
- Antifraud Intelligence.

Auditoría y Operations & Observability son capacidades transversales, no módulos de
negocio adicionales. Cada módulo conserva estado e interfaces públicas. Se prohíben
imports arbitrarios de internals, tablas ajenas y entidades ORM compartidas.

El flujo MVP es Microsoft 365 → Wazuh; después connectors → KrakenD → Wazuh
Indexer → telemetry → detection → soc
→ soar. Wazuh produce la alerta base; Detection & Correlation de QAPAQ prioriza y
puede añadir lógica complementaria sin duplicar el ruleset. Para una
alerta crítica, `soc` confirma la alerta y publica una salida; `soar` entrega
después por worker hacia Teams. [Flujo detallado](critical-alert-notifications.md).
Threat
Intelligence aporta contexto; Antifraud reutiliza contratos manteniendo reglas y
ownership propios. Access aplica autorización por capability, scope, recurso y
contexto en cada entrada protegida.

El diagrama muestra relaciones arquitectónicas permitidas, no llamadas obligatorias
para todos los casos. Outbox/inbox y jobs se usan cuando un efecto diferido requiere
recuperación; una llamada de aplicación sigue siendo preferible para decisión local
inmediata.

## Nivel 4 — Código representativo

[Diagrama de código del módulo SOC](../diagrams/12-c4-code-soc-module.mmd).

El repositorio ya contiene código ejecutable en API, worker, módulos y tests. El
diagrama de Nivel 4 representa la frontera conceptual del módulo `Alerts,
Incidents & Cases`; no sustituye un mapa de clases sincronizado con el source actual:

- `domain`: Alert, Incident, Case, invariantes, transiciones y eventos de dominio;
  no depende de NestJS, Prisma, SDK ni infraestructura.
- `application`: casos de uso, contratos de entrada y ports de salida.
- `presentation/http`: controllers, DTO mapping y declaración de política; no reglas
  de negocio.
- `infrastructure`: repositorios Prisma y adapters que implementan ports.
- `public`: contratos de aplicación disponibles para otros módulos.
- composition root: wiring NestJS; conoce implementaciones sin mover dependencias
  hacia el dominio.

Para confirmar nombres y comportamiento ejecutables, revisar el código y sus
contratos; el diagrama no debe usarse como inventario de implementación.

## Vista de despliegue objetivo

[Topología resiliente](../diagrams/15-resilient-deployment.mmd).

El diagrama separa el balanceador de acceso de usuarios del balanceador interno
para las integraciones. Ambos son objetivos; sus implementaciones, cantidad de
nodos, redes y zonas de fallo se documentan en el inventario real de cada ambiente.
Las líneas punteadas identifican componentes cuyo despliegue es posterior al MVP o
requiere aprobación/capacidad demostrada. Esta vista orienta el diseño del rollout;
no certifica alta disponibilidad.

## Vistas de apoyo

C4 muestra estructura. Los comportamientos y controles temporales se mantienen en
diagramas separados:

- [Ingesta durable](../diagrams/04-ingestion.mmd).
- [Autenticación y autorización](../diagrams/05-authentication-authorization.mmd).
- [Ciclo de incidente](../diagrams/06-incident-lifecycle.mmd).
- [Storage tiers](../diagrams/07-storage-tiers.mmd).
- [Adapters](../diagrams/08-integrations.mmd).
- [Auditoría](../diagrams/09-audit.mmd).
- [Detección y correlación](../diagrams/10-detection-correlation.mmd).
- [Ciclo de alerta](../diagrams/11-alert-lifecycle.mmd).
- [Notificación de alerta crítica](../diagrams/13-critical-alert-notification.mmd).
- [Despliegue resiliente](../diagrams/15-resilient-deployment.mmd).

Las vistas de contexto, contenedores y despliegue son conceptuales. ADR-030 define
el patrón lógico; Infraestructura completa los detalles físicos tras revisar red,
cuenta, capacidad, costo y recuperación.

## Reglas de mantenimiento

1. Cambiar primero ADR o decisión cuando se altera una frontera aceptada.
2. Actualizar la vista de mayor nivel afectada y todos los niveles inferiores.
3. Etiquetar alternativas no aceptadas y elementos futuros.
4. No convertir package, proceso, cola o adapter en microservicio por cómo se dibuja.
5. No añadir producto externo sin owner, finalidad y estado en el inventario.
6. No dibujar comunicación que evada autorización, auditoría o contratos públicos.
7. Verificar Mermaid, enlaces y coherencia con módulos, dependencias y gates.
