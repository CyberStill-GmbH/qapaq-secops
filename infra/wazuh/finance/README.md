# Reglas Wazuh de riesgo financiero QAPAQ

Reglas locales que disparan los playbooks del catálogo
[`finance-catalog.yaml`](../../../docs/security/ankay-playbooks/finance-catalog.yaml).
Complementan los paquetes `wazuh/office365`, `infra/wazuh/active-directory`,
`infra/wazuh/endpoint` e `infra/wazuh/launch-detections` sin modificarlos.

**Estado:** diseño validado con `wazuh-logtest` 4.14.8 sobre eventos sintéticos (job
`QAPAQ finance playbooks and detections`). No está desplegado. Un caso sintético no prueba
el comportamiento con datos reales del tenant: las reglas marcadas
`qapaq_pending_provider_evidence` siguen pendientes hasta tener un registro real redactado.

## Contenido

| Archivo | Uso |
|---|---|
| `rules/qapaq_finance_rules.xml` | 33 reglas en el rango reservado 101400–101449. |
| `lists/*.example` | Plantillas sintéticas de las listas CDB nuevas. |
| `tests/generate_cases.py` | Genera `logtest-cases.jsonl` y `expected-rules.txt` (fuente única de los casos). |
| `tests/prepare-container.sh` | Prepara un Manager 4.14.8 desechable: reglas, listas y TZ nocturna. |
| `tests/run-logtest.sh` | Ejecuta los casos por sesión y compara con lo esperado. |
| `validate_finance.py` | Validación estática de reglas, catálogo y workflows Shuffle. |

## Rango y bloques

| Bloque | IDs | Playbook |
|---|---|---|
| BEC y fraude de pagos | 101400–101404 | `finance.bec-payment-fraud` |
| Toma de cuenta del core | 101410–101412 | `finance.credit-core-account-takeover` |
| Exfiltración de datos de clientes | 101415–101422 | `finance.customer-data-exfiltration` |
| Privilegios y break-glass | 101425–101428 | `finance.privileged-breakglass-abuse` |
| Ransomware en agencia | 101430–101433 | `finance.branch-ransomware` |
| Marca y phishing a clientes | 101435–101437 | `finance.brand-impersonation-phishing` |
| Fraude interno | 101440–101445 | `finance.insider-fraud` |

IDs libres dentro de cada bloque quedan reservados para ese bloque. No reutilizar un ID
retirado: registrarlo aquí como retirado.

## Reglas

