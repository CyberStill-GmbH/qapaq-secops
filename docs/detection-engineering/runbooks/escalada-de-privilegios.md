# Runbook · Escalada de privilegios (Entra, AWS, AD y Linux)

Alcance: `entra/privileged-role-assignment` (100520, 100521, 101704), `entra/app-consent-and-credentials`
(100522, 100523), `entra/auth-methods-and-federation` (100524–100526), reglas IAM/Identity Center/Organizations
del paquete AWS (101630–101636), `aws/cloudtrail-tampering` (101710), `ad/privileged-groups-and-policy`
(101300–101303), `linux/privileged-group-membership` (101752) y `linux/persistence-fim` (101755–101760).

## Triage en 10 minutos

1. **¿Hay un cambio aprobado?** Buscar el ticket de cambio o la ventana de mantenimiento cargada en QAPAQ. Sin
   cambio aprobado → mínimo P2; tier 0 (Global/Privileged Role Admin, `AdministratorAccess`, Domain Admins, root) → P1.
2. **¿Quién lo hizo y quién lo recibió?** Actor (`UserId`, `aws.principal`, `srcuser`) y objetivo (`ObjectId`,
   rol, `dstuser`). Un actor que se otorga a sí mismo = P1.
3. **¿Vino después de un acceso anómalo?** Si hay 101700/101710 ya es cadena (P1).

<a id="entra"></a>
## Entra

- Ver la asignación en Entra (Roles y administradores → auditoría) y en PIM si es elegible o activa.
- Consentimientos y credenciales de apps (100522/100523): ¿la app es interna? ¿quién la publicó? Revisar
  permisos `Mail.Read`, `Files.Read.All`, `offline_access`.
- Federación (100524): **P1 siempre**; validar con el equipo de identidad en el mismo turno.
- **Contener:** retirar el rol/consentimiento/credencial (administrador de Entra con el ticket); si el actor está
  comprometido, playbook de identidad (aprobación).

## AWS

- `data.aws.event_name` y `data.aws.request_parameters`: política adjunta, usuario/rol creado, permission set.
- Revisar si el mismo principal tocó CloudTrail, GuardDuty o Config (101710/101712) → ver [CloudTrail y auditoría](cloudtrail-y-auditoria.md).
- **Contener:** quitar la política/rol, desactivar access keys nuevas, SCP de bloqueo si es la organización.

<a id="active-directory"></a>
## Active Directory

- 4728/4732/4756 sobre grupos integrados: confirmar con el owner del grupo; AdminSDHolder/GPO (101303) con ticket.
- Borrado de Security (101302): preservar el log del DC y escalar a P1.

<a id="linux"></a>
## Linux (grupos privilegiados y persistencia por FIM)

- 101752: ¿quién (`srcuser`) agregó a quién (`dstuser`) a `sudo`/`docker`/`lxd`? `docker` y `lxd` equivalen a root.
- 101755 llaves SSH, 101758 sudoers, 101759 PAM: **P1 fuera de cambio**; comparar con el `diff` de FIM
  (sin diff en `shadow` ni llaves por privacidad: pedir el archivo al owner del host).
- 101756/101757 unidad systemd o cron: revisar `ExecStart`/comando; correlacionar con `dpkg` (2902/2904) para
  descartar instalación de paquetes.
- **Contener:** retirar la llave/entrada, revertir sudoers/PAM desde configuración versionada, bloquear la IP de
  origen de la sesión (playbook de endpoint, aprobación) y rotar credenciales del host.

## Consultas

```text
rule.groups:(qapaq_privilege_escalation or qapaq_aws_iam or azure_ad)
rule.id:(100520 or 100521 or 101704 or 101700)
rule.id:(101755 or 101756 or 101757 or 101758 or 101759 or 101760)
rule.id:(2960 or 2961 or 101752)
```
