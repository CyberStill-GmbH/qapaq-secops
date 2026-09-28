# C-08 — contrato operativo y probe Wazuh

**Estado al 2026-09-25: DONE PARA SPRINT 2, POR EXCEPCIÓN DEL PRODUCT OWNER.**
La decisión permite avanzar Sprint 2 con el contrato local disponible. La
aceptación técnica integral de C-08 queda como gate obligatorio del E2E final del
MVP; no se afirma que Manager/Indexer reales hayan pasado esta sesión.

Este componente publica el puerto neutral `SecurityEventProvider` y una primera
implementación read-only para consultar alertas del Wazuh Indexer. El estado de planificación es `DONE` para habilitar Sprint 2 por excepción
explícita del Product Owner. La aceptación de integración real sigue pendiente:
todavía no se ha ejecutado el mismo contrato contra Manager e Indexer reales con
una identidad autorizada de solo lectura. El probe del Manager está
implementado en código; el flujo de inyección sintética exigido para la aceptación
completa sigue pendiente.

## Cambios implementados

- Contratos neutrales de capabilities, health, query, page, record y error en
  `modules/connectors/src/application/security-event-provider.ts`.
- Provider Wazuh con búsqueda read-only de alertas, allowlist de índice, orden
  `timestamp` + `id`, `search_after` y cursor versionado con HMAC, TTL y enlace a
  fuente/dataset/rango/tamaño.
- Health separado para Manager e Indexer. El cliente Manager obtiene JWT por el
  endpoint oficial, mantiene el token en memoria y evita renovaciones concurrentes
  con single-flight; Indexer health y errores HTTP se exponen con códigos seguros.
- El cliente OpenSearch existente conserva HTTPS, CA explícita y
  `rejectUnauthorized: true`; ahora implementa la interfaz interna de lectura y
  cierre del provider.
- Configuración C-03 para índice/dataset permitidos, secreto de firma de cursor,
  TTL, límites y credenciales/CA separadas del Manager. Los secretos solo se
  materializan mediante `SecretProvider`.
- Contract suite reusable con 18 verificaciones para capabilities, health,
  resultados, orden, determinismo, paginación, cursores, límites, cancelación,
  errores, neutralidad y escrituras; pruebas unitarias del provider y cierre.

## Límites y criterios pendientes

| Criterio | Estado | Evidencia o bloqueo |
| --- | --- | --- |
| Puerto y tipos neutrales | PASS local | Barril público exporta el contrato, no DTO OpenSearch/Wazuh |
| Consulta Indexer read-only, allowlist y cursor firmado | PASS unitario | No sustituye la verificación de mapping real |
| Health Manager en código | PASS local | `WazuhManagerClient` autentica por JWT y consulta `/manager/status`; falta prueba TLS/autenticación real |
| Contract suite portable (18 criterios) | PASS en harness controlado | La prueba del provider ejecuta la suite contra un cliente simulado; no cuenta como aceptación real |
| CA/TLS y autenticación reales | BLOQUEADO | No hay URLs, referencias de secretos ni CA del servicio actual |
| Tie-breaker estable del mapping | BLOQUEADO | Confirmar mapping real del alias autorizado; `id` aún no tiene esa evidencia |
| Retry-After/backoff y límite de respuesta | PASS unitario parcial | Lectura idempotente reintenta 429/502/503/504; el límite se verifica tras parseo del cliente OpenSearch |
| Cancelación | PARCIAL | Manager aborta la petición HTTPS; Indexer usa el abort de OpenSearch; falta contrato para timeout/cancelación integrados |
| Suite C-06 misma contract suite sobre provider Wazuh | DIFERIDO A E2E MVP | No hay acceso operativo: Docker Desktop falla, endpoints locales no responden y el proyecto Railway aislado está vacío |
| Evento sintético Manager → Indexer → provider | BLOQUEADO | Requiere Manager real, ruta de entrada y permisos autorizados |
| Permiso read-only demostrado | BLOQUEADO | Falta identidad/rol de prueba y verificación denegada de escritura |
| Credencial y CA inválidas reales | BLOQUEADO | Requiere un target TLS real con credenciales autorizadas |
| Versiones/digests fijados | PASS de procedencia; falta ligarlos a C-08 | Manager e Indexer 4.14.7 y digests resueltos en un despliegue C-06 previo se fijaron en `platform/testing/integration-environment.lock.json`; no prueban esta ejecución C-08 |

