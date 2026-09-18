# SecurityEvent y contratos de frontera

Estado: DECISION aceptada; contrato `qapaq.security-event` 1.0.0 pendiente de implementación.
[ADR-011](../adr/011-security-event-normalization.md) · [U-010](../decisions/unresolved.md).

## Autoridad y alcance

JSON Schema Draft 2020-12 será la fuente normativa en
`packages/contracts/security-event/1.0.0/security-event.schema.json`. Los tipos
TypeScript, validadores, documentación y mappings de OpenSearch deben generarse o
verificarse contra él. Ninguna interfaz TypeScript aislada constituye el contrato.

ECS 9.5.0 y OCSF 1.9.0 son referencias de interoperabilidad y perfiles de salida,
no el modelo interno. No se añaden `ecs.version` ni una versión OCSF al evento
canónico. Solo una proyección validada contra su perfil puede declarar
compatibilidad. Cambiar esas versiones exige ADR, análisis de impacto, corpus de
regresión y mapping versionado. La adopción no implica conformidad regulatoria.

## Estructura canónica 1.0.0

- `specVersion`: versión SemVer obligatoria del contrato.
- `recordId`: UUIDv7 nuevo para cada recepción física.
- `eventUid`, `eventUidType`: identidad lógica y método `native`, `transport` o
  `derived`; `dedupConfidence` indica `high`, `medium` o `low`.
- `kind`: `event`, `alert`, `finding` o `state`.
- `time`: `occurredAt`, `observedAt`, `ingestedAt`, `effectiveAt` y `timeBasis`.
  No se inventan tiempos ausentes ni zonas horarias.
- `producer`: `vendor`, `product`, `dataset`, `instanceId` validado y
  `nativeEventId` opcional.
- `classification`: `category`, `type`, `action` y `outcome`.
- `severity`: `normalized`, `score`, `sourceValue`, `sourceLabel`, `sourceScale`,
  `mappingId` y `mappingVersion`.
- `detection`: `ruleId`, `ruleName` y `ruleVersion` del origen; no reemplazan la
  identidad de una regla Qapaq.
- Entidades opcionales: `user`, `host`, `device`, `process`, `file` y `network`,
  con procedencia y límites explícitos.
- `threat.techniques`: técnicas observadas o declaradas con fuente.
- `raw`: `ref`, `sha256`, `mediaType` y `sizeBytes` de la evidencia separada.
- `pipeline`: `connector`, `connectorVersion`, `parserVersion` y `mappingVersion`.
- `handling`: `classificationCode` y `redactionState`.
- `extensions.<vendor>`: campos no canónicos con namespace, tamaño y profundidad
  limitados; sin indexación dinámica ilimitada.

Los campos opcionales ausentes se omiten; `null` solo se admite donde lo permita
el schema. Las claves extra se rechazan salvo dentro de extensiones controladas.
ADR-016 fija 256 KiB por evento normalizado, 500 eventos/5 MiB descomprimidos por
batch y 256 KiB por payload BullMQ.

## Taxonomía inicial

`classification.category` admite `authentication`, `iam`, `network`,
`intrusion_detection`, `malware`, `host`, `file`, `process`, `configuration`,
`email`, `web`, `vulnerability`, `threat`, `api`, `database` y `unclassified`.
`classification.type` admite `access`, `allowed`, `denied`, `change`, `creation`,
`deletion`, `start`, `end`, `error` e `info`. `outcome` admite `success`, `failure`
o `unknown`. Usar `unclassified` conserva el raw e incrementa una métrica de
calidad. Casos e incidentes son agregados separados, no clases de SecurityEvent.

## Severidad

La escala común es: `unknown` con score nulo; `informational` 0–19; `low` 20–39;
`medium` 40–59; `high` 60–79; `critical` 80–100. Siempre se conserva la escala del
origen y la versión del mapping.

El candidato Wazuh `wazuh.alerts.severity/1.0.0` asigna nivel 0 a `unknown`
suprimido; 1–4 a `informational`; 5–7 a `low`; 8–10 a `medium`; 11–13 a `high`;
y 14–15 a `critical`. Debe validarse con el corpus autorizado antes de uso
productivo y no puede reutilizarse para otras fuentes. La notificación crítica por
Teams usa `normalized=critical` solo después de aprobar el mapping de la fuente.

## Identidad, duplicados y replay

