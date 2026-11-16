# AWS → Wazuh QAPAQ (sin IAM)

Monitoreo de la propia cuenta AWS (061098277310) desde el nodo PowerUser. El rol SSO `SOC-PowerUser`
no puede crear IAM ni hacer `iam:PassRole`, así que el módulo AWS de Wazuh (que lee S3/CloudWatch con
credenciales) no se usa. En su lugar, un pipeline **push** que solo usa políticas de recurso:

```
CloudTrail (trail de organización, ya existente)
  → EventBridge, bus default (reglas regionales; solo eventos de escritura)
  → SNS (política del tema: events.amazonaws.com + aws:SourceArn; CMK propia en us-east-1)
  → HTTPS https://dev.security.qapaq.pe/hooks/aws-sns (ALB + WAF → edge nginx: solo POST, 300 KB, 50 r/s)
  → receptor aws-events (contenedor node, sin puertos publicados)
  → /var/ossec/logs/qapaq-collectors/aws/aws-events.jsonl (<localfile log_format="json">)
  → reglas 101600–101699 → wazuh-alerts-* → dashboard «QAPAQ · AWS»
```

| Pieza                                                                               | Dónde                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terraform (CMK, tema, 10 reglas us-east-1, 16 centinelas regionales, suscripciones) | `infra/aws-poweruser/aws-monitoring.tf`, `modules/aws-events-sentinel`                                                                                   |
| Receptor                                                                            | `receiver/sns-receiver.mjs` (+ `sns-receiver.test.mjs`, `node --test`)                                                                                   |
| Servicio y edge                                                                     | `infra/aws-poweruser/host/compose.qapaq.yaml` (`aws-events`), `edge.conf.template` (bloque `QAPAQ:aws-sns`), `host/aws-events.env` (temas aceptados)         |
| Reglas y logtest                                                                    | `rules/qapaq_aws_rules.xml`, `tests/make-cases.mjs` → `aws-cases.jsonl`, `tests/run-aws-logtest.sh`                                                        |
| Instalación en el manager                                                           | `sudo bash wazuh/aws-events/install-aws-events.sh` (crea el directorio de salida, reglas, `<localfile>`, `wazuh-analysisd -t`, reinicia solo el manager) |
| Dashboard                                                                           | `wazuh/dashboard/saved-objects/build_aws_dashboard.py` → `qapaq-aws.ndjson`                                                                                |

## Receptor

- Firma SNS **SignatureVersion 2** (SHA256withRSA); `SigningCertURL` solo `https://sns.<región del tema>.amazonaws.com/*.pem`,
  certificado vigente con SAN `sns.amazonaws.com` o `sns.<región>.amazonaws.com` (los temas se crean con `signature_version = 2`).
- Solo los `TopicArn` de `QAPAQ_AWS_SNS_TOPIC_ARNS`; la cabecera `x-amz-sns-topic-arn` debe coincidir.
- Confirma la suscripción (GET `SubscribeURL`) solo con firma válida, tema esperado y URL
  `https://sns.<región>.amazonaws.com/?Action=ConfirmSubscription&TopicArn=<el mismo>&Token=…`.
- Dedupe por `MessageId` y por id del evento EventBridge (un evento root + IAM coincide con dos reglas).
- Timestamp ≤ 1 h; token bucket → 503 (SNS reintenta; la política de entrega reintenta < 1 h).
- Normaliza a campos planos `aws.*` (`event_name`, `event_source`, `user_type`, `principal`, `source_ip`,
  `console_login`, `mfa_used`, `open_to_world`, …) y deja `request_parameters` / `response_elements` como texto
  recortado: el decodificador JSON de Wazuh limita campos y la línea a 64 KB.
- Sin secretos; nunca registra el contenido de los mensajes.

## Reglas (101600–101699)

