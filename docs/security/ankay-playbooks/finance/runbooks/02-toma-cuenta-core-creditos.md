# RB-FIN-02 · Toma de cuenta de colaborador con acceso al core de créditos

| Campo | Valor |
|---|---|
| Playbook | `finance.credit-core-account-takeover` v1.0.0 (`design-only`) |
| Prioridad / SLA | P1 · reconocer 15 min · triage 1 h · decisión de contención 2 h · evaluación regulatoria 4 h |
| **Dueño** | Jefe del SOC QAPAQ |
| Última verificación | 2026-10-28 (revisión documental; sin ejercicio con datos reales) |
| Disparadores | 101410, 101411, 101412 · contexto 100505, 100526, 101205, 100522, 100506 |
| Workflow | `infra/wazuh/launch-detections/ankay/finance/finance.credit-core-account-takeover.json` |
| Normativa | `SBS-504-INC`, `SBS-504-ACC`, `LPDP-SEG` ([matriz](../matriz-cumplimiento-sbs-anpd.md)) |

## Objetivo y alcance

Contener la toma de una identidad que puede aprobar, desembolsar o modificar créditos, o
consultar datos de clientes en el core, antes de que el atacante opere. La lista
`qapaq-finance-core-users` (mantenida por IAM) define qué identidades están en alcance.
El core de créditos y su consola de auditoría quedan como `TO_BE_PROVIDED`: el runbook
indica qué pedir al dueño del sistema, no cómo operarlo.

## Detección

| Señal | Regla | Fuente |
|---|---|---|
| Acceso tras fuerza bruta de usuario del core | 101412 | M365 UAL + lista |
| Inicio de sesión de riesgo alto de usuario del core | 101411 | Entra normalizado + lista |
| Cambio de MFA en la hora siguiente a un acceso por fuerza bruta | 101410 | M365 UAL |

## Triage

### Paso 1: Reconocer y confirmar que la identidad es del core (10 min)

- [ ] Reconocer en QAPAQ, asignar y revisar el resumen del workflow Ankay.
- [ ] Confirmar con IAM que la identidad tiene hoy un rol activo en el core.

VERIFICAR: el caso indica rol, agencia y si el usuario está de vacaciones o con licencia
(dato aportado por RR. HH. por el canal aprobado).

### Paso 2: Reconstruir accesos e identidad (20 min)

```text
rule.id:(100502 or 100503 or 100505 or 100506 or 100526 or 101205 or 101410 or 101411 or 101412) and (data.office365.UserId:"usuario@dominio" or data.qapaq_user_id:"usuario@dominio")
```

Lectura con Microsoft Graph PowerShell (permisos `AuditLog.Read.All`,
`UserAuthenticationMethod.Read.All`, cuenta nominativa del SOC):

```powershell
$Upn = 'usuario@dominio'
Get-MgAuditLogSignIn -Filter "userPrincipalName eq '$Upn'" -Top 50 |
  Select-Object CreatedDateTime, IPAddress, @{n='Pais';e={$_.Location.CountryOrRegion}}, AppDisplayName, ConditionalAccessStatus, RiskLevelDuringSignIn
Get-MgUserAuthenticationMethod -UserId $Upn | Select-Object Id, @{n='Tipo';e={$_.AdditionalProperties['@odata.type']}}
```

VERIFICAR: la línea de tiempo UTC muestra fallos, primer éxito sospechoso, cambio de MFA
y la ubicación habitual del usuario.

### Paso 3: Revisar operaciones en el core (30 min)

- [ ] Pedir al dueño del core las sesiones y operaciones de la identidad en la ventana
  (aprobaciones, desembolsos, cambios de condiciones, consultas masivas). Adaptador
  `core_banking.session_summary`: `TO_BE_PROVIDED`.
- [ ] Marcar operaciones hechas desde IP o equipo no habitual.

VERIFICAR: el caso deja una de dos conclusiones: sin operaciones en el core tras el acceso,
u operaciones a revisar listadas por referencia opaca.

## Contención

Decisión humana: **¿la identidad está comprometida y hubo operaciones en el core que
revertir o revisar?** Decide el analista N2 o el jefe del SOC, consultando al jefe de
créditos y a riesgos operacionales.

