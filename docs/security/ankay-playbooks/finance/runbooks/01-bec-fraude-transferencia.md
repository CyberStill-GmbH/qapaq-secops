# RB-FIN-01 · BEC y fraude de transferencia o cambio de cuenta de proveedor

| Campo | Valor |
|---|---|
| Playbook | `finance.bec-payment-fraud` v1.0.0 (`design-only`) |
| Prioridad / SLA | P1 · reconocer 15 min · triage 1 h · decisión de contención 2 h · evaluación regulatoria 4 h |
| **Dueño** | Jefe del SOC QAPAQ |
| Última verificación | 2026-10-28 (revisión documental; sin ejercicio con datos reales) |
| Disparadores | 101400, 101401, 101403, 101404 · contexto 100510–100514, 101402, 100505 |
| Workflow | `infra/wazuh/launch-detections/ankay/finance/finance.bec-payment-fraud.json` |
| Normativa | `SBS-504-INC`, `SBS-504-REP`, `LPDP-SEG` ([matriz](../matriz-cumplimiento-sbs-anpd.md)) |

## Objetivo y alcance

Evitar que un pago salga hacia una cuenta controlada por un atacante que comprometió un
buzón interno o suplantó a un proveedor. Cubre: reglas de bandeja que ocultan o reenvían
correo, reenvío de buzón, cambio de cuenta bancaria de proveedor en el ERP y pagos a
beneficiarios nuevos o recién cambiados. No cubre el fraude a clientes por canales
digitales (ver RB-FIN-06).

## Detección

| Señal | Regla | Fuente |
|---|---|---|
| Regla de bandeja con palabras de pagos (factura, transferencia, banco…) | 101400 | M365 UAL |
| Regla o reenvío creado tras acceso por fuerza bruta | 101401 | M365 UAL |
| Cambio de cuenta de proveedor sin aprobación o con conflicto SoD | 101403 | ERP normalizado |
| Pago a beneficiario nuevo o con cuenta cambiada en 72 h | 101404 | Tesorería normalizada |

Reportes humanos que también abren este runbook: tesorería recibe una “actualización de
datos bancarios” por correo, o un proveedor reclama un pago que QAPAQ figura como pagado.
Registrarlos como caso QAPAQ manual y asociar la identidad y el proveedor.

## Triage

### Paso 1: Reconocer y fijar el alcance inicial (15 min)

- [ ] Reconocer la alerta en QAPAQ y asignar el caso (reloj P1).
- [ ] Confirmar identidad afectada, proveedor (referencia opaca) y ventana temporal.
- [ ] Revisar el resultado del workflow Ankay en el caso: `state` y `degradedSources`.

VERIFICAR: el caso tiene `incidentRef`, responsable y la evidencia `playbook-triage-summary`
adjunta. Si Ankay no corrió o quedó `UNKNOWN`, seguir con los pasos manuales.

### Paso 2: Revisar el buzón sin abrir contenido (20 min)

Consulta en Wazuh Dashboard (Discover, índice `wazuh-alerts-*`):

```text
rule.id:(100505 or 100510 or 100511 or 100512 or 100513 or 101400 or 101401) and data.office365.UserId:"usuario@dominio"
```

Lectura con Exchange Online PowerShell (rol de solo lectura, cuenta nominativa del SOC):

```powershell
$Upn = 'usuario@dominio'
Get-InboxRule -Mailbox $Upn | Select-Object Name, Enabled, From, SubjectOrBodyContainsWords, ForwardTo, RedirectTo, MoveToFolder, DeleteMessage
Get-Mailbox -Identity $Upn | Select-Object ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward
Get-RecipientPermission -Identity $Upn | Where-Object { $_.Trustee -ne 'NT AUTHORITY\SELF' }
```

VERIFICAR: quedó registrado si hay regla, reenvío o permiso SendAs, con fecha de creación,
IP de origen y destino (solo dominio). No se leyó ni exportó el contenido de mensajes.

### Paso 3: Confirmar acceso de la cuenta (15 min)

- [ ] Inicios de sesión 24 h antes de la regla: IP, país, agente, MFA.
- [ ] Cambios de método MFA (100526/101410) y consentimientos OAuth (100522).

VERIFICAR: la línea de tiempo UTC del caso muestra el primer acceso sospechoso o deja
constancia de que no se encontró.

### Paso 4: Verificar el lado del pago con tesorería (30 min)

- [ ] Pedir a tesorería el estado de pagos pendientes al proveedor afectado.
- [ ] Confirmar el cambio de cuenta **por teléfono al número registrado antes del cambio**,
  nunca al que figura en el correo.
- [ ] Registrar quién aprobó el cambio en el ERP y si el aprobador fue distinto del
  solicitante.

VERIFICAR: el caso indica una de tres situaciones: sin pago en riesgo, pago pendiente en
riesgo o pago ya ejecutado.

## Contención

Decisión humana: **¿hay pago en riesgo o cuenta comprometida que exija retener pagos y
revocar sesiones?** Decide el analista N2 o el jefe del SOC, consultando a tesorería y
cumplimiento. Las acciones se piden desde el caso QAPAQ y requieren un aprobador distinto
del solicitante.

