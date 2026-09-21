# Informe de revisión de consistencia

Fecha: 2026-09-19 · Alcance revisado: rama `docs` en `2a5d2ca`, ADR-001…024,
C4, arquitectura, inventario, CI/CD, backlog, testing, threat model, árbol Git e
issues GitHub. No existe código de aplicación ni issues; la implementación es cero.

## Resultado cuantitativo

- 36 requisitos funcionales: RF-001…RF-036.
- 37 requisitos no funcionales: RNF-001…RNF-037.
- 17 entradas de decisión/gap: U-001…U-017, sin duplicar U-001…U-012.
- 24 capacidades clasificadas como MVP, posterior o pendiente.
- 13 objetivos/capacidades enlazados con requisitos, ADR y pruebas.

## Contradicciones y resoluciones documentales

1. **Roles informales frente a ADR-017:** `ADMIN/USER` no son roles universales
   vigentes. Se documentan `PLATFORM_ADMIN`, `ACCESS_ADMIN` y `VIEWER`; SOC L1/L2 y
   AUDITOR se preservan. U-013 debe cerrar el catálogo por endpoint.
2. **Pilotos sucesivos frente a vertical vigente:** ADR-024 sustituye el orden
   anterior. El MVP tiene una sola fuente empresarial, Microsoft 365, recolectada
   por Wazuh; Cato/Sophos y Graph directo son posteriores.
3. **Wazuh como componente frente a producto QAPAQ:** Wazuh recolecta, aplica su
   ruleset y produce alertas base. QAPAQ conserva SecurityEvent, prioridad
   complementaria, RBAC, casos, auditoría, búsqueda y notificaciones.
4. **Compatibilidad ECS/OCSF:** son perfiles/mappings por demostrar; no se afirma
   conformidad por nombrarlos.
5. **Métricas provisionales frente a objetivos aprobados:** valores como acuse de
   15 minutos o Teams p95≤60 s se tratan como propuestas pendientes de ratificación,
   no como SLO logrado. EPS, disponibilidad, RPO/RTO y retención permanecen `TBD`.
6. **CI diseñado frente a integración:** el pipeline está en PR #2, separado de la
   rama documental. GHAS/Dependency Review no está habilitado; U-016 registra el gap.

## Revisión de calidad

- Cada RF tiene actor/sistema, trigger/precondición, input/validación, resultado,
  fallo, datos/auditoría, autorización, prioridad/estado/fuente, aceptación y método.
- Cada RNF contiene escenario, estímulo/condición, respuesta, métrica o `TBD`,
  medición/ambiente, responsable, estado/fuente e impacto.
- No se atribuyen licencias, cuotas, ediciones, datasets, retención o replay reales
  a Microsoft, Wazuh, Cato o Sophos.
- No se declara código, infraestructura, integración o capacidad implementada.
- Raw, alerta Wazuh, SecurityEvent, alerta QAPAQ, incidente/caso y notificación se
  distinguen y enlazan.
- Toda capacidad MVP tiene RF, control de acceso/auditoría aplicable y prueba trazada.

## Listo para desarrollo

Pueden implementarse dominio y specs de identidad/política, SecurityEvent,
idempotencia, checkpoint, cuarentena, lineage, alerta/lifecycle, caso mínimo,
outbox Teams, audit writer, ports/adapters, modos y reglas de dependencia. Las
integraciones pueden construir su adapter y provider spec, pero no declararse
funcionales sin acceso real.

## Evidencia faltante para piloto

- tenant/app Entra y escenarios de federación;
- versión/edición/dataset/permisos/red de Microsoft 365 y Wazuh;
- actividad sintética autorizada y alerta Wazuh verificable;
- stores reales aislados, schema/corpus/mapping SecurityEvent;
- Team/workflow/secretRef y provider spec;
- ejecución E2E sin fakes y evidencia PASS/FAIL/BLOCKED.

## Evidencia faltante para producción

Matriz Legal/Compliance; WORM/firma/custodios; Collector/backends/canales; SLO,
capacidad, RPO/RTO, restores y runbooks ejecutados; cobertura de soporte; fallback
Teams; catálogo RBAC final; límites de búsqueda/export; registro/identidad/ambientes,
SBOM/attestation y rollback; cierre o aceptación formal de U-013…U-017.

## Verificaciones de esta entrega

Se verifican enlaces relativos, IDs únicos/contiguos, campos obligatorios de RF/RNF,
estado/origen, conteos, fences Markdown, YAML de inventario y `git diff --check`.
No se ejecutan tests de aplicación, provider specs, benchmarks, scans del PR de CI,
federación ni E2E porque no existen aplicación ni entornos autorizados en esta rama.
