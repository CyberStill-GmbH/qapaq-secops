# Auditoría de preparación del SOC Azure — 2026-10-23

## Resultado comprobado

- La corrección del gate Azure se integró en `main` como commit `c63c62a0d53d1212171a61ce307fed3796adec8a` ([PR #128](https://github.com/CyberStill-GmbH/qapaq-secops/pull/128)). El requisito del host SIEM solo bloquea un `apply` de alcance `soc`; generar el plan ya no requiere una excepción de red de AWS.
- No queda una precondición del runner o firewall de AWS en el workflow Azure. El run #39902841231 sí llegó a Terraform mediante OIDC de Azure; el resultado vacío provino de inputs SOC ausentes, no de una restricción heredada de AWS.
- La validación CI de Terraform y CI Security del PR terminó correctamente. El plan remoto de solo lectura [39902841231](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39902841231) también terminó correctamente desde `main`.
- El plan remoto más reciente [39989553972](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39989553972), sobre `main` (`c63c62a0d53d1212171a61ce307fed3796adec8a`), volvió a ser **0 altas, 0 cambios, 0 eliminaciones**. El job `apply` fue omitido: no se aplicaron cambios cloud ni DNS.
- Las entradas efectivas del plan demuestran por qué no aparece un despliegue: `siem_host=null`, `ankay_host=null`, `enable_runtime=false`, `container_images={}` y `key_vault_secret_ids={}`. Por tanto, este plan no propone crear el SIEM, Ankay ni el runtime de QAPAQ.
- El bundle offline Wazuh/QAPAQ más reciente está publicado en Blob privado según [la evidencia de release](siem-release-bundle.md): source SHA `6c3c2b498a8a9dc43f6a0da45c07244fdf132f2f`, SHA-256 `9cfcd1acd6c5c1c78ec10024d6a4b7c3bbd43932ad8931ce3a9d63d126a4ccac`. La publicación no equivale a instalación en una VM.
- Ankay todavía no está listo para publicar. El CI correctivo [39991140558](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39991140558) construyó Shuffle, backend y worker, pero el smoke Compose/API falló porque el backend no encontró `/run/ankay/opensearch-ca/ca.pem`; el harness no montaba la CA necesaria. El scan pasó para backend y worker, pero encontró 55 hallazgos (53 HIGH y 2 CRITICAL) en OpenSearch 2.19.7. El publish quedó omitido. El commit `2deecc0` cambia el smoke a HTTPS con CA verificada y modifica el scan para evaluar/reportar cada imagen sin abortar en la primera. Su nuevo CI [39993144736](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39993144736) sigue en curso con `publish_to_acr=false`; no es evidencia de remediación hasta que concluya.

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

## Revalidación posterior — 2026-10-23

- El último workflow Azure consultado, [40029106928](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40029106928), autentica por OIDC y genera un plan protegido con **0 altas, 0 cambios y 0 eliminaciones**. Se omitió el job apply porque `apply=false`; el resultado no es un despliegue.
- El environment GitHub `azure-demo` tiene una regla de rama y **ningún revisor requerido**. El flujo Azure no está bloqueado por la protección de approvals que se usaba en AWS. El requisito vigente es el perfil de host SIEM y los demás inputs Azure.
- Con la sesión Azure de `cguevara@qapaq.pe` y MFA, el registro `qapaqsecopsdemo66f8c73b` muestra los repositorios `ankay-qapaq-frontend` y `qapaq-dashboard`. Ankay frontend tiene tres tags. No aparecen repos de backend ni worker Ankay, por lo que no existe un conjunto completo de imágenes para ejecutar Shuffle.
- El CI de Ankay [40035289406](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40035289406) pasa sus pruebas del overlay/frontend y termina fallando en el gate de vulnerabilidades del digest OpenSearch 3.9.0 fijado: **37 HIGH** de paquetes Amazon Linux y **71 HIGH** de dependencias Java; **0 CRITICAL**. El job manual de publicación se omitió. No se publicó una imagen nueva.
- La lista de secretos del Key Vault sigue inaccesible: Azure muestra que el acceso público está deshabilitado y que la solicitud no procede de un servicio confiable ni de un private link aprobado; la tabla indica “unauthorized”. No se leyeron valores ni se cambió la frontera de red o RBAC.

Estos resultados confirman que no existe una barrera AWS que retirar en el flujo Azure. No se debe saltar el gate de imágenes ni aplicar un plan sin el perfil y las referencias de secretos requeridas.
