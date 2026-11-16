# 04 · Playbooks de Ankay

Parte de [17 · Ingeniería de detección](../17-ingenieria-de-deteccion.md). Archivos:
[`ankay/playbooks/`](../../ankay/playbooks/) (exportables de Shuffle 2.3.0, el motor heredado que
corre hoy en AWS con la marca Ankay). Contrato verificado por `node --test ankay/playbooks/playbooks.test.mjs`.

> **Requieren aprobación de QAPAQ.** Ninguno está importado en la instancia. Los de contención llevan la compuerta
> `qapaq_contencion_habilitada = false`: encenderla es una decisión que se registra en
> [10](../10-decisiones.md) (A13, N5) junto con los permisos de proveedor que exige. El destino de diseño sigue
> siendo Step Functions ([13](../13-ankay-qapaq.md)); estos flujos documentan la lógica para portarla.

| Archivo | Catálogo | Riesgo | Aprobación | Efectos |
| --- | --- | --- | --- | --- |
| `qapaq-triage-enriquecimiento.json` | `qapaq.triage-enrichment` | Bajo | No (solo lectura) | Nota en el incidente QAPAQ y aviso por correo |
| `qapaq-contencion-identidad-aprobada.json` | `qapaq.identity-containment` | Alto | Líder SOC + step-up, SoD | Revocar sesiones y deshabilitar la cuenta de Entra |
| `qapaq-contencion-endpoint-aprobada.json` | `qapaq.endpoint-containment` | Medio | Líder SOC, SoD | `firewall-drop` 600 s en el agente (Wazuh Active Response) |

## Triage y enriquecimiento

Disparo: webhook del adaptador `infra/wazuh/shuffle` (alertas nivel ≥ 12, payload v1 **sin** usuario, IP ni
`full_log`). Pasos: `validar_y_deduplicar` (contrato v1, `executionKey = alert.id`, clasifica la fuente y elige
el runbook) → `buscar_alerta_qapaq` (prioridad P1–P4 y razones, API QAPAQ de solo lectura) y
`contexto_agente_wazuh` (estado, SO y grupo) → `resumen_triage` (texto en español) → `nota_en_incidente_qapaq`
(solo si la alerta ya está en un incidente) y `aviso_correo_qapaq`.

**Correo:** usa el mismo contrato que el servicio de correo QAPAQ (`wazuh/alert-mail`): Graph `sendMail` desde el
buzón del SOC, asunto `QAPAQ SOC · <SEVERIDAD> · <título>`, contenido mínimo y enlace a la consola. Hoy la app no
tiene `Mail.Send`; hasta concederlo (acotado al buzón con Application Access Policy), el paso falla cerrado y la
nota en QAPAQ se conserva. Que Ankay tenga esa credencial es una excepción a «Respond no guarda credenciales
de proveedor» y debe aprobarse; la alternativa es encolar la intención de aviso en el outbox de QAPAQ (contrato
pendiente en [14](../14-ankay-conexion-qapaq.md)).

## Contención con aprobación

Disparo: solicitud de QAPAQ Core (`incidentRef`, `executionKey`, `requestedBy`, `targetRef`, `actionId`; nunca
contraseñas ni tokens). Flujo: `validar_solicitud` → `contexto_para_aprobar` → **User Input**
`aprobacion_lider_soc` → `verificar_compuerta` (aprobador ≠ solicitante **y** `qapaq_contencion_habilitada = true`)
→ acción → `resultado_en_incidente_qapaq` (ejecutada, rechazada o bloqueada; sin reintento ciego, ADR-028).

| Playbook | Prerrequisitos antes de habilitar |
| --- | --- |
| Identidad (Entra) | Permisos Graph `User.RevokeSessions.All` y `User.EnableDisableAccount.All` en una app dedicada; step-up para aprobar (docs/07, gate 2); prueba sobre una cuenta sintética |
| Endpoint (Wazuh AR) | Usuario de la API de Wazuh con solo `active-response:command` (docs/07, gate 3); `firewall-drop` solo existe en agentes Linux; allowlist de IPs administrativas (`QAPAQ_AR_WHITELIST`) |

Las autenticaciones se referencian por nombre (`qapaq-api-lectura`, `qapaq-graph-contencion`,
`wazuh-api-active-response`, …) y se crean en el almacén cifrado de Ankay; el JSON no contiene secretos
(lo comprueba el test).
