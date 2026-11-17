# 05 · Datos y retención

> Estado: el overlay ISM de `wazuh/indexer/ism/` (políticas con hot 30 d / warm 90 d y archivo
> de 7 d) es **hecho, sin verificar contra un Indexer en AWS**. Todo lo demás de este documento
> (hot de 7 d, Aurora, buckets con Object Lock, Glacier, cuenta `qapaq-log-archive`) es **propuesto**
> y depende de [02](02-arquitectura.md). Los plazos de retención y la residencia de datos son
> **a confirmar con QAPAQ** (Compliance/Legal): SBS Res. 504-2021, Ley 29733 y, si hay datos de
> tarjeta, PCI-DSS.

## Dónde vive cada dato

| Dato | Sistema | Dueño | Integridad |
| --- | --- | --- | --- |
| Alertas y eventos de seguridad (`wazuh-alerts-*`, `wazuh-archives-*`) | Wazuh Indexer (EBS cifrado con KMS en el nodo) | Wazuh | Índice diario, ISM y snapshot a S3 |
| Ayni Qapaq: alertas QAPAQ, incidentes, tareas, notas | Aurora Serverless v2 (PostgreSQL) | QAPAQ | Transacción con auditoría. Notas append-only |
| Auditoría | Aurora más archivo WORM en S3 Object Lock (fase 3) | QAPAQ | Cadena SHA-256, trigger append-only y anclaje periódico del hash |
| Sesiones e identidades | Aurora | QAPAQ | Solo `sha256(sessionId)` |
| Resultados de ML (`.opendistro-anomaly-results*`) | Wazuh Indexer | OpenSearch AD | Solo se leen |
| Ejecuciones de Ankay | Historial de Step Functions más registro en Aurora | QAPAQ | Auditadas; ejecución nombrada por la solicitud |
| Evidencia exportada | S3 con Object Lock (compliance), réplica en `qapaq-log-archive` | QAPAQ | Manifiesto con hash |

El destino frío es **S3** en AWS. Los diseños anteriores (ADR-008 y ADR-018) apuntaban a otra
nube y quedan sustituidos; su histórico está en [`archive/azure`](archive/azure/README.md).

## Capas de retención (propuesto)

| Capa | Dónde | Plazo | Qué la gobierna |
| --- | --- | --- | --- |
| **Hot** | Wazuh Indexer (EBS) | **7 d** de índices activos | ISM: tras 7 d se hace snapshot y se borra el índice local |
| **Snapshots** | S3 (repositorio `qapaq-s3`, KMS, `storage_class: standard_ia`) | Hasta el total de la matriz (400 d provisional) | ISM y API de snapshots; restauración bajo demanda |
| **Evidencia y auditoría** | S3 Object Lock modo compliance + réplica a `qapaq-log-archive` | 5 años (provisional) | Retención de Object Lock. Nadie puede borrarla, ni un administrador de la cuenta |
| **Archivo frío** | Mismos buckets de evidencia y auditoría, con ciclo de vida a Glacier | Hasta cumplir el plazo | Lifecycle de S3. Object Lock se mantiene al cambiar de clase |
| **Estado operativo** | Aurora Serverless v2 | Ver matriz | PITR de Aurora y copias en AWS Backup |

Con hot de solo 7 d, **buscar más atrás exige restaurar un snapshot**: el análisis retrospectivo
deja de ser inmediato. Si PCI-DSS aplica (req. 10: 12 meses, con 3 disponibles para análisis),
Compliance debe confirmar si una restauración por solicitud cumple el "disponible de inmediato".

## Mecanismo del Indexer: ISM y snapshots

Mecanismo: **OpenSearch ISM** (política `qapaq-wazuh-retention`, en
`wazuh/indexer/ism/qapaq-wazuh-retention.json`) más el repositorio de snapshots `qapaq-s3`
(plugin `repository-s3`, bucket con KMS y `storage_class: standard_ia`).

**Hecho (sin verificar en AWS):** la política actual tiene hot 0–30 d, warm 30–90 d (`read_only`,
`force_merge`, `replica_count: 0`) y cold a los 90 d con `snapshot` y borrado local; `qapaq-restored-ttl`
borra a los 7 días los índices `restored-*`; `qapaq-wazuh-archives-7d` borra `wazuh-archives-*` a los 7 d.

