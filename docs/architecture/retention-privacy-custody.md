# Política de retención, privacidad y custodia

Estado de diseño: **CONDITIONALLY ACCEPTED** por
[U-004/ADR-018](../adr/018-retention-privacy-custody.md). Fecha aportada por el
usuario: 2026-09-18. La eliminación automática productiva está **BLOCKED UNTIL
RETENTION SCHEDULE IS APPROVED**.

## Principios y gobierno

La retención se define por dataset, clasificación, finalidad, trigger y autoridad.
No se acepta un plazo único, conservación indefinida «por si acaso», borrado solo
por antigüedad del índice, backups como archivo ni inferir plazos del core
financiero para el SOC. Prevalecen, en este orden: hold/investigación/autoridad;
obligación legal, regulatoria o contractual validada; necesidad probatoria o de
seguridad aprobada; baseline interna; eliminación verificable.

Legal y Compliance deben evaluar Ley N.° 29733, D.S. N.° 016-2024-JUS,
Resolución SBS N.° 504-2021 y modificatorias, regulación específica aplicable,
contratos, investigaciones y políticas corporativas. Un evento puede referenciar
una operación financiera sin convertir al SOC en su sistema de registro.

## Inventario y clasificación

Ningún dataset entra a producción sin `datasetId`, nombre, business owner,
technical custodian, finalidad, sistema fuente, clasificación, categorías de datos
personales, campos prohibidos, ubicaciones y regiones aprobadas, trigger, retención
hot/total, autoridad legal/contractual, inmutabilidad, backup, eliminación,
elegibilidad de hold y fecha de revisión.

