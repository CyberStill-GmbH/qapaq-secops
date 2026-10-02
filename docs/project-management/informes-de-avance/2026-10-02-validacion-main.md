# Verificación local en `main` — 2026-10-02

**Base remota:** `c10ab65` (`origin/main` tras `git fetch origin main`).
**Ámbito:** cambios locales de la consola SOC, login institucional y prueba C-15;
no representa CI remoto ni aceptación de sistemas corporativos.

## Resultados

| Verificación | Resultado |
| --- | --- |
| `pnpm run verify` | PASS: formato, lint, 620/620 unitarias, 25/25 integración, typecheck, límites, build y 16/16 smoke |
| `pnpm run test:e2e` | PASS: 8/8; login sin API, recuperación del boundary, sesión, alertas, triaje, deduplicación, control de datos crudos, permisos de auditoría y estado degradado |
| C-06 PostgreSQL, Redis y MinIO | PASS: health y CRUD reales, digests fijados y cleanup sin recursos de la corrida. Evidencia ignorada: `artifacts/integration/c06-29d4eb7b-e8d7-4bce-ac46-e754a74ef6cf/environment-evidence.json` |
| C-15 observabilidad local | PASS: 1 log OTLP consultado en Loki, 1 métrica en Prometheus, 2/2 targets activos y Grafana healthy; datos sintéticos |

## Alcance y límites

El login revisa la sesión BFF y muestra el splash de QAPAQ durante la resolución;
la consola verifica capacidades para ordenar la navegación y las pruebas cubren
los flujos actuales contra la API local. El smoke C-15 usa payload sintético y
servicios locales. No acredita tenant Microsoft 365, Entra, Wazuh, Teams,
integración de productores QAPAQ, alta disponibilidad, restore, carga ni CI
remoto. Estos gates requieren sus endpoints y autorizaciones reales.

El test unitario del login y los E2E C-21/C-22 se actualizaron para comprobar el
splash y las pantallas SOC vigentes en vez de aserciones de la consola anterior.
La espera explícita a `/ready` de Loki evita que el smoke envíe OTLP antes de que
su ring de ingesters esté preparado.
