# Activación del Sprint 5 en el demo AWS

Estado: **preparado; no aplicado**. Fecha: 2026-10-12. Complementa el
[checklist de release](release-demo-checklist.md) y viene después de su §3 (base de datos).
Activa, en orden:
- la carga de secretos sin exponerlos;
- la inicialización de Wazuh (lector, proxy y usuarios);
- la identidad (dueño = admin, analista asignada, resto sin acceso);
- la ingesta Wazuh → SOC, el explorador de eventos y la salud por fuente;
- el padrón por Graph.

Cada paso dice quién lo ejecuta y cómo se verifica.

## 0. Valores en GitHub (no en el repositorio)

| Tipo | Nombre | Uso |
| --- | --- | --- |
| Secreto del environment `demo` | `ENTRA_CLIENT_SECRET` | Client secret del app registration del API |
| Secreto del environment `demo` | `WAZUH_OFFICE365_CLIENT_SECRET` | App de Entra con `ActivityFeed.Read` (módulo office365) |
| Secreto del environment `demo` | `WAZUH_BREAK_GLASS_UPNS` | UPN de cuentas de emergencia, separados por coma |
| Variable de repositorio | `QAPAQ_GROUP_OWNER_OIDS` | OID del dueño del grupo de admisión → admin en QAPAQ (respaldo hasta Graph) |
| Variable de repositorio | `QAPAQ_DIRECTORY_GROUP_ID` | Object ID de `QAPAQ-SecOps-Users`; vacío = padrón deshabilitado |
| Variable de repositorio | `QAPAQ_ADMIN_GROUP_IDS` | Object ID de los grupos cuyos miembros son admin, separados por coma. Sin ella se usa `QAPAQ_DIRECTORY_GROUP_ID`. La pertenencia se toma del claim `groups` del token o del padrón de Graph |
| Variable de repositorio | `WAZUH_ADMIN_USERNAME` | Usuario del Dashboard de Wazuh del dueño (p. ej. su UPN) |
| Variable de repositorio | `WAZUH_ANALYST_USERNAME` | Usuario del Dashboard de la persona analista |
| Variable de repositorio | `M365_TENANT_ID`, `WAZUH_O365_CLIENT_ID` | Colección de Office 365 |

Los secretos solo pasan a Secrets Manager por el workflow `Sync deploy secrets`: archivo temporal
0600, sin argumentos visibles y sin tfvars, plan ni state. La analista ya tiene su asignación
permanente en `demo.tfvars` (`QAPAQ_ROLE_BINDINGS`), en lugar de la asignación temporal
vencida.

**Limpieza recomendada:** el archivo local `infra/aws/entra-secret-api.tfplan` es un plan
de Terraform y puede contener el secreto de Entra. No está versionado; bórralo de la estación.

## 1. Secretos y Terraform

| # | Paso | Quién | Verificación |
| --- | --- | --- | --- |
| 1.1 | `Sync deploy secrets` | Dueño | Salida «actualizado: …» por cada secreto, sin valores |
| 1.2 | Merge a `main` y `Terraform Demo` → `apply` (con `wazuh_ingestion_enabled = false`) | Dueño | Crea `wazuh/indexer-reader`, `indexer-proxy-ca`, `dashboard-admin-user`, `dashboard-analyst-user` y el permiso de la instancia para poblarlos. El API recibe `QAPAQ_ROLE_BINDINGS` y, con la variable definida, `QAPAQ_GROUP_OWNER_OIDS` |
| 1.3 | `terraform output wazuh_indexer_private_ip` | Dueño | IP privada de la instancia |

## 2. Inicializar Wazuh

| # | Paso | Verificación |
| --- | --- | --- |
| 2.1 | `Initialize Wazuh` | Salida «completado: lector, proxy y usuarios (admin y analista) operativos». Si hay app de Office 365, `Module Office365 started` |
| 2.2 | Credenciales del Dashboard | La persona dueña lee `qapaq-secops/demo/wazuh/dashboard-admin-user` desde la consola de AWS e inicia sesión; la analista, `…/dashboard-analyst-user`. La analista ve alertas y no puede cambiar configuración |