Clasificaciones: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL` y `RESTRICTED`. La telemetría
raw es al menos `CONFIDENTIAL`; evidencia forense y datos personales sensibles son
`RESTRICTED`. No se indexan contraseñas, cookies, tokens, claves privadas, secretos,
números completos de tarjeta ni cuerpos de documentos financieros. Un secreto
detectado se cuarentena y alerta.

## Baseline provisional

| Dataset | Acceso rápido | Retención total | Inicio |
| --- | ---: | ---: | --- |
| Telemetría raw general | 30 días | 365 días | recepción |
| Eventos normalizados | 90 días | 400 días | recepción |
| Alertas no promovidas | 180 días | 400 días | cierre |
| Incidentes y casos | mientras estén activos | 5 años | cierre definitivo |
| Evidencia de incidentes | según investigación | 5 años | cierre definitivo |
| Auditoría de acceso/administración | 400 días | 5 años | creación |
| Aprobaciones y ejecuciones SOAR | 400 días | 5 años | finalización |
| Versiones de reglas | vida activa | 5 años | retiro |
| Autenticación y sesión | 180 días | 400 días | fin de sesión |
| Cuarentena inválida | 30 días | 30 días | ingreso |
| Jobs exitosos | 30 días | 90 días | finalización |
| Jobs fallidos | 90 días | 180 días | finalización |
| Exports temporales | — | 7 días; máximo 30 | generación |
| Cache, staging y temporales | — | 24 horas | creación |

Son objetivos internos pendientes de ratificación. Fraude, litigio, reclamo,
incidente de datos personales, investigación laboral, requerimiento de autoridad,
contrato o prescripción pueden exigir otro periodo.

## Tiers y lifecycle

- `HOT`: OpenSearch para investigación interactiva.
- `COLD`: Azure Blob cifrado, comprimido y restringido.
- `EVIDENCE`: Azure Blob inmutable para evidencia, auditoría crítica y manifests.

Mover datos no reinicia el plazo: se calcula desde `retentionTrigger`. Los índices
se separan por dataset y clasificación, usan aliases/templates versionados, rotan
por tiempo/tamaño, no mezclan políticas incompatibles y bloquean el borrado bajo
hold. Antes de eliminar se registra conteo, rango, checksum y resultado. No existe
un índice global de telemetría.

## Privacidad desde la ingesta

Cada pipeline soporta `ALLOW`, `DROP`, `REDACT`, `TOKENIZE`, `HASH` y
`QUARANTINE`. Aplica allowlists, minimiza headers/parámetros/cuerpos, enmascara
identificadores financieros cuando no sean indispensables, separa el mapping de
reidentificación y audita búsquedas raw y exports. No adquiere archivos completos,
adjuntos ni dumps sin autorización forense.

Legal/Privacy gobierna solicitudes de localización, restricción, exportación,
anonimización o eliminación vinculadas a una identidad. Un analista no borra
selectivamente evidencia o auditoría. Para incidentes de datos personales se
registran tiempos de descubrimiento/conocimiento, datasets, categorías, sujetos,
impacto, contención, notificaciones, plazos, autoridad, hold y cierre. Legal/Privacy
determina la notificabilidad y el plazo aplicable; el SOC no lo decide solo.
El D.S. N.° 016-2024-JUS contempla supuestos con notificación a la Autoridad
Nacional de Protección de Datos Personales dentro de 48 horas desde que se toma
conocimiento. Legal/Privacy determina si el supuesto aplica y registra el cómputo.

## Holds, custodia e inmutabilidad

Un hold contiene ID, caso, autoridad, solicitante/aprobador, razón, scope, datasets,
rango, recursos, creación, revisión y liberación. Debe ser granular, aprobado por
Legal/Compliance o autoridad designada, ejecutado por un custodio distinto y
revisado al menos cada 90 días. Su liberación se aprueba y audita; la información
permanece inmutable hasta entonces.

La evidencia registra ID, incidente, fuente/colector, adquisición, tiempos,
nombre/tipo/tamaño, SHA-256, versión del objeto, clasificación, referencia de llave,
eventos de custodia, hold y `retentionUntil`. El original no se modifica; se analiza
una copia vinculada a su hash. Adquisición, transferencia, validación, acceso,
copia, export, cambio de custodio, hold y eliminación quedan en cadena de custodia.
La desincronización de relojes se registra como limitación.

WORM se limita a evidencia, auditoría privilegiada, manifests de exportación,
holds, purge receipts y aprobaciones/acciones críticas. Se prueba desbloqueado
antes de bloquearlo; una política bloqueada no se acorta.

## Cifrado, backups y restauración

Datos `CONFIDENTIAL` y `RESTRICTED` se cifran en tránsito, reposo, backups,
objetos y exports. Las llaves viven fuera de la aplicación, con administración
separada, rotación, auditoría y recuperación. Crypto-erasure sigue un método
aprobado; borrar la llave no sustituye silenciosamente el borrado de objetos.

Baseline de backups: PostgreSQL PITR 14 días, diarios 35 días y mensuales 12 meses;
OpenSearch snapshots 30 días; Redis solo cuando el estado requiera recuperación;
configuración/reglas mediante versión y auditoría. Evidencia WORM se replica como
evidencia, no como backup mutable. Los backups expiran y no amplían la retención.

Toda restauración ocurre aislada, usa mínimo acceso, registra propósito/aprobador,
valida integridad, deshabilita acciones externas y reaplica el `deletion ledger`
antes de habilitar acceso. Se prueba trimestralmente de forma técnica, anualmente
de extremo a extremo y tras cambios mayores. Un job de backup exitoso no demuestra
recuperación.

Antes de la purga automática se demuestra: restore aislado de PostgreSQL; snapshot
de OpenSearch; recuperación de objeto archivado; checksum; conservación de
clasificación/ACL y auditoría; aplicación del deletion ledger; respeto de holds;
aislamiento desde producción; y destrucción del entorno de prueba.

## Purga y cambios de política

La purga identifica candidatos, verifica versión/trigger/holds y relaciones con
incidentes/evidencia, elimina hot/cold/derivados, invalida caches/exports, permite
la expiración de backups y reconcilia el resultado. Emite un `purge receipt` sin
contenido eliminado: `purgeRunId`, dataset, policyVersion, rango, objectCount,
bytesRemoved, tiempos, resultado, excepciones, manifestHash y aprobador. Es
idempotente; un fallo parcial alerta, identifica copias restantes y nunca se
declara éxito. El deletion ledger evita resurrección tras restore.

Un cambio de política es versionado, evalúa impacto y requiere aprobación del
owner, Legal/Compliance y Security, dry-run, reporte, fecha efectiva y rollback
cuando sea posible. Acortar un plazo aplica revisión de siete días salvo orden
legal urgente; aumentarlo requiere justificación.

## Exports, residencia y salida

Un export registra dataset/filtros/rango/finalidad, solicitante/aprobador,
clasificación, manifest, checksum, cifrado, descargas y evidencia de eliminación.
Expira en 7 días por defecto y no supera 30 sin Legal. El receptor acepta la
custodia de la copia.

No se presume residencia exclusivamente peruana. Antes de seleccionar región o
proveedor se documentan país/región primaria y réplica, backups, soporte,
subprocesadores, acceso extranjero, transferencias, acceso SBS/auditoría, salida,
eliminación y limitaciones jurídicas. Una región o subprocesador nuevo requiere
aprobación. El proveedor debe exportar en formatos documentados, verificar
integridad, migrar holds/metadata, recuperar auditoría, ejecutar salida, eliminar
copias/backups y evidenciar residuos y eliminación.

## Gate y aceptación productiva

Pueden desarrollarse interfaces, metadata, manifests, holds, WORM, deletion
ledger, fakes, tests y restore tooling. La eliminación automática requiere aprobar
inventario, clasificación, matriz normativa, periodos/triggers, regiones,
transferencias, backups, holds, sanitización y custodia, y superar:

1. Un evento recibe clasificación y política correctas.
2. Un secreto detectado se cuarentena y no se indexa.
3. Raw y normalizado tienen lifecycles independientes.
4. Un índice expira sin afectar otro dataset.
5. Un hold impide eliminar el objeto afectado.
6. El hold no bloquea datos fuera de su scope.
7. Liberarlo requiere aprobación y deja auditoría.
8. Un administrador no modifica evidencia WORM.
9. Una descarga de evidencia valida SHA-256.
10. La cadena de custodia registra cada acceso.
11. Un export expira y deja de ser descargable.
12. Una purga parcial alerta y no declara éxito.
13. Un backup restaura en un entorno aislado.
14. La restauración reaplica el deletion ledger.
15. No revive usuarios, exports ni datos purgados.
16. El inventario identifica región, réplica y subprocesadores.
17. Un dataset no aprobado se rechaza en producción.
18. Cambiar retención requiere doble aprobación.
19. Las búsquedas raw quedan auditadas.
20. Los purge receipts reconcilian OpenSearch y object storage.

Hasta superar el gate, solo hay lifecycle automático sintético y purga productiva
manual, aprobada y auditada.
