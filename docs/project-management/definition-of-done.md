# Definition of Done y criterios de refinamiento

Estado: BASELINE DEL EQUIPO para el timebox 2026-09-19 a 2026-10-30.
La Definition of Done es común a todos los incrementos; un criterio específico de
un PBI puede endurecerla, nunca reducirla.

## Definition of Done

Un PBI de software está Done únicamente cuando cumple todos los criterios aplicables:

### Resultado y trazabilidad

- satisface cada criterio de aceptación observable del issue;
- está vinculado a Product Goal, Sprint Goal, ADR/requisito y PR;
- no contiene `TODO`, excepción o comportamiento degradado no registrado;
- documentación operativa y de arquitectura refleja el comportamiento final;
- el Product Owner acepta el resultado de negocio durante o antes de la Review.

### Diseño y código

- mantiene monolito modular, capas hexagonales y dependencias hacia adentro;
- dominio/aplicación no importan SDKs, DTOs ni clientes de Wazuh/Microsoft;
- no crea abstracciones para proveedores futuros sin consumidor actual;
- contratos públicos están versionados y el cambio SemVer está justificado;
- errores, límites, timeout, idempotencia y comportamiento degradado son explícitos;
- no introduce secretos, datos personales reales ni URLs sensibles en código,
  tests, logs, fixtures, issues o evidencia.

### Specs automatizadas

- unit specs relevantes pasan sobre dominio puro;
- contract specs validan JSON Schema y la suite de conformidad del adapter;
- integration specs pasan con dependencias reales aisladas;
- provider specs pasan contra Microsoft 365 y Wazuh autorizados cuando el PBI
  afirma integración externa;
- E2E specs pasan para la ruta de usuario o pipeline modificada;
- pruebas negativas cubren autorización, input hostil y fallos de frontera;
- no hay spec obligatoria omitida, deshabilitada o marcada flaky;
- el reporte identifica comando, commit, versiones, entorno y resultado.

Mocks, stubs, servidores fake y respuestas grabadas no se incorporan a la suite ni
a la evidencia del MVP. Datos sintéticos sí pueden inyectarse en Microsoft
365/Wazuh reales cuando no contienen información personal.

### Seguridad

- autorización de endpoint/recurso/campo está definida y probada;
- acciones relevantes producen AuditEvent sin secretos;
- logs, traces y métricas respetan redacción y cardinalidad;
- inputs de Microsoft/Wazuh se tratan como datos no confiables;
- secretRefs se resuelven fuera del repositorio y con privilegio mínimo;
- SAST, secret scan, dependency scan y análisis aplicable concluyen sin hallazgos
  bloqueantes o con excepción aprobada, dueño y vencimiento;
- cambios en contratos, autenticación, reglas o mappings reciben la revisión exigida
  por los ADR.

### Operación y resiliencia

- health, métricas y errores permiten distinguir healthy, degraded y failed;
- reintentos tienen presupuesto, backoff y no duplican efectos;
- checkpoint/replay y cuarentena conservan lineage;
- reinicio y caída de dependencia aplicable se prueban;
- migración, rollback y compatibilidad se prueban cuando cambian datos o contratos;
- capacidad y límites se miden cuando el PBI altera carga o almacenamiento.

### Entrega

- PR pequeño, actualizado y aprobado por una persona distinta del autor;
- commits cumplen la convención acordada;
- CI requerida está verde; `skipped` solo es válido cuando el job no aplica por una
  condición documentada, no para ocultar una prueba faltante;
- branch actualizada sin conflictos y diff limitado al PBI;
- incremento es ejecutable y demostrable sin edición manual del código;
- evidencia se enlaza desde el issue sin exponer datos sensibles.

## Definition of Done documental

Un PBI exclusivamente documental está Done cuando los hechos y decisiones tienen
fuente, estados FACT/DECISION/PROPOSAL/ASSUMPTION/UNKNOWN son explícitos, enlaces y
diagramas validan, `git diff --check` pasa, el documento no afirma implementación
y el reviewer aprueba claridad y consistencia. Una decisión que exige código puede
estar Done como documentación y conservar `IMPLEMENTATION REQUIRED`.

## Criterios de refinamiento

Antes de considerar un PBI para Sprint Planning debe tener:

- resultado valioso expresado desde el usuario u operación;
- alcance incluido y excluido;
- criterios de aceptación verificables;
- dependencias, permisos y datos necesarios;
- riesgo de seguridad y ADR aplicables;
- evidencia esperada y tipo de specs;
- tamaño que pueda completarse dentro de un Sprint;
- preguntas abiertas visibles con dueño.
- uno o más componentes `C-xx`, ruta concreta y orden de dependencias según el
  [plan de construcción](component-delivery-plan.md).

Estos criterios mejoran transparencia; no son una “Definition of Ready” obligatoria
ni permiten que una persona bloquee unilateralmente el refinamiento.

## Política de defectos

- P0: vulnerabilidad explotable, pérdida/corrupción de evidencia, bypass de
  autorización o duplicación de efecto crítico. Detiene el trabajo relacionado.
- P1: incumple el Sprint Goal o criterio del MVP. Se corrige antes de tomar alcance
  adicional.
- P2: impacto acotado con workaround seguro. Vuelve al Product Backlog ordenado.

Un defecto que impide la Definition of Done mantiene el PBI fuera del incremento.
No se cierra y reabre para mejorar métricas.

## Evidencia mínima por tipo

- Contrato: schema, ejemplos válidos/inválidos y reporte de compatibilidad.
- Integración: versiones, configuración no secreta, ejecución real y fallos.
- Seguridad: caso permitido, caso denegado y registro de auditoría.
- Pipeline: raw/ref/hash, checkpoint, salida, replay y cuarentena.
- UI/API: spec E2E, autorización y manejo de error.
- Operación: health, métrica, alerta y runbook ejercitado.
- Rendimiento: escenario, hardware, dataset, resultado y límite observado.

[Plan Scrum](README.md) · [Product Backlog](product-backlog.md)
