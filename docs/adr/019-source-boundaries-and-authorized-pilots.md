# ADR-019 — Fronteras de fuentes y pilotos autorizados

Estado: Conditionally Accepted · Fecha de decisión aportada: 2026-09-18.

Enmienda: [ADR-024](024-microsoft-365-wazuh-mvp-vertical.md) sustituye el orden de
pilotos. El primer MVP usa Microsoft 365 como única fuente empresarial y Wazuh como
motor base de análisis/alertas. Cato, Sophos y fuentes adicionales son post-MVP.

Responsables: SOC Development, Infraestructura y dueños de cada fuente.

Estado operacional: ingesta productiva bloqueada hasta superar pilotos autorizados.

## Context

U-005 debía fijar la relación entre QAPAQ SecOps, Wazuh y las fuentes corporativas.
Tratar Wazuh como frontera obligatoria ocultaría procedencia, impediría aislar fallos
y acoplaría Microsoft, Cato y Sophos a una ruta que no forma parte de su contrato.
A la vez, mencionar productos no prueba edición, licencia, dataset, API, permisos,
cuotas, retención, cursor ni conectividad disponibles en QAPAQ.

## Decision

QAPAQ SecOps es la plataforma SOC central y propietaria de normalización,
correlación, casos, dashboards, RBAC, auditoría, reporting y SOAR. Wazuh aporta sus
agentes, HIDS, FIM, configuración, inventario, vulnerabilidades y alertas; no es la
aplicación SOC completa, el único motor de correlación ni la única ruta de ingesta.

Microsoft 365/Entra, Cato, Sophos y Wazuh tendrán adapters independientes dentro
del módulo `Integrations & Collectors`. Comparten contrato de admisión, pero
conservan autenticación, paginación, cursor, límites, replay y semántica del
proveedor. No se crea un adapter genérico con condicionales ni cuatro módulos de
negocio nuevos.

Infraestructura opera productos, licencias, cuentas, conectividad y secretos. SOC
Development implementa conectores, checkpoints, normalización, deduplicación,
gap detection, correlación, salud e integración con la plataforma. El código solo
recibe referencias a secretos administrados.

La primera vertical valida actividad Microsoft 365 recolectada y analizada por
Wazuh, seguida por consumo read-only del Indexer y normalización QAPAQ. No implementa
un conector Graph paralelo. Sophos y Cato siguen después del MVP. El inventario
versionado en `docs/integrations/source-inventory.yaml` no habilita componentes:
los valores reales y las pruebas autorizadas son un gate productivo.

## Alternatives

- Enviar toda fuente por Wazuh simplifica una entrada, pero pierde independencia,
  mezcla evento original con alerta derivada y amplía el blast radius.
- Construir los cuatro conectores en paralelo aumenta coste antes de validar el
  contrato común y la recuperación.
- Un adapter universal reduce archivos, pero esconde garantías incompatibles y
  deriva en condicionales por proveedor.
- Prometer cero pérdida desde el producto de origen confunde adquisición con
  procesamiento durable dentro de QAPAQ.

## Consequences

Cada dataset declara procedencia, nivel semántico, identidad estable, checkpoint,
replay y política de caminos duplicados. `WAZUH_ALERT` es una alerta derivada, no
el raw original. Si un hecho llega directo y por Wazuh, la política por dataset
elige fuente canónica, solo alerta derivada o ambos vinculados; nunca deduplica solo
por texto o timestamp.

El checkpoint avanza después de almacenamiento durable. En pull no se afirma ACK
al proveedor; en webhook se devuelve 2xx después de validar y persistir durably.
La garantía interna comienza en adquisición durable: at-least-once con consumidores
idempotentes. No cubre eventos que el producto o API nunca entregó.

## Trade-offs

Adapters independientes aumentan contratos y pruebas, pero contienen fallos,
preservan procedencia y permiten revocar una credencial sin detener otras fuentes.
El orden revisado retrasa Cato, Sophos y correlación multifuente, a cambio de
demostrar profundamente Microsoft 365/Wazuh sin comprometer varias APIs.

## Validación y revisión

La ingesta productiva requiere completar la ficha real y superar los 15 escenarios
de aceptación de [la estrategia canónica](../architecture/source-integration-strategy.md).
Revisar ante cambio de API, autenticación, versión, dataset, cursor, ruta duplicada,
garantía de replay, ownership o uso de Wazuh como intermediario.

[U-005](../decisions/unresolved.md) ·
[Estrategia de fuentes](../architecture/source-integration-strategy.md) ·
[Inventario](../integrations/source-inventory.yaml)
