# ADR-029 — QAPAQ SecOps como plataforma SIEM/XDR y espacio de trabajo SOC

- Estado: Accepted.
- Fecha: 2026-10-13.
- Responsables: Product Owner, SOC y Arquitectura.
- Sustituye: la decisión de producto descrita en `docs/deployment/qapaq-dashboard-wazuh-adaptation.md` que define Wazuh Dashboard adaptado como consola final.
- No sustituye: la vertical técnica del MVP de [ADR-024](024-microsoft-365-wazuh-mvp-vertical.md) ni la selección de Shuffle de [ADR-028](028-shuffle-soar-webhook-adapter.md).

## Contexto

QAPAQ SecOps se había descrito en algunos documentos principalmente como la consola
que complementa las alertas de Wazuh, y la adaptación de Wazuh Dashboard llegó a
presentarse como la interfaz final del producto. Esa descripción reduce el propósito
de QAPAQ a una pantalla y deja en segundo plano sus responsabilidades de SIEM/XDR,
operación SOC, respuesta y aprendizaje institucional.

El producto debe integrar un motor de seguridad de código abierto y concentrar en
QAPAQ la experiencia de operación, el contexto de la organización financiera y las
capacidades diferenciales que necesitan sus analistas. El MVP mantiene la ruta
Microsoft 365 → Wazuh → QAPAQ aprobada por ADR-024. La evolución posterior debe
ampliar fuentes, investigación colaborativa y automatización sin crear un segundo
motor SIEM ni confiar la autorización de negocio a la interfaz.

## Decisión

QAPAQ SecOps es el producto SOC central de la Financiera Qapaq: una plataforma SIEM/XDR
que integra recolección y detección de Wazuh con normalización, investigación,
coordinación operativa, respuesta gobernada y aprendizaje continuo. Wazuh es un
componente tecnológico del producto —motor de agentes, ingesta, reglas y alertas—,
no el nombre ni el límite de QAPAQ SecOps.

La experiencia final pertenece a QAPAQ SecOps. Después del MVP no se mantendrá un
Wazuh Dashboard independiente como consola principal del SOC. La consola QAPAQ podrá
reutilizar componentes y capacidades compatibles de OpenSearch Dashboards/Wazuh
donde aporten valor, pero navegación, identidad de producto, flujos de investigación,
autorización y experiencia operativa serán de QAPAQ. El Dashboard de Wazuh podrá
conservarse temporalmente como herramienta técnica de administración o transición
mientras la consola equivalente de QAPAQ cubre los casos operativos requeridos; su
retirada dependerá de paridad comprobada y no de una fecha supuesta.

**Ayni Qapaq** es el espacio colaborativo de investigación y gestión de incidentes
dentro de QAPAQ SecOps, inspirado en los flujos de trabajo de TheHive. Permite que un
equipo revise señales que ameritan atención, asigne responsables, coordine tareas,
registre notas y evidencia con procedencia, mantenga una línea de tiempo auditable,
documente decisiones y preserve el resultado como antecedente histórico reutilizable.
La inspiración se limita a patrones de colaboración; QAPAQ conserva su propio modelo
de dominio, controles, vocabulario y diseño. Ayni Qapaq no constituye otro SIEM ni
una fuente paralela de alertas.

Después de estabilizar el MVP, QAPAQ incorporará un SOAR no-code basado en Shuffle,
según ADR-028. QAPAQ conservará el catálogo de acciones permitidas, permisos,
aprobaciones, alcance, versiones autorizadas, idempotencia, correlación, auditoría y
reconciliación. Los playbooks podrán invocar capacidades de Wazuh adaptadas a las
necesidades de la financiera mediante adapters controlados. Active Response seguirá
siendo una capacidad de ejecución de Wazuh cuando corresponda; no sustituye el
gobierno de acciones de QAPAQ ni autoriza acciones por sí sola. El motor y editor
visual de Shuffle se habilitarán después del MVP tras superar los gates de seguridad,
integración y operación.