**Propuesto:** acortar el hot de `wazuh-alerts-*` a **7 d** (snapshot y borrado local al cumplirlos),
porque el disco del nodo único es el recurso caro y el costo de retención está en S3. La política
se ajusta en `wazuh/indexer/ism/` con un script idempotente y se prueba con un volumen real
antes de fijar el valor.

- **Un solo nodo:** hot y warm son estados lógicos y `replica_count: 0`. La protección del dato
  no es la réplica sino los snapshots a S3 y los snapshots EBS diarios ([06](06-operacion.md)).
- **Wazuh 5 / OpenSearch 3:** los snapshots se pueden montar como **searchable snapshots** sin
  restaurar. Eso reemplazaría el paso de restauración; queda para la fase 4.
- **El borrado definitivo de snapshots en S3 está desactivado** hasta que Legal ratifique la
  matriz (N7). El script `wazuh/indexer/ism/apply-ism.sh` crea el repo y las políticas; no borra
  snapshots.
- **No aplicar lifecycle de S3 (Glacier ni expiración) al bucket de snapshots del Indexer.** Los
  blobs de snapshot son incrementales y compartidos entre snapshots: expirarlos o moverlos a Glacier
  por debajo del repositorio lo corrompe. La reducción de costo se hace con `storage_class` del
  repositorio y la eliminación con la API de snapshots. **Glacier aplica solo a evidencia,
  auditoría y exportaciones**, no al repositorio.
- **Object Lock en los buckets de evidencia y auditoría**, modo compliance, con versionado. Se
  crean buckets nuevos para este fin; el modo compliance no se puede acortar ni quitar.

## Matriz de retención (provisional, pendiente de Legal/Compliance)

| Dataset | Rápido (Indexer o Aurora) | Total | Notas |
| --- | --- | --- | --- |
| Telemetría cruda (`wazuh-archives-*`) | 7 d en demo | 7 d en demo | Política ISM `qapaq-wazuh-archives-7d`; producción requiere decisión de Legal/Compliance |
| Alertas Wazuh (`wazuh-alerts-*`) | 7 d hot (propuesto; hoy 90 d en la política) | 400 d | Resto en snapshots S3 |
| Alertas QAPAQ no promovidas | 180 d | 400 d | Aurora |
| Incidentes, evidencia, auditoría administrativa, ejecuciones SOAR, versiones de reglas | — | 5 años | Aurora más Object Lock |
| Autenticación y sesiones | 180 d | 400 d | |
| Exportaciones | 7 d | 30 d máx. | |

**Respaldos de Aurora (propuesto):** PITR continuo (Aurora admite hasta 35 d), copias diarias y
mensuales en AWS Backup con vault bloqueado y copia a `qapaq-log-archive`. Los valores exactos
(14 d, 35 d, 12 meses de la topología anterior) se reconfirman. Los snapshots del Indexer no son
el archivo de evidencia: la evidencia va al bucket con Object Lock.

La captura cruda (`logall_json`) comprende todos los eventos que procesa Wazuh Manager, no
exclusivamente M365. En el demo el índice `wazuh-archives-*` se elimina localmente al cumplir siete
días; este plazo no modifica la retención de alertas ni habilita expiración de snapshots S3. La
recuperación histórica del Activity API de Microsoft es una operación separada: solo está disponible
durante siete días desde la notificación de cada blob y requiere replay con deduplicación antes de
reinyectarse al Manager.

**Datos personales y tarjetas:** IP, UPN y trazas son datos personales (Ley 29733, a confirmar);
no se envía raw a Teams. Si PCI-DSS aplica, el PAN se enmascara antes de indexarse y no se
guarda en Aurora ni en evidencia.

## Restauración

```bash
# 1. Ver snapshots disponibles
GET _snapshot/qapaq-s3/_all
# 2. Restaurar un día como índice temporal
POST _snapshot/qapaq-s3/<snapshot>/_restore
{ "indices": "wazuh-alerts-4.x-2026.06.01", "rename_pattern": "(.+)", "rename_replacement": "restored-$1" }
```

En la fase 2 (propuesto), QAPAQ expone `POST /api/history/restore` (Lambda). Requiere la capacidad
`history.restore` y aprobación del Líder SOC, tiene una cuota de días por solicitud y queda
auditado. El dashboard nunca restaura directamente.
