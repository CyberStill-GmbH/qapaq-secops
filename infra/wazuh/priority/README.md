# Reglas de prioridad QAPAQ (101600–101699)

**Estado: candidato.** 63 casos `wazuh-logtest` en Manager 4.14.8 (CI
`wazuh-priority-agents.yml`); no instalado en el manager.

Reglas hijas que elevan a nivel 12–15 una detección existente cuando toca un activo o una
identidad crítica de QAPAQ (listas CDB `qapaq-critical-assets`, `qapaq-privileged-identities`,
`qapaq-sensitive-workstations`, `qapaq-internet-facing`) y rebajan ruido conocido con
justificación. Dos señales nuevas: webshell (101612) e inhibición de recuperación (101614).
Monitor-only.

- `rules/qapaq_priority_rules.xml`: depende de los paquetes AD, endpoint, launch-detections y
  office365 (deben cargarse antes).
- `lists/*.example`: plantillas sintéticas. Las listas reales se provisionan fuera del
  repositorio; `apply-priority.sh` rechaza claves `.example` salvo en pruebas.
- `apply-priority.sh`: valida y normaliza las listas (variantes de mayúsculas), respalda,
  instala, registra las listas en `<ruleset>` y ejecuta `wazuh-analysisd -t`; restaura si falla.
- `tests/`: casos `sube:` / `mantiene:` / `baja:`, `run-logtest.sh` y `test_priority_rules.py`.

Catálogo y matriz P1–P4: [`docs/security/agents/07-reglas-de-prioridad.md`](../../../docs/security/agents/07-reglas-de-prioridad.md)
y [`03-matriz-priorizacion.md`](../../../docs/security/agents/03-matriz-priorizacion.md).
