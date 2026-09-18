# ADR-024 — Microsoft 365 y Wazuh como vertical del primer MVP

Estado: Accepted / Implementation Required · Fecha: 2026-09-18.
Fuente: decisiones explícitas del usuario durante la planificación del MVP.
Responsables: Product Owner, Desarrollo, dueño de Microsoft 365 e Infraestructura.

## Context

ADR-015 y ADR-019 ordenaban Wazuh y Microsoft como dos pilotos sucesivos. La
decisión vigente concentra el primer MVP en Microsoft 365 como única fuente
empresarial y conserva Wazuh como sistema base real para análisis, reglas y alertas.
El equipo disponible está compuesto por dos personas y el plazo objetivo es de seis
semanas; integrar APIs de Cato y Sophos en paralelo impediría profundizar en la
seguridad y operación de la primera vertical.

QAPAQ debe poder incorporar esas APIs después del MVP sin modificar el dominio, la
admisión ni los consumidores del evento canónico. Esa extensibilidad no requiere
implementar adapters especulativos.

## Decision

El primer MVP usa esta ruta:

```text
Microsoft 365 autorizado
  → integración nativa Office 365 de Wazuh
  → análisis y ruleset Wazuh
  → alertas en Wazuh Indexer
  → adapter Wazuh de QAPAQ
  → SecurityEvent 1.0.0
  → enriquecimiento, priorización y lifecycle QAPAQ
  → alerta/caso/auditoría/notificación
```

Microsoft 365 es la única fuente empresarial del MVP. Wazuh es una dependencia
central del pipeline, no una segunda fuente de negocio. La edición, versión,
dataset de Office 365, licencia, permisos, frecuencia y retención se confirman con
el entorno autorizado en Sprint 1. No se sustituye esta prueba con datos simulados.

Wazuh ejecuta la recolección soportada de Office 365, decodificación, reglas y
generación de alertas base. QAPAQ consume alertas mediante acceso de solo lectura al
Indexer, conserva procedencia y regla Wazuh, normaliza a SecurityEvent y gobierna
enriquecimiento, priorización, deduplicación prudente, casos, RBAC, auditoría,
reporting, notificaciones y futuras automatizaciones. QAPAQ no duplica en el MVP el
ruleset base de Wazuh.

Cato y Sophos quedan fuera del runtime, despliegue y Sprint Backlogs iniciales.
También queda fuera una segunda API directa de Microsoft que duplique la ruta
Wazuh. Permanecen en el Product Backlog posterior y no se crean clientes,
credenciales o módulos vacíos para anticiparlos.

La extensibilidad se obtiene mediante:

- `SecurityEventProvider` como port de aplicación independiente del proveedor;
- adapters aislados por proveedor, conectados únicamente en el composition root;
- `qapaq.security-event` 1.0.0 como salida común hacia los consumidores;
- mappings, checkpoints, capacidades y errores versionados por dataset;
- admisión durable, cuarentena, replay y observabilidad compartidos;
- suite de conformidad ejecutable que todo adapter futuro debe superar;
- prohibición de imports desde dominio/aplicación hacia SDKs, DTOs o clientes de
  Wazuh, Microsoft, Cato o Sophos.

No se usan fakes como evidencia de funcionamiento. Las specs puras verifican
invariantes y schemas; las specs de infraestructura usan servicios reales aislados;
las specs de Wazuh ejecutan una instancia real; y Microsoft 365 solo queda Done al
probar la integración Wazuh contra un tenant autorizado con credenciales externas
al repositorio. Sin acceso, el PBI queda `BLOCKED` y no se declara integrado.

## Alternatives

- Consumir Microsoft Graph directamente y reimplementar reglas en QAPAQ: duplica
  capacidades base de Wazuh y contradice la dirección vigente.
- Usar Wazuh como producto SOC completo: reduce código, pero no cubre el ownership
  aceptado de QAPAQ para casos, autorización, auditoría y workflows.
- Construir adapters para todos los proveedores: aparenta extensibilidad y añade
  código sin contratos reales.
- Crear un adapter universal: mezcla autenticación, paginación, throttling, replay
  y semánticas incompatibles.
- Acoplar dominio a documentos Wazuh: acelera una demo y obliga a reescribir
  consumidores al incorporar una fuente directa futura.

## Consequences

El incremento inicial concentra evidencia en Microsoft 365 y Wazuh reales. La
incorporación futura de otro proveedor añade adapter, mapping, inventario, specs de
conformidad y prueba autorizada; no modifica el dominio ni los consumidores de
SecurityEvent.

Wazuh se convierte en dependencia de disponibilidad y capacidad del MVP. Una caída
detiene nuevas alertas base, pero QAPAQ conserva el último checkpoint, no pierde lo
ya admitido y muestra cobertura degradada. La correlación multifuente y los adapters
Cato/Sophos quedan fuera del MVP.

## Trade-offs

Se reduce cobertura inicial a cambio de profundidad operacional. El contrato común
se valida primero con alertas Wazuh derivadas de Microsoft 365, por lo que el primer
adapter directo post-MVP deberá comprobar que la abstracción no contiene supuestos
del documento Wazuh. La suite de conformidad y las reglas de dependencia reducen
ese riesgo.

## Validación y revisión

La decisión queda implementada cuando: Office 365 produce actividad autorizada;
Wazuh la recolecta y genera la alerta esperada; QAPAQ lee el Indexer con mínimo
privilegio; el documento se normaliza a SecurityEvent; las specs reales cubren
paginación, 401/403, 429 si aplica, timeout, checkpoint y replay; reiniciar QAPAQ no
duplica efectos; detener Wazuh muestra degradación; y la guía de incorporación de
proveedores demuestra que no hay cambios en dominio o consumidores.

Revisar este ADR al cerrar el primer MVP o antes de autorizar una segunda fuente.

[Estrategia de fuentes](../architecture/source-integration-strategy.md) ·
[Plan Scrum](../project-management/README.md) ·
[ADR-019 sustituido parcialmente](019-source-boundaries-and-authorized-pilots.md)
