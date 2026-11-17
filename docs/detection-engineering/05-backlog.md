# 05 · Backlog y hoja de ruta de ingeniería de seguridad

Parte de [17 · Ingeniería de detección](../17-ingenieria-de-deteccion.md). Prioridad por riesgo para QAPAQ y por
costo de cierre. **Necesita:** `Entra` = permiso/consentimiento de administrador en Entra; `Agentes` = desplegar
agentes Wazuh en endpoints/servidores; `Presupuesto` = licencia o gasto; `—` = solo trabajo interno.

## Ahora (0–30 días)

| ID | Ítem | Por qué | Necesita | Owner |
| --- | --- | --- | --- | --- |
| BL-I01 | ~~Conceder `ActivityFeed.Read` a la app de Wazuh~~ **Hecho 2026-11-10** segun verificacion documentada en [18](../18-integraciones.md); revisar frescura antes de declarar fuente sana | Sin actividad M365 el SOC queda ciego | Entra | Platform + admin de Entra |
| BL-I04 | Poblar `qapaq-break-glass` con las cuentas de emergencia reales | 100530 (P1 no suprimible) no puede disparar con el centinela | — | Identidad |
| BL-S01 | Poblar `qapaq-internet-facing-projects` (proyecto Snyk → zona Cloudflare); luego automatizarlo desde la API de zonas | Sin lista, 101730/101731 no disparan | — | Security Engineering |
| BL-Q01 | ~~Afinar 521 (rootcheck, nivel 11)~~ **Hecho 2026-11-09**: exclusión de overlay en el agente, regla 101765 y 328 FP cerrados con auditoría ([07](07-ajuste-falsos-positivos.md)) | Ruido que tapaba P2 en el correo de nivel ≥ 8 | — | Ingeniería de detección |
| BL-R03 | Usuario de la API de Wazuh con solo `active-response:command` | Prerrequisito del playbook de contención de endpoint | — | Platform |
| BL-M01 | MTTD/MTTA/MTTR medidos desde QAPAQ (vista o informe) | Sin medición no hay SLO publicable (N8) | — | Backend QAPAQ |

| BL-Q02 | Bucle de retroalimentación: el motor de correlación y riesgo propone altas a `detections/lists/` por PR desde los veredictos `false_positive` | Afinamiento continuo sin editar reglas | — | Correlación + Ingeniería de detección |
| BL-Q03 | Decoder QAPAQ para `usermod`/sesiones SSH con IP en PAM; allowlist de `srcuser` por lista cuando Wazuh lo admita | Hoy 101766 compara el usuario origen por texto | — | Ingeniería de detección |

## Siguiente (30–90 días)

| ID | Ítem | Por qué | Necesita | Owner |
| --- | --- | --- | --- | --- |
| BL-I02 | Logs de sign-in de Entra (`AuditLog.Read.All`) vía Graph o Event Hub → Wazuh | Cierra T1621 (fatiga MFA), errores 50074/50126, ubicaciones y dispositivos | **Entra** | Platform |
| BL-E01 | Agentes Wazuh en estaciones Windows (grupo `windows-workstations`) y Sysmon en el piloto (`windows-telemetry-extended`, gate de privacidad N2) | Cierra T1204.002, T1059.001, T1003.001, T1219; activa 101100 y el paquete de lanzamiento | **Agentes** | Endpoint + Privacidad |
| BL-E02 | Agentes en controladores de dominio (multigrupo `windows-servers,domain-controllers`) | Activa 101300–101307 (Kerberoasting, DCSync, GPO) | **Agentes** | Endpoint |
| BL-R01 | Aviso de Ankay por el outbox de QAPAQ (o `Mail.Send` acotado al buzón SOC) | El paso de correo del triage falla cerrado | **Entra** (si Mail.Send) | Backend QAPAQ |
| BL-R02 | App de contención Graph (`User.RevokeSessions.All`, `User.EnableDisableAccount.All`) y decisión en docs/10 | Prerrequisito del playbook de identidad | **Entra** | Identidad + Líder SOC |
| BL-L03 | Decoder QAPAQ para `usermod -aG` | 101752 solo ve `gpasswd` | — | Ingeniería de detección |
| BL-A01 | Correlación GuardDuty ↔ CloudTrail por principal (credenciales de instancia T1552.005) | Los hallazgos ya llegan por EventBridge | — | Ingeniería de detección + monitoreo AWS |
| BL-A03 | Reglas de borrado de respaldos (DeleteRecoveryPoint, DeleteSnapshot masivo) | T1490 en AWS | — | Monitoreo AWS |
| BL-P01 | Clasificación de cierre (VP/FP/benigno) obligatoria en Ayni Qapaq | Base de la métrica de fidelidad por regla | — | Backend QAPAQ |

## Después (90+ días)

| ID | Ítem | Por qué | Necesita | Owner |
| --- | --- | --- | --- | --- |
| BL-I03 | Entra ID P2 (Identity Protection: riesgo de usuario y de sign-in, token anómalo) | T1557 AiTM y T1539 robo de cookie, sin reglas propias frágiles | **Presupuesto** + **Entra** | Identidad |
| BL-B02 | Defender for Office 365 P2 (AlertInfo, ClickEvents) | T1566 phishing: hoy no hay señal de correo malicioso | **Presupuesto** + **Entra** | Seguridad de correo |
| BL-L01 | auditd en servidores Linux (execve de shells, `docker exec`) | T1059.004, T1609, T1611 | **Agentes** | Platform |
| BL-L02 | Eventos del daemon de Docker en el nodo | T1610 contenedores nuevos | — | Platform |
| BL-A02 | Eventos read-only de CloudTrail (filtrados) | T1580/T1087.004 descubrimiento; costo por volumen | **Presupuesto** | Monitoreo AWS |
| BL-S02 | Snyk: alerta de paquetes maliciosos (T1195.001) | Supply chain en dependencias | — | AppSec |
| BL-B04 | Cobertura 24×7 (guardia rotativa o MSSP sin SaaS de logs, N1) | P1 fuera de horario | **Presupuesto** | Dirección |
| BL-W01 | Wazuh 5 + Security Analytics (Sigma) en clúster nuevo | Correlación entre tipos de log sin XML a mano | — | Platform (A16) |

## Hecho en este programa (2026-11-04)

24 reglas nuevas (101700–101760) con fixtures y prueba en vivo, catálogo y metadatos para 23 casos de uso,
matriz MITRE con brechas, 7 runbooks, 3 playbooks exportables, 6 vistas de análisis y CI de detección.
