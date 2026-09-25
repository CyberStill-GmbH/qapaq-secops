# Daily Scrum — Informe de avance — 2026-09-25

**Sprint 1 — Base ejecutable y contratos** · 2026-09-19 a 2026-10-02  
**Facilitador:** Cesar Adrian Guevara Salcedo · **Zona horaria:** America/Lima

## Resumen ejecutivo

`main` fue revisada en `df44dc7` (2026-09-25, 09:58 Lima). Integra C-04 como
DONE y la base del harness C-06. La rama `codex/c06-ci-repair` contiene evidencia
adicional de aceptación real OpenSearch/Wazuh y la decisión de cierre C-06 como
DONE con excepción de capacidad limitada al entorno de pruebas; esa rama todavía
no forma parte de `main` en este corte.

## Avance en `main`

| Componente | Estado en `main` | Evidencia / lectura |
| --- | --- | --- |
| C-04 — admisión transaccional | DONE | Rechazo por pertenencia y límites, pruebas de aislamiento y merge integrado en `df44dc7` |
| C-06 — integración base | IN_PROGRESS en el corte | Harness PostgreSQL/Redis/MinIO, evidencia y suite base incorporados; el cierre E2E de la rama aún no estaba integrado |
| C-08 — integración externa | IN_PROGRESS | La lectura del plan mantiene pendientes de acceso autorizado y referencias de secretos |
| C-09 — gobierno de CI/main | IN_PROGRESS | CI existe; el estado de protección requerida de rama se debe confirmar |

## Trabajo de hoy en la rama de cierre C-06

- CI base acreditó dos ejecuciones concurrentes en checkout limpio con health,
  aislamiento y cleanup PASS para PostgreSQL, Redis y MinIO.
- OpenSearch QAPAQ 3.7.0 pasó TLS verificado, health GREEN, CRUD autenticado y
  cleanup.
- Wazuh 4.14.7 recibió un evento sintético por TCP syslog; la regla 100501 creó
  una alerta que se recuperó por API desde el índice diario.
- La decisión de cierre acepta la capacidad disponible del piloto Railway para
  pruebas aunque no demuestre el sizing del Compose oficial. La excepción queda
  documentada y no cambia los requisitos de despliegue.
- Se capturó evidencia JSON del resultado real y se renderizó una imagen legible.
  El proyecto temporal Railway se eliminó al terminar.

## Gates C-06 al corte de trabajo

| Gate | Estado |
| --- | --- |
| PostgreSQL, Redis, object storage: health/operaciones | PASS local y CI |
| Aislamiento concurrente y limpieza | PASS local y CI |
| OpenSearch con TLS, CRUD y limpieza | PASS Railway |
| Wazuh Manager → pipeline → Indexer y consulta API | PASS Railway |
| Capacidad del Compose oficial Wazuh | Excepción aceptada para pruebas; no acredita despliegue |
| C-06 global | DONE con excepción documentada, pendiente de merge a `main` |

## Plan y riesgos

1. Integrar la rama de cierre con CI verde y actualizar el corte de `main`.
2. Mantener como trabajo posterior la orquestación local de los perfiles
   `search`, `wazuh` y `full`.
3. Confirmar accesos autorizados y referencias de secretos para C-08.
4. Confirmar branch protection/checks requeridos de C-09.

**Cambio aceptado al Sprint Backlog:** C-06 acepta el entorno de prueba disponible
para cerrar la aceptación funcional. Se registra como excepción temporal de
capacidad de pruebas; sizing oficial continúa requerido para despliegue.

**Confianza en el Sprint Goal:** ÁMBAR. C-04 está cerrado y C-06 tiene aceptación
funcional completa en la rama; C-08 y la protección de `main` siguen requiriendo
confirmación. Este informe usa un wordmark tipográfico QAPAQ porque el repositorio
no contiene un recurso gráfico oficial de logo en sus informes de avance.

## Evidencia visual de C-06

La imagen se renderizó desde la salida JSON original real de la sonda Railway;
no se reconstruyeron resultados de prueba.

![Evidencia E2E real OpenSearch y Wazuh](../c-06/assets/2026-09-25-c06-railway-full-e2e.png)

Fuentes: [auditoría C-06](../../architecture/c-06-completeness-audit.md),
[plan y ejecución C-06](../c-06/README.md), y `origin/main` en `df44dc7`.
