# Playbooks financieros QAPAQ · índice

**Estado:** diseño versionado (`design-only`). Las reglas Wazuh pasan `wazuh-logtest`
4.14.8 con eventos sintéticos en CI; los workflows Ankay no se importaron ni probaron en
una instancia, y el puente QAPAQ que consumen está propuesto, no implementado. Nada de esto
está desplegado.

QAPAQ es una financiera peruana regulada por la SBS. Este conjunto agrega a la operación
del SOC los riesgos propios del negocio financiero: fraude de pagos, toma de cuentas con
acceso al core de créditos, exfiltración de datos de clientes, abuso de privilegios,
ransomware en agencias, suplantación de marca, fraude interno y gestión regulatoria de
incidentes significativos.

## Piezas y cómo encajan

```text
Fuentes (M365/Entra, AD, Sysmon, Sophos, Cato, ERP, core, monitoreo de marca)
   │
   ▼
Wazuh 4.14.8 ── reglas 101400-101449 (infra/wazuh/finance) ── nivel 12+ ──► QAPAQ (caso, prioridad P1-P4)
                                                                               │ outbox firmado
                                                                               ▼
                                         Ankay (Shuffle 2.3.0): triage de solo lectura vía puente QAPAQ
                                                                               │ evidencia, solicitud de acción, aviso
                                                                               ▼
                         QAPAQ: decisión humana, control dual y SoD ──► outbox ──► containment.* / áreas de negocio
```

| Pieza | Ubicación |
|---|---|
| Catálogo (fuente única) | [`../finance-catalog.yaml`](../finance-catalog.yaml) (`catalogId: qapaq-ankay-finance`) |
| Reglas Wazuh, listas y pruebas | [`infra/wazuh/finance/`](../../../../infra/wazuh/finance/README.md) |
| Workflows Shuffle (generados) | [`infra/wazuh/launch-detections/ankay/finance/`](../../../../infra/wazuh/launch-detections/ankay/finance/README.md) |
| Contrato del puente QAPAQ ↔ Ankay | [`bridge-contract.md`](bridge-contract.md) |
| Matriz SBS 504-2021 / Ley 29733 / CNSD | [`matriz-cumplimiento-sbs-anpd.md`](matriz-cumplimiento-sbs-anpd.md) |
| CI | `.github/workflows/wazuh-finance-detections.yml` |

## Runbooks

| ID | Runbook | Playbook | Prioridad | Reglas primarias |
|---|---|---|---|---|
| RB-FIN-01 | [BEC y fraude de transferencia o cambio de cuenta de proveedor](runbooks/01-bec-fraude-transferencia.md) | `finance.bec-payment-fraud` | P1 | 101400, 101401, 101403, 101404 |
| RB-FIN-02 | [Toma de cuenta con acceso al core de créditos](runbooks/02-toma-cuenta-core-creditos.md) | `finance.credit-core-account-takeover` | P1 | 101410, 101411, 101412 |
| RB-FIN-03 | [Exfiltración masiva de datos de clientes](runbooks/03-exfiltracion-datos-clientes.md) | `finance.customer-data-exfiltration` | P1 | 101416–101419, 101421, 101422 |
| RB-FIN-04 | [Abuso de privilegios y break-glass](runbooks/04-abuso-privilegios-break-glass.md) | `finance.privileged-breakglass-abuse` | P1 | 101425–101428 |
| RB-FIN-05 | [Ransomware en agencia o sucursal](runbooks/05-ransomware-agencia.md) | `finance.branch-ransomware` | P1 | 101430–101433 |
| RB-FIN-06 | [Suplantación de marca y phishing a clientes](runbooks/06-suplantacion-marca-phishing.md) | `finance.brand-impersonation-phishing` | P2 | 101436, 101437 + reporte de cliente |
| RB-FIN-07 | [Fraude interno](runbooks/07-fraude-interno.md) | `finance.insider-fraud` | P2 | 101441, 101443–101445 |
| RB-FIN-08 | [Incidente significativo y notificación regulatoria](runbooks/08-incidente-significativo-regulatorio.md) | `finance.significant-incident-regulatory` | P1 | Ingreso desde RB-FIN-01 a 07 |