| Acción | Aprobador | Ejecutor | Restricción |
|---|---|---|---|
| Retener pagos al proveedor | Jefe de tesorería | Tesorería (manual) | Solo la referencia afectada; expira en 72 h |
| Quitar regla o reenvío | Jefe del SOC | `containment.m365-remove-mail-forwarding` (propuesto) | Solo lo identificado; copia previa |
| Revocar sesiones | Jefe del SOC | `containment.m365-revoke-sessions` | Solo la identidad afectada |

### Paso 5: Ejecutar lo aprobado (20 min)

Mientras los ejecutores automáticos sigan deshabilitados, un administrador de M365
distinto del aprobador ejecuta, **solo con la aprobación registrada en QAPAQ**:

```powershell
$Upn = 'usuario@dominio'
Get-InboxRule -Mailbox $Upn | Export-Clixml -Path ".\inboxrules-before.xml"   # evidencia previa
Disable-InboxRule -Mailbox $Upn -Identity 'nombre-de-la-regla'
Set-Mailbox -Identity $Upn -ForwardingSmtpAddress $null -DeliverToMailboxAndForward $false
Revoke-MgUserSignInSession -UserId $Upn
```

VERIFICAR: `Get-InboxRule` y `Get-Mailbox` muestran la regla deshabilitada y sin reenvío;
tesorería confirma la retención por escrito en el caso.

### Reversión

- Regla deshabilitada por error: `Enable-InboxRule` con la copia `inboxrules-before.xml`.
- Pago retenido legítimo: tesorería lo libera tras la verificación telefónica.
- La revocación de sesiones no se revierte; el usuario vuelve a autenticarse.

## Erradicación

- [ ] Restablecer contraseña y volver a registrar MFA del usuario (con mesa de ayuda).
- [ ] Retirar consentimientos OAuth no autorizados y permisos SendAs/FullAccess.
- [ ] Buscar la misma regla o dominio de destino en otros buzones (consulta del paso 2 sin
  filtro de usuario).
- [ ] Bloquear el dominio del atacante en la protección de correo (cambio aprobado).

## Recuperación

- [ ] Rehabilitar el buzón y vigilar 101400/101401 sobre la identidad durante 30 días.
- [ ] Si el pago salió: tesorería solicita de inmediato al banco ordenante el retiro o
  bloqueo de fondos y legal evalúa denuncia. Abrir RB-FIN-08 si se cumple algún criterio
  de incidente significativo.
- [ ] Corregir los datos del proveedor en el ERP con doble aprobación.

## Lecciones aprendidas

Revisión posterior en 5 días hábiles con SOC, tesorería y TI. Revisar: ¿la verificación
telefónica es obligatoria para todo cambio de cuenta?, ¿el ERP impide que solicitante y
aprobador sean la misma persona?, ¿101400 necesita más palabras clave?, MTTD/MTTC frente al
SLA. Registrar acciones con dueño y fecha en el caso.

## RACI

| Actividad | Analista N1 | Analista N2 | Jefe SOC | Tesorería | TI M365 | Cumplimiento | Legal |
|---|---|---|---|---|---|---|---|
| Reconocer y triage inicial | R | A | I | – | – | – | – |
| Investigación de buzón y accesos | C | R | A | – | C | – | – |
| Verificación con proveedor | – | C | I | R/A | – | I | – |
| Decisión de contención | – | R | A | C | – | C | – |
| Ejecutar contención | – | – | I | R (pagos) | R (M365) | – | – |
| Evaluación regulatoria | – | C | R | C | – | A | C |
| Lecciones aprendidas | C | R | A | C | C | I | – |

## Comunicación

- **Interna:** aviso P1 automático por el outbox QAPAQ a Teams (canal SOC). El jefe del
  SOC informa a tesorería y al oficial de seguridad de la información al confirmar pago en
  riesgo.
- **Ejecutiva:** si hay pago ejecutado o más de un buzón comprometido, resumen a gerencia
  en 2 h: hechos, monto en rango (sin cifra exacta en Teams), acciones, siguiente
  actualización.
- **Proveedor:** solo tesorería y por el canal registrado previamente.
- **Regulador:** según RB-FIN-08 y la matriz; no se notifica desde Ankay.

## Escalamiento

| Nivel | Cuándo | Quién |
|---|---|---|
| L1 | Alerta reconocida, sin pago en riesgo | Analista N1 → N2 |
| L2 | Pago pendiente en riesgo o cuenta comprometida confirmada | Jefe del SOC + jefe de tesorería |
| L3 | Pago ejecutado, varios buzones o proveedor crítico | Oficial de seguridad de la información + gerencia + legal (RB-FIN-08) |

## Evidencias

Registro UAL de la regla o reenvío, resumen de accesos, copia previa de reglas, registro
del ERP con aprobador, estado del pago, constancia de la verificación telefónica y de la
retención. Todas se adjuntan al caso QAPAQ con hash SHA-256; nunca se guardan en Teams.

## Métricas

MTTD, MTTA, MTTT, MTTC, latencia de aprobación y tasa de falsos positivos de 101400 (ver
`metricDefinitions` del catálogo). Dashboard: FILL IN cuando QAPAQ publique el tablero de
playbooks.

## Ejercicio

Tabletop trimestral con tesorería: correo de “cambio de cuenta” de un proveedor ficticio
`proveedor-lab.example` y regla de bandeja sintética (casos 101400/101401 de
`infra/wazuh/finance/tests`).
