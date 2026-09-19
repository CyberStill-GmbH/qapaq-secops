# Especificación de requisitos de QAPAQ SecOps

Estado: **BASELINE PARA DESARROLLO** · Corte documental: 2026-09-19.

Esta especificación transforma las decisiones arquitectónicas vigentes en
requisitos verificables. No acredita software implementado, integraciones activas
ni preparación productiva. Los estados usados son:

- **CONFIRMADO:** necesidad o decisión aceptada con fuente explícita.
- **PROPUESTO:** diseño útil pendiente de aceptación.
- **PENDIENTE:** requiere una decisión o evidencia externa antes de comprometerse.

## Índice

1. [Alcance, actores y fuentes](00-scope-and-sources.md).
2. [Mapa de capacidades](01-capability-map.md).
3. [Requisitos funcionales](02-functional-requirements.md).
4. [Requisitos no funcionales](03-non-functional-requirements.md).
5. [Matriz RBAC](04-rbac-matrix.md).
6. [Inventario de fuentes y dependencias](05-source-inventory.md).
7. [Matriz de trazabilidad y dependencias](06-traceability-matrix.md).
8. [Decisiones y asuntos abiertos](07-open-decisions.md).
9. [Glosario](08-glossary.md).
10. [Informe de revisión de consistencia](09-review-report.md).

## Convenciones

- `RF-nnn` identifica una obligación funcional atómica.
- `RNF-nnn` identifica un escenario de calidad medible.
- `U-nnn` conserva el registro de decisión existente.
- **MVP** forma parte del primer recorrido Microsoft 365 → Wazuh → QAPAQ.
- **Posterior** pertenece al alcance objetivo, pero queda fuera del primer MVP.
- **Pendiente** no entra a un Sprint hasta que su criterio de cierre sea satisfecho.

Los criterios Dado/Cuando/Entonces son la base mínima de las specs. Un requisito
solo pasa a implementado cuando existe código y evidencia de prueba en un commit;
un ADR, diagrama o PBI no demuestra implementación.
