# Diferencial SOC sobre Wazuh — contexto, correlación, persistencia y M365 como código

Fecha: 2026-10-11 · Alcance: C-12, C-16, C-17 y la integración Microsoft 365 → Wazuh
(ADR-024). Rama: `codex/mvp-backend-role-deploy`.

## Por qué

El análisis de rol SOC del 2026-10-11 concluyó que QAPAQ era, en la práctica, un visor de
alertas de Wazuh con un workflow encima. El dashboard de Wazuh ya resuelve detección y
búsqueda por evento; QAPAQ se justifica solo si responde lo que Wazuh no responde: qué
importa para el negocio, qué alertas forman un mismo incidente y quién hace qué con
trazabilidad. Cinco hallazgos lo impedían:

| # | Hallazgo | Corrección |
| --- | --- | --- |
| 1 | Contexto de priorización vacío: P1–P4 solo reetiquetaba `rule.level` | Contexto por configuración (`QAPAQ_DETECTION_*`), ruleset 1.1.0 con break-glass |
| 2 | La normalización de Office 365 solo extraía `UserId` | Mapping Wazuh 1.1.0 con sub-mapping Office 365 |
| 3 | El runtime instanciaba `InMemorySoc`: un reinicio borraba alertas e incidentes | `SocPersistence` con adapter PostgreSQL |
| 4 | Módulo `office365` y reglas locales fuera del repositorio | `infra/wazuh/office365/` y workflow SSM |
| 5 | Sin correlación: cada alerta de Wazuh era una alerta SOC aislada | Correlación por entidad y cadena de compromiso de cuenta |

## Qué cambió

### Contexto de negocio (C-16)

`platform/configuration/src/schema/detection.schema.ts` carga, por ambiente y nunca desde
el repositorio:

| Variable | Contenido | Efecto |
| --- | --- | --- |
| `QAPAQ_DETECTION_PRIVILEGED_IDENTITIES` | UPN separados por coma | `PRIVILEGED_IDENTITY` +15 |
| `QAPAQ_DETECTION_BREAK_GLASS_IDENTITIES` | UPN de emergencia | `BREAK_GLASS_IDENTITY`: siempre P1 y no suprimible |
| `QAPAQ_DETECTION_CRITICAL_ASSETS` | IDs o nombres de activo | `CRITICAL_ASSET` +15 |
| `QAPAQ_DETECTION_INTERNET_FACING_ASSETS` | IDs o nombres | `EXTERNAL_EXPOSURE` +10 |
| `QAPAQ_DETECTION_KNOWN_BENIGN_RULES` | `ruleId:referencia` | Suprime, pero exige referencia documental |

Todas son opcionales. Una entrada mal formada falla al arrancar, en vez de ignorarse en
silencio. Identidades y activos se comparan sin distinguir mayúsculas.

### Normalización Office 365 (C-12, mapping 1.1.0)

`modules/telemetry/src/wazuh-office365.ts` extrae:

- la operación como `action` (`office365.new-inboxrule`);
- el UPN con dominio;
- la IP de cliente validada (sin puerto, IPv4/IPv6);
- el workload y el objeto;
- el resultado (`ResultStatus` y operaciones de login);
- la extensión `microsoft.office365` con escalares declarados.

`Parameters` y `ModifiedProperties` no se copian: pueden contener direcciones de reenvío o
datos personales y quedan en el crudo. `data.srcip` se declara como recurso IP en cualquier
alerta Wazuh.

### Correlación (C-16)

`modules/detection/src/correlation.ts` es puro y determinista:

- **Claves de entidad**: `user:<upn>` e `ip:<ip>`.
- **Agrupación**: alertas que comparten clave en 24 h. Con tres o más relacionadas suma
  `CORRELATED_ENTITY` (+10).
