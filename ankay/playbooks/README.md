# ankay/playbooks · Playbooks exportables de Ankay

Diseño, prerrequisitos y estado: [docs/detection-engineering/04](../../docs/detection-engineering/04-playbooks-ankay.md).

| Archivo | Qué hace | Efectos | Aprobación |
| --- | --- | --- | --- |
| `qapaq-triage-enriquecimiento.json` | Valida y deduplica la alerta, lee la prioridad QAPAQ y el agente, deja nota y avisa por correo QAPAQ | Nota y correo | No (solo lectura) |
| `qapaq-contencion-identidad-aprobada.json` | Revoca sesiones y deshabilita la cuenta de Entra | Alto | Líder SOC + step-up, SoD |
| `qapaq-contencion-endpoint-aprobada.json` | `firewall-drop` 600 s en el agente Linux | Medio | Líder SOC, SoD |

**Requieren aprobación de QAPAQ antes de importarlos.** La contención trae `qapaq_contencion_habilitada = false`
y una compuerta que exige aprobador distinto del solicitante; los webhooks se exportan detenidos y las
credenciales son referencias a autenticaciones del almacén cifrado, nunca valores. Prueba de contrato:

```bash
node --test ankay/playbooks/playbooks.test.mjs
```
