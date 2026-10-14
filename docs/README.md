# Documentación QAPAQ SecOps

Diez documentos cortos reemplazan los ~200 anteriores (sprints, informes de avance, auditorías
C-0X, 31 ADR solapados, specs de pantallas). El histórico completo sigue en git:
`git show 050f9fa:docs/<ruta>`.

| # | Documento | Pregunta que responde |
| - | --- | --- |
| 01 | [Producto](01-producto.md) | Qué es QAPAQ y qué añade sobre Wazuh |
| 02 | [Arquitectura](02-arquitectura.md) | Cómo encajan las piezas y qué salió del diseño |
| 03 | [Evaluación de componentes](03-evaluacion-de-componentes.md) | Qué se conserva, qué se migra y qué se retira, y por qué no hay fork del manager |
| 04 | [Identidad y acceso](04-identidad-y-acceso.md) | Login Entra único para la consola y el dashboard |
| 05 | [Datos y retención](05-datos-y-retencion.md) | Hot/warm/cold, evidencia y auditoría |
| 06 | [Operación](06-operacion.md) | AWS, costos, observabilidad, despliegue |
| 07 | [Detección, ML y SOAR](07-deteccion-ml-y-soar.md) | Correlación, anomalías y respuesta gobernada |
| 08 | [Frontend unificado](08-frontend-unificado.md) | El dashboard de Wazuh como shell y QAPAQ dentro |
| 09 | [Plan de lanzamiento](09-plan-de-lanzamiento.md) | Fases, criterios de aceptación y orden |
| 10 | [Decisiones](10-decisiones.md) | Registro único de decisiones vigentes |
| 11 | [Caché y colas](11-cache-y-colas.md) | Dónde Valkey es fundamental, lazy loading y en qué puntos van las colas |

`reference/` guarda las decisiones integradas de Codex (ADR-028 a 030 en `reference/decisiones/`, Ayni
Qapaq, la arquitectura resiliente y el rollout de Terraform) y los archivos que el código o la CI leen (catálogo de errores, inventario de
fuentes, guía de extensión de proveedores, baseline de toolchain y gates de release). Si se mueven,
hay que actualizar los tests que los referencian.

## Reglas de esta documentación

- Un tema, un documento. Si algo ya está en el código o en git, se enlaza en vez de repetirse.
- Cada afirmación de estado distingue **hecho y verificado**, **hecho sin verificar contra el
  proveedor real** y **propuesto**.
- Las decisiones nuevas se agregan como fila en [10-decisiones.md](10-decisiones.md), no como un
  archivo ADR nuevo.
