# Microsoft 365 → Wazuh como código

Estado: reglas y script **verificados contra Wazuh 4.14.7 real** (`wazuh-logtest`, 48/48
casos; `apply-office365.sh` idempotente sobre el manager). Azure ahora incluye el script,
plantilla y reglas en el bundle de primer arranque; la validación de producción todavía
requiere ejecutar `wazuh-logtest` con 4.14.8 y confirmar lectura real del tenant autorizado
(ADR-024). En Azure, el secreto se entrega como archivo materializado desde Key Vault por
Managed Identity y no invoca AWS Secrets Manager. Los flujos AWS existentes conservan su
adaptador `aws-secretsmanager:`.

Este directorio versiona lo que antes se configuraba a mano en el manager: el módulo
`office365`, las reglas locales que convierten actividad de Microsoft 365 en alertas con
valor de detección y la lista de cuentas de emergencia.

## Contenido

| Archivo                           | Qué es                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ossec-office365.xml.tmpl`        | Bloque `<office365>` con marcadores `QAPAQ:office365`. El secreto se lee de un archivo, nunca de `ossec.conf`.  |
| `rules/qapaq_office365_rules.xml` | Reglas locales 100502–100530 (rango reservado 100500–100549).                                                   |
| `lists/qapaq-break-glass.example` | Formato de la lista CDB de cuentas break-glass. En Azure se provisiona por ambiente desde Key Vault como secreto. |
| `apply-office365.sh`              | Aplica todo de forma idempotente: respalda, valida con `wazuh-analysisd -t`, restaura si falla y reinicia.      |
| `tests/`                          | Casos sintéticos para `wazuh-logtest` y su runner.                                                              |

El bundle `.github/workflows/azure-siem-release-bundle.yml` incluye estos archivos fijados
por SHA-256 y `wazuh/azure-release/install.sh` ejecuta el modo `apply` durante el primer
arranque. El client secret y la lista break-glass se leen desde archivos locales creados por
el bootstrap con la identidad administrada de la VM. El modo `render` sigue disponible para
validar la plantilla sin tocar el manager.

## Por qué reglas locales

El ruleset oficial (`0755-office365_rules.xml`) registra casi toda la actividad con nivel 3
a 6 por tipo de registro. Sirve para buscar, pero no separa el compromiso de cuenta de la
operación normal. Las reglas locales elevan solo operaciones con valor de detección y les
asignan un grupo `qapaq_<táctica>`, que la correlación de QAPAQ
(`modules/detection/src/correlation.ts`) usa para reconocer la cadena "acceso → impacto"
sobre el mismo usuario.

| ID     | Nivel | Detección                                                         | MITRE                | Grupo QAPAQ                  |
| ------ | ----- | ----------------------------------------------------------------- | -------------------- | ---------------------------- |
| 100502 | 3     | Login fallido (marca, base de frecuencia)                         | —                    | `qapaq_credential_access`    |
| 100506 | 3     | Login exitoso (marca)                                             | —                    | `qapaq_initial_access`       |
| 100503 | 10    | Fuerza bruta: 10 fallos del mismo usuario en 5 min                | T1110.001            | `qapaq_credential_access`    |
| 100504 | 12    | Password spray: 15 usuarios distintos desde la misma IP en 10 min | T1110.003            | `qapaq_credential_access`    |
| 100505 | 13    | Login exitoso tras fuerza bruta sobre la misma cuenta             | T1110, T1078.004     | `qapaq_initial_access`       |
| 100510 | 12    | Regla de bandeja que reenvía, redirige, borra u oculta correo     | T1564.008, T1114.003 | `qapaq_persistence`          |
| 100511 | 8     | `UpdateInboxRules` desde cliente                                  | T1564.008            | `qapaq_persistence`          |
| 100512 | 12    | Reenvío SMTP de buzón                                             | T1114.003            | `qapaq_persistence`          |
| 100513 | 10    | Permiso SendAs                                                    | T1098.002            | `qapaq_persistence`          |
| 100514 | 11    | Regla de transporte nueva o modificada                            | T1114.003            | `qapaq_exfiltration`         |
| 100515 | 7     | Enlace anónimo en SharePoint/OneDrive                             | T1567                | `qapaq_exfiltration`         |
| 100520 | 13    | Alta en rol privilegiado de Entra                                 | T1098.003            | `qapaq_privilege_escalation` |
| 100521 | 9     | Alta en cualquier otro rol                                        | T1098.003            | `qapaq_privilege_escalation` |
| 100522 | 10    | Consentimiento OAuth o permisos a una aplicación                  | T1528                | `qapaq_persistence`          |
| 100523 | 10    | Credenciales nuevas en una app o service principal                | T1098.001            | `qapaq_persistence`          |
| 100524 | 14    | Cambio de dominio o federación                                    | T1484.002            | `qapaq_defense_evasion`      |
| 100525 | 10    | Cambio de políticas de Entra (incluye Conditional Access)         | T1556.009            | `qapaq_defense_evasion`      |
| 100526 | 8     | Cambio de métodos MFA                                             | T1556.006            | `qapaq_persistence`          |
| 100527 | 14    | Auditoría unificada desactivada                                   | T1562.008            | `qapaq_defense_evasion`      |
| 100528 | 12    | Auditoría de buzón desactivada o eximida                          | T1562.008            | `qapaq_defense_evasion`      |
| 100529 | 12    | Exportación de eDiscovery                                         | T1114                | `qapaq_exfiltration`         |
| 100530 | 14    | Cualquier login de una cuenta break-glass (lista CDB)             | T1078.004            | `qapaq_initial_access`       |

Hallazgo de la prueba real que fija un diseño: a igual nivel, Wazuh desciende por la regla
oficial que se cargó primero. Por eso las marcas de login (nivel 3) cuelgan también de 91545
y 91540. Subirles el nivel habría convertido cada login en una alerta de severidad media.

Pendiente de evidencia del proveedor (investigación C-4 con Microsoft Learn): 100520,
100521, 100523, 100525 y 100529 llevan el grupo `qapaq_pending_provider_evidence`.
Microsoft documenta esas actividades como etiquetas de la consola de Entra (por ejemplo,
`Update Conditional Access policy` o las variantes PIM `Add eligible member to role in PIM
completed (permanent)`), no como el `Operation` exacto del registro de la Management
Activity API. Las regex aceptan ambas formas sin distinguir mayúsculas; se declaran
funcionales solo con un registro real redactado como fixture. Los casos 44–48 de
`tests/logtest-cases.jsonl` cubren las variantes: 48/48 en logtest 4.14.7 (2026-10-12).

## Requisitos en Microsoft 365

- App de Entra dedicada (distinta del login de QAPAQ) con **Application permission
  `ActivityFeed.Read`** en Office 365 Management APIs y consentimiento de administrador.
  `ActivityFeed.ReadDlp` solo si se activa DLP.
- Unified Audit Log habilitado y auditoría de buzones activa.
- Salida HTTPS del manager a `login.microsoftonline.com` y `manage.office.com`.

## Aplicar

1. Cargar el client secret con un canal administrativo aprobado en Azure Key Vault. Si se usa
   la lista break-glass, cargar sus UPN como otro secreto de Key Vault. La Managed Identity
   SIEM recibe lectura solo en los nombres de secreto asignados a `wazuh_secret_names`.
2. Configurar `siem_host.office365` con tenant ID, client ID, tipo de API y DLP; guardar solo
   nombres de secretos en `wazuh_secret_names`, incluyendo `office365-client-secret`.
3. Generar un plan Terraform remoto y revisar cambios/costos antes de aplicar. El primer
   arranque materializa secretos localmente y aplica plantilla/reglas con respaldo y rollback.
4. Tras el despliegue, confirmar que `wazuh-modulesd:office365` inició y validar ingesta real
   mediante un evento de prueba del tenant autorizado. El build/plan no demuestra ingestión.

Uso manual en un manager:

```bash
QAPAQ_O365_TENANT_ID=<guid> QAPAQ_O365_CLIENT_ID=<guid> \
QAPAQ_O365_SECRET_SOURCE=file:/etc/qapaq-secrets/office365-client-secret \
QAPAQ_BREAK_GLASS_SOURCE=file:/etc/qapaq-secrets/break-glass-identities \
sudo -E bash apply-office365.sh
```

La lista CDB distingue mayúsculas: las claves deben coincidir con el `UserId` que registra
Microsoft.

## Probar las reglas contra Wazuh real

```bash
docker run -d --rm --name qapaq-wazuh wazuh/wazuh-manager:4.14.7
# Una vez iniciado: aplicar con la lista de ejemplo y un secreto sintético
docker cp wazuh/office365 qapaq-wazuh:/tmp/qapaq-office365
docker exec qapaq-wazuh sh -c 'ln -sf /var/ossec/framework/python/bin/python3 /usr/local/bin/python3; printf secreto-sintetico > /tmp/o365-secret'
docker exec -e QAPAQ_O365_TENANT_ID=00000000-0000-4000-8000-000000000001 \
  -e QAPAQ_O365_CLIENT_ID=00000000-0000-4000-8000-000000000002 \
  -e QAPAQ_O365_SECRET_SOURCE=file:/tmp/o365-secret \
  -e QAPAQ_BREAK_GLASS_SOURCE=file:/tmp/qapaq-office365/lists/qapaq-break-glass.example \
  qapaq-wazuh bash /tmp/qapaq-office365/apply-office365.sh
bash wazuh/office365/tests/run-logtest.sh qapaq-wazuh
```

`tests/architecture/wazuh-office365-rules.spec.ts` verifica sin Wazuh el rango de IDs, MITRE,
los grupos reconocidos por la correlación, los padres de cada regla y que los casos sean
sintéticos.
