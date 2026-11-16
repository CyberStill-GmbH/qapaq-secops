# Runbooks de triage e investigación QAPAQ

Parte de [17 · Ingeniería de detección](../../17-ingenieria-de-deteccion.md). Cada runbook sigue el mismo
esquema: **alcance** (reglas), **triage en 10 minutos**, **investigación**, **contención** (siempre por QAPAQ
Respond con aprobación del Líder SOC), **recuperación**, **cierre y evidencia** y **consultas** (KQL para
Discover sobre `wazuh-alerts-*`).

| Runbook | Casos de uso | Prioridad típica |
| --- | --- | --- |
| [Ataques de credenciales](credenciales.md) | M365 fuerza bruta/spray y cadena, BEC, Kerberos, consola AWS, SSH | P1–P2 |
| [Escalada de privilegios](escalada-de-privilegios.md) | Roles de Entra y tier 0, IAM/Identity Center, grupos de AD, sudo/grupos y persistencia Linux | P1–P2 |
| [Malware y EDR](malware-edr.md) | Bitdefender (malware, cuarentena, protección deshabilitada), Sophos, Outlook → proceso | P1–P2 |
| [Vulnerabilidad expuesta](vulnerabilidad-expuesta.md) | Snyk crítica/alta con exploit maduro y expuesta, Wazuh VD | P1–P3 |
| [Oleada en el WAF](oleada-waf.md) | Cloudflare 101513 y 101740, cambios de control | P2 |
| [CloudTrail y auditoría](cloudtrail-y-auditoria.md) | CloudTrail/GuardDuty/Config apagados, auditoría de M365 desactivada | P1 |
| [Exfiltración desde SharePoint](exfiltracion-sharepoint.md) | SharePoint/OneDrive: descarga masiva, borrado, uso compartido externo, política, etiquetas, postura | P1–P3 |
| [Reglas estándar de Wazuh](reglas-estandar-wazuh.md) | Office 365 (MailItemsAccessed, envíos, descargas, admin), FIM, rootcheck, paquetes, SSH, SCA | P3–P4 |

Reglas comunes a todos:

- **Evidencia primero:** antes de contener, exportar la alerta QAPAQ (id, prioridad, razones) y los documentos
  Wazuh (`_id`, índice). La auditoría QAPAQ con cadena hash registra cada transición.
- **Sin datos personales en canales abiertos:** en Teams/correo solo referencias; el detalle vive en QAPAQ (N2).
- **Nada se suprime sin registro:** un falso positivo se documenta en el incidente y se convierte en afinamiento
  (lista CDB, ventana de mantenimiento en QAPAQ o PR de la regla).
- **Cierre:** clasificación VP/FP/benigno, causa raíz, acciones y lección para el backlog de detección.
