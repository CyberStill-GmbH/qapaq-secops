# Auditoría de preparación del SOC Azure — 2026-10-23

## Resultado comprobado

- La corrección del gate Azure se integró en `main` como commit `c63c62a0d53d1212171a61ce307fed3796adec8a` ([PR #128](https://github.com/CyberStill-GmbH/qapaq-secops/pull/128)). El requisito del host SIEM solo bloquea un `apply` de alcance `soc`; generar el plan ya no requiere una excepción de red de AWS.
- No queda una precondición del runner o firewall de AWS en el workflow Azure. El run #39902841231 sí llegó a Terraform mediante OIDC de Azure; el resultado vacío provino de inputs SOC ausentes, no de una restricción heredada de AWS.
- La validación CI de Terraform y CI Security del PR terminó correctamente. El plan remoto de solo lectura [39902841231](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39902841231) también terminó correctamente desde `main`.
- El resumen protegido del plan fue **0 altas, 0 cambios, 0 eliminaciones**. El job `apply` fue omitido: no se aplicaron cambios cloud ni DNS.
- Las entradas efectivas del plan demuestran por qué no aparece un despliegue: `siem_host=null`, `ankay_host=null`, `enable_runtime=false`, `container_images={}` y `key_vault_secret_ids={}`. Por tanto, este plan no propone crear el SIEM, Ankay ni el runtime de QAPAQ.
- El bundle offline Wazuh/QAPAQ está publicado en Blob privado según [la evidencia de release](siem-release-bundle.md): source SHA `a3699ccfb7f8b8cb36e85c8333d4266c7a2e1170`, SHA-256 `9f3678a17daa0421694c060255daf5c4167613a442836ca6fb811af8b9234fa0`. La publicación no equivale a instalación en una VM.

## Secretos y conectividad

- La inspección de GitHub consultó solo nombres de secretos. Existen secretos OIDC de Azure, contraseña de bootstrap PostgreSQL y `ENTRA_CLIENT_SECRET`; sus valores no se leyeron ni copiaron.
- El input del plan no contiene referencias Key Vault. El contrato de bootstrap requiere, como mínimo, `office365-client-secret`, `wazuh-install-files.tar.b64` y las referencias del core QAPAQ que correspondan al modo de despliegue.
- El entorno GitHub `azure-demo` no tiene configurados los inputs de runtime `AZURE_SIEM_HOST_JSON`, `AZURE_ANKAY_HOST_JSON`, `AZURE_KEY_VAULT_SECRET_IDS_JSON`, `AZURE_CONTAINER_IMAGES_JSON` ni `AZURE_ENABLE_RUNTIME`; sus defaults explican `null`, `{}` y `false` en el plan. Que existan credenciales OIDC de Azure no crea esos perfiles ni los secretos de aplicación.
- En el portal, Key Vault indica que el acceso público está deshabilitado y que la solicitud no procede de un servicio confiable ni de un private link aprobado; la lista de secretos devuelve “unauthorized”. El Cloud Shell volvió a abrir una sesión, pero la interfaz no permitió enviar comandos. **No se verificó si esos secretos existen ni se leyó ningún valor.**
- No se cambió el firewall de Key Vault, no se habilitó acceso público y no se modificaron permisos para eludir esa frontera.

## Bloqueos para una ejecución real

1. Falta un `AZURE_SIEM_HOST_JSON` revisado con SKU y disco, clave SSH pública recuperable, CIDR aprobados para Dashboard/agentes, datos M365 no secretos y URI/SHA del bundle. El firewall bloquea ingreso si los CIDR quedan vacíos; no se debe reemplazar ese dato con `0.0.0.0/0`.
2. Faltan referencias verificadas a secretos existentes de Key Vault para Wazuh y QAPAQ. La configuración no debe apuntar a referencias supuestas: el bootstrap se detiene si falta el material de certificados/contraseñas o la credencial de M365.
3. Falta la configuración del host Ankay: digests de imágenes aprobadas, Compose revisado y perfil de red. El módulo de Terraform no demuestra que Ankay se instale ni que sus playbooks funcionen.
4. El costo aún requiere revisión contra el plan exacto. La estimación registrada para Chile Central calcula **USD 530.86/mes** como piso de Wazuh + PostgreSQL + Azure Firewall Basic, y **USD 1,155.01/mes** con Firewall Standard; excluye disco, logs, respaldos, Ankay y conectores. Es precio de lista, no cotización contractual. No se debe tratar el umbral de USD 200 como apagado automático.
5. No existe evidencia de VM SIEM/Ankay instalada, TLS o DNS en Azure, sesión QAPAQ, agentes conectados, ingestión M365, conectores Sophos/Cato, webhook Teams ni playbooks ejecutándose.

## Siguiente secuencia verificable

1. Restablecer una ruta autorizada desde un operador dentro de la red privada para consultar **solo metadatos** del Key Vault y verificar nombres/estado. No se deben imprimir ni exportar valores.
2. Resolver de forma controlada el aprovisionamiento/escrow de los certificados Wazuh y las referencias del core. Mantener `ENTRA_CLIENT_SECRET` fuera de Terraform, Git y logs.
3. Completar el perfil SIEM y Ankay con información real de subredes/egress, imágenes y acceso. La selección de CIDR no debe abrir el Dashboard ni puertos de agentes a Internet completa.
4. Ejecutar un nuevo plan desde `main`; revisar acciones, costos y recursos protegidos. Aplicar solo ese plan cuando el resumen sea compatible con el despliegue previsto.
5. Validar el arranque y salud Wazuh/Core, autenticación y roles QAPAQ, M365→Indexer, Sophos/Cato, notificación Teams y Ankay mediante eventos sintéticos autorizados. Registrar resultados antes de cualquier corte DNS.

## Alcance de esta auditoría

Esta nota registra resultados del plan en GitHub Actions y observaciones del portal; no certifica runtime. No se alteró Terraform de producción, Key Vault, la autenticación, la red, recursos existentes ni DNS. El SOC sigue **no desplegado / no operativo en Azure** hasta que las pruebas de extremo a extremo anteriores tengan evidencia real.
