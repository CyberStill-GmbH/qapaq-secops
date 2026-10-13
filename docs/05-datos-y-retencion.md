# 05 · Datos y retención

## Dónde vive cada dato

| Dato | Sistema | Dueño | Integridad |
| --- | --- | --- | --- |
| Alertas y eventos de seguridad (`wazuh-alerts-*`, `wazuh-archives-*`) | Wazuh Indexer | Wazuh | Índice diario, ISM y snapshot a S3 |
| Casos: alertas QAPAQ, incidentes, tareas, notas | PostgreSQL (RDS) | QAPAQ | Transacción con auditoría. Notas append-only |
| Auditoría | PostgreSQL más archivo WORM (fase 3) | QAPAQ | Cadena SHA-256 y trigger append-only |
| Sesiones e identidades | PostgreSQL | QAPAQ | Solo `sha256(sessionId)` |
| Resultados de ML (`.opendistro-anomaly-results*`) | Wazuh Indexer | OpenSearch AD | Solo se leen |
| Evidencia exportada | S3 con Object Lock (compliance) | QAPAQ | Manifiesto con hash |

Este diseño reemplaza los anteriores (ADR-008 y ADR-018), que apuntaban a Azure Blob. La demo y
la plataforma corren en **AWS**, así que el destino frío es **S3**.

## Hot · warm · cold del Indexer

Mecanismo: **OpenSearch ISM** (política `qapaq-wazuh-retention`, en
`wazuh/indexer/ism/qapaq-wazuh-retention.json`) más el repositorio de snapshots `qapaq-s3`
(plugin `repository-s3`, bucket con KMS y `storage_class: standard_ia`).

| Fase | Edad del índice | Qué pasa | Consulta |
| --- | --- | --- | --- |
| **hot** | 0–30 d | Escritura activa, 1 shard primario | Dashboard o QAPAQ en tiempo real |
| **warm** | 30–90 d | `read_only`, `force_merge` a 1 segmento y `replica_count: 0` (un solo nodo en la demo) | Igual, algo más lento |
| **cold** | > 90 d | `snapshot` al repo `qapaq-s3` y luego `delete` del índice local | Restauración bajo demanda |
| **restored** | ≤ 7 d | Índice `restored-*` creado desde el snapshot. La política `qapaq-restored-ttl` lo borra a los 7 días | Dashboard (patrón `restored-*`) |

- **Un solo nodo (demo):** hot y warm son estados lógicos dentro del mismo nodo. En producción se
  añaden nodos con `node.attr.temp: warm` y se activa la acción `allocation` (ya está en la
  política, comentada).
- **Wazuh 5 / OpenSearch 3:** los snapshots se pueden montar como **searchable snapshots** (rol
  `warm`) sin restaurar. Eso reemplaza el paso de restauración y queda para la fase 4.
- **El borrado definitivo de snapshots en S3 está desactivado** hasta que Legal ratifique la
  matriz (N7). El script `wazuh/indexer/ism/apply-ism.sh` crea el repo y las políticas; no borra
  snapshots.
- **No aplicar lifecycle de S3 (Glacier ni expiración) al bucket de snapshots.** Los blobs de
  snapshot son incrementales y compartidos entre snapshots: expirarlos o moverlos por debajo del
  repositorio lo corrompe. La reducción de costo se hace con `storage_class` del repositorio. La
  eliminación se hace con la API de snapshots.

## Matriz de retención (provisional, pendiente de Legal/Compliance)

| Dataset | Rápido (hot+warm) | Total | Notas |
| --- | --- | --- | --- |
| Telemetría cruda (`wazuh-archives-*`) | 30 d | 365 d | Solo si se activa `logall_json` |
| Alertas Wazuh (`wazuh-alerts-*`) | 90 d | 400 d | |
| Alertas QAPAQ no promovidas | 180 d | 400 d | Postgres |
| Incidentes, evidencia, auditoría administrativa, ejecuciones SOAR, versiones de reglas | — | 5 años | Postgres más WORM |
| Autenticación y sesiones | 180 d | 400 d | |
| Exportaciones | 7 d | 30 d máx. | |

**Respaldos:** Postgres con PITR de 14 d, diarios por 35 d y mensuales por 12 meses. Los
snapshots del Indexer no son el archivo de evidencia: la evidencia va al bucket con Object Lock.

## Restauración

```bash
# 1. Ver snapshots disponibles
GET _snapshot/qapaq-s3/_all
# 2. Restaurar un día como índice temporal
POST _snapshot/qapaq-s3/<snapshot>/_restore
{ "indices": "wazuh-alerts-4.x-2026.06.01", "rename_pattern": "(.+)", "rename_replacement": "restored-$1" }
```

En la fase 2, QAPAQ expone `POST /api/history/restore`. Requiere la capacidad
`history.restore` y aprobación del Líder SOC, tiene una cuota de días por solicitud y queda
auditado. El dashboard nunca restaura directamente.