- **Repetición**: misma regla sobre la misma entidad en 1 h (`REPEATED_ACTIVITY`).
- **Cadena `m365.account-compromise`**: una alerta previa de acceso (credential_access o
  initial_access) sobre el **mismo usuario**, seguida de persistencia, escalamiento,
  evasión, recolección o exfiltración en 24 h. Suma `ATTACK_CHAIN` (+25) y no se suprime.
  Una IP compartida agrupa, pero no basta para afirmar que fue el mismo actor.

La clase de señal sale, en este orden, de: el grupo de regla `qapaq_<táctica>`, el catálogo
`acción → señal` que entrega el composition root (`apps/api/src/runtime/signal-catalog.ts`) y
la categoría. El dominio no nombra al proveedor (C-23).

Cada alerta conserva `entityKeys`, `signal`, `ruleId` y `relatedAlertIds` (una fotografía
al promover). La API acepta `GET /api/alerts?entity=user:<upn>` o `ip:<ip>`.

### Persistencia (C-17)

- Puerto `SocPersistence` (`modules/soc/src/ports.ts`): unidad de trabajo, lecturas, relay del
  outbox y ventana de correlación.
- `InMemorySoc` para specs y desarrollo; `PostgresSocPersistence` en el subpath
  `@qapaq/soc/postgres`, que se carga de forma diferida para que el runtime en memoria no
  cargue Prisma.
- Migración `20261011120000_c16_c17_correlation_soc_outbox`: columnas de correlación con
  índice GIN, CHECK de catálogo y topes, y tabla `soc_outbox_messages`. Esta tabla es
  separada porque `outbox_messages` tiene FK a manifiestos de C-04.
- La cadena de auditoría toma un advisory lock por tenant. El store fuera de transacción
  verifica la cabeza antes de escribir, así los escritores concurrentes no bifurcan la
  cadena.
- Cola durable del outbox (D-7): el despacho de C-20 reclama directamente de
  `soc_outbox_messages` con un claim atómico (`FOR UPDATE SKIP LOCKED`) y un lease persistido
  (`lease_until`, 2 min). Si el despachador muere, el lease vence y otro proceso reclama el
  mensaje; la idempotencia del intento evita la segunda notificación. Ya no hay copia a
  memoria: la revisión de Codex detectó que el relay anterior marcaba como entregado antes
  de enviar y podía perder un crítico ante un reinicio.
- `QAPAQ_SOC_PERSISTENCE` (`memory` | `postgres`) **sin valor por defecto en producción**. El
  modo efectivo se registra al arrancar (`soc.persistence.<modo>`) y la readiness falla si
  PostgreSQL no responde o falta la migración.
- La cadena de auditoría ahora es una sola: inicio de sesión, casos de uso SOC y despacho
  escriben en el mismo store. Antes la consulta de auditoría no veía las acciones SOC.

- Despacho continuo (D-8): `NotificationDispatcher` corre dentro del API, cada 5 s y cuando
  un caso de uso encola algo. Antes un P1 solo salía a Teams si alguien llamaba
  `POST /api/notifications/drain`; ese endpoint queda para operación y exige la nueva
  capability `notifications.dispatch` (líder SOC y admin de plataforma).
- Intentos de notificación en PostgreSQL (`notification_attempts`, adapter
  `@qapaq/soar/postgres`, base de Codex): en modo `postgres` se persisten junto con la cola.

Siguen en memoria: sesiones, handshakes OIDC y lockout/rate limit.

### Microsoft 365 → Wazuh como código

Ver [infra/wazuh/office365](../../infra/wazuh/office365/README.md): 22 reglas locales con
MITRE, script idempotente con respaldo y restauración, workflow SSM con modo `render` y
contenedores de secreto en Terraform que no reemplazan la instancia.

## Evidencia

