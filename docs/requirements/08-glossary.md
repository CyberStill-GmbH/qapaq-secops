# Glosario contractual

- **ACK:** confirmación en un límite concreto. En APIs pull no existe ACK al
  proveedor; el checkpoint local confirma progreso solo tras durable. Un 2xx de
  webhook confirma validación y persistencia/encolado durable, no procesamiento final.
- **Actividad Microsoft 365:** hecho registrado por Microsoft; no es automáticamente
  una alerta Wazuh ni una alerta QAPAQ.
- **Alert Candidate:** detección pendiente de enriquecimiento/deduplicación.
- **Alerta:** señal accionable disponible para triaje, con lifecycle propio.
- **Alerta Wazuh:** documento generado por decoder/ruleset Wazuh; es entrada derivada
  para QAPAQ y no necesariamente el raw original Microsoft.
- **AuditEvent:** registro de una acción/decisión de QAPAQ; no es log operacional ni
  SecurityEvent.
- **Caso:** contenedor de investigación SOC o antifraude con timeline, notas,
  tareas y evidencia; puede agrupar incidentes/alertas según contrato.
- **Checkpoint:** posición durable de adquisición por source/dataset. Solo avanza
  después de la persistencia exigida por RF-008.
- **Cursor:** token/posición del proveedor para paginación o continuidad; se trata
  como dato no confiable y no implica replay ilimitado.
- **Custodia:** controles de integridad, acceso, manifests, holds, historial y
  responsables sobre evidencia; no certifica por sí sola admisibilidad legal.
- **Deduplicación:** prevención de efectos repetidos usando identidad confiable y
  política versionada; nunca solo timestamp/texto/hash.
- **Detection:** resultado de evaluar una regla/política sobre eventos/contexto.
- **Durable:** persistido de modo que un reinicio dentro del modelo de fallos
  aprobado permita recuperar el trabajo; Redis sin respaldo contractual no es
  registro único de evidencia.
- **Evento / SecurityEvent:** representación canónica de un hecho de seguridad. No
  equivale a alerta, incidente o notificación.
- **Evidence:** información trazable que sustenta una investigación, con
  clasificación, integridad y acceso controlado.
- **Gap:** intervalo o posición cuya adquisición/cobertura no puede demostrarse.
- **Idempotencia:** repetir una operación con la misma identidad no crea efectos de
  negocio adicionales, aunque pueda crear intentos/recepciones auditables.
- **Incidente:** investigación formal con lifecycle de respuesta; una alerta no se
  convierte automáticamente en incidente.
- **Lineage:** relaciones e IDs que permiten recorrer actividad de origen,
  transformaciones, alertas, casos y notificaciones.
- **Notificación:** proyección de una alerta hacia un canal. `SENT` significa
  aceptación del endpoint, no lectura, acuse ni resolución.
- **Raw:** representación recibida sin normalización o referencia exacta a ella;
  puede ser una alerta Wazuh y no el evento Microsoft previo.
- **Replay:** relectura/reprocesamiento dentro de capacidad declarada (`FULL`,
  `BOUNDED`, `BEST_EFFORT`, `NO_REPLAY`).
- **Rollback:** retorno al artefacto/estado operacional anterior conforme a un
  procedimiento probado; no implica down migration automática.
- **Scope:** límite organizacional, fuente, dataset, caso u otro ámbito sobre el
  que un grant permite una capability.
- **SecretRef:** referencia opaca resuelta por SecretProvider; no contiene el secreto.
- **Source owner:** responsable que autoriza finalidad, dataset y permisos de una fuente.
- **WORM:** capacidad de almacenamiento que impide modificación/borrado durante una
  política aprobada; debe probarse en el producto real.
