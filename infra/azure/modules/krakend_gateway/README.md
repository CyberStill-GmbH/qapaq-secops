# KrakenD privado para ingesta Wazuh

Módulo opt-in para el contrato Azure QAPAQ Core → KrakenD → proxy TLS de Indexer. El root lo deja apagado (`krakend_gateway = null`) hasta tener imagen por digest, permisos Entra y las dos referencias Key Vault precreadas. La ruta de proxy/seed ya está versionada y validada por CI, pero aún no se ha desplegado ni verificado en Azure. No crea ni cambia DNS público.

## Contrato de red y API

- Despliega un Azure Container Apps Environment con internal load balancer, `public_network_access = Disabled`, subnet dedicada `/27` o mayor y DNS privado del dominio administrado de ACA.
- La app permite ingress externo **solo dentro del VNet**: Core corre en la VM SIEM, fuera del environment ACA. Solo publica HTTPS `GET /wazuh/_cluster/health` y `POST /wazuh/_search`; ambas rutas requieren token Entra RS256 validado por issuer/JWKS/audience, el app role de aplicación `Qapaq.Wazuh.Read` y `appid` (token v1) o `azp` (token v2) coincidente con `core_client_id`.
- KrakenD reescribe la búsqueda a `POST /wazuh-alerts-*/_search` en el proxy TLS del SIEM por TCP/9443. El NSG admite 9443 solo desde la subnet privada ACA y deniega explícitamente otras fuentes del VNet; incluso con KrakenD apagado, 9443 queda denegado. El puerto Indexer 9200 nunca se abre al VNet. Nginx escucha en 9443, separado del Indexer que mantiene su listener 9200 local (loopback o la IP estática del host con TLS verificado).
- El módulo no define `/api/*`, el host del Core, ni `127.0.0.1`. El root inyecta al servicio Core su URL HTTPS privada, scope y `QAPAQ_INGESTION_SOURCE=wazuh`; su cliente usa `EntraClientCredentialsTokenSource` existente.
- `client_scope` define la aplicación recurso/audience; `core_client_id` identifica al único caller autorizado. No se infiere uno del otro. Terraform exige que `core_client_id` coincida con `QAPAQ_ENTRA_CLIENT_ID` configurado en Core.
- El issuer predeterminado usa el claim v1 que fija el entorno QAPAQ existente (`https://sts.windows.net/<tenant>/`); JWKS se resuelve desde el endpoint Microsoft v2. Revisar issuer, audience, `roles`, `appid`/`azp` con tokens sintéticos antes de habilitar.

## Gate de habilitación

Terraform no lee valores de Key Vault. El plan/aplicación EUS2 comprueba por ARM solo metadata (ID y enabled) cuando KrakenD está configurado; no avanza si falta o está deshabilitada una referencia. Antes del plan deben existir:

1. Un digest OCI inmutable de `qapaq-secops-krakend` publicado en el ACR EUS2 aprobado.
2. `wazuh-reader-b64`, cuyo valor inicial puede ser el marcador fijo `bootstrap-pending`. El bootstrap lo reemplaza, después de las autopruebas, por **solo** el texto Base64 de `qapaq_reader:<password>` (no JSON). KrakenD lo recibe como `WAZUH_BASIC_AUTH_B64`.
3. `wazuh-proxy-ca`, cuyo valor inicial puede ser el mismo marcador fijo. El bootstrap lo reemplaza, después de validar TLS, por el certificado PEM autosignado del proxy, usado como ancla de confianza dentro de esta red privada.
4. Una aplicación recurso Entra cuya audience sea `api://<resource-client-id>`, con app role `Qapaq.Wazuh.Read` cuyo `allowedMemberTypes` sea solo `Application`. Asignar ese rol exclusivamente al service principal QAPAQ Core definido por `core_client_id`. El Core usa client credentials, su `QAPAQ_ENTRA_CLIENT_SECRET` ya referenciado y scope `api://<resource-client-id>/.default`. Terraform valida el caller permitido pero no crea el app role ni su asignación: son un gate Entra previo.
5. La opción `indexer_read_proxy` del bootstrap `siem_host`. Crea el rol `qapaq_alerts_read` con solo `cluster:monitor/health` y `read` sobre `wazuh-alerts-*`, crea o reutiliza el lector sin reemplazar una cuenta preexistente cuando KV aún tenga el marcador, configura Nginx en 9443, valida búsquedas (200) y escritura/administración (403) y publica únicamente los dos valores generados en KV. Los errores revierten la configuración Nginx y los objetos Indexer QAPAQ creados/modificados; si falla la escritura parcial de secretos, la siguiente ejecución reutiliza el valor ya persistido. Este flujo no se ejecutó en Azure; no afirma que el servicio esté listo.

