# Motor Wazuh y OpenSearch — detección, correlación y almacenamiento

Estado: documento descriptivo. No crea una decisión nueva; consolida
[ADR-005](../adr/005-opensearch-wazuh-telemetry.md) (Proposed, parcialmente
sustituido) y [ADR-024](../adr/024-microsoft-365-wazuh-mvp-vertical.md)
(Accepted / Implementation Required) para explicar qué aporta el motor externo
Wazuh, cómo se relaciona con OpenSearch y dónde termina su responsabilidad
frente a QAPAQ SecOps. No afirma versión, licencia, topología ni disponibilidad
productiva más allá de lo ya aceptado en esos ADR y en
[Fuentes y pilotos autorizados](source-integration-strategy.md).

## Propósito y alcance

QAPAQ SecOps no reimplementa un motor SIEM. El primer MVP depende de Wazuh
como motor de recolección, decodificación, reglas y alertamiento base sobre
Microsoft 365, y de un almacén compatible con OpenSearch para indexar esas
alertas. Este documento explica:

1. Por qué se adoptó Wazuh como motor base en lugar de construir reglas
   propias o un SIEM completo.
2. Qué modelo interno de detección y correlación aporta Wazuh, y qué parte de
   ese trabajo QAPAQ no duplica.
3. Cómo se distinguen el Wazuh Indexer (externo, basado en OpenSearch) y una
   eventual proyección OpenSearch propia de QAPAQ.
4. Dónde termina la frontera de ownership entre Infraestructura (opera Wazuh)
   y SOC Development (consume, normaliza y correlaciona en QAPAQ).

No sustituye a ADR-005, ADR-024 ni a
[Integraciones y adapters](integrations.md); ante cualquier conflicto, esos
documentos son la fuente de verdad.

## Por qué Wazuh como motor base

[ADR-024](../adr/024-microsoft-365-wazuh-mvp-vertical.md) documenta la
decisión explícita del usuario: el equipo del MVP son dos personas con un
plazo de seis semanas, y Microsoft 365 es la única fuente empresarial
autorizada. Reimplementar decodificación y ruleset propios para Office 365
duplicaría trabajo ya cubierto por la integración nativa de Wazuh y retrasaría
la profundidad operacional que el MVP necesita (casos, RBAC, auditoría,
notificaciones).

Alternativas evaluadas y descartadas explícitamente en ADR-024:

- **Consumir Microsoft Graph directamente y reimplementar reglas en QAPAQ:**
  duplica capacidades base de Wazuh sin necesidad demostrada.
- **Usar Wazuh como producto SOC completo:** reduce código propio, pero no
  cubre el ownership aceptado de QAPAQ sobre casos, autorización, auditoría y
  workflows (ADR-019).
- **Construir adapters para todos los proveedores en paralelo:** aparenta
  extensibilidad y añade código sin contratos reales.
- **Adapter universal:** mezcla autenticación, paginación, throttling, replay
  y semánticas incompatibles entre proveedores.

Wazuh queda así como **dependencia central del pipeline, no como una segunda
fuente de negocio**: aporta recolección, decodificación, reglas y alertas
base; QAPAQ gobierna enriquecimiento, priorización, deduplicación, casos,
RBAC, auditoría, reporting y notificaciones. Esta frontera ya está fijada por
[ADR-019](../adr/019-source-boundaries-and-authorized-pilots.md) y se revisa
al cerrar el primer MVP o antes de autorizar una segunda fuente.

## Qué aporta el motor Wazuh (arquitectura del componente externo)

Wazuh se opera como stack oficial de terceros (Manager, Indexer, Dashboard),
no como código propio del repositorio. Localmente,
[`scripts/dev/setup-wazuh.ps1`](../../scripts/dev/setup-wazuh.ps1) clona
`wazuh/wazuh-docker` en la etiqueta fijada `v4.14.7` a `.local/wazuh-docker`
(carpeta ignorada por git) y levanta el compose oficial `single-node`; QAPAQ
no versiona `ossec.conf`, decoders, reglas ni `opensearch.yml` propios de
Wazuh. Cualquier cambio a ese ruleset o topología es responsabilidad de
Infraestructura, según [Fuentes y pilotos autorizados](source-integration-strategy.md).

Componentes relevantes para QAPAQ:

- **Wazuh Manager:** ejecuta la integración nativa Office 365, aplica
  **decoders** (extracción estructurada de campos sobre el log crudo del
  proveedor) y el **ruleset** (reglas declarativas con nivel de severidad,
  agrupación por `groups`, dependencia entre reglas vía `if_sid`, y
  correlación local por frecuencia/ventana de tiempo — `frequency` y
  `timeframe` — para detectar repetición o secuencias de eventos). También
  administra CDB lists (listas de referencia, p. ej. IPs o dominios) y
  capacidades adicionales del producto (FIM, Security Configuration
  Assessment, inventario, detección de vulnerabilidades) que QAPAQ no
  reimplementa ni depende de ellas en el MVP salvo necesidad demostrada.
- **Wazuh Indexer:** almacén de documentos basado en OpenSearch. Persiste
  `wazuh-alerts-*` (resultado del ruleset) y, si Infraestructura lo habilita,
  `wazuh-archives-*` (eventos crudos recolectados, deshabilitado por defecto).
  QAPAQ únicamente lee `wazuh-alerts-*` con mínimo privilegio; no escribe ni
  modifica los índices que Wazuh gestiona.
- **Wazuh Dashboard:** consola nativa de administración/consulta del stack Wazuh.
  ADR-029 define que no será una consola independiente del SOC después del MVP.
  QAPAQ podrá reutilizar OpenSearch Dashboards y plugins compatibles como base
  técnica, pero la experiencia y el ciclo de trabajo finales pertenecen a la
  consola QAPAQ. Casos, RBAC, auditoría y SOAR se gobiernan en QAPAQ; ninguna de
  esas reglas se traslada al Manager ni se confía solo a la UI. La transición
  requiere paridad comprobada y no implica que el Dashboard ya se haya retirado.
- **Active response y remediación:** capacidad del producto Wazuh que QAPAQ no
  activa ni orquesta en el MVP; el módulo `SOAR, Playbooks & Ticketing` de
  QAPAQ es quien gobierna respuesta autorizada, no el Manager de Wazuh.

