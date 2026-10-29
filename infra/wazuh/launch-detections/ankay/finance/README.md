# Workflows Ankay de los playbooks financieros

Un workflow Shuffle 2.x por playbook de
[`finance-catalog.yaml`](../../../../../docs/security/ankay-playbooks/finance-catalog.yaml),
generado por `build_workflows.py`. No editar los JSON a mano: cambiar el catálogo y
regenerar.

```bash
python3 infra/wazuh/launch-detections/ankay/finance/build_workflows.py
python3 infra/wazuh/finance/validate_finance.py
```

**Estado:** importables por formato (exportación de Shuffle: `actions`, `branches`,
`triggers`, `start`, `workflow_variables`), pero **no probados en una instancia Ankay**. El
puente QAPAQ que consumen está propuesto y no implementado
([contrato](../../../../../docs/security/ankay-playbooks/finance/bridge-contract.md)).
Siguen la condición de `opensource-roadmap.md`: tras importarlos en la versión fijada hay que
exportarlos de nuevo desde Shuffle, revisar el diff y versionar esa exportación.

## Forma común

```text
Webhook (outbox QAPAQ) ─► verify_dispatch ─┬─► enrich_* (solo lectura, en serie) ─► assess
                                            │        ─► attach_evidence ─┬─► request_actions ─┐
                                            │                            └────────────────────┴─► notify_outbox ─► record_result
                                            └─► record_rejected (firma, expiración, replay o duplicado)
```

- **verify_dispatch:** QAPAQ valida firma HMAC, timestamp, nonce, expiración, tenant y
  `executionKey`. Ankay no tiene el secreto de firma.
- **enrich\_\*:** cada nodo pide una consulta permitida para ese playbook
  (`triage.queries` del catálogo). QAPAQ rechaza consultas fuera de la lista.
- **assess:** Python determinista. Agrega resultados y marca `degraded` si una fuente
  falló; nunca concluye “limpio” por falta de datos. No decide efectos.
- **request_actions:** solo si alguna lectura marcó `containmentCandidate`. Crea una
  solicitud `pending-human-decision` en QAPAQ con las opciones del catálogo. Un humano
  decide y otro distinto aprueba (SoD); QAPAQ despacha por el outbox al playbook
  `containment.*` correspondiente.
- **notify_outbox:** intención de aviso; el outbox QAPAQ deduplica y envía a Teams.

## Al importar

1. Ankay/Shuffle 2.3.0 con las apps `http` 1.4.0 y `Shuffle Tools` 1.2.0 activadas.
   Shuffle resuelve las apps por nombre y versión (`app_id` va vacío).
2. Crear la autenticación de app `qapaq-ankay-bridge` para `http` con la credencial de
   workload del puente, leída de Key Vault. Asignarla a todos los nodos HTTP. No escribir
   la credencial en variables del workflow: no están cifradas.
3. Fijar la variable `qapaq_bridge_base_url` (URL HTTPS interna, no secreta).
4. Copiar la URL del webhook generado al registro de destinos del outbox QAPAQ. El
   adaptador directo de Wazuh no se usa para estos workflows.
5. Mantener el workflow desactivado hasta pasar las pruebas del contrato (firma inválida,
   replay, duplicado, 401/403/429/5xx, timeout y fuente degradada).
