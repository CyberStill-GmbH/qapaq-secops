# 09 · Plan de lanzamiento

El producto se sirve desde el Wazuh Dashboard modificado en
`https://qapaq-secops.jappi.net.pe`. `apps/web` y Vercel dejan de ser el frontend; el backend
TypeScript, PostgreSQL y KrakenD se conservan. Cada fase requiere evidencia verificable. **Este
plan no afirma que un apply o despliegue se haya realizado.**

## Fase 0 · Completar el candidato

| Tarea | Aceptación |
| --- | --- |
| Integrar los cambios del Dashboard y plugin QAPAQ sobre la versión Wazuh fijada por el repo | Build reproducible para la versión runtime y verificación de los assets de login |
| Retirar `apps/web` de workspace, builds, scripts, CI, smoke tests y documentación de runtime | No quedan dependencias ejecutables ni builds Docker que requieran `apps/web` |
| Cerrar API same-origin del plugin en `/qapaq-api/api` | Pruebas del plugin/API cubren login, sesión, casos, auditoría, revocación y Teams |
| Completar Valkey HA y BullMQ | Caché de TTL breve con fallback; el worker procesa el outbox durable de PostgreSQL; polling del API sigue disponible |
| Revisar CI, límites de dependencias y documentación | CI verde; documentación y runbooks describen el mismo diseño |

## Fase 1 · Gate de identidad y preparación de infraestructura

| Tarea | Aceptación |
| --- | --- |
| Registrar en Entra el callback exacto `https://qapaq-secops.jappi.net.pe/qapaq-api/api/auth/callback` | La URI exacta está presente y validada en la aplicación Entra |
| Preservar secretos existentes | Se reutiliza el client secret actual; el plan no rota ni publica una versión nueva |
| Preparar DNS, TLS y proxy del host Wazuh | `qapaq-secops.jappi.net.pe` sirve Dashboard y enruta `/qapaq-api/` al ALB API; `wazuh.jappi.net.pe` se conserva como alias temporal |
| Reconciliar Terraform, state remoto y recursos AWS | Cuenta, región y state confirmados; plan guardado y revisado recurso por recurso |
| Mantener runtime de negocio | Plan conserva API, PostgreSQL, KrakenD, Wazuh/volúmenes, secretos, buckets y roles de despliegue |
| Incorporar Valkey y worker resilientes | Valkey Multi-AZ y servicio ECS worker en subredes privadas; ningún cambio destructivo no previsto |

**Gate:** no hacer cutover del login hasta confirmar el alta de redirect URI en Entra. No cambiar
ni rotar secretos para sortear este gate. No aplicar un plan que destruya o reemplace recursos
durables o credenciales.

## Fase 2 · Cutover de interfaz

| Tarea | Aceptación |
| --- | --- |
| Publicar Dashboard modificado, plugin, login y artefactos inmutables | Build y digest verificados corresponden al código revisado |
| Probar login Entra en `qapaq-secops.jappi.net.pe` | Login, cookie, sesión única, logout y revocación funcionan con la URI ya registrada |
| Probar las vistas del plugin contra la API real | Casos Ayni Qapaq, timeline/tareas, auditoría, usuarios y notificaciones responden correctamente |
| Probar permisos y proxy auth | Usuario ve solo las capacidades e índices autorizados; revocación corta el acceso |
| Retirar el frontend Vercel | Tras aprobar salud funcional, un segundo plan elimina los DNS `app`/`codexpt`; conserva los dominios API y sus recursos |
| Verificar estabilidad y rollback | Logs/health checks sin errores; se conoce la reversión DNS/artefacto sin recrear ni rotar secretos |

El criterio de aceptación es que el plugin Wazuh entregue interfaz y login QAPAQ en la URL
objetivo y que la API TypeScript continúe atendiendo sus flujos. La retirada de Vercel no equivale
a retirar el API ni a destruir su infraestructura.

El primer apply mantiene el alias Wazuh anterior y los DNS Vercel para rollback. El plan de limpieza
se ejecuta después del smoke funcional y muestra únicamente el retiro explícito de esos registros.

## Fase 3 · Resiliencia de caché y notificaciones

| Tarea | Aceptación |
| --- | --- |
| Validar caché de eventos en Valkey | Claves separan usuario/tenant/permisos/filtros; expiración corta; fallo de caché vuelve a la fuente |
| Validar wake-up BullMQ y worker ECS | Outbox de PostgreSQL se drena con reintentos; worker espera su trabajo en curso al apagarse |
| Simular caída de Valkey o worker | Sin pérdida de casos/auditoría/notificaciones; API polling reanuda el drenaje |
| Observar retraso y errores | Logs y métricas permiten distinguir API, Valkey, cola, worker y PostgreSQL |

## Fase 4 · Diferencial y SOAR

| Tarea | Aceptación |
| --- | --- |
| Actualización en vivo en el plugin | Long-poll/fallback muestra cambios sin romper el proxy |
| Correlación y Anomaly Detection | Evidencia sintética reproduce el resultado y la prioridad con su explicación |
| Ingesta push y reconciliación | Una alerta de prueba llega con latencia acordada sin duplicarse |
| Ankay Qapaq (Shuffle) | Siguiente scope separado: red privada, aprobación, idempotencia y auditoría probadas |
| Archivo WORM de auditoría | Manifiesto se valida contra `GET /api/audit/verify`; gate de retención revisado |

## Fuera de este lanzamiento

Migrar a Wazuh 5, cambiar la zona DNS raíz, sustituir KrakenD, eliminar API/backend o rotar secretos.
Cada cambio requiere decisión y plan específicos. Consultar [10 · Decisiones](10-decisiones.md).
