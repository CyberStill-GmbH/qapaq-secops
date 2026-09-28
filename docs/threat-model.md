# Threat model inicial

Estado: PROPOSAL. Método: flujos y fronteras con categorías STRIDE; alcance de diseño,
sin escaneo ni pentest ejecutado. [Contexto](architecture/system-context.md).

## Activos y adversarios

Activos: credenciales de integraciones, datos de identidad, raw/evidencia, reglas,
permisos, estado de incidentes, historial de auditoría y continuidad de ingesta.
Adversarios: usuario interno con privilegios insuficientes, cuenta comprometida,
emisor de telemetría hostil, proveedor comprometido, atacante sobre CI/dependencias
y operador privilegiado con acceso a stores.

Fronteras principales: navegador/API; API/worker/stores; vendor/collector;
configuración/egress; audit/archive; CI/entorno productivo. Red interna no es
frontera suficiente para confiar.

## Escenarios y tratamiento

- T-01 — Spoofing: token mal validado o sesión revocada conserva acceso. ADR-017/025 fijan tenant explícito, validación OIDC, sesión BFF única, red QAPAQ, passkey, revocación/versionado y cuentas técnicas separadas. Probar los 35 escenarios antes de producción; residual: compromiso/configuración del IdP o borde.
- T-02 — Elevación: usuario cambia ID de case, campo de rol o asignaciones para leer/exportar o autoescalar. Capabilities + scope + objeto/campo + JIT, step-up y doble control privilegiado. Residual: implementación o matriz defectuosa; gate ADR-017 pendiente.
- T-03 — Tampering: payload vendor modifica reglas, ejecuta comandos o inyecta HTML/SQL. JSON Schema normativo, extensiones acotadas, cuarentena, escape, consultas parametrizadas y sin eval/shell interpolado. Probar fixtures maliciosos y hashes raw inválidos; residual: parser/SDK vulnerable.
- T-04 — SSRF/exfiltración: conector o nextLink apunta a destino no autorizado y arrastra token. Allowlist por proveedor, validar redirect/DNS y egress, no URLs arbitrarias. Probar destino alternativo; residual: host permitido comprometido.
- T-05 — Disclosure: raw/token/PII en logs, API, export o métrica. DTO allowlist,
  SecretProvider, redacción, métricas sin labels de alta cardinalidad y permisos
  separados; probar errores/logs/download. Residual: raw forense sensible requiere
  custodia estricta.
- T-06 — Repudiation: estado se confirma sin audit, un operador elimina eventos o
  un restore retrocede la cadena. ADR-021 exige transacción local, append-only,
  secuencia/hash, manifest firmado, WORM, llaves separadas y reconciliación.
  Probar los 24 escenarios; residual: colusión o compromiso simultáneo de datos,
  archive y signing service.
- T-07 — DoS: búsqueda amplia, restore cold, payload comprimido o fuente ruidosa agota recursos. ADR-020 añade modos, backpressure GREEN…RED, 2× carga y drenaje medido; residual: targets provisionales hasta benchmark.
- T-08 — Integridad: retries/replay generan alertas o respuestas duplicadas; mensajes se pierden entre stores. `eventUid` estable, `recordId` por recepción, descarte solo con identidad confiable, outbox/inbox, manifiestos y reconciliación; inyectar caídas. Residual: origen sin replay/ACK fiable o identidad derivada de baja confianza.
- T-09 — Retención: TTL provisional, restore o hold incompleto elimina o revive evidencia. ADR-018 bloquea borrado automático y exige manifests, WORM selectivo, dry-run, deletion ledger, purge receipts y 20 pruebas. Residual: matriz legal y capacidades del proveedor sin ratificar.
- T-10 — Supply chain: workflow de PR, metadata, caché o dependencia roba secretos, modifica el repo o publica un artifact. ADR-023 separa confianza: `pull_request`, permisos mínimos, sin secretos/publicación, Actions por SHA, CODEOWNERS, scanners, build-once, digest/SBOM/attestation y OIDC futuro acotado por ambiente. Residual: compromiso de proveedor/toolchain o configuración incorrecta; demostrar los ocho escenarios.
- T-11 — SOAR futuro: ejecución peligrosa se repite o aprobación se reutiliza con otros targets. Plan versionado y acotado, aprobación vinculada a parámetros, reautorización, idempotencia y resultado unknown. Residual: API externa sin garantías; no habilitar en MVP.
- T-12 — Poisoning: IOC/contexto falso o timestamps manipulados alteran prioridad/correlación. Procedencia, vigencia, validación temporal, calidad y revisión de reglas. Probar datos tardíos/inconsistentes; residual: fuente legítima informa datos erróneos.
- T-13 — Teams: fuga del webhook permite spam o exfiltración; una tarjeta falsa,
  enlace manipulado, owner huérfano o timeout ambiguo oculta o duplica avisos.
  SecretProvider, egress, payload allowlist, co-owner, deep link autenticado,
  `notificationId`, outbox y fallback reducen el riesgo. Residual: aceptación del
  endpoint no demuestra lectura y el proveedor puede permanecer indisponible.
- T-14 — Analítica futura: artifact, algoritmo o dependencia maliciosos permiten
  ejecución, exfiltración, poisoning o consumo excesivo. U-007 exige algoritmo
  allowlisted, checksums, schemas, sin secretos/egress/shell, límites, lockfile,
  resultado no confiable y revisión humana. Residual: supply chain y sesgo del
  dataset; Python permanece deshabilitado hasta superar el gate.

## Prioridad y límites

Antes de la primera vertical: T-01/02/05/06/08 y límites de T-07. Antes de collectors
reales: T-03/04/12. Antes de retención/exports productivos: T-09. CI requiere T-10;
respuesta automatizada futura requiere T-11. Esta prioridad es propuesta cualitativa,
no evaluación formal de probabilidad/impacto de Qapaq.
Antes de activar Python se revisa T-14 y se superan aislamiento, supply chain,
privacidad, reproducibilidad y límites de recursos de U-007.

Responsables sugeridos: Desarrollo implementa y demuestra; Seguridad valida
políticas/threat model; SOC valida comportamiento y evidencia; Infraestructura
valida aislamiento/backups/llaves. Confirmar dueños nominales sin registrar datos
personales aquí.

Actualizar modelo al incorporar proveedor, transporte, permisos de escritura,
nueva frontera o cambio de retención. Riesgo residual no se «acepta» por escribirlo;
registrar aprobación explícita por el responsable correspondiente.