La identidad asignada a KrakenD obtiene `AcrPull` sobre el ACR y `Key Vault Secrets User` sobre esos dos secretos exactos. La Managed Identity del SIEM recibe un rol personalizado con solo `getSecret/action` y `setSecret/action`, asignado en los dos recursos secretos individuales; no recibe list, delete ni administración del vault. Ningún valor secreto entra en Terraform, outputs, Git, argv, artifacts o logs. El seeder ARM permite crear solo los dos nombres anteriores con el marcador constante, de forma manual y create-only; no accede a valores de otras integraciones.

**Gate RBAC:** el apply que habilita el módulo también crea la definición personalizada y sus dos asignaciones exactas. La identidad Terraform EUS2 observada no tiene permiso confirmado `Microsoft.Authorization/roleDefinitions/write` para este nuevo ID; mantener el módulo apagado hasta revisar ese permiso/acotarlo con el administrador. No sustituirlo por `Key Vault Secrets Officer` ni ampliar roles permitidos.

## Logs de acceso

El access log permanece desactivado. KrakenD Community Edition usa el logger Gin predeterminado, que agrega el query string a la ruta, y no permite configurar un formato seguro que lo omita. Activarlo podría escribir datos de query sensibles en stdout. Se mantienen logs de aplicación en INFO y métricas de ruta/estado/latencia sin query, token, body ni headers. Para access logs de auditoría se requiere primero un middleware sanitizador probado o una edición que permita declarar un formato allowlist; no habilitar el logger predeterminado.

## Escala, costo y límites

- 2 réplicas mínimas, 4 máximas; cada una reserva 0.5 vCPU y 1 GiB. El piso configurado es 1 vCPU y 2 GiB de capacidad de aplicación; el máximo es 2 vCPU y 4 GiB. Dos réplicas mínimas impiden scale-to-zero.
- El gasto final depende de región, consumo activo/idle, egress, Firewall ya requerido por el host SIEM y retención/ingesta de Log Analytics. No es un precio fijo ni un límite mensual; no hay apagado automático. Cotizar el perfil en Azure Pricing Calculator antes de un plan remoto.
- Sin zone redundancy y sin garantía HA regional. Esto mejora la disponibilidad de la app frente a una réplica, pero no vuelve HA el SIEM single-node, PostgreSQL, Firewall, DNS ni el VNet.
- La UDR de la subnet ACA fuerza egress a Azure Firewall. La policy agrega allowlists de plataforma/ACR/Entra/Key Vault limitadas al CIDR de ACA y las service tags documentadas por Microsoft. Verificar resolución DNS privada y rutas de Managed Identity en un plan/aplicación aislados.

## Verificación previa a uso

CI valida el contrato de rutas, la configuración de KrakenD, el proxy/rollback con mocks, los gates de CIDR y el preflight de metadata Key Vault sin credenciales cloud. Eso no prueba la red efectiva, la existencia inicial de secretos, la validez del token, ni el estado del Indexer. Tras el apply autorizado, comprobar desde Core: resolución DNS privada; TLS válido; `GET /wazuh/_cluster/health` 200; `POST /wazuh/_search` 200; rutas no permitidas 403; sin acceso público; y polling con eventos sintéticos en QAPAQ. Revisar redacción de logs, métricas y costo antes de declarar la fuente operativa.
