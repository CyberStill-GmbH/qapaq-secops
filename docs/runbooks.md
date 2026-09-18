# Runbooks iniciales

Estado: procedimientos de diseño para convertir en operación tras conocer entorno.
No ejecutar comandos reales ni alterar proveedores a partir de estos documentos.
Cada runbook requiere dueño, señales, autorización, límites y evidencia del entorno.

## Conector degradado o sin eventos

Comprobar última recepción/checkpoint, errores y cobertura, sin revelar tokens.
Distinguir 401/403, throttling, indisponibilidad y «sin actividad». Pausar polling
si continuar empeora fallo; no adelantar cursor. Corregir secreto/permisos mediante
su custodio. Reanudar desde checkpoint con ventana/dedup documentadas.
Éxito: datos frescos, backlog drena y gaps se explican; no basta health HTTP verde.

## Backlog, jobs fallidos o Redis perdido

Comparar ingreso/drenaje, edad, errores, memoria y disco. Limitar fuentes/exportaciones
según prioridad aprobada; no borrar cola para ocultar atraso. Poison jobs van a
cuarentena con rawRef y razón. Tras recuperar Redis, reconciliar manifiestos/outbox/
efectos antes de reencolar; no ejecutar replay ilimitado ni duplicar notificaciones.
Éxito: cobertura y efectos reconciliados, lag dentro del objetivo acordado.

## Indexador caído

Marcar búsqueda parcial/degradada y preservar backlog idempotente de indexación;
la correlación de la primera vertical espera la indexación conforme a U-001. Reducir carga y coordinar
con el dueño Wazuh/Indexer sin modificar índices gestionados a ciegas.
Al recuperar, validar conteos/cobertura y mappings antes de restituir consultas.

## Auditoría no disponible o atrasada

Si falla append local de acción crítica, no confirmar mutación. Si falla archivo,
mantener buffer durable y alertar atraso/capacidad; bloquear nuevas acciones
críticas según límite acordado antes de agotarlo. Verificar manifiestos y
continuidad tras recuperación. No rellenar auditoría perdida como si se hubiera
observado; registrar incidente de integridad y reconstrucción con procedencia.

## Consulta cold / restauración

Autorizar propósito/rango, planear coste/capacidad y verificar hold. Restaurar
particiones seleccionadas a destino temporal autorizado, comprobar digests y
conteos, ofrecer estado/cobertura. Reautorizar descarga; cancelar/expirar trabajo
y limpiar derivados temporales respetando holds. Un fallo no equivale a cero resultados.

## Sospecha de secreto expuesto

Limitar conector/cuenta afectada, avisar a custodio y Seguridad por canal aprobado,
rotar/revocar, revisar alcance y auditoría. No pegar secreto en ticket/log/chat.
Conservar evidencia restringida y redactar derivados; verificar nueva referencia
y reanudar con mínimo permiso. No borrar evidencia por limpiar logs sin política.

## Purga y legal hold

Comprobar política aprobada, alcance, archivo verificado y ausencia de hold activo.
Acción autorizada/auditada con previsualización de objetos afectados. Si existe
conflicto de política/hold, detener la purga; no interpretar vencimiento como permiso
incondicional. Registrar resultado/tombstones y verificación posterior.

## Recuperación del producto

Restaurar en entorno aislado, validar llaves/secret refs, PostgreSQL y catálogo,
raw/archivo, reconstruir índices/colas según contrato, revisar permisos y
checkpoints. Arrancar fuentes controladamente y comparar cobertura. No ejecutar
playbooks/acciones externas durante replay de recuperación. Medir RPO/RTO real
y registrar discrepancias frente al objetivo.
