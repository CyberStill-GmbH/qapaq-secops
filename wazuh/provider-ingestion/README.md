# Sophos Central y Cato → Wazuh QAPAQ

Este módulo opcional incorpora dos fuentes de entrada directamente en el overlay Wazuh, según A15. Consume APIs de solo lectura y escribe JSONL por proveedor; Wazuh las incorpora mediante `<localfile log_format="json">`. Los eventos y archivos de ingesta quedan separados por fuente, mientras el manager y sus logs internos conservan sus rutas propias.

## Estado y límites

- Los conectores quedan apagados si `provider_ingestion` no los habilita. Habilitarlos requiere una referencia Key Vault por credencial, egress HTTPS explícito y una prueba con eventos sintéticos del tenant.
- El código no lee ni presenta valores secretos durante plan/build. `wazuh_secret_names` materializa `sophos-client-id`, `sophos-client-secret` y `cato-api-key` en `/etc/qapaq-secrets`; el instalador los lee localmente. No poner valores en tfvars, variables de entorno persistentes, GitHub Actions ni logs.
- El acceso de red de Key Vault del entorno actual negó la consulta del portal; por ello este cambio no afirma que existan esos secretos, que los permisos de Sophos/Cato estén concedidos ni que el runtime Azure esté operativo.
- No se instalan reglas de severidad automática basadas en datos de prueba. Acordar primero los campos/eventos reales de cada tenant y agregar fixtures anonimizados; los playbooks deben requerir aprobación QAPAQ Core.

## Sophos Central

Se integra el SIEM Integration API oficial mediante el cliente Sophos Central SIEM Integration fijado a `v2.1.0` (`4fd97bbc7ec54e507bca9eaf4245f136cc90097d`, Apache-2.0). El `siem.py` en ese tag declara internamente `VERSION="2.0.1"`; por eso el bundle registra el tag/commit y hashes individuales en vez de confiar en la versión interna. El setup habilita events y alerts, conserva cursor del upstream y empieza con el comportamiento oficial de backfill inicial de hasta 12 horas. Sophos limita la API a una ventana de 24 horas; un apagado prolongado puede perder eventos que salgan de esa ventana. El tenant ID y la región son configuración no secreta. El secreto de cliente se conserva como archivo restringido. La fuente oficial puede variar su contrato/versión: revisar `manifest.json` antes de promover.

## Cato Networks

El collector consulta `eventsFeed` con permiso Cato `Events`. La primera consulta sin marker crea la posición actual y puede no devolver registros; después continúa secuencialmente usando el marker opaco tal como lo entrega Cato. Para eventos, escribe un checkpoint de recuperación antes del JSONL y confirma el marker después de hacer `fsync` del lote. Si se reinicia tras un append completo pero antes de confirmar el marker, reconoce el hash y el offset del lote ya persistido y no lo vuelve a anexar. Si el append quedó parcial, trunca solo hasta el offset registrado y vuelve a consultar con el marker anterior. El API conserva la cola aproximadamente tres días; una interrupción mayor puede dejar eventos fuera de la ventana. Los errores GraphQL o de una cuenta no avanzan el marker. Esto protege la escritura local del collector; la aceptación end-to-end aún debe comprobar el comportamiento de offsets del logcollector Wazuh después de reiniciar el Manager. El endpoint está fijado a `https://api.catonetworks.com/api/v1/graphql2`.

## Configuración Terraform no secreta

Dentro de `siem_host`:

```hcl
provider_ingestion = {
  sophos_enabled     = "true"
  sophos_tenant_id   = "<tenant UUID>"
  sophos_data_region = "<region asignada por Sophos>"
  cato_enabled       = "true"
  cato_account_id    = "<account ID numérico>"
}

wazuh_secret_names = {
  # Referencias de nombres ya existentes en Key Vault; nunca sus valores.
  sophos-client-id     = "<nombre del secreto>"
  sophos-client-secret = "<nombre del secreto>"
  cato-api-key         = "<nombre del secreto>"
  # Mantener además wazuh-install-files.tar.b64 y office365-client-secret.
}
```

Los valores `provider_ingestion` son no secretos y quedan en bootstrap config; cualquier otro campo se rechaza. Cuando se habilita una fuente, Terraform amplía la allowlist HTTPS solo con sus destinos (`id.sophos.com`, API Sophos regional o `api.catonetworks.com`). Revisa siempre el plan por coste/cambios de red antes de aplicar.

## Instalación y comprobación

Los timers consultan cada 60 s con jitter; el Manager supervisa JSONL de cada proveedor y etiqueta cada evento como `integration.vendor=sophos|cato`. Los archivos de estado de cursor son locales al SIEM. La aceptación exige confirmar timers activos, último éxito de API sin exponer credenciales, ingestión de fixtures sintéticos en `wazuh-alerts-*`, campos normalizados consultables y recuperación sin pérdida ni doble append al reiniciar el collector durante un lote. También debe probarse por separado que el logcollector Wazuh reanuda su offset sin duplicar esos JSONL tras reiniciar el Manager. Un bundle CI exitoso solo acredita empaquetado: no acredita conectividad ni datos reales del tenant.

## Fuentes primarias

- Sophos: [Get events](https://developer.sophos.com/reference/siem-v1/events/get-events/), [Get alerts](https://developer.sophos.com/reference/siem-v1/alerts/get-alerts/), [API guide](https://developer.sophos.com/siem/), [schemas](https://developer.sophos.com/siem-api-schemas/), [official integration](https://github.com/sophos/Sophos-Central-SIEM-Integration).
- Cato: [GraphQL API reference](https://api.catonetworks.com/documentation/) (`eventsFeed`; permission `Events`; queue marker semantics).
- Wazuh: [JSON log labels](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/localfile.html) y [command monitoring](https://documentation.wazuh.com/current/user-manual/capabilities/command-monitoring/configuration.html).
