# Ankay Qapaq en Azure EUS2: Compose y perfil `ankay_host`

Esta carpeta produce lo que necesita `AZURE_EUS2_ANKAY_HOST_JSON` para que el alcance `soc`
de `terraform-azure-demo-eus2.yml` levante Ankay con un único `terraform apply`.

| Archivo                    | Qué es                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.template.yaml`    | Compose de los cinco servicios (docker-guard, opensearch, backend, frontend, orborus) con marcadores para los digests. Sin secretos: usa `${ANKAY_*}` de `/etc/ankay/runtime.env` |
| `ankay-host.defaults.json` | Valores fijos del perfil: SKU, disco, URL pública, nombres de Key Vault y versiones apt exactas                                                                                   |
| `render_ankay_host.py`     | Toma `published-images.json` (del workflow de publicación) y el perfil del host; devuelve el Compose exacto, su SHA-256 y el JSON `ankay_host` completo                           |
| `tests/`                   | Pruebas del render; el Compose de `modules/ankay_host/tests/fixtures/` es este mismo render con digests ficticios                                                                 |

## Límites del runtime

- **Socket Docker**: solo lo monta `docker-guard` (usuario 10002 + grupo `docker` con GID fijo 2375, rootfs de solo lectura, sin capacidades). Orborus y los workers usan `DOCKER_HOST=tcp://docker-guard:2375` en la red interna `docker-api`. Backend y frontend no tienen acceso al daemon.
- **OpenSearch**: en la red interna `data`, a la que solo se conecta el backend. Usa TLS con una CA y un certificado de nodo generados en el primer arranque por `prepare-opensearch-tls.py`, no los certificados demo públicos. El usuario `admin` se crea con el hash bcrypt de la contraseña de Key Vault. El backend verifica el certificado (`SHUFFLE_OPENSEARCH_SKIPSSL_VERIFY=false`).
- **Publicados**: el frontend en 3001, solo desde el host SIEM (edge `/ankay/`), y el backend en 5001, solo desde el host SIEM (webhooks Wazuh y QAPAQ Core). Lo restringe la NSG del módulo. Sin IP pública.
- **Apps**: el worker ejecuta solo `ankay/apps:qapaq-ankay_1.0.0`. El host la descarga por digest y la etiqueta; docker-guard no permite hacer pull.
- **Playbooks**: tras quedar sano el stack, el host corre `import_playbooks.py` dentro de la imagen de la app, en la red `ankay_shuffle`. El importador es idempotente.

## Secretos (crear antes del apply)

Los siete se generan al azar dentro del job, sin pasar por GitHub Secrets ni por personas. Se crean con `seed-eus2-key-vault-secret.yml` (frase `SEED-EUS2-SECRET`), uno por ejecución:

| `source_secret` del workflow              | Key Vault                           | Variable en el host            |
| ----------------------------------------- | ----------------------------------- | ------------------------------ |
| `QAPAQ_EUS2_ANKAY_ENCRYPTION_MODIFIER`    | `ankay-shuffle-encryption-modifier` | `ANKAY_ENCRYPTION_MODIFIER`    |
| `QAPAQ_EUS2_ANKAY_OPENSEARCH_PASSWORD`    | `ankay-opensearch-admin-password`   | `ANKAY_OPENSEARCH_PASSWORD`    |
| `QAPAQ_EUS2_ANKAY_ADMIN_PASSWORD`         | `ankay-admin-password`              | `ANKAY_ADMIN_PASSWORD`         |
| `QAPAQ_EUS2_ANKAY_ADMIN_API_KEY`          | `ankay-admin-api-key` (UUID v4)     | `ANKAY_ADMIN_API_KEY`          |
| `QAPAQ_EUS2_ANKAY_WAZUH_WEBHOOK_TOKEN`    | `ankay-wazuh-webhook-token`         | `ANKAY_WAZUH_WEBHOOK_TOKEN`    |
| `QAPAQ_EUS2_ANKAY_DISPATCH_WEBHOOK_TOKEN` | `ankay-dispatch-webhook-token`      | `ANKAY_DISPATCH_WEBHOOK_TOKEN` |
| `QAPAQ_EUS2_ANKAY_DISPATCH_HMAC_KEY`      | `ankay-dispatch-hmac-key`           | `ANKAY_DISPATCH_HMAC_KEY`      |

Los secretos deben existir antes del apply. El módulo asigna `Key Vault Secrets User` sobre cada secreto por su ID, y no puede hacerlo si el secreto no existe. `ankay-encryption-modifier` no se puede rotar sin volver a autenticar las apps de Shuffle.

## Pasos

1. Publicar: correr `ankay-azure.yml` en `main` y luego `ankay-azure-eus2-publish.yml` con ese run. La etapa `publish` espera la aprobación del environment `azure-demo-eus2`. El job deja `published-images.json` en el artefacto `ankay-eus2-published-<sha>`.
2. Renderizar el perfil. `profile.json` solo lleva datos no secretos:

```bash
python3 infra/azure/ankay-runtime/render_ankay_host.py --published published-images.json --profile profile.json --compose-out compose.yaml --json-out ankay_host.json
```

3. Guardar `ankay_host.json` en `AZURE_EUS2_ANKAY_HOST_JSON` y correr el plan `soc`.

`profile.json` para EUS2. La IP es la primera usable de `10.80.0.32/27`. La versión de Ubuntu y la clave SSH son las del SIEM:

```json
{
  "private_ip_address": "10.80.0.36",
  "admin_ssh_public_key": "<la misma clave pública ssh-ed25519 del perfil SIEM>",
  "ubuntu_image_version": "24.04.202610210"
}
```

## Tamaño

`Standard_E2bds_v5` (2 vCPU, 16 GiB) es el valor por defecto. La suscripción solo tiene cuota en la familia EBDSv5, con un límite de 10 vCPU; el SIEM ya usa 4 con `E4bds_v5`, así que quedan 6 libres. El módulo también acepta `Standard_E4bds_v5`. OpenSearch usa 3 GiB de heap y el disco persistente es de 128 GiB StandardSSD.
