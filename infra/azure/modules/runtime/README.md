# Módulo `runtime`

Cinco Container Apps genéricas (`edge`, `web`, `gateway`, `api`, `worker`) con imágenes fijadas por digest y secretos referenciados desde Key Vault. Está apagado por defecto (`enable_runtime = false`) y no es la topología objetivo del SOC, que corre en el host SIEM.

Los upstreams internos usan `https://<app>.internal.<dominio>` sin puerto, porque el ingress interno de ACA escucha en 443 y reenvía al `target_port`.

<!-- BEGIN_TF_DOCS -->

## Requirements

Hereda las restricciones de versión del root (`infra/azure/versions.tf`).

## Providers

| Name    | Source            |
| ------- | ----------------- |
| azurerm | hashicorp/azurerm |

## Modules

No modules.

## Resources

| Name                                                                                                                           | Type     |
| ------------------------------------------------------------------------------------------------------------------------------ | -------- |
| [azurerm_container_app.runtime](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/container_app) | resource |

## Inputs

| Name                                     | Description                                                                          | Type               | Default | Required |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | ------------------ | ------- | :------: |
| app_database_name                        | Base de datos de la API.                                                             | `string`           | n/a     |   yes    |
| container_app_environment_default_domain | Dominio interno del entorno para los upstreams entre apps.                           | `string`           | n/a     |   yes    |
| container_app_environment_id             | Container Apps Environment con perfil Consumption; vacío si el runtime está apagado. | `string`           | n/a     |   yes    |
| container_images                         | Imágenes edge/web/gateway/api/worker fijadas por digest sha256.                      | `map(string)`      | n/a     |   yes    |
| container_registry_login_server          | Login server del ACR desde el que se extraen las imágenes.                           | `string`           | n/a     |   yes    |
| enable_runtime                           | Crea las cinco Container Apps genéricas; apagado por defecto.                        | `bool`             | n/a     |   yes    |
| environment                              | Entorno lógico; se conserva en la interfaz para etiquetas y nombres futuros.         | `string`           | n/a     |   yes    |
| key_vault_secret_ids                     | URIs de secretos Key Vault por servicio y variable de entorno.                       | `map(map(string))` | n/a     |   yes    |
| name_base                                | Base compacta de nombres; también forma los FQDN internos de service discovery.      | `string`           | n/a     |   yes    |
| postgres_fqdn                            | FQDN privado de PostgreSQL.                                                          | `string`           | n/a     |   yes    |
| queue_database_name                      | Base reservada para jobs; sin consumidor activo todavía.                             | `string`           | n/a     |   yes    |
| resource_group_name                      | Resource group precreado por bootstrap.                                              | `string`           | n/a     |   yes    |
| runtime_identity_id                      | Identidad administrada con AcrPull y Key Vault Secrets User.                         | `string`           | n/a     |   yes    |
| tags                                     | Etiquetas comunes de gobierno y costo.                                               | `map(string)`      | n/a     |   yes    |

## Outputs

| Name              | Description                                                                   |
| ----------------- | ----------------------------------------------------------------------------- |
| edge_default_fqdn | FQDN temporal administrado por Azure para el edge, si el runtime está activo. |

<!-- END_TF_DOCS -->