| Acción | Aprobador | Ejecutor | Restricción |
|---|---|---|---|
| Revocar sesiones | Jefe del SOC | `containment.m365-revoke-sessions` | Solo la identidad |
| Deshabilitar la cuenta | Jefe del SOC + gerente de TI | `containment.entra-disable-user` (propuesto) | Dos aprobadores distintos del solicitante |
| Suspender el rol en el core | Jefe de créditos | IAM (manual) | Temporal, hasta cerrar el caso |

### Paso 4: Ejecutar lo aprobado (15 min)

Con la aprobación registrada en QAPAQ, un administrador distinto del aprobador:

```powershell
$Upn = 'usuario@dominio'
Revoke-MgUserSignInSession -UserId $Upn
Update-MgUser -UserId $Upn -AccountEnabled:$false   # solo si se aprobó deshabilitar
```

VERIFICAR: `Get-MgUser -UserId $Upn -Property AccountEnabled` devuelve `False` (si se
aprobó) y no hay nuevos inicios de sesión exitosos en 15 minutos. IAM confirma por escrito
la suspensión del rol en el core.

### Reversión

`Update-MgUser -UserId $Upn -AccountEnabled:$true` solo después de restablecer contraseña,
volver a registrar MFA con verificación presencial o por video y cerrar la revisión de
operaciones. IAM rehabilita el rol del core con la misma aprobación.

## Erradicación

- [ ] Restablecer contraseña y métodos MFA; eliminar métodos agregados por el atacante.
- [ ] Revisar reglas de bandeja y consentimientos OAuth (RB-FIN-01, paso 2).
- [ ] Si el origen fue fuerza bruta o spray, revisar bloqueo por IP en acceso condicional
  (cambio aprobado).

## Recuperación

- [ ] Riesgos y créditos revisan y, si corresponde, revierten operaciones del core con
  doble aprobación propia del negocio.
- [ ] Vigilar la identidad 30 días (101410–101412 y 100505).
- [ ] Abrir RB-FIN-08 si hubo operaciones fraudulentas o acceso a datos de clientes.

## Lecciones aprendidas

En 5 días hábiles: ¿la identidad tenía MFA resistente a phishing?, ¿acceso condicional
exigía dispositivo administrado para el core?, ¿la lista `qapaq-finance-core-users` estaba
al día?, MTTC frente al SLA.

## RACI

| Actividad | Analista N1 | Analista N2 | Jefe SOC | IAM | Jefe de créditos | Riesgos operacionales | TI |
|---|---|---|---|---|---|---|---|
| Triage inicial | R | A | I | C | – | – | – |
| Reconstrucción de accesos | C | R | A | C | – | – | C |
| Revisión de operaciones del core | – | C | A | – | R | C | – |
| Decisión de contención | – | R | A | C | C | C | – |
| Ejecutar contención | – | – | I | R (core) | A (core) | – | R (Entra) |
| Reversión de operaciones | – | I | I | – | R | A | – |

## Comunicación

- **Interna:** aviso P1 por outbox; el jefe del SOC informa al jefe de créditos.
- **Usuario afectado:** lo contacta su jefe directo o la mesa de ayuda por teléfono, nunca
  por el correo comprometido.
- **Ejecutiva y regulador:** si hubo operaciones fraudulentas o acceso a datos, según
  RB-FIN-08.

## Escalamiento

| Nivel | Cuándo | Quién |
|---|---|---|
| L1 | Señal sin confirmación de compromiso | Analista N1 → N2 |
| L2 | Compromiso confirmado, sin operaciones en el core | Jefe del SOC + IAM |
| L3 | Operaciones en el core o varias identidades | Oficial de seguridad de la información + jefe de créditos + riesgos (RB-FIN-08) |

## Evidencias

Inicios de sesión, cambios de MFA, sesiones y operaciones del core (por referencia),
contexto de red Cato, aprobaciones y confirmaciones de IAM, con hash en el caso QAPAQ.

## Métricas

MTTD, MTTA, MTTT, MTTC, MTTR y latencia de aprobación. Dashboard: FILL IN.

## Ejercicio

Simulación semestral con una cuenta de laboratorio incluida en
`qapaq-finance-core-users.example` (casos 101410–101412).
