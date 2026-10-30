# Contrato propuesto del puente QAPAQ ↔ Ankay

**Estado:** propuesto, no implementado. Lo consumen los workflows de
`infra/wazuh/launch-detections/ankay/finance/`. Concreta, para los playbooks financieros,
el `governedActionDispatcher` del catálogo base (`status: not-implemented`) y la frontera
`executionBoundary`: Ankay recibe referencias, QAPAQ lee proveedores y autoriza efectos.

## Principios

1. Ankay no guarda credenciales de Microsoft, Sophos, Cato, ERP ni core. Solo tiene una
   credencial de workload del puente, de alcance mínimo y rotada desde Key Vault.
2. Toda lectura pasa por un adaptador QAPAQ y devuelve resúmenes y referencias, no
   contenido (correo, archivos, datos de clientes, números de cuenta, montos).
3. Ankay no puede aprobar ni ejecutar efectos. Solo puede **solicitar** una acción; QAPAQ
   aplica control dual, SoD, step-up y expiración, y despacha por el outbox.
4. Toda respuesta incluye `status` (`ok`, `degraded`, `unavailable`); la ausencia de datos
   nunca equivale a “limpio”.
5. Cada llamada lleva `executionKey`; QAPAQ es idempotente por `(executionKey, operación)`.

## Despacho (outbox → Ankay)

El outbox publica en el webhook del workflow un sobre firmado dentro del cuerpo, porque el
trigger de Shuffle entrega el cuerpo como `$exec`:

```json
{
  "envelope": {
    "schema": "qapaq.ankay.dispatch/v1",
    "playbookId": "finance.bec-payment-fraud",
    "playbookVersion": "1.0.0",
    "executionKey": "exec-opaque-0001",
    "tenantRef": "tenant-opaque",
    "incidentRef": "inc-opaque",
    "alertRefs": ["alert-opaque"],
    "scopeRef": "scope-opaque",
    "window": {"from": "2026-10-27T10:00:00Z", "to": "2026-10-27T12:00:00Z"},
    "issuedAt": "2026-10-27T12:00:05Z",
    "expiresAt": "2026-10-27T12:15:05Z",
    "nonce": "base64url-128-bit"
  },
  "signature": {"alg": "HMAC-SHA256", "keyId": "outbox-ankay-2026-10", "value": "base64url"}
}
```

## Endpoints

| Operación | Método y ruta | Efecto | Respuesta mínima |
|---|---|---|---|
| Verificar despacho | `POST /v1/ankay/dispatch/verify` | ninguno | `decision` (`accept`/`reject`/`duplicate`), `reason`, campos del sobre validados |
| Enriquecimiento | `POST /v1/ankay/enrichment` | ninguno | `status`, `signals[]`, `containmentCandidate`, `evidenceRefs[]`, `sourceFreshness` |
| Adjuntar evidencia | `POST /v1/ankay/incidents/{incidentRef}/evidence` | escribe en el caso QAPAQ | `evidenceRef`, `sha256` |
| Solicitar acción | `POST /v1/ankay/action-requests` | crea solicitud `pending-human-decision` | `actionRequestRef` |
| Intención de aviso | `POST /v1/ankay/notification-intents` | encola en outbox (dedupe) | `outboxRef` |
| Resultado | `POST /v1/ankay/executions/{executionKey}/result` | registra auditoría | `recorded` |
| Rechazo | `POST /v1/ankay/executions/rejected` | registra auditoría | `recorded` |

Si `record_result` no llega antes de `expiresAt` + margen, QAPAQ marca la ejecución como
`UNKNOWN` y la muestra al analista; no la reintenta con efectos.

## Consultas de enriquecimiento por playbook

QAPAQ mantiene la lista blanca `playbookId → queries` igual a `triage.queries` del
catálogo. Una consulta fuera de la lista devuelve 403 y se audita.

| Consulta | Adaptador | Devuelve (resumen) |
|---|---|---|
| `m365.mailbox_rules` | Wazuh office365 / Graph lectura | reglas y reenvíos con acción, destino de dominio y fecha |
| `m365.signin_summary` | Wazuh office365 / Graph lectura | éxitos y fallos por IP, país y agente |
| `m365.file_activity_summary`, `m365.sharing_links`, `m365.dlp_matches`, `m365.sensitive_site_access`, `m365.related_mail_alerts` | Wazuh office365 | conteos, rutas y etiquetas de sensibilidad |
| `entra.risk_detections`, `entra.auth_methods_changes`, `entra.privileged_role_changes` | Graph lectura | detecciones de riesgo, cambios de MFA y de roles |
| `ad.privileged_group_changes` | Wazuh DC | altas y bajas con actor y grupo |
| `erp.vendor_bank_changes`, `erp.payments_pending` | adaptador ERP (por definir) | referencia de proveedor, aprobador, estado del pago; sin números ni montos |
| `core_banking.session_summary`, `core_banking.access_summary` | adaptador core (por definir) | sesiones y consultas con `qapaq_role_match` |
| `iam.role_baseline` | IAM/RR. HH. vía QAPAQ | rol, área, cartera y estado laboral autorizado para el caso |
| `sophos.endpoint_detections`, `sophos.remediation_status` | Sophos SIEM lectura | detecciones, hash y estado de remediación |
| `cato.user_sessions`, `cato.site_events`, `cato.upload_destinations`, `cato.domain_access` | Cato eventsFeed lectura | eventos por sitio, destino y veredicto |
| `brand.domain_intel` | monitoreo de marca (por definir) | RDAP, DNS, certificado; sin visitar la URL |
| `wazuh.host_alerts`, `qapaq.*` | QAPAQ | alertas relacionadas, activos, cambios aprobados, custodia break-glass, reportes de clientes, línea de tiempo, evidencias, relojes regulatorios |

## Solicitud de acción

```json
{
  "playbookId": "finance.bec-payment-fraud",
  "playbookVersion": "1.0.0",
  "executionKey": "exec-opaque-0001",
  "incidentRef": "inc-opaque",
  "state": "pending-human-decision",
  "decision": "¿Hay pago en riesgo o cuenta comprometida...?",
  "options": [{"effect": "payment-hold-request", "approverRoles": ["jefe-tesoreria"], "constraints": "..."}],
  "approvalPolicy": "dual-control-and-sod"
}
```

QAPAQ rechaza cualquier otro `state`. El analista elige la opción y el alcance exacto
(identidad, endpoint, indicador) en QAPAQ; un aprobador distinto del solicitante y del
analista confirma con step-up; QAPAQ despacha al ejecutor del `effectCatalog` y verifica el
resultado. Los efectos `manual` generan una tarea para el área responsable.

## Pruebas exigidas antes de habilitar

Firma inválida, nonce repetido, sobre expirado, `executionKey` duplicado, consulta fuera de
lista, 401/403/429/5xx del adaptador, timeout, fuente `degraded`, `state` distinto de
`pending-human-decision`, credencial revocada y ausencia de secretos o PII en logs de Ankay.
