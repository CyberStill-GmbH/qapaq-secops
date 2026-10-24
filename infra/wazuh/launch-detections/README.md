# Paquete de detección QAPAQ para lanzamiento

Estado: **preconfigurado en Git; no instalado en un Manager real**. El catálogo
mantiene 30 casos priorizados. Las reglas locales de este paquete consumen un
contrato JSON plano `integration=qapaq-provider`; los adapters Sophos/Cato/Entra
que deben emitirlo aún necesitan implementación y pruebas con proveedor. Los
detectores M365 existentes se referencian por su ID, no se copian ni se editan.

## Contrato de entrada de proveedores

Los adapters autorizados que decidan enrutar eventos a Wazuh deben escribir una
línea JSON por evento con identificadores y campos planos. Ejemplo exclusivamente
sintético:

```json
{
  "integration": "qapaq-provider",
  "qapaq_vendor": "sophos",
  "qapaq_event_type": "threat_detected",
  "qapaq_severity": "critical",
  "qapaq_status": "active",
  "qapaq_endpoint_id": "endpoint-lab-01",
  "qapaq_user_id": "usuario@qapaq-lab.example",
  "qapaq_source_record_id": "event-synthetic-001"
}
```

El adapter conserva el raw de proveedor fuera de este log, agrega `source_record_id`
estable, redacción y referencia/hash del raw. No escribir tokens, cuerpo de correo,
URL sensible ni payload raw en `alerts.json`. Cursor y admisión durable pertenecen
al adapter; Wazuh no avanza checkpoints de Sophos/Cato.

Campos comunes: `integration`, `qapaq_vendor`, `qapaq_event_type`,
`qapaq_source_record_id`, `qapaq_severity`, `qapaq_status`, `qapaq_action`,
`qapaq_user_id`, `qapaq_actor`, `qapaq_endpoint_id`, `qapaq_host`,
`qapaq_source_ip`, `qapaq_destination`, `qapaq_hash`, `qapaq_remedy_result`,
`qapaq_change_status`, `qapaq_path_scope`. Omit campos ausentes; no rellenar
valores desconocidos con defaults que eleven prioridad.

## Contenido

- `rules/qapaq_launch_provider_rules.xml`: reglas locales 101200–101215 para
  detecciones puntuales y telemetría normalizada. No habilita Active Response.
- `agent-groups/`: perfiles de referencia para Windows/Linux; Sysmon está
  separado para no solicitar un canal inexistente en equipos sin ese producto.
- `ankay/playbooks.json`: seis contratos de triage read-only. Especificación, no un
  export JSON importable de Shuffle.
- `../../../docs/security/launch-detection-catalog-2026-10-20.json`: 30 detecciones
  con prioridad, motor, señales, dependencias y estado de activación.
- `tests/`: fixtures sintéticas positivas/negativas para probar reglas con
  `wazuh-logtest` 4.14.8.
- `validate_catalog.py`: verifica el catálogo de 30, unicidad y referencias a
  reglas instaladas existentes.

## Aplicación al iniciar Wazuh

El siguiente bundle de release Azure incluye el catálogo y ambas reglas locales QAPAQ.
Su instalador las copia de forma atómica en `/var/ossec/etc/rules/`, garantiza que el
directorio está registrado en el `<ruleset>` activo, valida con
`/var/ossec/bin/wazuh-analysisd -t` y reinicia el Manager con rollback si falla. Esto
requiere construir y publicar un bundle nuevo y después instalarlo; el candidato Blob
publicado el 23 de octubre todavía no contiene este cambio. No reiniciar un Manager
ajeno desde CI.

Las reglas proveedoras solo generarán alertas después de instalar en el Manager el
adaptador local que escriba el contrato anterior. El archivo del catálogo es fuente
de configuración del backlog y no se debe presentar como cobertura operativa.

## Verificación

```bash
python infra/wazuh/launch-detections/validate_catalog.py
docker run --detach --rm --name qapaq-wazuh-launch-test wazuh/wazuh-manager:4.14.8
bash infra/wazuh/launch-detections/tests/run-logtest.sh qapaq-wazuh-launch-test
docker rm -f qapaq-wazuh-launch-test
```

Los fixtures prueban evaluación sintética del motor; no son prueba de conectividad
con Microsoft, Sophos, Cato ni endpoints reales. El workflow de CI corre el mismo
logtest en Manager fijado. La activación de cada caso requiere cumplir su `activation`
en el catálogo y la aceptación real descrita en el perfil de demo multifuente.

## Fuentes upstream

- Wazuh mantiene [reglas base](https://github.com/wazuh/wazuh-ruleset) y documenta
  [reglas personalizadas](https://documentation.wazuh.com/current/user-manual/ruleset/rules/custom.html),
  [decodificación JSON](https://documentation.wazuh.com/current/user-manual/ruleset/decoders/json-decoder.html)
  y [configuración central de agentes](https://documentation.wazuh.com/current/user-manual/reference/centralized-configuration.html).
- Las reglas portables candidatas se seleccionan desde [SigmaHQ](https://github.com/SigmaHQ/sigma);
  conservar UUID, estado, falsos positivos y DRL 1.1 para cualquier adaptación.
- El conector Sophos se debe ajustar al contrato de
  [Sophos Central SIEM Integration](https://github.com/sophos/Sophos-Central-SIEM-Integration)
  y a la [referencia oficial SIEM API](https://developer.sophos.com/siem/).
- Cato se integra mediante su [API oficial](https://api.catonetworks.com/documentation/)
  y el [SDK oficial Go](https://github.com/catonetworks/cato-go-sdk), sujeto a que el
  tenant tenga disponible `eventsFeed` y los permisos mínimos.
- Los playbooks se convertirán a formato exportado solo desde la instancia Ankay/
  Shuffle fijada, usando [documentación de workflows](https://github.com/Shuffle/shuffle-docs)
  y revisando artefactos upstream en [shuffle-workflows](https://github.com/Shuffle/shuffle-workflows).
