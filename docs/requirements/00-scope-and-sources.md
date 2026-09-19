# Alcance, actores y fuentes

## Propósito y objetivos observables

QAPAQ SecOps será la plataforma interna para que el SOC reciba actividad de
seguridad autorizada, conserve su procedencia, investigue alertas y gestione casos
con autorización y auditoría verificables.

Objetivos del primer MVP:

1. demostrar un recorrido real desde actividad controlada de Microsoft 365 hasta
   una alerta Wazuh y un `SecurityEvent` consultable en QAPAQ;
2. permitir que un analista autorizado priorice, acuse, investigue y relacione esa
   alerta con un incidente o caso;
3. preservar raw disponible, hashes, lineage, checkpoints y decisiones de
   autorización/auditoría sin afirmar ausencia de pérdida antes del piloto;
4. notificar alertas `CRITICAL` mediante Teams sin convertir Teams en fuente de
   verdad ni bloquear la creación de la alerta;
5. dejar una frontera de adapters que permita incorporar otras APIs sin cambiar el
   dominio ni el contrato canónico.

Los indicadores de valor, volumen y tiempo de atención requieren medición real.
No se fija en esta especificación una cifra de EPS, disponibilidad, RPO, RTO o
retención que no haya sido ratificada.

## Actores humanos

- **SOC L1:** vigila cobertura, consulta alertas en su ámbito, acusa, clasifica,
  documenta y escala.
- **SOC L2:** investiga, correlaciona evidencia, gestiona lifecycle y propone
  cierre o respuesta dentro de su ámbito.
- **SOC Manager:** supervisa colas, escalamiento, prioridades y aprobaciones
  operativas expresamente asignadas.
- **Detection Engineer:** diseña y prueba reglas QAPAQ; no modifica el ruleset
  Wazuh productivo sin el proceso del dueño del producto.
- **Platform Admin:** opera configuración lógica y salud de QAPAQ; no obtiene
  acceso implícito a raw, evidencias o roles.
- **Access Admin:** administra grants y scopes bajo doble control; no puede
  autoaprobar privilegios.
- **Auditor:** consulta auditoría y reportes autorizados en modo de solo lectura;
  exportar requiere capability y propósito separados.
- **Viewer:** consulta vistas permitidas con mínimo privilegio.
- **Infraestructura:** opera ambientes, Wazuh, stores, redes, secretos y servicios
  corporativos; no decide reglas del dominio QAPAQ.
- **Security / Compliance / Legal:** gobiernan controles, custodia y obligaciones;
  Legal/Compliance ratifica retención, privacidad y residencia.

## Sistemas externos

- Microsoft Entra ID: IdP humano single-tenant; configuración real pendiente.
- Microsoft 365: única fuente empresarial del MVP, recolectada por Wazuh.
- Wazuh Manager/Indexer: recolección Office 365, ruleset y alertas base; QAPAQ usa
  acceso de solo lectura al Indexer.
- Microsoft Teams Workflows: salida primaria para avisos críticos minimizados.
- PostgreSQL, Redis/BullMQ, OpenSearch QAPAQ y object storage: dependencias de la
  aplicación administradas por Infraestructura.
- OpenTelemetry Collector y servicio de firma: contratos corporativos externos.
- Cato, Sophos y MISP: integraciones posteriores sujetas a inventario y decisión.

## Frontera de responsabilidad

**SOC/Desarrollo** implementa software, contratos, adapters, normalización,
autorización, casos, pruebas y evidencia técnica. **Infraestructura** provisiona y
opera productos, ambientes, conectividad, identidades técnicas, secretos, backups
y destinos. **Security** valida políticas y excepciones. **Dueños de fuente**
autorizan datasets y permisos. **Legal/Compliance** ratifica finalidad, periodos,
residencia, holds y eliminación. Ningún documento de proveedor sustituye estas
aprobaciones.

## Alcance

### MVP

- sesión humana federada con Entra y autorización por capability, recurso y scope;
- inventario/configuración lógica de Microsoft 365/Wazuh mediante `secretRef`;
- lectura de alertas Wazuh derivadas de Microsoft 365;
- raw/manifiesto/checkpoint, idempotencia, replay y cuarentena;
- `SecurityEvent` 1.0.0, búsqueda e indexación derivada;
- priorización, alertas, triaje e incidente/caso mínimo;
- vista de cobertura y salud operacional;
- notificación crítica por Teams, acuse dentro de QAPAQ y fallback pendiente;
- auditoría de acciones sensibles y evidencia de CI/release candidate.

