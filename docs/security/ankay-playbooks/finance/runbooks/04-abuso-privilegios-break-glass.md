# RB-FIN-04 · Abuso de cuentas privilegiadas y break-glass

| Campo | Valor |
|---|---|
| Playbook | `finance.privileged-breakglass-abuse` v1.0.0 (`design-only`) |
| Prioridad / SLA | P1 · reconocer 15 min · triage 1 h · decisión de contención 2 h · evaluación regulatoria 4 h |
| **Dueño** | Oficial de seguridad de la información |
| Última verificación | 2026-10-28 (revisión documental; sin ejercicio con datos reales) |
| Disparadores | 101425, 101426, 101427, 101428 · contexto 100530, 100520, 100521, 100524, 100525, 101300, 101303, 101206, 101207 |
| Workflow | `infra/wazuh/launch-detections/ankay/finance/finance.privileged-breakglass-abuse.json` |
| Normativa | `SBS-504-INC`, `SBS-504-ACC`, `SBS-504-LOG` ([matriz](../matriz-cumplimiento-sbs-anpd.md)) |

## Objetivo y alcance

Confirmar en minutos si un uso privilegiado (rol de Entra, grupo de AD, cuenta break-glass
de M365 o de AD) está respaldado por una emergencia o un cambio aprobado. Si no lo está,
tratarlo como compromiso de máximo impacto. Regla de oro: **nunca dejar a QAPAQ sin una
cuenta de emergencia operativa**; la contención se hace sobre la cuenta usada, con la otra
custodiada y verificada.

## Detección

| Señal | Regla | Fuente |
|---|---|---|
| Cuenta break-glass M365 haciendo cambios privilegiados | 101425 | M365 UAL + lista |
| Rol privilegiado de Entra asignado de noche | 101426 | M365 UAL |
| Alta en grupo privilegiado de AD de noche | 101427 | DC (4728/4732/4756) |
| Inicio de sesión de break-glass de AD | 101428 | DC (4624) + lista |

## Triage

### Paso 1: Contrastar con custodia y cambios aprobados (15 min)

- [ ] Buscar en QAPAQ el cambio aprobado y el registro de custodia (apertura de sobre o
  bóveda) para la cuenta y la hora (`qapaq.approved_changes`, `qapaq.breakglass_custody`).
- [ ] Llamar al custodio registrado y al dueño del cambio.

VERIFICAR: el caso indica “autorizado” con número de cambio o acta de emergencia, o “sin
autorización encontrada” con hora de la consulta.

### Paso 2: Reconstruir lo que hizo la cuenta (25 min)

```text
rule.id:(100520 or 100521 or 100524 or 100525 or 100527 or 100528 or 100530 or 101300 or 101303 or 101425 or 101426 or 101427 or 101428) and (data.office365.UserId:"cuenta@dominio" or data.win.eventdata.subjectUserName:"cuenta" or data.win.eventdata.targetUserName:"cuenta")
```

Lectura en AD (cuenta nominativa con permisos de lectura):

```powershell
$Sam = 'cuenta'
Get-ADUser -Identity $Sam -Properties LastLogonDate, PasswordLastSet, MemberOf | Select-Object SamAccountName, Enabled, LastLogonDate, PasswordLastSet
Get-ADGroupMember -Identity 'Domain Admins' | Select-Object SamAccountName, objectClass
```

VERIFICAR: la línea de tiempo UTC lista cada cambio privilegiado con actor, destino y si
se desactivó auditoría o se tocó federación (100524, 100527, 100528).

### Paso 3: Detectar autoaprobación y persistencia (15 min)

- [ ] ¿El actor aprobó su propio cambio o se agregó a sí mismo?
- [ ] ¿Se crearon cuentas, credenciales de aplicación (100523) o GPO nuevas (101303)?

VERIFICAR: el caso lista los objetos creados o modificados para revertir.

## Contención