La sesión no encontró variables `QAPAQ_WAZUH_*` configuradas y `docker info`
reportó cero CPU/memoria y sin versión del servidor. La evidencia del smoke de
C-06 conservada bajo `docs/project-management/c-06/` es de otro probe y no demuestra
este provider, su autenticación least-privilege ni el mapping usado por la
paginación.

## Configuración C-03 añadida

Ejemplo ficticio (valores de secreto siempre son referencias):

```dotenv
QAPAQ_WAZUH_INDEXER_URL=https://wazuh-indexer.example.test:9200
QAPAQ_WAZUH_USERNAME_REF=secret://production/wazuh-reader-user
QAPAQ_WAZUH_PASSWORD_REF=secret://production/wazuh-reader-password
QAPAQ_WAZUH_CA_REF=secret://production/wazuh-indexer-ca
QAPAQ_WAZUH_ALLOWED_INDEX=wazuh-alerts-*
QAPAQ_WAZUH_DATASET=wazuh-alerts
QAPAQ_WAZUH_CURSOR_SECRET_REF=secret://production/wazuh-cursor-hmac
QAPAQ_WAZUH_CURSOR_TTL=1m
QAPAQ_WAZUH_MAX_RESPONSE_BYTES=10485760
QAPAQ_WAZUH_MANAGER_API_URL=https://wazuh-manager.example.test:55000
QAPAQ_WAZUH_MANAGER_USERNAME_REF=secret://production/wazuh-manager-reader
QAPAQ_WAZUH_MANAGER_PASSWORD_REF=secret://production/wazuh-manager-password
QAPAQ_WAZUH_MANAGER_CA_REF=secret://production/wazuh-manager-ca
```

El principal de Indexer debe poder consultar solamente los aliases/índices
autorizados `wazuh-alerts-*` y leer los metadatos de cluster necesarios para
health. No debe tener privilegios de create, index, update, delete, manage ni
administración de roles. Un responsable de Infraestructura debe verificar que
la lectura de alertas funciona y que una operación de escritura de prueba se
deniega. Manager requiere una credencial separada de lectura cuando se complete
su cliente.

## Checks ejecutados

```text
pnpm --filter @qapaq/connectors typecheck                         PASS
pnpm exec vitest run --config vitest.config.ts modules/connectors/test/wazuh-security-event.provider.spec.ts  PASS (26; 18 contract checks on simulated client)
pnpm run test:unit                                             PASS (237/237)
pnpm run typecheck                                            PASS
pnpm run lint                                                 PASS
pnpm run boundaries                                           PASS (123 modules / 168 dependencies)
```

La salida JSON de Vitest y su imagen reproducible están en `assets/2026-09-25-c08-contract-run.json`
y `assets/2026-09-25-c08-contract-suite.png`. La imagen muestra el límite del
harness simulado; no pretende ser evidencia de una consulta Wazuh real.

## Gate obligatorio de aceptación final del MVP

Antes de anunciar `DONE`, habilitar el entorno versionado C-06 con sus digests,
CA, credenciales distintas para Manager e Indexer, principal Indexer read-only y
ruta sintética aprobada. La aceptación debe arrancar por esa ruta, ejecutar el
probe separado de ambos componentes, consultar el marcador por
`SecurityEventProvider`, validar paginación y denegaciones reales, capturar logs
sanitizados/versiones/commit y limpiar solo los recursos de la corrida. En este
checkout todavía no existe un comando de integración C-08 honesto que realice
esos pasos; se añadirá junto al harness real en vez de reportar como PASS un
comando unitario o una consulta de datos preexistentes.

## Estado final

**DONE PARA SPRINT 2 POR EXCEPCIÓN DEL PRODUCT OWNER (2026-09-25);
ACEPTACIÓN TÉCNICA REAL PENDIENTE.** El estado Done se limita a la planificación
de Sprint 2. La consulta autorizada real sigue siendo obligatoria antes de aceptar
el MVP y no se registra como PASS. Railway CLI está autenticado y se creó el proyecto vacío
`qapaq-c08-wazuh-e2e-20260925` (`332d1f74-bd01-417e-8173-d26318713946`), pero
ninguna máquina está desplegada ni hay autorización/secreto indexer y manager
disponible en el entorno actual. No se incorporaron secretos reales al repo ni
se registraron en logs.
