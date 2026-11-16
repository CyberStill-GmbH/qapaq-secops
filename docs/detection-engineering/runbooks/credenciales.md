# Runbook · Ataques de credenciales

Alcance: `m365/credential-attacks` (100502–100506, 100530), `m365/compromise-chain` (101700–101703),
`m365/bec-mailbox-persistence` (100510–100514), `m365/data-exfiltration`, `ad/kerberos-attacks` (101304–101307),
`aws/console-bruteforce-success` (101713, base 101607/101608), `linux/ssh-bruteforce-success` (101750, base
5710/5712/5763). Playbooks: `qapaq-triage-enriquecimiento` (automático) y `qapaq-contencion-identidad-aprobada` /
`qapaq-contencion-endpoint-aprobada` (con aprobación).

## Triage en 10 minutos

1. ¿Hubo **éxito**? 100505, 101703, 101713, 101750 = sí → **P1**. Solo fallos (100503, 100504, 101608, 5712) → P2/P3.
2. ¿La cuenta es privilegiada o break-glass? (razones `PRIVILEGED_IDENTITY` / `BREAK_GLASS_IDENTITY` en QAPAQ) → P1.
3. ¿La IP de origen es de QAPAQ (oficina, VPN, CI)? Si sí y la persona confirma por un canal fuera de banda, es
   benigno: documentar y cerrar.
4. ¿Hay acciones posteriores de la misma cuenta (cadena)? Abrir la caza **H01** del dashboard «QAPAQ · Threat hunting».

<a id="cadena-m365"></a>
## M365 / Entra: cadena de compromiso (101700–101703)

- **Investigar:** en Discover, `data.office365.UserId:"<cuenta>"` 48 h: inicios (IP, país, cliente), cambios de
  MFA (100526), reglas de bandeja (100510–100512), roles (100520/101704), consentimientos (100522).
- **Contener (aprobación):** `m365.revoke-sessions` y, si hay persistencia, `m365.disable-user` desde QAPAQ. Mientras
  el playbook no esté habilitado, lo ejecuta un administrador de Entra con el ticket del incidente.
- **Recuperar:** restablecer contraseña, eliminar métodos MFA no reconocidos, borrar reglas de bandeja/reenvío,
  revocar consentimientos y roles agregados, revisar correos enviados (fraude de pago).

<a id="bec"></a>
## BEC: reglas de bandeja y reenvío (100510–100514, 101702)

- Confirmar destino del reenvío (dominio externo = P1 si hay pagos involucrados).
- Revisar mensajes movidos/borrados por la regla: suelen esconder respuestas de proveedores o bancos.
- Avisar a Tesorería/Riesgos no financieros si el buzón gestiona pagos.

<a id="exfiltracion"></a>
## Exfiltración (100515, 100529)

- Enlace anónimo: ¿el archivo contiene datos personales o de clientes? Si sí, revocar el enlace y escalar a Legal.
- eDiscovery: confirmar caso legal aprobado por Compliance; si no existe, P1.

<a id="kerberos"></a>
## Kerberos (101304–101307)

- Agrupar por cuenta de servicio y origen; RC4 aislado es higiene (P3), muchas cuentas desde un host = Kerberoasting (P1).
- DCSync candidato: el principal debe ser un DC o una cuenta de sincronización documentada.

<a id="aws"></a>
## Consola AWS tras fuerza bruta (101713)

- Ver `data.aws.principal`, MFA y región; listar lo que hizo ese principal después (`data.aws.principal:"<p>"`).
- Contener: deshabilitar el login profile / access keys del usuario IAM (consola AWS por un administrador con el
  ticket; no hay acción automatizada para AWS) y rotar credenciales.

<a id="ssh"></a>
## SSH tras fuerza bruta (101750)

- `data.srcip` y `data.dstuser`: ¿cuenta con llave o contraseña? En los nodos QAPAQ la autenticación por contraseña
  debería estar deshabilitada: si entró con contraseña, es hallazgo de hardening además del incidente.
- Revisar lo que hizo la sesión: sudo (5402), cambios FIM (101755–101760), usuarios nuevos (5902).
- Contener (aprobación): `endpoint.block-ip` (firewall-drop 600 s) y, si hubo acceso real, aislar el host.

## Consultas

```text
rule.groups:qapaq_attack_chain
rule.id:(100502 or 100503 or 100504 or 100505) and data.office365.UserId:"<cuenta>"
rule.groups:sshd and data.srcip:"<ip>"
rule.groups:aws and data.aws.source_ip:"<ip>"
```

**Cierre:** clasificación, métodos MFA y sesiones revocadas, IPs bloqueadas (con vencimiento), lección para el
backlog (p. ej. Conditional Access, deshabilitar contraseña en SSH).