| ID | Nivel | Qué detecta | Depende de | Estado de evidencia |
|---|---|---|---|---|
| 101400 | 14 | Regla de bandeja que oculta o reenvía correo con palabras de pagos | 100510 | M365 documentado |
| 101401 | 14 | Regla o reenvío de buzón en la hora siguiente a un acceso tras fuerza bruta | 100510–100512, 100505 | M365 documentado |
| 101402 | 8 | Cambio de cuenta bancaria de proveedor en ERP | 101200 | Pendiente: adaptador ERP |
| 101403 | 13 | Ese cambio sin aprobación válida o con conflicto SoD | 101402 | Pendiente: adaptador ERP |
| 101404 | 13 | Pago liberado a beneficiario nuevo o con cuenta cambiada en 72 h | 101200 | Pendiente: adaptador ERP |
| 101410 | 14 | Cambio MFA en la hora siguiente a un acceso tras fuerza bruta | 100526, 100505 | M365 documentado |
| 101411 | 14 | Inicio de sesión de riesgo alto de usuario del core | 101205 + lista | Pendiente: contrato Entra |
| 101412 | 14 | Acceso tras fuerza bruta de usuario del core | 100505 + lista | M365 documentado |
| 101415 | 3 | Marca de descarga desde SharePoint/OneDrive | 91532 | M365 documentado |
| 101416 | 13 | 100 descargas del mismo usuario en 10 min | 101415 | M365 documentado |
| 101417 | 12 | 30 descargas en 10 min entre 21:00 y 06:30 | 101415 | M365 documentado |
| 101418 | 12 | 30 descargas en 10 min en fin de semana | 101415 | M365 documentado; ver límites |
| 101419 | 12 | 10 enlaces anónimos en una hora | 100515 | M365 documentado |
| 101420 | 8 | Coincidencia DLP de Purview | 91532 | Pendiente: suscripción DLP.All |
| 101421 | 13 | 5 coincidencias DLP del mismo usuario en una hora | 101420 | Pendiente: suscripción DLP.All |
| 101422 | 12 | Subida de volumen alto a app en la nube no autorizada | 101200 | Pendiente: contrato Cato |
| 101425 | 15 | Cuenta break-glass M365 haciendo cambios privilegiados | 100520/21/24/25/27/28 + lista | M365 documentado |
| 101426 | 14 | Rol privilegiado de Entra asignado de noche | 100520 | Pendiente (hereda de 100520) |
| 101427 | 14 | Alta en grupo privilegiado de AD de noche | 101300 | Windows documentado |
| 101428 | 14 | Inicio de sesión de break-glass de AD (4624) | 60106 + lista | Windows documentado |
| 101430 | 14 | Inhibición de recuperación (shadow copies, wbadmin, bcdedit) | `sysmon_event1` | Sysmon documentado |
| 101431 | 15 | Inhibición en 3 equipos distintos en 30 min | 101430 | Sysmon documentado |
| 101432 | 15 | Sophos detecta ransomware | 101200 | Pendiente: contrato Sophos |
| 101433 | 14 | 5 amenazas altas permitidas por Cato en el mismo sitio en 15 min | 101203 | Pendiente: contrato Cato |
| 101435 | 8 | Dominio parecido a la marca detectado | 101200 | Pendiente: monitoreo de marca |
| 101436 | 12 | Dominio parecido con MX, certificado o web activa | 101435 | Pendiente: monitoreo de marca |
| 101437 | 12 | Tráfico interno a dominio parecido registrado | 101200 + lista | Pendiente: contrato Cato |
| 101440 | 3 | Marca de acceso a sitio SharePoint sensible | 91532 + lista | M365 documentado |
| 101441 | 10 | 50 accesos a sitios sensibles en una hora | 101440 | M365 documentado |
| 101442 | 9 | Consulta de cliente fuera de cartera o agencia | 101200 | Pendiente: adaptador core |
| 101443 | 13 | 20 consultas fuera de función en una hora | 101442 | Pendiente: adaptador core |
| 101444 | 12 | Consulta sin justificación de cliente PEP, colaborador o reservado | 101200 | Pendiente: adaptador core |
| 101445 | 13 | Exportación de reporte de clientes que el rol no justifica | 101200 | Pendiente: adaptador core |

## Campos nuevos del contrato normalizado `qapaq-provider`

Las reglas de ERP, core bancario, monitoreo de marca, Sophos y Cato usan eventos
normalizados por adaptadores QAPAQ con `integration=qapaq-provider` (regla base 101200).
Estos campos se añaden al contrato y deben llegar con referencias opacas, nunca con
números de cuenta, montos, documentos de identidad ni datos de clientes:

| Campo | Valores | Fuente |
|---|---|---|
| `qapaq_vendor_ref` | referencia opaca del proveedor | ERP/tesorería |
| `qapaq_change_status` | `approved`, `unapproved`, `unknown`, `sod_violation` | ERP (ya usado por 101206/101207) |
| `qapaq_beneficiary_age` | `new`, `changed_72h`, `established` | tesorería |
| `qapaq_threat_name` | nombre de la detección Sophos | Sophos |
| `qapaq_site` | identificador del sitio Cato (agencia) | Cato |
| `qapaq_app_sanctioned` | `true`/`false` | Cato (catálogo de apps) |
| `qapaq_volume_class` | `normal`, `high`, `anomalous` | Cato |
| `qapaq_domain`, `qapaq_domain_capability` | dominio y `mx`, `certificate`, `web_active`, `none` | monitoreo de marca |
| `qapaq_role_match` | `true`/`false`, calculado contra cartera/agencia asignada | adaptador del core |
| `qapaq_customer_segment` | `retail`, `pep`, `employee`, `restricted` | core |
| `qapaq_access_justification` | `none`, `ticket`, `customer_request` | core |
| `qapaq_customer_ref` | referencia opaca del cliente | core |

