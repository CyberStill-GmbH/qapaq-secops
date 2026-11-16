# assistant — Qapaqzito

Dominio del asistente de IA de QAPAQ SecOps («Qapaqzito»). Sin frameworks ni SDK de proveedores: define el
puerto del modelo (`AssistantModel`), las herramientas de **solo lectura** (`AssistantTool`) y el
bucle que las orquesta (`runAssistant`). Los adaptadores de Claude (API de Anthropic o Amazon
Bedrock) y las herramientas que leen el SOC viven en `apps/api/src/assistant/`.

Reglas de diseño (ver [docs/15](../../docs/15-qapaqzito-asistente.md)):

- **Mismo permiso que la persona.** Las herramientas leen por la propia API con la sesión de quien
  pregunta; Qapaqzito no ve nada que esa persona no vea.
- **Solo lectura.** No hay herramientas que cambien estado. Una acción de respuesta se propone y la
  aprueba una persona en Ankay.
- **Datos personales seudonimizados** (correos e IPv4) antes de salir hacia el modelo y
  restituidos en la respuesta.
- **Presupuesto acotado**: turnos de herramientas, tokens y tiempo.
