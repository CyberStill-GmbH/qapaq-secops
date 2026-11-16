# Runbook · Manipulación de CloudTrail y de la auditoría

Alcance: `aws/cloudtrail-tampering` (101710–101712, base 101620/101621 del paquete AWS), servicios de detección
AWS (101622–101625, 101644), pipeline de monitoreo QAPAQ (101615) y `m365/audit-tampering` (100527, 100528).
**Siempre P1**: borrar el rastro es la acción de un intruso o rompe la evidencia regulatoria (SBS 504-2021, N11).

## Triage en 10 minutos

1. **¿Quién?** `data.aws.principal` / `data.aws.principal_arn`, tipo (`Root`, `IAMUser`, `AssumedRole`) e IP.
   Principal de CI/Terraform con cambio aprobado → documentar y cerrar como benigno.
2. **¿Qué más hizo en la última hora?** 101710 (IAM antes), 101711 (root), 101712 (varios servicios) ya lo dicen;
   ampliar a 24 h con `data.aws.principal:"<p>"`.
3. **¿Sigue apagado?** Verificar en la consola: `GetTrailStatus` (IsLogging), GuardDuty, Config, Security Hub.

## Contención

1. **Restaurar el registro primero** (`StartLogging`, recrear el detector/recorder) — por un administrador con el ticket.
2. Inhabilitar el principal: quitar sesiones/permisos del rol, desactivar access keys, y para root: cambiar
   contraseña y revisar MFA.
3. Si es la organización: SCP que impida `cloudtrail:StopLogging`/`DeleteTrail` salvo al rol de plataforma (BL-A).

## Investigación

- Hueco de evidencia: desde `StopLogging` hasta `StartLogging` no hay CloudTrail de ese trail; usar los eventos de
  EventBridge ya entregados a QAPAQ, VPC Flow Logs y logs de servicios.
- Revisar creaciones de usuarios/llaves/roles y snapshots compartidos (101645) en la ventana.

## M365: auditoría desactivada (100527, 100528)

Reactivar `UnifiedAuditLogIngestionEnabled` / auditoría del buzón, identificar al administrador, revisar sus
inicios de sesión y roles (runbook de [credenciales](credenciales.md)).

## Consultas

```text
rule.id:(101620 or 101621 or 101710 or 101711 or 101712)
rule.groups:qapaq_aws_defense_disabled
rule.id:(100527 or 100528)
```

**Cierre:** registro restaurado y verificado, principal contenido, ventana sin evidencia documentada en el
incidente (auditoría QAPAQ), y lección (SCP, alerta de salud del pipeline 101615).
