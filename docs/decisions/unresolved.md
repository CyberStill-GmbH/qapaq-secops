# Preguntas y decisiones pendientes

Actualizado: 2026-09-17. Las preguntas permiten completar el diseño sin inventar
capacidad, permisos o aprobaciones. Dueños son funciones sugeridas, no asignaciones
personales confirmadas. No bloquean esta entrega documental.

## U-001 — límites y aceptación operacional

PROPOSAL / UNRESOLVED. El nuevo adjunto define alcance y stack; antes estaban vacíos.
Ocho módulos y vocabulario/lifecycle están propuestos. SOC/Arquitectura deben
validar ownership y primera vertical. Cierre: escenarios de uso y criterios de
aceptación del piloto acordados. Puede continuar documentación y pruebas sintéticas.

## U-002 — versiones, tooling y capacidad

UNKNOWN / UNRESOLVED. NestJS/React/PostgreSQL/Redis/BullMQ son ahora requisitos,
no candidatos; faltan versiones, ORM, gestor workspace, runtimes, recursos y carga.
Desarrollo/Platform deben aportar compatibilidad, EPS/pico, tamaños y concurrencia.
Cierre: toolchain fijado, benchmark y límites de payload/query/lotes acordados.
No prometer capacidad ni crear comandos de calidad ficticios.

## U-003 — identidad y autorización

UNKNOWN / UNRESOLVED. ¿IdP/MFA y modelo de sesión? ¿Una entidad o ámbitos por
unidad/equipo/filial? ¿Quién puede asignar qué capabilities, exportar raw y aprobar
operaciones críticas? Seguridad/SOC/Identity deben validar matriz y revocación.
Cierre: política de acceso y federación comprobable. Bloquea endpoints productivos,
no diseño/fakes. Roles del documento son bundles propuestos.

## U-004 — retención, privacidad y custodia

UNKNOWN / UNRESOLVED. ¿Plazos por dataset/raw/audit/backups? ¿Requisitos aplicables,
residencia, clasificación, holds, purga y export? Legal/Compliance/SOC e
Infraestructura definen política y capacidades de object storage.
Cierre: política aprobada y restauración/hold demostrados antes de borrado automático.
No inferir obligaciones regulatorias por ser una entidad financiera.

## U-005 — fuentes piloto e inventario real

UNKNOWN / UNRESOLVED. Microsoft 365/Cato/Sophos son uso informado, Wazuh es componente
central requerido; faltan ediciones, datasets, APIs, licencias, scopes, cuotas,
cursores, destinos y versiones Indexer/Manager. SOC/dueños de fuentes aportan
inventario sin secretos al repo. Cierre: ficha y prueba autorizada del piloto,
incluida semántica de raw/ACK/replay y fuentes que no pueden garantizar cero pérdida.

## U-006 — auditoría y observabilidad

UNKNOWN / UNRESOLVED. ¿Proveedor de métricas/logs/traces, custodio de audit,
capacidad de archivo inmutable, llaves, buffer máximo y destino de alertas?
Seguridad/Infraestructura definen comportamiento de fallo y soporte.
Cierre: prueba de audit rollback, archivo/reconciliación y alertas ante atraso.

## U-007 — analítica Python

PROPOSAL / UNRESOLVED. Python queda permitido/requerido para cargas justificadas,
no activo en MVP automáticamente. ¿Qué análisis aporta valor frente a Wazuh/TS?
Desarrollo/SOC deben aportar caso y benchmark. Cierre: schemas conformes,
presupuesto y validación de proceso acotado; otro transporte requiere revisar ADR-007.

## U-008 — workflow SOC y SOAR

PROPOSAL / UNRESOLVED. ¿Cardinalidades Alert/Incident/Case, estados, cierre,
reapertura, evidencias obligatorias, grants L1/L2 y doble control?
SOC/Seguridad validan con escenarios. SOAR futuro necesita catálogo de acciones,
idempotencia externa y aprobaciones; no se implementa para cerrar esta pregunta.

## U-009 — operación y continuidad

UNKNOWN / UNRESOLVED. ¿RPO/RTO, SLO, ventanas de mantenimiento, backups,
capacidad de drenaje, propietarios y soporte fuera de horario?
Infraestructura/Platform/SOC acuerdan servicio y ensayan restore. Bloquea
producción, no desarrollo aislado. No introducir Terraform ni cloud concreto.

## U-010 — contrato SecurityEvent

PROPOSAL / UNRESOLVED. Núcleo v1, categorías, mappings de severidad, identidad de
eventos sin ID nativo y versiones ECS/OCSF deben contrastarse con corpus sintético
representativo. Desarrollo/SOC son dueños sugeridos. Cierre: diccionario,
schemas ejecutables y contract tests, sin autoafirmar compatibilidad.

## U-011 — CI y política de releases

UNKNOWN / UNRESOLVED. La solicitud de CI/CD concreta CodeQL, Dependabot, npm audit,
Trivy y Gitleaks; el flujo local usa runners hospedados de GitHub. Ver
[implementación y activación](../ci-cd.md). Faltan registro y destino de publicación,
ambientes, identidad de despliegue, aprobaciones, health checks, migraciones,
rollback y criterios de excepción. No existe evidencia de infraestructura provisionada.
Impacto: no habilitar publicación o despliegue con contratos/credenciales supuestos;
puede continuar CI. Desarrollo/Seguridad/Infraestructura acuerdan esos contratos.
Cierre: destino y política documentados y aceptados, pipeline probado sin secretos
en PR no confiable y evidencia de release y rollback.

## Historial

El registro inicial solo tenía U-001…007 y trataba tecnologías como candidatos.
La nueva solicitud aporta stack y proveedores previstos; se actualizan esas
premisas sin afirmar que estén desplegados. Ningún ADR pasa a Accepted por este
cambio. Mantener fecha, fuente y enlace a aceptación al resolver una entrada.
