# wazuh/ — overlay QAPAQ sobre Wazuh

Este es el "backend Wazuh" de QAPAQ. No es un fork del código: versiona todo lo que QAPAQ cambia
de Wazuh y lo aplica sobre la versión oficial fijada en [`VERSION`](VERSION). Decisión y motivos
en [`docs/03-evaluacion-de-componentes.md`](../docs/03-evaluacion-de-componentes.md).

| Carpeta                      | Qué cambia de Wazuh                                                                       | Se aplica con                                                             | Estado                 |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------- |
| `access/`                    | Usuario `qapaq_reader`, proxy TLS allowlist del Indexer, usuarios internos                | `access/apply-access.sh` (workflow `initialize-wazuh.yml`)                | En uso en la demo      |
| `office365/`                 | Módulo Office 365, 22 reglas QAPAQ, listas y tests de logtest                             | `office365/apply-office365.sh` (workflow `configure-wazuh-office365.yml`) | En uso en la demo      |
| `edge/`                      | nginx: TLS, `auth_request` contra QAPAQ, `/` → dashboard, `/api` → QAPAQ, `/soc` estático | Fase 1                                                                    | Propuesto              |
| `indexer/security/`          | Security plugin: proxy auth y roles QAPAQ                                                 | `securityadmin.sh`                                                        | Propuesto              |
| `indexer/ism/`               | Retención hot/warm/cold y repo de snapshots S3                                            | `indexer/ism/apply-ism.sh`                                                | Propuesto              |
| `indexer/anomaly-detection/` | Detectores ML (RCF)                                                                       | `indexer/anomaly-detection/apply-detectors.sh`                            | Propuesto              |
| `dashboard/`                 | Marca QAPAQ, proxy auth y plugin `qapaq-ops`                                              | Copia más reinicio de `wazuh-dashboard`                                   | Propuesto              |
| `manager/integrations/`      | Push de alertas a QAPAQ (`custom-qapaq`) y snippets de Shuffle y AWS                      | `ossec.conf`                                                              | Propuesto (fase 2 y 3) |

## Reglas

- **Idempotente:** cada script se puede ejecutar N veces y deja el mismo estado. Cada uno toca solo
  su bloque `QAPAQ:<nombre>:begin/end` dentro de los archivos de Wazuh.
- **Sin secretos:** las credenciales se leen de Secrets Manager en el host, nunca del repo.
- **Probado antes de aplicar:** reglas con `wazuh-logtest` (`office365/tests`), JSON con `jq`, nginx
  con `nginx -t`.
- **Licencia:** las reglas y decoders derivados de Wazuh son GPLv2. Se mantiene la atribución y no
  se redistribuyen binarios modificados.
- **Versión:** al subir `VERSION`, recompilar el plugin del dashboard contra el
  `pluginPlatform.version` exacto de esa versión de Wazuh.
