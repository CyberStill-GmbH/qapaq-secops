# Roadmap de automatización Ankay QAPAQ basado en upstreams

**Estado:** selección y diseño; todavía no se importaron workflows a una instancia
Ankay ni se habilitaron credenciales. El criterio es adoptar interfaces y prácticas
de repositorios upstream con mantenimiento identificable, no copiar flujos de labs
personales que ejecutan comandos, usan tokens en claro o bloquean automáticamente.

## Qué se aprovecha de cada upstream

| Upstream | Aporte seleccionado | Integración prevista | Guardrail |
|---|---|---|---|
| Wazuh Manager / ruleset | Decoders y reglas base, grupos de eventos, `wazuh-logtest`, integración de alertas. | Wazuh detecta y mantiene alertas; personalizaciones locales en `infra/wazuh/` y versionadas. | No editar `/var/ossec/ruleset`; validar contra la versión exacta; los grupos de eventos requieren telemetría real. |
| SigmaHQ | Hipótesis de detección portables con estado, UUID, ATT&CK y falsos positivos documentados. | Traducir reglas elegidas a campos del decoder Wazuh; guardar fuente, autores, licencia y fixtures. | No importación masiva ni conversión automática a producción. Las reglas test/experimental pasan a shadow y nivel de revisión. |
| Shuffle / Shuffle Docs | Workflows visuales, triggers, condiciones, subflows, export/import JSON y patrón Collect → Enrich → Detect → Respond → Verify. | Ankay ejecuta triage y enriquecimiento; export JSON versionado tras validar que el workflow importa en la versión fijada. | Las variables ordinarias de Shuffle no están cifradas y son compartidas dentro del tenant; no poner tokens de proveedor allí. Sin acciones destructivas en un workflow de ingestión. |
| Sophos Central SIEM Integration (upstream Sophos) | Recolección paginada con estado/checkpoint, reintento y normalización JSON/CEF; evita perder eventos por polling incremental. | Comparar con el conector QAPAQ existente; aprovechar el contrato/técnicas para ingestión de eventos y alertas Sophos. | No ejecutar dos pollers con estados independientes contra la misma fuente; deduplicar por ID proveedor y no confundir alerta con evento. |
| Cato Networks `cato-go-sdk` / `cato-cli` | Cliente/CLI oficial de la API GraphQL para consultas y automatización operativa. | En Ankay usar un adapter read-only o HTTP GraphQL limitado para `eventsFeed`, continuar el marker opaco y adjuntar site/asset. | No dar a un workflow de triage credenciales de mutación de política. No reconstruir markers ni cambiar configuración de red automáticamente. |
| Microsoft Graph | Superficie oficial complementaria para `security/alerts_v2`, sign-ins y audit logs. | Mantener Wazuh como colector M365 principal; Graph complementa casos con scopes mínimos, cuando añada campos no presentes en UAL. | No duplicar todo el feed; fijar permiso/licencia, tenant, campos y política de retención antes de activar. |
| VirusTotal | Lookup de hash/IOC como fuente secundaria de reputación. | Solo `VIRUSTOTAL_ENTERPRISE_LOOKUP` aprobado y desde un case/adaptador; registrar fecha, proveedor y veredicto. | No usar API Public comercial; no enviar archivos, URLs con tokens, PII ni activos internos. Un veredicto no ejecuta contención. |

## Automatizaciones propuestas para Ankay

### A0 · Clasificación inicial de alertas Wazuh

1. Recibir solo alerta con nivel/grupo allowlisted y schema fijado.
2. Validar referencia, versión, tamaño y cabecera; deduplicar por `alert.id`.
3. Etiquetar familia (M365, endpoint, Sophos, Cato), registrar ejecución mínima y
   devolver resumen read-only a un caso QAPAQ.
4. En error de dependencia o dato ausente, marcar `unknown/degraded`; no interpretar
   ausencia de datos como saludable.

### A1 · Phishing M365 / posible BEC

1. Activar solo con señal M365 relevante o reporte admitido por analista.
2. Correlacionar cambio de inbox/forwarding, consentimiento OAuth, inicio de sesión y
   proceso endpoint cuando existan señales con actor/entidad común en la ventana.
3. Normalizar URL como texto; nunca abrirla ni descargar adjuntos durante la etapa
   inicial. No enviar contenido de correo a servicios externos.
4. Consultar Graph/Sophos/Cato/VT solo mediante adaptadores autorizados y entregar
   al analista procedencia, timestamps, confidence y datos faltantes.
5. La acción de reporte, bloqueo o revocación queda en espera de aprobación QAPAQ.

### A2 · Endpoint y malware

1. Enrutar la regla QAPAQ candidata `101100` solo desde un caso y después del job
   `wazuh-endpoint-detection` verde; no bajar el umbral global del forwarder.