Referencia oficial:
[componentes de Wazuh](https://documentation.wazuh.com/current/getting-started/components/index.html) ·
[ruleset de Wazuh](https://documentation.wazuh.com/current/user-manual/ruleset/index.html) ·
[Wazuh Indexer](https://documentation.wazuh.com/current/user-manual/wazuh-indexer/index.html).

## Correlación y detección: qué hace Wazuh y qué añade QAPAQ

Wazuh produce una **correlación local, por regla**: agrupa eventos que
comparten `if_sid`, frecuencia y ventana temporal dentro de su propio motor,
y emite una alerta (`WAZUH_ALERT`) con procedencia (`ruleId`, nivel, grupo).
Esa correlación no cruza fuentes ni conserva el contexto de negocio de QAPAQ
(activos, casos previos, threat intelligence, RBAC).

[Detection & Correlation](modules.md) de QAPAQ consume la alerta ya validada
como `SecurityEvent 1.0.0`, la enriquece con contexto versionado de Threat
Intelligence, y aplica priorización y correlación complementaria propia antes
de decidir si genera un `Alert Candidate`. El flujo aceptado es:

```text
Wazuh (ruleset y alerta base)
  → SecurityEvent 1.0.0 validado
  → enriquecimiento con Threat Intelligence
  → priorización y correlación QAPAQ
  → resultado de detección validado
  → Alert Candidate → deduplicación → Alert
  → Incident/Case → Response (SOAR autorizado) → Resolution y Closure
```

[Diagrama de detección y correlación](../diagrams/10-detection-correlation.mmd).

QAPAQ **no duplica en el MVP el ruleset base de Wazuh** (ADR-024): no
reimplementa decoders ni reglas de detección de Office 365 ya cubiertas por
Wazuh. La correlación multifuente (combinar alertas Wazuh con señales
directas de Cato, Sophos o una segunda fuente Microsoft) queda fuera del MVP
y solo se incorpora tras una decisión post-MVP explícita.

## OpenSearch: dos instancias conceptuales distintas

El repositorio distingue dos usos de OpenSearch que no deben confundirse:

- **Wazuh Indexer:** externo, administrado por Infraestructura, basado en
  OpenSearch pero gestionado íntegramente por el stack Wazuh. QAPAQ lo
  consulta en modo read-only mediante
  [`WazuhSecurityEventProvider`](../../modules/connectors/src/infrastructure/wazuh/wazuh-security-event.provider.ts)
  y [`WazuhGatewayClient`](../../modules/connectors/src/infrastructure/wazuh/wazuh-gateway.client.ts).
  El cliente usa las rutas allowlist de KrakenD, limita timeout y tamaño de
  respuesta, y valida el origen antes de mapear eventos. No se alteran los índices
  gestionados por Wazuh ni su ciclo de vida.
- **OpenSearch QAPAQ:** proyección objetivo, derivada de `SecurityEvent`, para
  búsqueda y consulta histórica. **No es fuente de verdad transaccional**
  (PostgreSQL conserva el estado operacional). El adapter/indexer propio no está
  desplegado en el ambiente local descrito; su incorporación sigue el benchmark,
  mapeo y recuperación de ADR-030. Ver
  [Almacenamiento y búsqueda histórica](storage.md).

Ambas instancias se mantienen separadas incluso en desarrollo local
(`infra/local/README.md`): solo el Wazuh Indexer se levanta hoy, vía
`setup-wazuh.ps1`. Antes de habilitar una proyección OpenSearch propia hace
falta inventariar carga, retención y compatibilidad de versión, según el
mismo criterio que ADR-005 exige para reutilizar el Indexer compatible.

## Procedencia y niveles semánticos

Un documento de `wazuh-alerts-*` no sustituye el evento crudo de Microsoft
365; es una interpretación aplicada por el ruleset de Wazuh. Los niveles de
procedencia aceptados en
[Fuentes y pilotos autorizados](source-integration-strategy.md#semántica-y-procedencia)
son:

```text
VENDOR_RAW → WAZUH_ARCHIVED_EVENT → WAZUH_ALERT → NORMALIZED_EVENT → CORRELATED_ALERT → INCIDENT
```

Todo `SecurityEvent` normalizado conserva `ruleId`, procedencia, tiempos de
origen/ingesta/recepción y referencia/hash del raw. `wazuh-archives-*`
(evento crudo indexado por Wazuh) permanece deshabilitado por defecto hasta
una decisión explícita de Infraestructura.

## Frontera de ownership

| Responsabilidad | Wazuh / Infraestructura | QAPAQ SecOps / SOC Development |
|---|---|---|
| Agentes, recolección Office 365, decoders, ruleset base | Sí | No (no se reimplementa sin necesidad demostrada) |
| Manager, Indexer, Dashboard: operación, versión, licencia, disponibilidad | Sí | No |
| Lectura read-only de `wazuh-alerts-*` con mínimo privilegio | — | Sí |
| Normalización a `SecurityEvent`, enriquecimiento, priorización, correlación complementaria | No | Sí |
| Casos, RBAC, vistas/dashboards de investigación QAPAQ, auditoría, reporting, SOAR | No | Sí |
| Active response / remediación automática | Wazuh (no activado) | No en el MVP |

## Gate productivo relevante

Subconjunto del gate de 15 puntos de
[Fuentes y pilotos autorizados](source-integration-strategy.md#gate-productivo)
aplicable a esta pieza: la integración Office 365 real de Wazuh recolecta
actividad autorizada; el ruleset produce la alerta esperada; QAPAQ accede al
Indexer con mínimo privilegio; la alerta se normaliza preservando `ruleId` y
procedencia; detener Wazuh marca cobertura degradada sin perder trabajo
durable; ningún secreto de Wazuh/OpenSearch aparece en repositorio, logs o
evidencia. El gate completo, no este resumen, es la referencia normativa.

## Reglas de mantenimiento

1. Cambiar primero ADR-005 o ADR-024 cuando se altere el rol de Wazuh u
   OpenSearch en el MVP; este documento solo describe la decisión vigente.
2. No versionar en este repositorio configuración real de Wazuh (reglas,
   decoders, `ossec.conf`) ni de OpenSearch (`opensearch.yml`, index
   templates, dashboards); esa configuración pertenece al stack oficial
   operado por Infraestructura.
3. No declarar una proyección OpenSearch propia de QAPAQ como disponible
   hasta que ADR-005 pase de Proposed a Accepted con inventario y prueba de
   carga.
4. No presentar la correlación de Wazuh como correlación multifuente de
   QAPAQ; son capas distintas con dueños distintos.
5. Mantener la distinción Wazuh Indexer (externo, read-only) vs OpenSearch
   QAPAQ (proyección propia) en cualquier diagrama o documento nuevo.

[Modelo C4](c4-model.md) ·
[Integraciones y adapters](integrations.md) ·
[Almacenamiento y búsqueda histórica](storage.md) ·
[Fuentes y pilotos autorizados](source-integration-strategy.md) ·
[ADR-005](../adr/005-opensearch-wazuh-telemetry.md) ·
[ADR-024](../adr/024-microsoft-365-wazuh-mvp-vertical.md)
