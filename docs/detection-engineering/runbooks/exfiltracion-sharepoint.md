# Runbook · Exfiltración desde SharePoint y OneDrive

Alcance: `sharepoint/exfiltration` (101900–101911), `sharepoint/mass-deletion` (101915–101920),
`sharepoint/external-sharing` (101925–101930), `sharepoint/sharing-policy-and-admins` (101935–101941),
`sharepoint/labels-and-dlp` (101945–101951), `sharepoint/posture` (101960–101972) y la regla heredada 100515
(enlace anónimo). Fuente y permisos: [23 · SharePoint y OneDrive](../../23-sharepoint-onedrive.md).
Playbook: contención manual en el centro de administración de SharePoint/Entra por un operador con el ticket,
aprobada por el Líder SOC (QAPAQ no escribe en Microsoft 365).

## Triage en 10 minutos

1. **¿Quién y con qué identidad?** `data.office365.UserId`. Invitado (`#ext#`, 101905/101906), cuenta
   deshabilitada (101907) o cuenta de servicio (lista `qapaq-m365-service-accounts`: si aparece ahí con nivel ≥ 8, la
   lista no la cubre → revisar). Mirar en Entra los inicios de sesión de esa cuenta en las 24 h previas: un login
   tras fuerza bruta (100505) o desde la IP de un spray (101703) convierte cualquier alerta de esta página en **P1**.
2. **¿Desde dónde?** `data.office365.ClientIP`: en Spamhaus/Feodo (101908) o Tor (101909) → **P1** sin más
   análisis. Red nueva para el usuario (101904, solo vía Purview) → confirmar con el usuario por un canal distinto
   del correo.
3. **¿Cuánto y cuándo?** 101902 (150 en 10 min) es P2; fuera de horario (101903, 40 en 30 min) es P1.
   Distinguir **sincronización** (`FileSyncDownloadedFull`, cliente OneDrive, un dispositivo) de **descarga web**
   (`FileDownloaded`, navegador, `UserAgent`): la primera suele ser un equipo nuevo; la segunda, extracción.
4. **¿Sale de QAPAQ?** Enlace anónimo (100515/101926), correo personal (101927/101930), invitado (101928). Si el
   mismo archivo perdió su etiqueta justo antes (101948) → **P1**, exfiltración preparada.
5. **¿Destrucción?** 101917/101918/101920: borrado masivo o vaciado de la papelera de segunda etapa → P1 si hay
   ransomware o salida del empleado; restaurar es urgente (la papelera de la colección conserva 93 días).
6. **¿Cambió la superficie?** 101936/101937/101963 (Cualquier persona habilitado), 101938–101941 (administradores):
   ¿hay ticket de TI? Sin ticket → tratar como compromiso de un administrador (runbook de
   [escalada de privilegios](escalada-de-privilegios.md)).

| Prioridad | Cuándo |
| --- | --- |
| P1 | IP maliciosa/Tor, fuera de horario, red nueva + volumen, etiqueta quitada y compartido, destrucción o papelera vaciada, tenant debilitado, administrador invitado |
| P2 | Volumen en horario, invitado en volumen, cuenta deshabilitada, correo personal, enlaces anónimos en volumen, administrador agregado, DLP alta |
| P3 | Enlace anónimo aislado, compartición con un socio, DLP media, sitio nuevo, permiso externo encontrado |
| P4 | Marcas (nivel ≤ 3) y fotos de postura: solo búsqueda y contexto |

## Investigación

- **Alcance de lo descargado:** todos los `ObjectId`/`SourceFileName` del usuario en la ventana (consulta abajo);
  sitios afectados (`SiteUrl`) y su clasificación; ¿hay archivos con etiqueta o DLP (101949–101951)?
- **Dispositivo:** `UserAgent`, `Platform`, `DeviceDisplayName`, `IsManagedDevice` (si el registro los trae). Un
  dispositivo no administrado + volumen sube la prioridad.
- **Línea de tiempo:** inicio de sesión → acceso → descarga/compartición → borrado. Buscar reglas de bandeja o
  reenvíos (100510–100512) del mismo usuario: el BEC suele exfiltrar por correo y SharePoint a la vez.
- **Enlaces creados:** en el sitio, «Administrar acceso» del archivo; en postura, `sharepoint.finding.*`
  (101966–101968) muestra enlaces anónimos y externos existentes aunque falte la auditoría.
- **Empleado que se va:** cruzar con RR. HH.; la actividad de una cuenta ya deshabilitada (101907) puede ser
  registrada antes del bloqueo (comparar `CreationTime` con la hora del bloqueo en Entra).

## Contención (con aprobación del Líder SOC)

- Revocar sesiones y restablecer credenciales en Entra; bloquear el inicio de sesión si hay compromiso.
- Quitar los enlaces anónimos y los permisos externos del contenido afectado; si hace falta, bajar el uso
  compartido del sitio a «Solo personas de la organización» mientras dura la investigación.
- Quitar el administrador de colección agregado sin ticket y revisar los demás.
- Destrucción: restaurar desde la papelera de la colección de sitios o con «Restaurar este OneDrive/biblioteca».
- Revertir la configuración del tenant debilitada (`sharingCapability`) y registrar quién la cambió.

## Recuperación y cierre

Verificar que no quedan enlaces del atacante (siguiente pasada de postura, 101966–101968), que la etiqueta volvió
a los archivos afectados y que la cuenta de servicio legítima que causó un falso positivo quedó en la allowlist
por PR (`detections/lists/qapaq-m365-service-accounts` o `qapaq-m365-sharing-approved`). Clasificar VP/FP/benigno,
causa raíz y lección para el backlog (umbral, lista o regla).

## Consultas

```text
rule.groups:qapaq_sharepoint and rule.level >= 8
rule.groups:qapaq_sharepoint and data.office365.UserId:"<usuario>"
rule.id:(101900 or 101902 or 101903 or 101904) and data.office365.UserId:"<usuario>"
rule.groups:qapaq_external_sharing or rule.id:(100515 or 101926)
rule.id:(101945 or 101946 or 101948)
rule.groups:qapaq_posture and data.sharepoint.finding.kind:anonymous_link
rule.groups:qapaq_source_health and data.qapaq.capability.status:blocked
```
