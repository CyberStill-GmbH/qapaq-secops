# Diagramas Mermaid

Límites/lifecycles aceptados por U-001/ADR-015 e identidad por U-003/ADR-017;
topología técnica restante propuesta,
no inventario ni software desplegado. Flechas sólidas
representan flujo/interacción; punteadas representan relación transversal u opción
futura según etiqueta. Los módulos no son microservicios.

1. [System Context Diagram](01-system-context.mmd).
2. [Container Diagram](02-containers.mmd): contenedores conceptuales, no compromiso con Docker/Kubernetes.
3. [Arquitectura modular](03-modules.mmd): datos/contratos, no imports de internals; audit aplica también a acciones críticas no dibujadas.
4. [Pipeline de ingesta](04-ingestion.mmd): aceptación durable distinta de procesamiento.
5. [Autenticación/autorización](05-authentication-authorization.mmd): flujo Entra/BFF aceptado; configuración real pendiente del gate.
6. [Ciclo de incidente](06-incident-lifecycle.mmd): secuencia aceptada; guardas y excepciones siguen U-008.
7. [Hot/Warm/Cold](07-storage-tiers.mmd): tiers lógicos; restore histórico puede ser asíncrono.
8. [Adapters externos](08-integrations.mmd): puertos de aplicación, implementación en infraestructura.
9. [Auditoría](09-audit.mmd): atomicidad local y archivo posterior.
10. [Detección/correlación](10-detection-correlation.mmd): promoción explícita Detection → Alert Candidate → Alert; en la primera vertical se indexa antes del análisis.
11. [Ciclo de alerta](11-alert-lifecycle.mmd): secuencia aceptada por U-001, distinta del ciclo de incidente.

Las fuentes .mmd son canónicas. Para cambiar un diagrama, contrastar
[flujos](../architecture/data-flow.md), [seguridad](../architecture/security.md) y
el ADR correspondiente. No inferir dependencias adicionales de una flecha.
