# Riesgos arquitectónicos

Estado: registro propuesto; prioridad cualitativa, sin aceptación de riesgos.

- A-01 — Alta: capacidad todavía no medida; Node, Redis o indexador pueden saturarse y afectar control plane. U-002 acepta límites, perfiles y gates, no una cifra de EPS. Mitigar con batches/backpressure, workers aislables y benchmarks reproducibles. Development/Platform. Cierre: publicar el mayor perfil aprobado con 30% de headroom y drenaje demostrado.
- A-02 — Alta: la política de grants aceptada se implementa mal o la federación queda incompleta, causando escalada. Mitigar con scopes, objeto/campo, versionado, JIT, doble aprobación y segregación de ADR-017. Seguridad/SOC/Identity. Cierre: matriz y 27 pruebas productivas aprobadas; estado operacional bloqueado.
- A-03 — Alta: raw recibido no durable o checkpoint adelantado causa pérdida. Mitigar recibos, manifiestos, outbox y reconciliación. Desarrollo/Platform. Cierre: fault injection y replay; documentar límites de fuentes sin ACK. U-005/U-009.
- A-04 — Alta: retención inventada, purga o hold incorrecto elimina evidencia. Mitigar políticas aprobadas y prueba de restore antes de purga. Legal/Compliance/SOC. Cierre: matriz de retención y custodios confirmados. U-004.
- A-05 — Alta: auditoría local editable o archivo atrasado. Mitigar cuentas separadas, atomicidad, manifiestos y verificación externa. Seguridad/Infraestructura. Cierre: comportamiento ante caída y manipulación demostrado. U-006.
- A-06 — Media/alta: compatibilidad Wazuh Indexer/carga compartida obliga duplicación de infraestructura. Inventariar versiones, capacidad y soporte; read-only primero. Platform. Cierre: prueba del port y presupuesto de carga. U-005.
- A-07 — Media/alta: APIs/licencias/rate limits impiden fuentes prometidas. Ficha por dataset y piloto limitado; no comprometer endpoints sin validar. Dueño de proveedor/SOC. Cierre: acceso autorizado y evidencia de cursor/cobertura. U-005.
- A-08 — Media: modelo propio deriva en schema ad hoc y mappings rotos. Mantener núcleo, diccionario/versionado y corpus ECS/OCSF. Desarrollo/SOC. Cierre: fixtures de tres clases representativas y estrategia de evolución. U-010.
- A-09 — Media: ocho módulos derivan en monolito acoplado o en burocracia de ports. Ownership e imports comprobados; extraer solo por necesidad. Arquitectura. Cierre: vertical sin imports internos cruzados y revisión de límites.
- A-10 — Media: Python introduce segundo runtime y contratos incompatibles sin beneficio. Diferir hasta benchmark/caso real, schemas y fixtures comunes. Desarrollo/Platform. Cierre: valor medido frente a TypeScript/Wazuh. U-007.
- A-11 — Alta: consultas cold/exports se usan para exfiltrar o agotar recursos. ADR-017 acepta capability, scope, step-up, aprobación, manifest, cifrado, TTL y auditoría; retención sigue U-004. Seguridad/Platform. Cierre: pruebas de acceso/revocación/cancelación/coste.
- A-12 — Media/alta: equipo pequeño no opera cola, stores, IdP y fuentes de forma fiable. Reusar servicios existentes, runbooks y responsabilidades claras. Líder técnico/Infraestructura. Cierre: simulacro operacional y soporte acordado. U-009.
- A-13 — Media: references numéricas de skills antiguas apuntan ahora a otro ADR. Mitigar consultando índice y título; esta entrega solo modifica docs/. Dueño: mantenimiento del harness. Cierre: actualización futura autorizada de referencias fuera de docs/.

No usar migración a microservicios como mitigación automática. Primero medir
aislamiento, capacidad y fallos reales; añadir distribución puede agravar A-12.