| Nivel | Regla                                                                                                                                                                                                                                                                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13    | 101605 login de consola root · 101620 CloudTrail StopLogging/DeleteTrail · 101664/101673 hallazgo crítico                                                                                                                                                                                                                                                            |
| 12    | 101606 API de root · 101612 cómputo/VPC en región no habitual · 101615 manipulación del pipeline QAPAQ · 101622–101624 GuardDuty/Security Hub/Config deshabilitados · 101632 admin concedido · 101636 Organizations/SCP · 101657 KMS ScheduleKeyDeletion · 101663/101672 hallazgo alto                                                                                 |
| 10    | 101608 fuerza bruta (5 fallos/5 min por IP) · 101611 actividad en región no habitual · 101621 CloudTrail modificado · 101625 Access Analyzer · 101631 IAM alto riesgo · 101634 permission sets · 101635 Organizations · 101641 SG abierto a Internet · 101644 flow logs borrados · 101645 snapshot/AMI compartido · 101651/101652 S3 público · 101656 KMS DisableKey |
| 8     | 101609 login IAM sin MFA · 101630 IAM · 101633 Identity Center · 101640 SG · 101642 NACL · 101643 rutas/gateways · 101650 S3 · 101655 KMS política · hallazgos medios                                                                                                                                                                                                |
| 3–6   | 101601/101602/101610 actividad, 101607 login fallido (5), 101613 servicio AWS en otra región (4), 101616 cambio del pipeline (6), 101646 EC2 RunInstances                                                                                                                                                                                                            |

`bash wazuh/aws-events/tests/run-aws-logtest.sh qapaq-wazuh.manager-1` → 50/50 casos.

## Despliegue PowerUser y push de alertas

`infra/aws-poweruser/scripts/deploy-host.sh` espera que Manager esté arriba, instala el localfile y
las reglas con `install-aws-events.sh`, valida/reinicia el Manager y recién después arranca el servicio
Compose `aws-events`. El instalador mantiene copia de `ossec.conf`, revierte config/reglas si falla la
validación o el reinicio y persiste el archivo host con reemplazo atómico. Si falla cualquier gate,
el despliegue se detiene antes del edge; SNS conserva sus reintentos de entrega. El flujo no se ha
ejecutado aquí contra un host AWS.

El fast path `custom-qapaq` sigue separado del despliegue normal. Tras aprobar el canario y sincronizar
el HMAC, el operador debe ejecutar explícitamente `activate-wazuh-push.sh`; hace backup, valida con
`wazuh-analysisd -t` y `wazuh-integratord -t`, reinicia Manager y revierte si falla. No forma parte de
`deploy-host.sh`.

Filtro de salida: nivel mínimo 3 y grupos `qapaq_provider,office365`. Wazuh 4.14.8 comprueba nivel y
grupo como condiciones sucesivas (AND); los nombres dentro de `<group>` son alternativas (OR). Los
roots de reglas AWS QAPAQ ya heredan `qapaq_provider`; el root de reglas QAPAQ M365 lo incorpora. El grupo
`office365` añade las alertas base oficiales de M365 3–6, evitando reenviar reglas Wazuh ajenas a esos
providers. Contrato contrastado con el [manual de integración externo de Wazuh](https://documentation.wazuh.com/current/user-manual/manager/integration-with-external-apis.html)
y el [código del integrator fijado a v4.14.8](https://github.com/wazuh/wazuh/blob/v4.14.8/src/os_integrator/integrator.c#L187-L226).

### Gate de latencia y volumen

Objetivo propuesto, todavía no medido: p95 desde el `aws.time` del evento hasta la recepción durable
de su hint en la inbox QAPAQ ≤10 segundos bajo 10 mensajes/segundo sostenidos durante 10 minutos en un
entorno de canario autorizado, sin pérdidas en el conjunto sintético y con duplicados identificados.
Separar además el p95 de visibilidad en Indexer para distinguir entrega del webhook, lectura JSONL,
decodificación y escritura de Wazuh. Ejecutar 50/50 reglas de `wazuh-logtest`, tests del receptor,
tests estáticos de orden/config y después medir el canario con timestamps/IDs correlables antes de
activar `custom-qapaq`.

Riesgo de volumen: `office365` también incluye los eventos base de M365 de nivel 3–6; al habilitar
push puede elevar mucho la tasa y `integratord` lanza el script por alerta. El emisor es best-effort,
no reintenta, y la API aplica límites de entrada; ante picos, errores o duplicados, el pull de Indexer
continúa siendo la reconciliación obligatoria. No declarar p95 ni completitud a partir de tests
sintéticos o del hecho de arrancar los servicios.

## Límites (sin IAM)

- Reenviar a un bus central exige rol IAM: cada región tiene su propio tema/regla (centinela).
- Sin eventos de lectura (Get/List/Describe) ni eventos de datos (S3 GetObject…): exigirían el estado
  `ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS` o un trail con selectores de datos (no se piden).
- Sin VPC Flow Logs, S3 access logs ni CloudWatch Logs: requieren rol de entrega o lectura con credenciales.
- Identity Center vive en la cuenta de administración: sus cambios no llegan a esta cuenta.
- GuardDuty y Security Hub están apagados: las reglas de hallazgos quedan listas pero sin datos.
