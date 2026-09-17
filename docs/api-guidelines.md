# API y política por operación

Estado: PROPOSAL; no rutas desplegadas. [Seguridad](architecture/security.md),
[RBAC](architecture/rbac.md) y [auditoría](architecture/audit.md).

## Flujo

Autenticación → evaluación de capabilities → validación estructural → carga
autorizada del recurso y restricciones de scope/campo → validación de negocio →
operación transaccional y auditoría → respuesta segura. Validación de tamaño
también ocurre antes del parseo. Control de objeto se repite al conocer el recurso;
un guard de ruta no puede verificar todo con un ID no resuelto.

Cada endpoint expuesto declara política; uno público necesita excepción explícita.
Proteger rutas administrativas, health detallado, exports, streams y jobs igual
que los controllers principales. No usar if role == ADMIN como bypass universal.

## Ficha requerida antes de implementar

Método/ruta propuestos, caso de uso, actor, allOf/anyOf capabilities, scope, controles
de objeto/campo, DTO runtime, límites, respuesta/errores, idempotencia, auditoría,
riesgos y pruebas negativas. No crear endpoints de relleno.

Ejemplo conceptual de cerrar incidente: incidents.close + acceso al incidente +
estado permitido + responsable/disposición/razón. Versión de recurso evita lost
updates; transacción incluye cambio, AuditEvent y outbox. El ejemplo no fija una
ruta ni supone que el permiso esté asignado.

## Entrada, salida y consumo

Aceptar solo campos allowlisted; paginación limitada, rangos temporales y filtros
tipados. No exponer DSL arbitraria de OpenSearch ni SQL del cliente. Limitar cuerpos,
profundidad, coste de query, frecuencia y concurrencia por actor/operación.
Umbrales quedan pendientes de medición. Secure headers y CORS de orígenes aprobados;
si hay cookies, CSRF en mutaciones. Escapar salida en contexto, no «sanitizar»
destructivamente el raw original.

Errores con code estable, mensaje seguro y correlationId, sin stack trace, tokens,
secrets, consultas ni connection strings. 401 para identidad ausente/inválida;
403 o 404 consistente para evitar enumeración según política; 409 para versión/
estado incompatible; 429 con retry apropiado para límites. Detalles solo en logs
redactados. No revelar existencia de recursos a quien carece de permiso.

## Asincronía e idempotencia

Para restores/reportes/exports, contrato de job con estado y cobertura; 202 significa
aceptado para procesar, no completado. Estado/descarga requieren reautorización.
Idempotency key de mutaciones reintentables se vincula a actor, operación, scope
y hash de payload; misma clave con payload diferente devuelve conflicto. Ventana
y almacenamiento quedan definidos por operación antes de implementarla.

Las descargas usan referencias opacas y canal autorizado; si se eligen URLs firmadas,
deben tener alcance/caducidad y no quedar en logs. No permitir exportaciones masivas
mediante permiso de lectura básico.

## Criterios de pruebas

Actor válido permitido y denegado; sesión revocada; objeto ajeno; escalada por campos;
overposting; límites/rangos; concurrencia; replay de key; fallo de auditoría; job
creado antes de revocación; respuestas sin secretos. Documentar N/A con motivo.