El script es idempotente: repetirlo no rota contraseñas (salvo con el input `rotate`).

## 3. Entra: token de workload y Graph

| # | Paso | Quién | Verificación |
| --- | --- | --- | --- |
| 3.1 | En el app registration del API: Application ID URI `api://<client-id>` y `accessTokenAcceptedVersion = 2` en el manifiesto | Admin de Entra | Un token de client credentials para `api://<client-id>/.default` trae `aud = <client-id>` e `iss = …/v2.0`, igual que exige KrakenD (`OIDC_AUDIENCE`, `OIDC_ISSUER`) |
| 3.2 | (Padrón) Permiso de aplicación de Graph `GroupMember.Read.All` (y `User.Read.All` si se quiere el estado de cuenta) con consentimiento de administrador | Admin de Entra | Tras el siguiente ciclo, `GET /api/admin/users` → `sync.status = ok` |

Sin 3.2, `QAPAQ_DIRECTORY_GROUP_ID` puede definirse igual: la vista muestra
`DIRECTORY_FORBIDDEN` y los dueños salen de `QAPAQ_GROUP_OWNER_OIDS`.

## 4. Activar la ingesta Wazuh → SOC

| # | Paso | Verificación |
| --- | --- | --- |
| 4.1 | En las variables del ambiente: `wazuh_ingestion_enabled = true`, `wazuh_indexer_private_ip = <1.3>`, `wazuh_ingestion_gateway_scope = "api://<client-id>/.default"`; merge, revisar el plan y `apply` | El plan **reemplaza el servicio ECS de KrakenD** (se agrega su registro de service discovery): hay una ventana breve sin gateway. Nuevas task definitions de API y KrakenD |
| 4.2 | Logs del API | `ingestion.source.wazuh`; sin `ingestion.pass.failed` repetidos |
| 4.3 | `GET /api/sources/health` como lead o admin | `state = healthy`, `lastSuccessAt` reciente. Un éxito con cero filas también cuenta |
| 4.4 | Actividad sintética controlada en M365 (regla de bandeja en un buzón de laboratorio) | Alerta 100510 en el Indexer y, en menos de 2 minutos, la alerta en QAPAQ. La consola la muestra sin refrescar (feed `/api/changes`) |
| 4.5 | `GET /api/events?severity=high,critical` | `status = ok` y el evento normalizado; `raw` solo con lead o admin |

Si 4.2 muestra `PROVIDER_AUTHENTICATION_FAILED`, el token de workload no pasa KrakenD: revisar 3.1.
`PROVIDER_GATEWAY_UNAVAILABLE` apunta al proxy o al security group: el paso 2.1 debió terminar con
autoprueba OK.

## 5. Rollback

- Ingesta: `wazuh_ingestion_enabled = false`. El API vuelve a `QAPAQ_INGESTION_SOURCE=disabled` y
  KrakenD a su configuración anterior. El cursor y las observaciones quedan en la base.
- Padrón: vaciar `QAPAQ_DIRECTORY_GROUP_ID`. Los dueños vuelven a salir solo del deploy.
- Wazuh: borrar `/etc/nginx/conf.d/qapaq-indexer-proxy.conf` y recargar nginx. Los usuarios se
  quitan desde Security en el Dashboard.

## 6. Pendiente y fuera de alcance

- Secretos placeholder anteriores, ya reemplazados: `wazuh/indexer-reader-username`,
  `…-password`, `wazuh/gateway-access-token`, `wazuh/cursor-secret`. Retirarlos en un cambio
  aparte.
- Sesiones abiertas antes de la migración `20261013150000_s5_session_oid`: no tienen OID; si su
  dueña sale del grupo, vencen por su tope absoluto (8 h) en lugar de cortarse en el ciclo.
- Solicitudes de rol con aprobación SoD (identidad v2).
