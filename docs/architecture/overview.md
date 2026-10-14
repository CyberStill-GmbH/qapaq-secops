# Arquitectura general de Qapaq SecOps

**Fuente arquitectónica vigente:** [arquitectura resiliente](qapaq-secops-resilient-architecture.md), [C4](c4-model.md) y [ADR-030](../adr/030-resilient-platform-architecture.md). Esta página ofrece el resumen; las decisiones fechadas y la evidencia del ambiente conservan su autoridad.

## Producto

Qapaq SecOps es la plataforma SIEM/XDR que coordina monitoreo, alertas,
investigación, respuesta controlada y aprendizaje. Wazuh entrega capacidades de
agentes, adquisición y detección integradas; Qapaq añade normalización, contexto,
priorización, gobierno de acceso y coordinación del SOC. Ayni Qapaq ofrece el
espacio de investigación colaborativa. Shuffle es el motor SOAR no-code elegido
para una etapa posterior al MVP.

El producto no duplica el motor de reglas de Wazuh ni confía la autorización a la
interfaz. Las funciones diferenciales residen en el Core de Qapaq SecOps, con
contratos y ownership explícitos. Consulta la [decisión de producto](../adr/029-qapaq-secops-product-direction.md).

## Base de implementación

El repositorio contiene una aplicación organizada en API, worker y web, módulos de
acceso, conectores, telemetría, detección, SOC y SOAR, más contratos y servicios
transversales. Esa estructura permite compartir dominio sin dividir prematuramente
el producto en microservicios. La presencia de código, tests o vistas no demuestra
que el componente esté configurado o desplegado en el ambiente final.

La ruta prioritaria del MVP sigue siendo Microsoft 365 → Wazuh → Qapaq SecOps.
Cada fuente adicional requiere autorización, mapping, límites, observabilidad,
pruebas reales y un responsable operativo.

## Capas arquitectónicas

1. **Experiencia:** la consola carga listas paginadas y detalles bajo demanda; no
   conecta directamente a proveedores o stores.
2. **Core de producto:** API/BFF, identidad, RBAC por capability/scope, dominio
   SOC/Ayni, detección complementaria, auditoría y control de respuesta.
3. **Procesamiento:** pollers y workers desacoplados, contratos canónicos, admisión
   durable, checkpoints, reintentos e indexación acotada.
4. **Datos:** PostgreSQL para estado operacional; Redis/BullMQ para jobs; OpenSearch
   para búsquedas derivadas; object storage para raw, evidencia y archivo según
   política.
5. **Bordes:** balanceador para distribuir acceso a réplicas Qapaq; un balanceador
   interno y KrakenD para integrar APIs externas y webhooks autorizados.

Los detalles de resiliencia, polling escalonado, hot/warm/cold, despliegues rolling y
controles de sobrecarga están en la [arquitectura resiliente](qapaq-secops-resilient-architecture.md).

## Flujo resumido

```text
fuente autorizada
  → adquisición Wazuh o adapter mediante KrakenD
  → admisión durable y cursor/checkpoint
  → trabajos pequeños en Redis/BullMQ
  → normalización, enriquecimiento y detección
  → búsqueda OpenSearch + alertas en Qapaq SecOps Core
  → investigación compartida en Ayni Qapaq
  → playbook Shuffle solicitado con autorización y audit trail
```

El índice es una proyección de consulta, no autoridad transaccional. Una alerta no
desaparece si falla la búsqueda y un timeout de automatización no se interpreta
como éxito o permiso para repetirla.

## Separación de estados

| Estado | Significado |
| --- | --- |
| Base de código | Existe implementación identificable y contracts/tests que la cubren. |
| Integración validada | Un entorno autorizado completó el flujo con fuente real y evidencia. |
| Objetivo de arquitectura | Decisión aceptada que aún requiere despliegue y gates. |
| Propuesta | Opción que necesita aprobación antes de volverse estándar. |
| Histórico | Registro fechado que conserva lo observado en ese momento. |

No se infiere alta disponibilidad por tener balanceador dibujado, cero pérdida por
tener checkpoint, capacidad por tener cola, ni cumplimiento por nombrar un tier.

## Diagramas y decisiones

- [C4 contexto, contenedores y componentes](c4-model.md).
- [Vista de despliegue resiliente](../diagrams/15-resilient-deployment.mmd).
- [Flujos](data-flow.md), [almacenamiento](storage.md) y
  [continuidad](operations-and-continuity.md).
- [Índice de ADR](../adr/README.md), especialmente
  [producto](../adr/029-qapaq-secops-product-direction.md) y
  [arquitectura resiliente](../adr/030-resilient-platform-architecture.md).