Con ID nativo estable, `eventUid` deriva de `instanceId + dataset + nativeEventId`.
Sin él, deriva de la representación canónica JCS de `instanceId`, `dataset`,
`occurredAt`, cursor o secuencia estables, campos semánticos seleccionados y
`raw.sha256`. El contrato de cada dataset documenta exactamente los componentes.

Solo `native` o un cursor de transporte estable permiten descartar automáticamente
una recepción duplicada. Una identidad `derived` de confianza baja solo marca una
sospecha para análisis; no elimina el registro. Dos eventos legítimos semejantes
deben poder coexistir. Un replay mantiene `eventUid`, emite un `recordId` nuevo y
registra lineage. Qapaq no declara exactly-once.

## Raw, privacidad y custodia

Los bytes recibidos viven en almacenamiento restringido; SecurityEvent conserva
referencia y SHA-256. Secretos y datos innecesarios se redactan antes de indexar la
representación normalizada. La redacción del derivado no modifica el objeto bajo
custodia. Acceso y exportación de raw se auditan. Hash inválido o raw ausente impide
afirmar integridad y lleva el registro al flujo de excepción.

`handling.classificationCode` usa `UNASSIGNED` hasta que U-004 apruebe el catálogo.
Wazuh archives permanece deshabilitado por defecto; habilitarlo y retenerlo son
decisiones de infraestructura y retención, no del contrato lógico.

## Validación y cuarentena

Se valida al entrar al normalizador, antes de indexar y antes de exportar. Un evento
inválido preserva raw, se envía a cuarentena/DLQ con código de error, conector y
versión del parser, incrementa métricas y puede reprocesarse. Desconocer una versión
mayor causa rechazo o cuarentena; nunca interpretación tolerante silenciosa.

Validadores mínimos:

1. tipos, enums, formatos, límites y rechazo de propiedades no admitidas;
2. coherencia temporal sin exigir llegada ordenada;
3. rango de severidad y correspondencia con mapping aprobado;
4. identidad reproducible e idempotencia en replay;
5. existencia e integridad SHA-256 del raw cuando se reclame custodia;
6. tamaño/profundidad de extensiones y redacción previa a indexación;
7. compatibilidad de productores y consumidores con la versión soportada.

## Evolución y artefactos

El layout previsto dentro de `packages/contracts/security-event/` contiene el schema
por versión, catálogos, mappings por vendor, perfiles `ecs-9.5.0` y `ocsf-1.9.0`,
y ejemplos sintéticos. Los mappings tienen versión independiente. Un cambio
incompatible eleva major; uno aditivo exige lectores compatibles. Renormalizar crea
una revisión nueva y conserva lineage, sin reescribir silenciosamente la historia.

Todo PR del contrato incluye razón, evidencia, antes/después, efecto en detecciones,
dashboards y Teams, aprobación de SOC y versión. Desarrollo/SOC mantienen schema y
taxonomía; el dueño de cada fuente aprueba su mapping; Infra valida indexación y
capacidad; Seguridad revisa manejo y redacción; Legal/Compliance define retención y
clasificación; Arquitectura gobierna incompatibilidades y perfiles.

## Corpus mínimo de aceptación

Debe cubrir: alerta Wazuh; raw Wazuh sin alerta; autenticación Microsoft 365 exitosa
y fallida; alerta de identidad/correo; tráfico Cato permitido y bloqueado; malware
Sophos; finding de vulnerabilidad; ausencia de ID nativo; replay; dos eventos
legítimos parecidos; timestamp sin zona; llegada tardía o fuera de orden; campo de
vendor desconocido; evento sobredimensionado; secreto/token; JSON malformado; hash
raw inválido; y cambio de versión de API/producto.

Para el MVP son obligatorios el schema 1.0.0, el mapping de alertas Wazuh derivadas
de Microsoft 365 y el corpus mínimo aplicable. Cato, Sophos y adapters directos
adicionales requieren contratos y muestras autorizadas post-MVP.

## Frontera Node/Python futura

U-007 mantiene Python fuera del MVP. Si se habilita, `SecurityEvent`,
`AnalysisRequest` y `DetectionResult` usarán schemas JSON compartidos y corpus de
compatibilidad en ambos extremos. No se admiten pickle, `eval`, objetos ORM ni
bytes sin encoding. IDs y enteros fuera del rango seguro de JavaScript se
transportan como strings. El backend valida referencias y autorización antes de
promover un resultado.
