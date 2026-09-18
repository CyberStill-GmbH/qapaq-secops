# Diagramas Mermaid

Límites/lifecycles aceptados por U-001/ADR-015, identidad por U-003/ADR-017 y
fronteras de fuentes por U-005/ADR-019 y separación audit/observabilidad por
U-006/ADR-021;
topología técnica restante propuesta,
no inventario ni software desplegado. Flechas sólidas
representan flujo/interacción; punteadas representan relación transversal u opción
futura según etiqueta. Los módulos no son microservicios.

1. [C4 nivel 1 — System Context](01-system-context.mmd): QAPAQ SecOps como sistema de interés.
2. [C4 nivel 2 — Containers](02-containers.mmd): unidades ejecutables/stores conceptuales, no compromiso con Docker/Kubernetes.
3. [C4 nivel 3 — Components](03-modules.mmd): módulos y capacidades, no imports de internals.
4. [Pipeline de ingesta](04-ingestion.mmd): aceptación durable distinta de procesamiento.
5. [Autenticación/autorización](05-authentication-authorization.mmd): flujo Entra/BFF aceptado; configuración real pendiente del gate.
6. [Ciclo de incidente](06-incident-lifecycle.mmd): secuencia aceptada; guardas y excepciones siguen U-008.
7. [Hot/Warm/Cold](07-storage-tiers.mmd): tiers lógicos; restore histórico puede ser asíncrono.
8. [Adapters externos](08-integrations.mmd): puertos de aplicación, implementación en infraestructura.
9. [Auditoría](09-audit.mmd): atomicidad local, cadena hash, firma, WORM y reconciliación.
10. [Detección/correlación](10-detection-correlation.mmd): promoción explícita Detection → Alert Candidate → Alert; en la primera vertical se indexa antes del análisis.
11. [Ciclo de alerta](11-alert-lifecycle.mmd): secuencia aceptada por U-001, distinta del ciclo de incidente.
12. [C4 nivel 4 — código representativo](12-c4-code-soc-module.mmd): capas hexagonales propuestas del módulo SOC; no clases implementadas.

Las fuentes .mmd son canónicas. Para cambiar un diagrama, contrastar
[flujos](../architecture/data-flow.md), [seguridad](../architecture/security.md) y
el ADR correspondiente. No inferir dependencias adicionales de una flecha.
La guía narrativa y reglas de zoom están en el [modelo C4](../architecture/c4-model.md).
