# Modelo C4 de QAPAQ SecOps

Estado: vista arquitectónica documental. Consolida decisiones ACCEPTED y
CONDITIONALLY ACCEPTED; no afirma software, infraestructura ni integraciones
desplegadas. Fuente de verdad: [ADRs](../adr/README.md) y
[decisiones](../decisions/unresolved.md).

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

Microsoft Entra ID autentica humanos. Wazuh, Microsoft 365/Entra logs, Sophos y
Cato son sistemas externos independientes. MISP es una integración futura. Una
flecha de fuente a QAPAQ representa un dataset autorizado, no disponibilidad real,
licencia, credencial ni garantía de replay.

Decisiones que gobiernan esta vista:

- U-001/ADR-015: alcance, actores, módulos y ownership.
- U-003/ADR-017: Entra ID single-tenant y BFF.
- U-005/ADR-019: QAPAQ como producto central y fuentes independientes.
- U-009/ADR-020: Infraestructura opera dependencias; QAPAQ observa su estado.

## Nivel 2 — Contenedores

[Diagrama de contenedores](../diagrams/02-containers.mmd).

### Web SOC

React/Vite presenta vistas y estados autorizados. No llama proveedores ni stores,
no recibe tokens Entra y no decide autorización.

### API / BFF

NestJS/Fastify mantiene sesión opaca, aplica políticas, expone casos de uso
síncronos y consulta estado. Las mutaciones críticas persisten auditoría local.

### Worker / scheduler

Node/NestJS ejecuta collectors, pipeline, detección y jobs recuperables. Comparte
release y módulos con la API; es separación de carga/entrypoint, no microservicio.

### Analytics

Python es opcional y acotado a analítica justificada. Recibe y devuelve JSON
versionado; no accede directamente a tablas ni controla el dominio.

### Stores

- PostgreSQL: estado operacional, políticas, checkpoints, audit local, commands,
  outbox/inbox y metadatos.
- Redis/BullMQ: entrega de jobs; no es registro único de evidencia o acciones.
- OpenSearch/Wazuh Indexer compatible: búsqueda e índices derivados; no fuente de
  verdad transaccional.
- Object storage: raw, archivo, evidencia, manifests y exports temporales con
  retención, custodia y holds.

SecretProvider y fuentes permanecen externos. La selección/topología productiva de
proveedores continúa sujeta a gates; el diagrama no crea recursos cloud.

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

El flujo principal es connectors → telemetry → detection → soc → soar. Threat
Intelligence aporta contexto; Antifraud reutiliza contratos manteniendo reglas y
ownership propios. Access aplica autorización por capability, scope, recurso y
contexto en cada entrada protegida.

El diagrama muestra relaciones arquitectónicas permitidas, no llamadas obligatorias
para todos los casos. Outbox/inbox y jobs se usan cuando un efecto diferido requiere
recuperación; una llamada de aplicación sigue siendo preferible para decisión local
inmediata.

## Nivel 4 — Código representativo

[Diagrama de código del módulo SOC](../diagrams/12-c4-code-soc-module.mmd).

No existe código de aplicación que permita dibujar clases reales. Este nivel usa
`Alerts, Incidents & Cases` como ejemplo de estructura objetivo:

- `domain`: Alert, Incident, Case, invariantes, transiciones y eventos de dominio;
  no depende de NestJS, Prisma, SDK ni infraestructura.
- `application`: casos de uso, contratos de entrada y ports de salida.
- `presentation/http`: controllers, DTO mapping y declaración de política; no reglas
  de negocio.
- `infrastructure`: repositorios Prisma y adapters que implementan ports.
- `public`: contratos de aplicación disponibles para otros módulos.
- composition root: wiring NestJS; conoce implementaciones sin mover dependencias
  hacia el dominio.

Los nombres de clases, métodos, endpoints, tablas y eventos ejecutables se definirán
al implementar casos de uso. El diagrama no los inventa.

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

No existe una vista de deployment porque host, cloud, región, réplicas, HA y
orquestador no están aprobados. ADR-020 define objetivos y recovery sin escoger esa
topología. Cuando Infraestructura la apruebe, se añadirá una vista C4 Deployment
basada en inventario real.

## Reglas de mantenimiento

1. Cambiar primero ADR o decisión cuando se altera una frontera aceptada.
2. Actualizar la vista de mayor nivel afectada y todos los niveles inferiores.
3. Etiquetar alternativas no aceptadas y elementos futuros.
4. No convertir package, proceso, cola o adapter en microservicio por cómo se dibuja.
5. No añadir producto externo sin owner, finalidad y estado en el inventario.
6. No dibujar comunicación que evada autorización, auditoría o contratos públicos.
7. Verificar Mermaid, enlaces y coherencia con módulos, dependencias y gates.
