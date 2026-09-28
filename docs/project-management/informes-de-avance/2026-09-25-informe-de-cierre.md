# Informe de cierre del día — 2026-09-25

**Para:** Ing. Franco Clavo Santander — Product Owner y sponsor de Riesgos No Financieros

**De:** Cesar Adrian Guevara Salcedo — Developer y Scrum Master interino

**Fecha:** 25 de septiembre de 2026

**Asunto:** Cierre de Sprint 1 — C-04, C-06, C-08 y C-09 materializados en `main`

Este informe cierra la jornada del 2026-09-25 sobre `main` en el commit
**`6c78e27`** (merge de PR #17, C-09). Con este merge quedan materializados en
`main` los últimos componentes pendientes de Sprint 1: **C-08** (contrato
operativo Wazuh) y **C-09** (CI seguro y evidencia), sumados a C-04 y C-06 ya
cerrados. Complementa el [Daily Scrum](../daily-scrum.md) y el
[informe de cierre de 2026-09-24](2026-09-24-informe-de-cierre.md); no los
reemplaza.

## Resumen ejecutivo

Sprint 1 — Base ejecutable y contratos llega a su recta final con los nueve
componentes (`C-01`…`C-09`) presentes en `main`, aunque **no todos con
aceptación técnica completa**: dos de ellos avanzan por excepción explícita del
Product Owner, no por evidencia end-to-end real. Este informe es deliberadamente
preciso sobre esa diferencia — el propio repositorio lo es:

| ID | Estado real en `main` | Matiz obligatorio |
| --- | --- | --- |
| C-01, C-02, C-03, C-05, C-07 | `DONE` | Sin cambio, evidencia previa |
| C-04 — persistencia de admisión | `DONE` | Confirmado en CI (run `36154234794`) |
| C-06 — entorno de integración | `DONE` | E2E real Wazuh/OpenSearch en Railway, excepción de capacidad de pruebas aceptada |
| C-08 — contrato operativo Wazuh | **`DONE` solo para habilitar Sprint 2, por excepción del PO** | La integración real contra Manager/Indexer autorizados **no se ejecutó**; queda como gate obligatorio del E2E final del MVP |
| C-09 — CI seguro y ownership | **`IMPLEMENTED / BLOCKED_BY_REPOSITORY_ADMINISTRATION`**, no `DONE` | CI y evidencia pasan, pero el repo no tiene protección de rama ni CODEOWNERS activos; el propio documento se niega a declararlo `DONE` |

## C-08 — contrato `SecurityEventProvider` para Wazuh

Implementado en `modules/connectors`: puerto neutral de capabilities/health/
query/paginación, provider Wazuh de solo lectura con allowlist de índice,
orden `timestamp`+`id`, cursor firmado con HMAC/TTL, y un cliente Manager que
obtiene JWT con single-flight para evitar renovaciones concurrentes. Configuración
C-03 añadida para índice, dataset, secreto de firma de cursor y credenciales
separadas de Manager/Indexer, todas resueltas vía `SecretProvider` — nada de
secretos reales en el repo.

**Resultado real de la contract suite (26 pruebas, entorno simulado):**

| Métrica | Valor |
| --- | --- |
| Test suites | 4/4 PASS |
| Pruebas totales | 26/26 PASS |
| Verificaciones contractuales cubiertas | 18 (capabilities, health, orden, determinismo, paginación, cursores, límites, cancelación, errores, neutralidad, escrituras) |
| Unit suite del workspace | 237/237 PASS |
| Typecheck / lint / boundaries | PASS (123 módulos, 168 dependencias) |

![Suite de contrato C-08 — resultado real de Vitest](../c-08/assets/2026-09-25-c08-contract-suite.png)

**Lo que esta evidencia NO cubre**, tal como lo deja escrito el propio
[`c-08/README.md`](../c-08/README.md): la contract suite corrió contra un
cliente simulado, no contra un Manager o Indexer Wazuh real. La sesión no tenía
`QAPAQ_WAZUH_*` configuradas, Docker Desktop falló al abrir `dockerInference`, y
el proyecto Railway aislado creado para C-08
(`qapaq-c08-wazuh-e2e-20260925`) quedó **vacío**, sin máquinas desplegadas. TLS/
autenticación real, el mapping estable del índice, el evento sintético
Manager → Indexer → provider, y la denegación real de escritura siguen
`BLOQUEADO`. Por eso el estado se registra explícitamente como *"DONE para
Sprint 2 por excepción del Product Owner"* y no como aceptación técnica: la
excepción habilita empezar a construir sobre el contrato en Sprint 2, no
certifica que Wazuh real ya fue consultado.

## C-09 — CI seguro y evidencia: implementado, no `DONE`

PR #16 (`ci: add C-09 security evidence`) se fusionó como `c6d235b`; el propio
workflow de evidencia ([run 36179387219](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/36179387219))
confirmó que el artifact `c09-ci-evidence-c6d235b82a88904b3e129103e861f17bd1534f40`
no tiene fugas (Gitleaks limpio), sus seis archivos allowlisted verifican por
`sha256sum` y el ZIP descargado coincide con el digest publicado por GitHub. La
auditoría del histórico PR #2 (fusionado 2026-09-21) no encontró secretos,
acciones sin fijar ni `pull_request_target`.

A pesar de ese resultado limpio, el estado se registra como
**`IMPLEMENTED / BLOCKED_BY_REPOSITORY_ADMINISTRATION`**, no `DONE`: el plan de
GitHub del repositorio privado no aplica reglas de protección de rama ni
`required checks`, no hay CODEOWNERS ni revisión independiente activa, y no se
probó un canario sintético vía fork controlado. Franco confirmó que Cesar es el
único mantenedor humano y eximió la revisión independiente mientras eso se
mantenga — la misma decisión ya registrada el
[2026-09-24](../../decisions/unresolved.md#decisión-protección-de-rama-en-main-no-es-requisito-de-este-timebox)
— pero esa excepción **no sustituye** el criterio de aceptación documentado
originalmente para C-09, y el propio componente lo deja escrito así en vez de
maquillarlo como cierre completo.

## Backlog y decisiones vigentes

- **Sprint 2** puede avanzar con los contratos locales de C-08 aunque Wazuh
  real siga sin conectarse; PBI-007 y cualquier provider spec que dependa de
  Wazuh autorizado permanecen `BLOCKED` hasta tener acceso real — el timebox
  2026-10-05/06 ya no presupone que **todos** los accesos estén listos, por
  decisión explícita del Product Owner del 2026-09-25.
- **PBI-006** (Microsoft 365) y la excepción de protección de rama siguen
  vigentes sin cambios hoy (ver informes anteriores).
- Ningún PBI se declara `DONE` en este informe; los cambios de hoy son de
  estado de componente (`C-xx`), no de aceptación de PBI.

## Riesgos y bloqueos vigentes

| Elemento | Estado | Dueño | Siguiente acción |
| --- | --- | --- | --- |
| C-08: integración real contra Wazuh Manager/Indexer autorizado | `BLOQUEADO`, gate obligatorio del E2E final del MVP | Cesar / Franco | Provisionar acceso real (tenant, credenciales, Docker o Railway funcional) antes de declarar aceptación técnica |
| C-09: sin protección de rama ni CODEOWNERS activos en GitHub | Riesgo de proceso aceptado explícitamente, no resuelto técnicamente | Cesar / Franco | Reevaluar si se incorpora un colaborador externo real |
| C-09: sin prueba controlada de fork con canario sintético | Riesgo activo | Cesar | Diseñar y ejecutar el canario antes de certificar el gate de PR no confiable |
| Microsoft 365 (`PBI-006`): gate técnico incompleto | Riesgo activo | Franco / Cesar | Completar scopes, ticket, dataset y conexión real de lectura |

## Confianza en el Sprint Goal

VERDE-ÁMBAR: los nueve componentes de Sprint 1 tienen presencia real en `main`,
con evidencia técnica completa en C-01 a C-07, evidencia E2E real para C-06, y
dos excepciones documentadas por el Product Owner (C-08, C-09) que permiten
avanzar a Sprint 2 sin fingir una aceptación que todavía no ocurrió. El cierre
completo del MVP sigue condicionado a la integración real de Wazuh (C-08) y al
gobierno de rama (C-09), ninguno de los cuales se resuelve con más código local.

---

**Sprint 1 llega a su tramo final.** 🎉

![Celebración — cierre de los últimos componentes de Sprint 1](assets/2026-09-25-celebracion-sprint1.png)

[Daily Scrum](../daily-scrum.md) · [Plan de componentes](../component-delivery-plan.md) ·
[C-08 — contrato operativo Wazuh](../c-08/README.md) ·
[C-09 — CI seguro y evidencia](../c-09/README.md) ·
[Decisiones sin resolver](../../decisions/unresolved.md) ·
[Informe de cierre de 2026-09-24](2026-09-24-informe-de-cierre.md)