2. Correlacionar agente, process parent/child, hash SHA-256 y estado de Sophos.
3. Usar VirusTotal únicamente con Enterprise y solo para hashes permitidos; cachear
   por hash/versión/TTL, limitar cuota y conservar la procedencia.
4. No aislar ni limpiar el equipo por la regla o el veredicto de una sola fuente.

### A3 · Cato / actividad de red

1. Leer el `eventsFeed` por cursor, preservar marker y checkpoint durable.
2. Correlacionar site, asset, hora, IOC y outcome de política con telemetría Wazuh.
3. Separar eventos de conectividad y eventos con veredicto de seguridad para reducir
   ruido. No convertir `blocked`, `allowed` o un feed vacío en la misma severidad.
4. Las políticas y bloqueos requieren workflow separado, aprobación dual, alcance,
   expiración, comprobación y compensación.

### A4 · Verificación y notificación

- El outbox QAPAQ mantiene el envío crítico a Teams y su dedupe. Ankay no debe emitir
  una segunda notificación con severidad crítica por la misma referencia.
- Tras una acción autorizada, consultar el estado real del proveedor, comparar antes/
  después y registrar resultado, actor, aprobación y errores. Un HTTP 200 del webhook
  solo acredita recepción, no ejecución ni efecto de seguridad.

## Controles medibles contra ruido y respuestas erróneas

- **Selección:** alertas por ID/grupo allowlisted; severidad sola no dispara acción.
- **Correlación:** entidad/actor/host común, ventana temporal definida y evidencia de
  más de una señal antes de subir prioridad; el evento base sigue visible.
- **No duplica:** clave estable por tenant + alert/provider ID + playbook version.
- **Datos incompletos:** salida `unknown`; no reemplazar campos ausentes con valores
  de demostración ni tomar una acción por defecto.
- **Excepciones:** por regla, activo o actor específico, con owner, razón, ticket,
  vencimiento y prueba negativa que asegure que la detección sigue funcionando.
- **Tuning:** medir volumen por regla/activo, tasa de duplicados, falsos positivos
  confirmados, precisión de triage, tiempo de primera revisión y lag de fuente. No
  promover severidad hasta observar una ventana representativa.
- **Acciones:** humano/SoD, permiso de mínimo alcance, dry-run, idempotencia,
  expiración y verificación. `containment.*` permanece desactivado hasta ese gate.

## Condiciones para importar a Shuffle

1. Confirmar versión de Ankay/Shuffle y presencia/versiones de las Apps requeridas.
2. Exportar el workflow desde Shuffle en JSON; revisar el diff y versionarlo en Git.
   No inventar un JSON de importación sin probarlo con la versión fijada.
3. Revisar cada variable, auth, endpoint, scope y límite; eliminar secretos y PII del
   artefacto exportado.
4. Ejecutar fixtures sintéticos con ramas positivas, negativas, datos incompletos,
   timeout, 401/403/429/5xx, replay y duplicados.
5. Importar y probar con credenciales read-only en demo; conservar evidencia redacted,
   y luego solicitar revisión humana antes de habilitar un workflow.

## Referencias de código y documentación

- [Wazuh: reglas locales y prueba con `wazuh-logtest`](https://documentation.wazuh.com/current/user-manual/ruleset/rules/custom.html)
- [Wazuh ruleset: Sysmon Event ID 1](https://github.com/wazuh/wazuh-ruleset/blob/master/rules/0595-win-sysmon_rules.xml)
- [SigmaHQ: hijo sospechoso de Outlook](https://github.com/SigmaHQ/sigma/blob/master/rules/windows/process_creation/proc_creation_win_office_outlook_susp_child_processes.yml)
- [SigmaHQ: DRL 1.1](https://github.com/SigmaHQ/Detection-Rule-License)
- [Shuffle: workflow lifecycle, webhook, conditions, exports e imports](https://github.com/shuffle/shuffle-docs/blob/master/docs/workflows.md)
- [Shuffle: Wazuh alert forwarding](https://github.com/Shuffle/Shuffle-docs/blob/master/docs/extensions.md)
- [Shuffle: workflow release process y etapas Collect/Enrich/Detect/Respond/Verify](https://github.com/Shuffle/shuffle-docs/blob/master/handbook/engineering/workflow_release_process.md)
- [Shuffle: workflows del proyecto upstream](https://github.com/Shuffle/shuffle-workflows)
- [Sophos: Central SIEM Integration](https://github.com/sophos/Sophos-Central-SIEM-Integration)
- [Cato Networks: Go SDK](https://github.com/catonetworks/cato-go-sdk)
- [Cato Networks: CLI](https://github.com/catonetworks/cato-cli)
- [Microsoft Graph: list security alerts](https://learn.microsoft.com/en-us/graph/api/security-list-alerts_v2?view=graph-rest-1.0)
