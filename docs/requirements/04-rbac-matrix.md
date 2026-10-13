# Matriz de actores, recursos, acciones y ámbitos

Estado: los bundles destino están confirmados por ADR-017; el runtime presente solo
implementa los cuatro `qapaq.*` del inventario. Capabilities con `*` son propuestas hasta
cerrar U-013. Toda celda está sujeta a scope, estado del recurso, vigencia y deny
global. No existe un rol `ADMIN` universal: el término informado se divide en
`PLATFORM_ADMIN` y `ACCESS_ADMIN`. `USER` se representa como `VIEWER`.

Leyenda: **P** permitido por bundle; **C** condicionado a grant/step-up/aprobación;
**—** no incluido. Una P nunca supera el scope asignado.

| Recurso / acción | L1 | L2 | Manager | Detection Eng. | Auditor | Viewer | Platform Admin | Access Admin | Ámbito/control |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Alertas · leer | P | P | P | C | C | P | — | — | unidad/equipo/caso |
| Alertas · acusar/clasificar | P | P | P | — | — | — | — | — | scope y estado |
| Alertas · cerrar crítica | — | C | P | — | — | — | — | — | motivo; aprobación según política |
| Incidentes · crear/asignar | P | P | P | — | — | — | — | — | scope operativo |
| Incidentes · lifecycle/cerrar | — | P | P | — | — | — | — | — | guardas y concurrencia |
| Casos · leer/notas | P | P | P | — | C | C | — | — | caso asignado/permitido |
| SecurityEvents · buscar | P | P | P | C | C | P | — | — | dataset/source/scope |
| Raw/evidencia · leer | — | C | C | — | C | — | — | — | capability separada, propósito/step-up |
| Evidencia · adjuntar | C | P | P | — | — | — | — | — | caso y clasificación |
| Evidencia/raw · exportar | — | C | C | — | C | — | — | — | aprobación, expiración, auditoría |
| Auditoría · leer | — | C | P | — | P | — | C | C | función y scope; soporte técnico limitado |
| Auditoría · exportar | — | — | C | — | C | — | — | — | capability explícita; nunca por lectura |
| Reglas QAPAQ · leer | C | P | P | P | C | — | — | — | scope de detección |
| Reglas · crear/probar | — | C | C | P | — | — | — | — | corpus/versionado |
| Reglas · habilitar/deshabilitar | — | — | C | C | — | — | — | — | revisión/SoD para críticas |
| Integraciones · leer salud | P | P | P | C | C | C | P | — | metadatos sin secretos |
| Integraciones · configurar/replay | — | — | C | — | — | — | P | — | fuente permitida; auditado |
| Notificaciones · leer/retry | P/— | P/C | P | — | C/— | — | C | — | retry técnico no concede acuse |
| Usuarios/roles · leer | — | — | C | — | C | — | — | P | scope administrativo |
| Usuarios/grants · administrar | — | — | — | — | — | — | — | P | conjunto otorgable, JIT/SoD |
| Salud/plataforma · operar* | C | C | P | — | C | C | P | — | detalle sensible restringido |
| Notificaciones · despacho manual | — | — | — | — | — | — | P | — | `notifications.dispatch`, `soc.write`; automático independiente |
| Retención/hold* | — | — | C | — | C | — | C | — | Legal/Compliance y doble control |
| SOAR futuro · ejecutar* | — | C | C | — | — | — | — | — | U-008, action-specific, step-up |

## Reglas obligatorias

1. `PLATFORM_ADMIN` no hereda evidencia, exports ni roles.
2. `ACCESS_ADMIN` no puede autoasignarse ni autoaprobar privilegios.
3. `AUDITOR` es read-only; export requiere grant distinto y propósito.
4. identidades técnicas carecen de login humano y se limitan a fuente/función;
5. la UI solo refleja permisos; el backend vuelve a evaluar cada operación;
6. descarga y job diferido revalidan autorización antes del efecto;
7. cada endpoint implementado debe sustituir la capability propuesta por una
   entrada contractual y specs allow/deny antes de producción.

## Roles realmente presentes en el runtime

El runtime actual no implementa los ocho bundles objetivo de esta matriz. La sesión recibe
estos app roles de Entra (más el binding MVP configurado):

| App role real | Funciones observadas |
| --- | --- |
| `qapaq.soc.analyst` | eventos, alertas/triaje, incidentes escritura, notificaciones lectura/acuse |
| `qapaq.soc.lead` | analyst + eventos raw, cierre de incidentes, auditoría lectura, `notifications.dispatch` |
| `qapaq.auditor` | auditoría sensible/verificación e incidentes lectura |
| `qapaq.platform.admin` | unión SOC explícita actual, incluida `notifications.dispatch` y secretos; sin gestión de usuarios |

Hoy login consume el claim `roles`; aunque el validador conoce `groups`, `SecOpsRuntime` no
valida membresía de grupo ni consulta Microsoft Graph. La vista de administración solicitada
debe limitarse al grupo Entra de admisión y persistir roles/sesiones QAPAQ; los contratos y
gates están en [administración de usuarios Entra](../architecture/entra-soc-user-admin.md).
No desplegar la ruta de usuarios hasta implementar enforcement backend, sync y store durable.

## Discrepancia resuelta explícitamente

La lista informal `ADMIN, SOC L1, SOC L2, AUDITOR, USER` no es la decisión más
reciente. ADR-017 acepta bundles más específicos. No se crea alias `ADMIN` porque
reintroduciría privilegio universal; una migración futura deberá mapear asignaciones
con aprobación y alcance, nunca por equivalencia automática.
