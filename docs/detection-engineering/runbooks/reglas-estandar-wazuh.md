# Runbook · Reglas estándar de Wazuh con volumen en QAPAQ

Alcance: reglas estándar de Wazuh 4.14.8 con volumen en QAPAQ: Office 365 (91578, 91707, 91708, 91702, 91703, 91712, 91713, 91548, 91533), integridad de archivos (550, 553, 554), rootcheck (510, 521), paquetes (2902, 2904), SSH (5710, 5762), SCA (19003, 19007) y agente (220).

Metadatos y guía por regla: [`detections/wazuh-stock/stock-rules.yaml`](../../../detections/wazuh-stock/stock-rules.yaml).

Casi todo este volumen es **actividad normal registrada**, no ataque. El trabajo es separar lo
habitual de lo que no encaja, con la entidad (usuario, IP, host) como eje.

## Triage en 10 minutos

1. **¿Quién y dónde?** Usuario, IP y host de la alerta. ¿Es el dueño del recurso? ¿Es su IP o su país habitual?
2. **¿Hay contexto que la explique?** Despliegue, actualización de paquetes, alta de personal o ventana de cambios en la misma hora.
3. **¿Se acompaña de otra señal?** Alertas QAPAQ de la misma entidad (fuerza bruta, regla de bandeja, descarga masiva, cambio de rol) en ±24 h.
4. **Volumen:** comparar con el historial de 30 días de la misma regla y entidad. Lo habitual y sin otra señal se cierra como benigno con la razón.

## Buzones de Exchange Online

Casos de uso `wazuh-stock/m365-mailbox-access` (91578 MailItemsAccessed, 91707 envío, 91708 envío con otros permisos).

- MailItemsAccessed es auditoría de lectura del buzón: la sincronización de Outlook del propio dueño la genera sin parar. **Benigno** si el actor es el dueño (o un delegado conocido), desde su IP habitual y con un cliente conocido.
- **Escalar** si accede alguien que no es el dueño ni delegado, una aplicación desconocida, desde IP o país inusual, con lectura masiva (Bind de muchos elementos) o `IsThrottled=true`; o si 91708 aparece sin delegación documentada o tras una regla de bandeja o reenvío (100510).
- Siguiente paso de investigación: [credenciales](credenciales.md) (cadena M365 y BEC).

## SharePoint y OneDrive

Casos de uso `wazuh-stock/m365-sharepoint-files` (91702 descarga, 91703 nivel de permiso).

- Descargas individuales son trabajo normal; el volumen lo vigilan las reglas QAPAQ de [exfiltración](exfiltracion-sharepoint.md).
- **Escalar** si descarga un invitado o anónimo, desde IP inusual, o si se añade un nivel de permiso de control total por alguien que no administra el sitio.

## Administración de Entra ID, Exchange y cumplimiento

Casos de uso `wazuh-stock/m365-directory-admin` (91712, 91713, 91548, 91533).

- **Escalar** si el grupo es privilegiado o da acceso a datos sensibles, si el actor no es administrador o actúa fuera de horario, o si el cmdlet cambia protección, retención o auditoría (Set-/Remove-/New-).
- Ver [escalada de privilegios](escalada-de-privilegios.md).

## Integridad de archivos, paquetes y rootcheck

Casos de uso `wazuh-stock/host-integrity-fim` (550, 553, 554), `wazuh-stock/host-packages` (2902, 2904) y `wazuh-stock/host-rootcheck` (510, 521).

- Un cambio FIM en binarios o en /etc a la misma hora que 2902/2904 es una **actualización**: benigno.
- 521 sobre /var/lib/docker o /var/lib/containerd es el **falso positivo conocido** de las capas overlay (la política linux-servers lo ignora; si aparece, el agente no tiene la política al día).
- **Escalar** cambios en SSH, sudoers, cuentas, cron, systemd o authorized_keys sin despliegue; binarios cambiados sin paquete; borrado de logs; herramientas ofensivas instaladas; 521 fuera de Docker o repetido.

## SSH, SCA y agente

Casos de uso `wazuh-stock/host-ssh` (5710, 5762), `wazuh-stock/host-hardening-sca` (19003, 19007) y `wazuh-stock/wazuh-agent-config` (220).

- 5710 desde Internet es ruido de escáneres; **escalar** si después hay un login válido desde esa IP o si apuntan a usuarios reales.
- SCA es postura, no incidente: P4 al backlog de hardening, salvo regresión súbita de controles críticos.
- 220: la política de grupo publicada tiene algo que el agente no acepta; revisar `verify-agent-conf` y la visibilidad perdida del host.

## Cierre y evidencia

- Benigno: anotar la razón concreta (dueño del buzón desde IP habitual, actualización de paquetes a la misma hora…).
- Si una misma causa benigna se repite, proponer afinamiento (lista CDB, exclusión de ruta o ajuste de nivel) en vez de cerrar a mano cada vez.
- Verdadero positivo: abrir incidente y seguir el runbook específico enlazado arriba.

## Consultas

- MailItemsAccessed de un usuario: `rule.id:91578 and data.office365.UserId:"usuario@qapaq.pe"`
- Accesos a buzón por alguien distinto del dueño: `rule.id:91578 and not data.office365.MailboxOwnerUPN:data.office365.UserId` (revisar en Discover, el campo cambia según la operación)
- FIM con actualización en la misma hora: `rule.id:(550 or 553 or 554 or 2902 or 2904) and agent.name:"host"`
