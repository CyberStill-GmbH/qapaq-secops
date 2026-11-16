# 06 · Vistas de análisis (OpenSearch Dashboards)

Parte de [17 · Ingeniería de detección](../17-ingenieria-de-deteccion.md). Fuente:
`wazuh/dashboard/saved-objects/detection/build_detection_dashboards.py` → `qapaq-detection-dashboards.ndjson`
(73 objetos, IDs `qapaq-det-*`, paleta de la [identidad QAPAQ](../brand/qapaq-visual-identity.md): Coral = crítica,
Fucsia = alta, Amarillo = media, Turquesa = baja/éxito, Azul = neutro, Lavanda = sin dato).

| Dashboard | ID | Qué responde | Índices |
| --- | --- | --- | --- |
| **QAPAQ · Cobertura MITRE ATT&CK** | `qapaq-det-dashboard-mitre` | Qué técnicas y tácticas disparan, cuáles cubre el repositorio y qué brechas quedan | `wazuh-alerts-*` + matriz generada |
| **QAPAQ · Gestión de vulnerabilidades** | `qapaq-det-dashboard-vulnerabilities` | Qué CVE y paquetes parchar primero en los agentes, y qué issues de Snyk están expuestos con exploit | `wazuh-states-vulnerabilities-*`, `wazuh-alerts-*` |
| **QAPAQ · Identidad y acceso** | `qapaq-det-dashboard-identity` | Quién falla y entra, desde dónde, y qué privilegios cambian (M365/Entra, AWS, SSH) | `wazuh-alerts-*` |
| **QAPAQ · Integridad y cumplimiento** | `qapaq-det-dashboard-integrity` | Qué archivos cambian (persistencia QAPAQ), qué controles CIS fallan y qué requisitos PCI/NIST tienen alertas | `wazuh-alerts-*` |
| **QAPAQ · Threat hunting** | `qapaq-det-dashboard-hunting` | Diez cazas (H01–H10) con hipótesis, abribles en Discover | `wazuh-alerts-*` |
| **QAPAQ · Calidad de detección** | `qapaq-det-dashboard-quality` | Volumen por regla, reglas ruidosas, niveles, proporción QAPAQ y MITRE | `wazuh-alerts-*` |

**Importación** (host AWS, como administrador de servicio, nunca con el login de una persona):

```bash
sudo bash infra/aws-poweruser/scripts/bootstrap-detection-content.sh
```

Sale desde el contenedor del dashboard con proxy auth (`qapaq-bootstrap`, `qapaq.platform.admin`), igual que
`bootstrap-wazuh-app.sh`; exige que existan los index patterns `wazuh-alerts-*` y `wazuh-states-vulnerabilities-*`,
importa con `overwrite=true` (idempotente) y verifica los seis dashboards. Importado en AWS el 2026-11-04
(73/73) **[verificado]**. Los paneles de M365/Entra quedan vacíos hasta BL-I01.

**Regenerar** después de cambiar reglas: `qapaq_detections.py coverage` y luego el builder (la matriz y las brechas
del dashboard de cobertura salen del JSON de cobertura).

**Permisos:** los roles de solo lectura (`qapaq.soc.analyst`, `qapaq.soc.lead`, `qapaq.auditor`) leen
`wazuh-alerts-*` y `wazuh-states-*` (`wazuh/indexer/security/roles.qapaq.yml`), así que todas las vistas funcionan
para analistas; guardar cambios en el tenant global queda para el Líder SOC.