La visión del producto comprende un ciclo continuo de monitoreo, detección,
investigación, respuesta, mitigación y aprendizaje. El aprendizaje se materializa
con evidencia histórica, revisión de incidentes, mejora aprobada de detecciones y
playbooks, y retroalimentación verificable; no implica cambios autónomos en reglas o
respuestas sin validación humana y trazabilidad.

## Alcance por etapa

- **MVP:** mantener la única vertical empresarial aprobada —Microsoft 365 recolectado
  por Wazuh y consumido por QAPAQ—; completar triaje, investigación, incidentes,
  auditoría y operación de fuentes acordados. El MVP no se redefine como un reemplazo
  general de todas las funciones Wazuh ni como un XDR de cobertura universal.
- **Evolución post-MVP:** consolidar la consola propia QAPAQ y Ayni Qapaq; añadir
  fuentes XDR priorizadas por autorización y valor; habilitar Shuffle y playbooks
  financieros gobernados; incorporar lecciones y mejoras de detección con revisión.
- **No incluido por esta decisión:** migrar inmediatamente todo Wazuh, duplicar su
  ruleset, habilitar respuestas destructivas sin aprobación, prometer cobertura de
  todas las fuentes o afirmar que las capacidades futuras ya están operativas.

## Licenciamiento y sostenibilidad

La preferencia es construir sobre proyectos open source compatibles para evitar
costos de licencias propietarias de software en los componentes seleccionados. Esto
no equivale a costo total cero: permanecen infraestructura, almacenamiento,
conectividad, soporte, operación, seguridad, capacitación y mantenimiento. Antes de
cada adopción se revisarán la licencia, procedencia, obligaciones de redistribución,
compatibilidad, ciclo de soporte y costo operativo del proyecto.

La arquitectura modular permite que un equipo pequeño incorpore capacidades por
verticales y extienda el producto con adapters y módulos acotados. La modularidad no
justifica crear servicios, motores o abstracciones duplicadas sin una necesidad
validada, ownership y evidencia operativa.

## Consecuencias y guardas

- Los requisitos y documentación del producto describirán QAPAQ SecOps como
  plataforma; Wazuh y Shuffle se documentarán como componentes integrados.
- Se actualizarán progresivamente los documentos que todavía asignan al Wazuh
  Dashboard el papel de consola final. El plan de adaptación visual de ese Dashboard
  queda sustituido; las tareas de transición y migración de capacidades se conservan
  solo donde sean reutilizables para la consola QAPAQ.
- PostgreSQL y los servicios de QAPAQ mantienen la fuente de verdad para casos,
  permisos, aprobaciones y auditoría. Alertas y eventos fuente mantienen su
  procedencia en Wazuh u otros proveedores; QAPAQ no los altera para simular autoridad.
- Toda acción automatizada valida autorización en servidor, scope, aprobación
  aplicable, versión autorizada, límites e idempotencia; las operaciones ambiguas se
  reconcilian antes de reintentarse.
- La salida del Dashboard Wazuh requiere matriz de capacidades, pruebas de rol,
  búsqueda y respuesta operativa, exportación/retención, rendimiento, recuperación y
  rollback en un entorno autorizado.
- La afirmación de ahorro de licencias se limita a licencias de software seleccionadas;
  el presupuesto de operación debe incluir costos recurrentes no relacionados con
  licenciamiento.

## Criterios de revisión

Revisar esta decisión al aceptar el cierre del MVP, al habilitar la primera fuente
adicional, antes de desplegar Shuffle en producción o si una evaluación de licencia,
soporte, seguridad o costo cambia la selección de componentes.

## Referencias

[ADR-024 — Vertical del primer MVP](024-microsoft-365-wazuh-mvp-vertical.md) ·
[ADR-028 — Shuffle como motor SOAR](028-shuffle-soar-webhook-adapter.md) ·
[Sistema](../architecture/system-context.md) ·
[Motor Wazuh/OpenSearch](../architecture/wazuh-engine-and-opensearch.md).