## Listas CDB

| Lista | Clave | Mantiene | Plantilla |
|---|---|---|---|
| `qapaq-finance-core-users` | UPN exacto | IAM, desde los roles del core de créditos | `lists/qapaq-finance-core-users.example` |
| `qapaq-break-glass-ad` | `sAMAccountName` exacto | Seguridad de la información | `lists/qapaq-break-glass-ad.example` |
| `qapaq-sensitive-sites` | `SiteUrl` exacta, sin barra final, entre comillas | Dueños de datos | `lists/qapaq-sensitive-sites.example` |
| `qapaq-lookalike-domains` | dominio en minúsculas | SOC tras revisar 101435/101436 | `lists/qapaq-lookalike-domains.example` |
| `qapaq-break-glass` | UPN exacto | paquete office365 | `wazuh/office365/lists/qapaq-break-glass.example` |

Los valores reales se provisionan por ambiente desde Key Vault o el pipeline de despliegue,
nunca en el repositorio. Registrar cada lista en `<ruleset>` de `ossec.conf`.

## Despliegue (cuando se apruebe)

1. Instalar las reglas como `etc/rules/zz_qapaq_finance_rules.xml`. Wazuh carga
   `etc/rules` en orden alfabético y estas reglas cuelgan de office365 (1005xx) y de
   launch-detections (1012xx); con el nombre original se cargan antes y Wazuh descarta
   las hijas (“Signature ID not found”).
2. Fijar la zona horaria del Manager en `America/Lima`: 101417, 101418, 101426 y 101427
   evalúan `<time>`/`<weekday>` con la hora local del Manager.
3. Provisionar las listas, ejecutar `wazuh-analysisd -t` y reiniciar el Manager.
4. Observar dos semanas en modo revisión (sin playbook automático) y ajustar umbrales
   con datos del tenant antes de enlazarlas al despacho de Ankay.

No ejecuta Active Response ni contención. Solo el nivel 12+ llega al adaptador de triage.

## Validación

```bash
python3 infra/wazuh/finance/validate_finance.py
docker run --detach --rm --name qapaq-wazuh-finance-test --ulimit nofile=458752:458752 \
  --env "TZ=$(bash infra/wazuh/finance/tests/prepare-container.sh --tz 23)" wazuh/wazuh-manager:4.14.8
bash infra/wazuh/finance/tests/prepare-container.sh qapaq-wazuh-finance-test 23
bash infra/wazuh/finance/tests/run-logtest.sh qapaq-wazuh-finance-test
docker rm -f qapaq-wazuh-finance-test
```

Al cambiar casos, editar `tests/generate_cases.py` y ejecutar
`python3 infra/wazuh/finance/tests/generate_cases.py`.

## Límites conocidos

- Una correlación (`if_matched_sid`, `frequency`) no reutiliza un evento previo que ya usó
  otra correlación de nivel igual o mayor (`lf->matched >= rule->level` en
  `Search_LastSids`, comprobado con wazuh-logtest 4.14.8). Por eso 101410 y 101416 tienen
  un nivel más que la regla que marca sus eventos. Mantener esa relación al cambiar niveles.
- En logtest, `ignore` no suprimió 101417: dispara cada 30 descargas nuevas. Las
  descargas que terminan en 101417 no cuentan para 101416, que de noche dispara unas
  descargas más tarde (en el caso de prueba, en la 103). Los
  escenarios con fuerza bruta van en sesiones separadas porque 100503 consume los fallos.
- 101418 (fin de semana) comparte umbral y nivel con 101417 y va después: un fin de semana
  de noche gana 101417. El caso de logtest no puede forzar el día de la semana.
- 101433 y 101431 suponen agencias identificables por `qapaq_site` o por nombre de equipo;
  confirmar la convención de nombres de agencias con TI.
- Las reglas de volumen (101416–101419, 101441, 101443) usan umbrales iniciales sin línea
  base del tenant. Ajustarlos tras la observación del paso 4.
