# Riesgos arquitectónicos

Estado: registro propuesto; prioridad cualitativa, sin aceptación de riesgos.

- A-01 — Alta: capacidad todavía no medida; Node, Redis o indexador pueden saturarse y afectar control plane. U-002 acepta límites, perfiles y gates, no una cifra de EPS. Mitigar con batches/backpressure, workers aislables y benchmarks reproducibles. Development/Platform. Cierre: publicar el mayor perfil aprobado con 30% de headroom y drenaje demostrado.
- A-02 — Alta: la política de grants aceptada se implementa mal o la federación queda incompleta, causando escalada. Mitigar con scopes, objeto/campo, versionado, JIT, doble aprobación y segregación de ADR-017. Seguridad/SOC/Identity. Cierre: matriz y 27 pruebas productivas aprobadas; estado operacional bloqueado.
- A-03 — Alta: raw recibido no durable o checkpoint adelantado causa pérdida. ADR-019 fija avance tras DURABLE, replay por dataset y garantía desde adquisición. Desarrollo/Platform. Cierre: fault injection y pilotos autorizados.
- A-04 — Alta: una baseline provisional se activa sin ratificación o una purga/hold elimina evidencia. ADR-018 bloquea TTL productivo y exige matriz, dry-run, restore, deletion ledger y purge receipts. Legal/Compliance/SOC/Infraestructura. Cierre: 20 pruebas y gate aprobados.
- A-05 — Alta: auditoría local editable o archivo atrasado. Mitigar cuentas separadas, atomicidad, manifiestos y verificación externa. Seguridad/Infraestructura. Cierre: comportamiento ante caída y manipulación demostrado. U-006.
- A-06 — Media/alta: compatibilidad Wazuh Indexer/carga compartida obliga duplicación de infraestructura. Inventariar versiones, capacidad y soporte; read-only primero. Platform. Cierre: prueba del port y presupuesto de carga. U-005.
- A-07 — Media/alta: APIs/licencias/rate limits impiden fuentes prometidas. Inventario `TO_BE_PROVIDED` y Pilot A/B; no marcar enabled sin validar. Dueño de proveedor/SOC. Cierre: 15 escenarios ADR-019 y evidencia de cursor/cobertura.
- A-08 — Media: modelo propio deriva en schema ad hoc y mappings rotos. Mantener núcleo, diccionario/versionado y corpus ECS/OCSF. Desarrollo/SOC. Cierre: fixtures de tres clases representativas y estrategia de evolución. U-010.
- A-09 — Media: ocho módulos derivan en monolito acoplado o en burocracia de ports. Ownership e imports comprobados; extraer solo por necesidad. Arquitectura. Cierre: vertical sin imports internos cruzados y revisión de límites.
- A-10 — Media: Python introduce segundo runtime y contratos incompatibles sin beneficio. Diferir hasta benchmark/caso real, schemas y fixtures comunes. Desarrollo/Platform. Cierre: valor medido frente a TypeScript/Wazuh. U-007.
- A-11 — Alta: consultas cold/exports se usan para exfiltrar o agotar recursos. ADR-017 acepta capability/scope/step-up y ADR-018 manifest, cifrado, expiración y custodia. Seguridad/Platform. Cierre: pruebas de acceso/revocación/cancelación/coste y expiración.
- A-12 — Media/alta: equipo pequeño no opera cola, stores, IdP y fuentes de forma fiable. ADR-020 exige modos, runbooks ejecutados, Service Owner y cobertura honesta 8x5/24x7. Cierre: 25 pruebas y recovery medido.
- A-13 — Media: references numéricas de skills antiguas apuntan ahora a otro ADR. Mitigar consultando índice y título; esta entrega solo modifica docs/. Dueño: mantenimiento del harness. Cierre: actualización futura autorizada de referencias fuera de docs/.
- A-14 — Alta: un mismo hecho directo y vía Wazuh duplica alertas o correlación. Política por dataset, nivel semántico, IDs estables y `relatedEventIds`; nunca deduplicar solo por timestamp/texto. Cierre: fixture de doble ruta en piloto.
- A-15 — Alta: publicar SOC 24x7 sin guardia ni escalamiento deja SEV1 sin respuesta. Declarar `LIMITED PRODUCTION / 8x5` hasta aprobar calendario, contactos, autoridad, handoff y política laboral.

No usar migración a microservicios como mitigación automática. Primero medir
aislamiento, capacidad y fallos reales; añadir distribución puede agravar A-12.
