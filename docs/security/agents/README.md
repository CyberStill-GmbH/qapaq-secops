# Agentes Wazuh y priorización por red interna · QAPAQ

Configuración de agentes por clase de activo, elevación de detecciones a crítico/alto según la
red interna de QAPAQ y su despliegue reproducible sobre Wazuh 4.14.8 (manager
`app.jappi.net.pe`, Azure East US 2).

**Estado:** candidato listo para piloto. Validado con `verify-agent-conf` y `wazuh-logtest` de
Wazuh 4.14.8 en CI y con las specs del núcleo. Nada está desplegado. Los datos de la red real son
`TO_BE_PROVIDED` hasta responder el [cuestionario](08-cuestionario-dueno.md).

## Índice

| # | Documento | Para quién |
|---|---|---|
| 01 | [Arquitectura y decisiones](01-arquitectura.md) | Arquitectura, auditoría |
| 02 | [Perfiles de agente y justificación de cada canal](02-perfiles-de-agente.md) | SOC, AD, infraestructura |
| 03 | [Matriz de priorización Wazuh ↔ P1–P4, SLA y avisos](03-matriz-priorizacion.md) | Dueño, líder SOC |
| 04 | [Despliegue y rollback](04-despliegue.md) | Operador de despliegue |
| 05 | [Operación: salud, desconectados, volumen, actualizaciones](05-operacion.md) | Analista de turno |
| 06 | [Afinamiento continuo de falsos positivos](06-afinamiento-falsos-positivos.md) | Ingeniería de detección |
| 07 | [Catálogo de reglas de prioridad 101600–101699](07-reglas-de-prioridad.md) | Ingeniería de detección |
| 08 | [Cuestionario para el dueño (TO_BE_PROVIDED)](08-cuestionario-dueno.md) | Dueño |

## Artefactos

| Ruta | Contenido |
|---|---|
| `infra/wazuh/agents/shared/<grupo>/agent.conf` | Ocho perfiles: `qapaq-dc`, `qapaq-srv-core`, `qapaq-srv-db`, `qapaq-srv-web`, `qapaq-ws-sensitive`, `qapaq-ws-general`, `qapaq-linux-server`, `qapaq-laptop-remote` |
| `infra/wazuh/agents/profile-catalog.json` | Catálogo de perfiles, listas y EPS estimado |
| `infra/wazuh/agents/deploy/` | Manifiesto con hashes, instaladores Windows (MSI, Sysmon) y Linux (deb/rpm), rollback, auditd |
| `infra/wazuh/agents/tools/verify_agent.py` | Verificación de heartbeat, inventario y SCA vía API |
| `infra/wazuh/priority/` | Reglas 101600–101646, plantillas CDB `.example`, aplicador y 63 casos `wazuh-logtest` |
| `modules/detection/src/prioritization.ts` | Ruleset 1.2.0: etiquetas `qapaq_ctx_*`, `SENSITIVE_WORKSTATION`, `OFF_HOURS`, `PROVIDER_TUNED_DOWN` |
| `.github/workflows/wazuh-priority-agents.yml` | CI: invariantes, sintaxis, `verify-agent-conf`, `wazuh-logtest` |

## Relación con los paquetes existentes

- Los perfiles piloto `infra/wazuh/launch-detections/agent-groups/*` y
  `infra/wazuh/active-directory/agent-groups/windows-domain-controller.agent.conf` siguen como
  están (su catálogo y pruebas los fijan). Los perfiles de este paquete los sustituyen al pasar
  el piloto; retirar los anteriores es un cambio aparte.
- Las reglas de prioridad extienden las de `infra/wazuh/active-directory`, `endpoint`,
  `launch-detections` y `wazuh/office365` sin modificarlas.
- Los playbooks financieros (`docs/security/ankay-playbooks/finance*`) consumen las alertas
  elevadas; las reglas propias de esa sesión usan el rango 101400–101449.
