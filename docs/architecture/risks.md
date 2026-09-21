# Riesgos arquitectónicos

Estado: registro propuesto; prioridad cualitativa, sin aceptación de riesgos.

- A-01 — Alta: capacidad todavía no medida; Node, Redis o indexador pueden saturarse y afectar control plane. U-002 acepta límites, perfiles y gates, no una cifra de EPS. Mitigar con batches/backpressure, workers aislables y benchmarks reproducibles. Development/Platform. Cierre: publicar el mayor perfil aprobado con 30% de headroom y drenaje demostrado.
- A-02 — Alta: la política de grants aceptada se implementa mal o la federación queda incompleta, causando escalada. Mitigar con scopes, objeto/campo, versionado, JIT, doble aprobación y segregación de ADR-017. Seguridad/SOC/Identity. Cierre: matriz y 27 pruebas productivas aprobadas; estado operacional bloqueado.
- A-03 — Alta: raw recibido no durable o checkpoint adelantado causa pérdida. ADR-019 fija avance tras DURABLE, replay por dataset y garantía desde adquisición. Desarrollo/Platform. Cierre: fault injection y pilotos autorizados.
- A-04 — Alta: una baseline provisional se activa sin ratificación o una purga/hold elimina evidencia. ADR-018 bloquea TTL productivo y exige matriz, dry-run, restore, deletion ledger y purge receipts. Legal/Compliance/SOC/Infraestructura. Cierre: 20 pruebas y gate aprobados.
- A-05 — Alta: auditoría local editable, hash chain manipulada o archivo atrasado.
  ADR-021 acepta cuentas separadas, atomicidad, append-only, manifests firmados,
  reconciliación y fail-closed. Seguridad/Infraestructura. Cierre: superar los 24
  escenarios U-006 y registrar custodios, WORM, firma, canales y runbooks.
- A-06 — Media/alta: compatibilidad Wazuh Indexer/carga compartida obliga duplicación de infraestructura. Inventariar versiones, capacidad y soporte; read-only primero. Platform. Cierre: prueba del port y presupuesto de carga. U-005.
- A-07 — Media/alta: licencia, permisos, retención o conectividad impiden la ruta
  Microsoft 365/Wazuh. Inventario `TO_BE_PROVIDED`; no marcar enabled sin prueba
  real. Dueño de proveedor/SOC. Cierre: gate ADR-024 y evidencia de cobertura,
  checkpoint y degradación.
- A-08 — Media: el contrato propio se implementa distinto entre productores,
  consumidores o mappings. ADR-011 fija JSON Schema 2020-12, SemVer, corpus,
  cuarentena, identidad prudente y perfiles ECS 9.5.0/OCSF 1.9.0. Desarrollo/SOC.
  Cierre: completar los doce criterios de U-010, incluido mapping de alertas Wazuh
  derivadas de Microsoft 365, replay, integridad raw y reporte de cobertura.
- A-09 — Media: ocho módulos derivan en monolito acoplado o en burocracia de ports. Ownership e imports comprobados; extraer solo por necesidad. Arquitectura. Cierre: vertical sin imports internos cruzados y revisión de límites.
- A-10 — Media: activar Python sin valor probado introduce segundo runtime y contratos incompatibles. U-007 lo mantiene dormante hasta caso real, baseline, schemas, fixtures, benchmark y 18 pruebas. Desarrollo/Platform. Cierre: valor medido frente a TypeScript/Wazuh/OpenSearch.
- A-11 — Alta: consultas cold/exports se usan para exfiltrar o agotar recursos. ADR-017 acepta capability/scope/step-up y ADR-018 manifest, cifrado, expiración y custodia. Seguridad/Platform. Cierre: pruebas de acceso/revocación/cancelación/coste y expiración.
- A-12 — Media/alta: equipo pequeño no opera cola, stores, IdP y fuentes de forma fiable. ADR-020 exige modos, runbooks ejecutados, Service Owner y cobertura honesta 8x5/24x7. Cierre: 25 pruebas y recovery medido.
- A-13 — Media: references numéricas de skills antiguas apuntan ahora a otro ADR. Mitigar consultando índice y título; esta entrega solo modifica docs/. Dueño: mantenimiento del harness. Cierre: actualización futura autorizada de referencias fuera de docs/.
- A-14 — Alta: una futura ruta directa y Wazuh duplican el mismo hecho. El MVP usa
  una sola ruta Microsoft 365 → Wazuh. Antes de habilitar otra, definir política
  por dataset, IDs estables y `relatedEventIds`, y probar ambas rutas reales; nunca
  deduplicar solo por timestamp/texto.
- A-15 — Alta: publicar SOC 24x7 sin guardia ni escalamiento deja SEV1 sin respuesta. Declarar `LIMITED PRODUCTION / 8x5` hasta aprobar calendario, contactos, autoridad, handoff y política laboral.
- A-17 — Alta: mezclar CI no confiable con publicación o despliegue expone secretos
  y cadena de suministro. ADR-023 separa pipelines, permisos, artifacts y ambientes;
  bloquea CD hasta contrato real. Cierre: mismo digest promovido y ocho pruebas.
- A-16 — Alta: Teams acepta, retrasa, duplica o pierde visibilidad de una tarjeta;
  un secreto filtrado permite mensajes no autorizados. ADR-022 exige outbox,
  idempotencia, payload minimizado, SecretProvider, owner alterno, métricas, acuse
  en QAPAQ y fallback. Cierre: datos operacionales y 20 pruebas aprobadas.

No usar migración a microservicios como mitigación automática. Primero medir
aislamiento, capacidad y fallos reales; añadir distribución puede agravar A-12.