| Verificación | Resultado | Cómo reproducir |
| --- | --- | --- |
| Unit (telemetry, detection, soc, configuration, api, arquitectura) | PASS | `pnpm test:unit` |
| Adapter PostgreSQL contra PG 18.6 real (reinicio, idempotencia, GIN, cadena concurrente, integridad) | PASS (corrida del 2026-10-11, antes del cambio a cola con lease) | `DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts modules/soc` |
| Cola con lease, fencing y despacho durable en PG real (claim concurrente, lease vencido, token viejo rechazado, caída tras entregar sin doble notificación, intentos persistidos) | PASS 10/10 (2026-10-12) | `DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts modules/soc modules/soar` |
| Roles de mínimo privilegio en PG real (sin DDL, DELETE ni UPDATE de auditoría para el runtime; tablas del migrator; bootstrap idempotente) | PASS 7/7 (2026-10-12); destapó el `CREATE` sobre la base que necesitaba el migrator | `platform/database/test/postgres-roles.integration.spec.ts` |
| `platform/database` completo en PG real (C-04, C-19, C-20, C-24, migraciones) | PASS 59/59 con la versión de HEAD de `commit-admission.ts` (el WIP actual no compila) | `DATABASE_URL=… pnpm --filter @qapaq/database test` |
| Bucle de despacho (un vuelo, ráfagas, errores, apagado) y capability `notifications.dispatch` | PASS | `pnpm exec vitest run --config vitest.config.ts apps/api` |
| `platform/database` con PG real (54 casos, incluida la migración nueva) | PASS con la versión de HEAD de `commit-admission.ts` | `DATABASE_URL=… pnpm --filter @qapaq/database test` |
| Smoke del BFF en modo postgres: break-glass con severidad baja → P1/100; persiste tras reiniciar; repetición → `duplicate` | PASS | ver sección "Reproducir el smoke" |
| Resolución de producción (`dist`, sin condición `development`) | PASS | `pnpm --filter '@qapaq/api...' run build` |
| Reglas Wazuh con `wazuh-logtest` 4.14.7 (43 casos, incluidas frecuencia, spray y CDB) | PASS 43/43 | `infra/wazuh/office365/tests/run-logtest.sh` |
| Variantes de C-4 (PIM, Conditional Access, mayúsculas; casos 44–48) y lista break-glass desde el ejemplo | PASS 48/48 (2026-10-12) | ídem |
| `apply-office365.sh` en manager real: `analysisd -t`, módulo iniciado, idempotente, 0640 `root:wazuh` | PASS | README de `infra/wazuh/office365` |
| Recolección desde tenant real | **BLOCKED** | requiere tenant, app y secreto autorizados |
| Despliegue demo con PostgreSQL | **PENDIENTE** | migraciones en el pipeline, CA de RDS, usuario de aplicación |

## Limitaciones declaradas

- La correlación opera sobre alertas promovidas, no sobre todo el volumen de eventos.
- Los listados leen hasta 2.000 filas por filtro y paginan en el BFF; el total es exacto. Si
  el volumen medido lo exige, se pasa a keyset en SQL sin cambiar el contrato HTTP.
- Las reglas 100520, 100523 y 100525 dependen de nombres de operación que se deben confirmar
  en el tenant.
- El demo se despliega con `QAPAQ_SOC_PERSISTENCE=memory` explícito hasta completar el
  rollout de PostgreSQL.

## Reproducir el smoke

```bash
QAPAQ_PROFILE=development QAPAQ_SOC_PERSISTENCE=postgres \
QAPAQ_POSTGRES_HOST=127.0.0.1 QAPAQ_POSTGRES_PORT=55432 QAPAQ_POSTGRES_DATABASE=qapaq_smoke \
QAPAQ_POSTGRES_USERNAME=qapaq QAPAQ_POSTGRES_PASSWORD=<local> \
QAPAQ_DETECTION_BREAK_GLASS_IDENTITIES=bg-01@qapaq-lab.example \
node --import tsx --conditions=development apps/api/src/main.ts
```

Con la base migrada (`pnpm --filter @qapaq/database migrate:deploy`), enviar un
SecurityEvent de login de `BG-01@qapaq-lab.example` a `POST /api/ingest/security-events`,
reiniciar el proceso y repetir el envío.
