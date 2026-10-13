# Acceso a Wazuh para QAPAQ (Sprint 5)

`apply-access.sh` deja el Wazuh all-in-one del demo listo para QAPAQ. Es idempotente y lo
ejecuta el workflow **Initialize Wazuh** por SSM. No reemplaza la instancia.

| Paso | Resultado | Verificación del propio script |
| --- | --- | --- |
| Lector de ingesta | Usuario interno `qapaq_reader` con rol `qapaq_alerts_read`: `read` sobre `wazuh-alerts-*` y `cluster_monitor` | Busca alertas por el proxy (200); no alcanza la API de seguridad (403); no puede escribir (403) |
| Proxy TLS privado | nginx en `<IP privada>:9200` con certificado propio para esa IP. Solo admite `POST /wazuh-alerts-*/_search` y `GET /_cluster/health`; el resto responde 403. Verifica el certificado del Indexer contra su CA | `nginx -t`. Si la autoprueba falla, restaura la configuración anterior |
| Dueño del grupo | Usuario del Dashboard con `all_access` y rol `administrator` en la API de Wazuh | — |
| Analista | Usuario del Dashboard con `qapaq_wazuh_readonly` (lectura de `wazuh-*`), `kibana_user` y rol `readonly` en la API de Wazuh | — |
| Secretos | Publica en Secrets Manager: `wazuh/indexer-reader` (JSON con `basic_auth_b64`, solo para KrakenD), `wazuh/indexer-proxy-ca`, `wazuh/dashboard-admin-user` y `wazuh/dashboard-analyst-user` | Nunca imprime valores |

Las credenciales llegan a `curl` por archivos de configuración temporales (0600) y nunca por
argumentos, para que no aparezcan en `ps`. Reejecutar el script no rota contraseñas; con el
input `rotate` del workflow, sí.

## Prueba local (2026-10-12)

La prueba usó OpenSearch 3.7.0 con el plugin de seguridad, `wazuh/wazuh-manager:4.14.7` (API) y
un runner Ubuntu 24.04 con nginx real.

- Tres ejecuciones seguidas: las contraseñas se reutilizaron y las reglas de la API de Wazuh
  quedaron creadas una sola vez, ligadas a los roles `administrator` (1) y `readonly` (2).
- Proxy: una ruta distinta de la búsqueda responde 403.
- Analista: lee (200) y no escribe (403). Dueño: administra la seguridad (200).
- La primera búsqueda de un usuario recién creado puede tardar en un Indexer frío; la
  autoprueba reintenta hasta 5 veces antes de declarar el fallo.

Limitación: el Indexer real del all-in-one no se probó localmente. El script detecta en vivo el
nombre del certificado del Indexer (primer DNS del SAN, si no la IP) y la autoprueba confirma el
tramo completo en la instancia; si falla, no deja el proxy aplicado.