Decisión humana: **¿el uso privilegiado está autorizado por una emergencia o un cambio
aprobado?** Deciden el jefe del SOC y el gerente de TI, consultando al oficial de
seguridad de la información.

| Acción | Aprobador | Ejecutor | Restricción |
|---|---|---|---|
| Revocar sesiones de la cuenta | Oficial de seguridad de la información | `containment.m365-revoke-sessions` | Nunca la última break-glass operativa |
| Deshabilitar la cuenta | Oficial de seguridad + gerente de TI | `containment.entra-disable-user` (propuesto) / AD manual | Rotación y nueva custodia antes de rehabilitar |

### Paso 4: Ejecutar lo aprobado (20 min)

Con aprobación registrada y verificando primero que la otra cuenta break-glass funciona:

```powershell
Disable-ADAccount -Identity 'cuenta'
Remove-ADGroupMember -Identity 'Domain Admins' -Members 'miembro-agregado' -Confirm:$false
Revoke-MgUserSignInSession -UserId 'cuenta@dominio'
```

VERIFICAR: `Get-ADUser cuenta` muestra `Enabled False`; el miembro ya no figura en el
grupo; no hay nuevos 4624 de la cuenta en 15 minutos.

### Reversión

`Enable-ADAccount` y nueva custodia de credencial solo tras rotarla dos veces (krbtgt si
hubo indicios de compromiso del dominio, con el procedimiento de TI). Los miembros
removidos por error se reincorporan con un cambio aprobado.

## Erradicación

- [ ] Revertir cambios no autorizados (roles, grupos, políticas, federación, auditoría).
- [ ] Rotar credenciales de la cuenta y de cuentas de servicio tocadas.
- [ ] Si hubo DCSync o cambios en AdminSDHolder, escalar a respuesta de compromiso de
  dominio con apoyo externo.

## Recuperación

- [ ] Rehabilitar la auditoría unificada y de buzones si se desactivó.
- [ ] Nueva custodia de break-glass con acta y prueba de acceso controlada.
- [ ] Vigilar 30 días 101425–101428.

## Lecciones aprendidas

En 5 días hábiles: ¿el uso de break-glass siempre genera evento de custodia?, ¿PIM exige
aprobación para roles críticos?, ¿hay alertas para el uso legítimo que se puedan anticipar
con ventanas de cambio?

## RACI

| Actividad | Analista N2 | Jefe SOC | Oficial de seguridad | Gerente de TI | Custodio | Auditoría interna |
|---|---|---|---|---|---|---|
| Contraste con custodia y cambios | R | A | I | C | C | – |
| Reconstrucción | R | A | I | C | – | – |
| Decisión de contención | C | R | A | C | – | I |
| Ejecución | – | I | A | R | – | – |
| Nueva custodia | – | I | A | R | R | I |

## Comunicación

- **Interna:** aviso P1 por outbox; el jefe del SOC llama al oficial de seguridad.
- **Ejecutiva:** si no hay autorización, informar a gerencia en 1 h.
- **Regulador:** según RB-FIN-08 si hay impacto significativo.

## Escalamiento

| Nivel | Cuándo | Quién |
|---|---|---|
| L1 | Uso con autorización encontrada | Analista N2 documenta y cierra |
| L2 | Sin autorización, sin cambios dañinos | Jefe del SOC + gerente de TI |
| L3 | Cambios dañinos, auditoría desactivada o compromiso de dominio | Oficial de seguridad + gerencia + apoyo externo (RB-FIN-08) |

## Evidencias

Cambios de rol o grupo con actor y destino, ticket o su ausencia, registro de custodia,
línea de tiempo UTC y estado previo de objetos revertidos.

## Métricas

MTTD, MTTA, MTTT, MTTC, latencia de aprobación. Dashboard: FILL IN.

## Ejercicio

Prueba semestral controlada de break-glass con acta, que debe disparar 101428 o 100530 y
cerrarse como “autorizado” en menos de 15 minutos.