Todos siguen la misma estructura: detección, triage, contención (con decisión humana y
reversión), erradicación, recuperación, lecciones aprendidas, RACI, comunicación,
escalamiento L1–L3, evidencias, métricas y ejercicio. Cada paso tiene tiempo estimado y
una línea `VERIFICAR:`.

## SLA y métricas

| Prioridad | Reconocer | Triage completo | Decisión de contención | Evaluación regulatoria |
|---|---|---|---|---|
| P1 | 15 min | 1 h | 2 h | 4 h |
| P2 | 30 min | 4 h | 8 h | 24 h |
| P3 | 4 h | 24 h | 2 días | 3 días |

Las métricas (MTTD, MTTA, MTTT, MTTC, MTTR, FPR, tasa de incumplimiento de SLA y latencia
de aprobación) se definen en `metricDefinitions` del catálogo. La evaluación regulatoria es
una meta interna para llegar a tiempo a los plazos legales de RB-FIN-08, no un plazo legal.

## Roles

| Rol | Responsabilidad en estos playbooks |
|---|---|
| Analista SOC N1 | Reconoce, hace el triage inicial y escala. |
| Analista SOC N2 | Investiga, propone la decisión y solicita acciones en QAPAQ. |
| Jefe del SOC | Decide contención técnica y aprueba acciones de su ámbito. |
| Oficial de seguridad de la información | Dueño de RB-FIN-04, 07 y 08; aprueba acciones sobre cuentas privilegiadas. |
| Oficial de datos personales | Decide si hay incidente de datos personales y prepara la notificación a la ANPD. |
| Gerente de TI, jefe de redes, IAM | Ejecutan o aprueban cambios en su plataforma. |
| Tesorería, créditos, agencias, atención al cliente | Verifican y ejecutan medidas de negocio (retener pagos, revisar operaciones, continuidad). |
| Legal, cumplimiento, comunicaciones, auditoría interna, RR. HH. | Evaluación regulatoria, mensajes externos, investigación de personas. |
| Comité de crisis | Decide reportabilidad y firmantes en RB-FIN-08. |

## Reglas de gobierno comunes

1. **Separación de funciones:** quien solicita una acción no la aprueba; quien la aprueba
   no la ejecuta cuando la ejecución es manual. QAPAQ impide la autoaprobación.
2. **Sin efectos desde Ankay:** los workflows solo leen, adjuntan evidencia, solicitan
   acciones y emiten intenciones de aviso. Los efectos los despacha QAPAQ por el outbox
   hacia playbooks `containment.*` deshabilitados hasta su habilitación formal.
3. **Datos mínimos:** referencias opacas; nunca cuerpos de correo, archivos, números de
   cuenta, montos, documentos de identidad ni datos de clientes en Ankay o Teams.
4. **Fuente ausente = degradado:** la falta de datos nunca cierra un caso como limpio.
5. **Notificación regulatoria humana:** Ankay no notifica a la SBS, la ANPD ni el CNSD.

## Datos de QAPAQ por completar

| Dato | Uso | Responsable |
|---|---|---|
| Adaptadores ERP/tesorería y core de créditos (`TO_BE_PROVIDED`) | Reglas 101402–101404, 101442–101445 y consultas del puente | TI + dueños de sistema |
| Monitoreo de marca (`TO_BE_PROVIDED`) | Reglas 101435–101436 | SOC + marketing |
| Listas CDB reales (usuarios del core, break-glass AD, sitios sensibles, dominios parecidos) | Reglas con `<list>` | IAM, seguridad, dueños de datos |
| Criterio interno de “impacto adverso significativo” | RB-FIN-08 | Cumplimiento + legal |
| Matriz de aprobadores con nombres y suplentes de guardia | Contención de todos los runbooks | Jefe del SOC |
| Tablero de playbooks (`Dashboard: FILL IN`) | Métricas | QAPAQ Core |

## Habilitación por etapas

1. Desplegar las reglas en observación (sin despacho a Ankay) y ajustar umbrales con dos
   semanas de datos del tenant.
2. Implementar el puente QAPAQ y sus pruebas de contrato.
3. Importar los workflows en Ankay, volver a exportarlos desde Shuffle y versionar el
   diff; probar con eventos sintéticos.
4. Ejercicio de mesa por runbook con las áreas de negocio.
5. Habilitar los ejecutores `containment.*` uno a uno, con dry-run y aprobación SoD.
