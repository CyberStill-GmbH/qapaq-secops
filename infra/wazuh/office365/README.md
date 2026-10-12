# Microsoft 365 → Wazuh como código

Estado: reglas y script **verificados contra Wazuh 4.14.7 real** (`wazuh-logtest`, 48/48
casos; `apply-office365.sh` idempotente sobre el manager). La recolección desde un tenant
real sigue `BLOCKED` hasta tener el tenant autorizado, la app de Entra y el secreto
(ADR-024). Fecha: 2026-10-11.

Este directorio versiona lo que antes se configuraba a mano en el manager: el módulo
`office365`, las reglas locales que convierten actividad de Microsoft 365 en alertas con
valor de detección y la lista de cuentas de emergencia.

## Contenido

| Archivo                           | Qué es                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ossec-office365.xml.tmpl`        | Bloque `<office365>` con marcadores `QAPAQ:office365`. El secreto se lee de un archivo, nunca de `ossec.conf`.  |
| `rules/qapaq_office365_rules.xml` | Reglas locales 100502–100530 (rango reservado 100500–100549).                                                   |
| `lists/qapaq-break-glass.example` | Formato de la lista CDB de cuentas break-glass. La lista real se provisiona por ambiente desde Secrets Manager. |
| `apply-office365.sh`              | Aplica todo de forma idempotente: respalda, valida con `wazuh-analysisd -t`, restaura si falla y reinicia.      |
| `tests/`                          | Casos sintéticos para `wazuh-logtest` y su runner.                                                              |

El workflow `.github/workflows/configure-wazuh-office365.yml` empaqueta este directorio y lo
ejecuta en el manager demo por SSM. Tiene modo `render`, que valida y muestra el bloque sin
tocar nada, y modo `apply`.

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

1. El dueño de Microsoft 365 carga el client secret en
   `qapaq-secops/<ambiente>/wazuh/office365-client-secret` y, opcionalmente, los UPN
   break-glass separados por comas en `qapaq-secops/<ambiente>/wazuh/break-glass-identities`.
   Terraform (`modules/wazuh_public`) crea los contenedores y el permiso de lectura del host.
   Agregar esos recursos no reemplaza la instancia.
2. Ejecutar el workflow en modo `render` para validar entradas y plantilla.
3. Ejecutar en modo `apply`. La salida muestra las líneas de `wazuh-modulesd:office365`
   posteriores al reinicio y nunca imprime secretos.

Uso manual en un manager:

```bash
QAPAQ_O365_TENANT_ID=<guid> QAPAQ_O365_CLIENT_ID=<guid> \
QAPAQ_O365_SECRET_SOURCE=aws-secretsmanager:qapaq-secops/demo/wazuh/office365-client-secret \
QAPAQ_BREAK_GLASS_SOURCE=aws-secretsmanager:qapaq-secops/demo/wazuh/break-glass-identities \
sudo -E bash apply-office365.sh
```

La lista CDB distingue mayúsculas: las claves deben coincidir con el `UserId` que registra
Microsoft.

## Probar las reglas contra Wazuh real

```bash
docker run -d --rm --name qapaq-wazuh wazuh/wazuh-manager:4.14.7
# Una vez iniciado: aplicar con la lista de ejemplo y un secreto sintético
docker cp infra/wazuh/office365 qapaq-wazuh:/tmp/qapaq-office365
docker exec qapaq-wazuh sh -c 'ln -sf /var/ossec/framework/python/bin/python3 /usr/local/bin/python3; printf secreto-sintetico > /tmp/o365-secret'
docker exec -e QAPAQ_O365_TENANT_ID=00000000-0000-4000-8000-000000000001 \
  -e QAPAQ_O365_CLIENT_ID=00000000-0000-4000-8000-000000000002 \
  -e QAPAQ_O365_SECRET_SOURCE=file:/tmp/o365-secret \
  -e QAPAQ_BREAK_GLASS_SOURCE=file:/tmp/qapaq-office365/lists/qapaq-break-glass.example \
  qapaq-wazuh bash /tmp/qapaq-office365/apply-office365.sh
bash infra/wazuh/office365/tests/run-logtest.sh qapaq-wazuh
```

`tests/architecture/wazuh-office365-rules.spec.ts` verifica sin Wazuh el rango de IDs, MITRE,
los grupos reconocidos por la correlación, los padres de cada regla y que los casos sean
sintéticos.
