# Validación de la entrega documental

Fecha: 2026-09-17. Alcance: arquitectura creada en docs/, sin implementación de
features ni acceso a servicios de Financiera Qapaq.

## Comprobaciones

- Presencia de los diez documentos solicitados en architecture/ y documentación complementaria de estructura, dependencias, convenciones, pruebas, threat model, riesgos y preguntas.
- Catorce ADR canónicos identificados por encabezado ADR-001…014, todos Proposed, con Context, Decision, Alternatives, Consequences y Trade-offs. Los tres archivos heredados de temas renumerados son notas de traslado, no ADR adicionales.
- Enlaces Markdown locales comprobados contra el filesystem, sin depender de que Git rastree los archivos nuevos. Encabezados requeridos de la evaluación y fences Markdown comprobados.
- Diez fuentes Mermaid analizadas y renderizadas con Mermaid 12.0.0 en Chromium headless. Inspección visual de contenedores, ingesta y tiers; imágenes temporales de validación fuera del repo, fuentes .mmd canónicas dentro de docs/diagrams/.
- Revisión manual de separación de módulos, ownership, autorización por objeto/campo, auditoría transaccional, raw durable, idempotencia y restauración histórica; inconsistencias principales resueltas en overview.md.
- Comparación SHA-256 de los archivos preexistentes fuera de docs/: sin modificaciones por esta tarea. Se observaron archivos de CI añadidos en paralelo bajo .github/ y documentación asociada; se conservaron y no se atribuyen a esta entrega de arquitectura.

## Límites

No se ejecutaron tests de aplicación, SAST, pruebas de proveedores, carga, restore
real ni validación de credenciales/licencias. No hay implementación de negocio que
verificar en esta tarea. El workflow CI concurrente y sus resultados quedan fuera
de esta validación; consultar su documentación específica.

Renderizar Mermaid no demuestra corrección operacional de la arquitectura. Los
contratos son propuestas; faltan schemas ejecutables, pruebas de conformidad y
aprobación de políticas. No se han aprobado ADR ni riesgos en nombre de Qapaq.

Las páginas de Sophos/Cato no pudieron leerse íntegramente; sus capacidades
detalladas quedan pendientes. Las fuentes de referencia disponibles se documentan
en [references.md](references.md). Retención, identidad, capacidad y continuidad
se resolverán mediante [preguntas abiertas](decisions/unresolved.md).
