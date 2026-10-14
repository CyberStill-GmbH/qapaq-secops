# Ayni Qapaq — investigación colaborativa de incidentes

**Ayni Qapaq** es el espacio de trabajo en equipo para investigar señales que
requieren atención, coordinar decisiones y conservar el aprendizaje sobre
incidentes de seguridad. Forma parte de Qapaq SecOps; no es un SIEM separado ni
una fuente alternativa de alertas.

## Propósito

Una alerta puede requerir análisis, pero también una historia que varias personas
puedan entender y continuar. Ayni ordena esa labor en un expediente común, con
responsables, tareas, evidencia vinculada, hipótesis, decisiones y una secuencia de
actividad que permita reconstruir lo ocurrido.

Su diseño toma como referencia los patrones de colaboración de TheHive —casos,
observables, tareas y trabajo en equipo— sin copiar su interfaz, vocabulario,
modelo de datos ni código. La identidad visual, permisos, estados y contratos
pertenecen a Qapaq SecOps.

## Recorrido de una investigación

1. **Recibir:** el analista abre una alerta priorizada desde la consola Qapaq y
   revisa fuente, tiempo, alcance, estado de cobertura y evidencia permitida.
2. **Organizar:** crea o relaciona un incidente y define objetivo, severidad,
   alcance y responsable. El mismo hallazgo no se duplica para simular varios
   casos.
3. **Investigar:** el equipo distribuye tareas, registra observaciones y mantiene
   hipótesis con referencias a los eventos originales. Las notas y correcciones
   conservan autor, hora y relación con la entrada anterior.
4. **Coordinar:** el timeline reúne transiciones, asignaciones, decisiones y
   acciones correlacionadas. Cada persona ve solo objetos y datos autorizados por
   su rol y scope.
5. **Responder:** desde una alerta o el expediente se revisa el catálogo de
   automatizaciones disponibles. Una ejecución requiere permiso, versión,
   parámetros y aprobación según impacto; su resultado se refleja en el mismo
   historial.
6. **Cerrar y aprender:** se registra resolución, fundamento, hallazgos y
   recomendaciones. La revisión posterior puede proponer cambios a detecciones o
   procedimientos, con control de versión y aprobación humana.

## Principios de experiencia

- Una vista de expediente muestra primero resumen, estado, owner, prioridad y
  próximos pasos; detalles y evidencia se cargan bajo demanda.
- El analista puede saltar desde la alerta a la investigación y volver al evento
  original sin perder filtros ni contexto de tiempo.
- La colaboración distingue “asignado”, “observador” y “aprobador”; atender,
  revisar y aprobar son responsabilidades distintas.
- La interfaz presenta de forma explícita datos stale, parciales, en restauración
  o no disponibles. La falta de datos no se presenta como ausencia de amenazas.
- La evidencia mantiene procedencia y acceso auditado. Raw, exportaciones y
  datos sensibles requieren autorización específica.
- Automatizaciones desconocidas o en ejecución no se muestran como exitosas. Una
  acción ambigua requiere reconciliación antes de repetirla.

## Base existente y evolución

El repositorio ya incluye una base de investigación de incidentes con estado,
alertas relacionadas, tareas, bitácora de notas y timeline. Ayni Qapaq organiza y
extiende esa capacidad como experiencia del producto. Sus siguientes entregas
deben verificar permisos por objeto, concurrencia, evidencia, referencias a
fuentes, historial, recuperación y conexión al catálogo SOAR.

La revisión de incidentes y el aprendizaje operativo se incorporan por etapas.
El nombre Ayni no afirma que la experiencia completa, la retención histórica o la
integración SOAR estén ya desplegadas; cada etapa requiere pruebas y evidencia.

## Documentación relacionada

- [Visión y decisión de producto](../adr/029-qapaq-secops-product-direction.md).
- [Arquitectura resiliente](../architecture/qapaq-secops-resilient-architecture.md).
- [Flujo de incidentes actual](../frontend-design/incidentes-investigacion.md).
- [Matriz de roles](../requirements/04-rbac-matrix.md).
- [Roadmap](../roadmap.md).