### Posterior

- adapters directos adicionales para Microsoft, Cato o Sophos;
- MISP/CTI, correlación multifuente, SOAR ejecutable y ticketing;
- capacidades antifraude completas;
- analítica Python después de caso, benchmark y aprobación.

### Exclusiones actuales

- infraestructura productiva, cloud, Terraform, Kubernetes y CMDB corporativa;
- administración física de Wazuh, endpoints, red o Microsoft 365;
- CD/publicación sin contrato de Infraestructura;
- obligaciones regulatorias o certificaciones no ratificadas;
- garantía de cero pérdida, operación 24x7 o capacidad no medida.

## Flujos operativos principales

1. **SOC L1:** autentica → abre cola autorizada → verifica cobertura → acusa alerta
   → clasifica → añade nota → escala o crea incidente.
2. **SOC L2:** abre incidente autorizado → consulta SecurityEvents y raw permitido
   → relaciona evidencia → cambia estado con motivo → propone resolución/cierre.
3. **Administrador:** solicita privilegio vigente → cambia configuración permitida
   → el sistema valida SoD/scope → persiste cambio y auditoría en una transacción.
4. **Auditor:** autentica → consulta audit trail filtrado → verifica actor, decisión
   y cadena → solicita exportación separada cuando tenga capability y propósito.

## Inventario de fuentes de verdad

| Fuente | Sección o versión | Autoridad | Uso en esta especificación |
| --- | --- | --- | --- |
| `docs/decisions/unresolved.md` | U-001…U-012, 2026-09-18 | DECISIÓN APROBADA o CONDICIONAL según entrada | Estado y gates |
| `docs/adr/015…024` | estados declarados | DECISIÓN APROBADA/CONDICIONAL | límites, identidad, datos, fuentes, continuidad, Teams, CI y vertical MVP |
| `docs/architecture/c4-model.md` | corte 2026-09-18 | ACUERDO INFORMADO | actores, contenedores y módulos; no implementación |
| `docs/project-management/*` | timebox 2026-09-19…2026-10-30 | BASELINE DE PLANIFICACIÓN | prioridad y forecast; no compromiso de capacidad |
| `docs/integrations/source-inventory.yaml` | schema 1.0 | INVENTARIO PENDIENTE | valores `TO_BE_PROVIDED` y estados de fuente |
| Árbol Git de `requirements` | commit base `2a5d2ca` | EVIDENCIA OBSERVADA | no existe código de aplicación ni tests funcionales |
| Issues GitHub | consulta 2026-09-19 | EVIDENCIA OBSERVADA | cero issues; el backlog documental no está materializado como issues |

Fuentes oficiales consultadas el 2026-09-19:

- [Wazuh Office 365](https://documentation.wazuh.com/current/cloud-security/office365/index.html), mecanismo disponible; versión/edición QAPAQ desconocida.
- [Wazuh Indexer API](https://documentation.wazuh.com/current/user-manual/indexer-api/index.html), interfaz posible; endpoint y permisos QAPAQ desconocidos.
- [Microsoft identity platform](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), comportamiento OIDC; configuración QAPAQ desconocida.
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use), controles de workflow; no prueba configuración organizacional.
- [Dependency Review Action](https://github.com/actions/dependency-review-action#overview),
  disponible en repositorios privados con GitHub Advanced Security; el run del PR
  #2 informó que esa capacidad no está habilitada para este repositorio.
- ECS 9.5.0 y OCSF 1.9.0 se mantienen como versiones de mapping aceptadas por
  ADR-011; no se declara conformidad hasta ejecutar sus perfiles y reporte.

## Supuestos y dependencias

- ASSUMPTION: el tenant, Wazuh y Teams de prueba podrán ser autorizados dentro del
  timebox; si no, los PBIs externos quedan `BLOCKED`.
- DEPENDENCY: Infraestructura entrega versiones, conectividad, `secretRef`, stores
  y contratos operativos.
- DEPENDENCY: dueños de fuente autorizan actividad sintética sin datos personales.
- DEPENDENCY: Legal/Compliance ratifica la matriz de retención antes de TTL.
- UNKNOWN: volumen, distribución de tamaños, cuotas, ventanas de replay, capacidad
  y cobertura humana.

[Registro de decisiones](07-open-decisions.md) · [Inventario](05-source-inventory.md)
