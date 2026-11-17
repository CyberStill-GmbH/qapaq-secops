# Catálogo de reglas de prioridad (101600–101699)

Archivo: `infra/wazuh/priority/rules/qapaq_priority_rules.xml`. Rango reservado para este
paquete; `finance-playbooks` usa 101400–101449. Instalación: `infra/wazuh/priority/apply-priority.sh`.

Leyenda: ↑ eleva · ↓ rebaja · ★ señal nueva. Contexto: CA activo crítico, PI identidad
privilegiada, SW estación sensible, IF expuesto a Internet, OH fuera de horario.

## 1. Activos críticos y dominio (Windows Security)

| ID | Padre | Nivel | Ctx | Condición | MITRE |
|---|---|---|---|---|---|
| 101600 ↑ | 101302 (13) | 15 | CA | Security log borrado en activo crítico | T1070.001 |
| 101601 ↑ | 101301 (12) | 14 | CA | Política de auditoría cambiada en activo crítico | T1562.002 |
| 101602 ↑ | 101300 (12) | 14 | — | Alta en grupo privilegiado por actor **no** listado como privilegiado | T1098.007 |
| 101603 ↑ | 101306 (6) | 13 | — | Replicación de directorio pedida por cuenta de usuario (DCSync) | T1003.006 |
| 101604 ↓ | 101306 (6) | 3 | — | Replicación entre DC registrados (`dc`) por cuenta de equipo | — |
| 101605 ↑ | 101305 (7) | 12 | PI | TGT sin preautenticación para identidad privilegiada | T1558.004 |
| 101606 ↑ | 60106 (3) | 10 | PI | Tier 0 con logon interactivo/RDP fuera de activos críticos | T1078.002 |
| 101607 ↑ | 60115 (9) | 12 | PI | Bloqueo de cuenta privilegiada | T1110 |
| 101608 ↓ | 101307 (6) | 3 | — | Kerberos 0x25 (desfase de reloj) | — |
| 101609 ↓ | 101307 (6) | 3 | — | Preautenticación fallida de cuenta de equipo | — |

## 2. Endpoint (Sysmon Event 1)

| ID | Padre | Nivel | Ctx | Condición | MITRE |
|---|---|---|---|---|---|
| 101610 ↑ | 101100 (8) | 12 | SW | Outlook → intérprete en estación sensible | T1204.002, T1566.001 |
| 101611 ↑ | 101100 (8) | 13 | CA | Outlook → intérprete en activo crítico | T1204.002 |
| 101612 ★ | sysmon_event1 | 12 | — | Proceso web (w3wp, httpd, nginx, php-cgi, tomcat) lanza shell o utilidad de reconocimiento | T1505.003 |
| 101613 ↑ | 101612 | 14 | IF | Lo anterior en servidor expuesto | T1505.003, T1190 |
| 101614 ★ | sysmon_event1 | 13 | — | Borrado de shadow copies / catálogo de respaldo | T1490 |
| 101615 ↑ | 101614 | 15 | CA | Lo anterior en activo crítico | T1490 |

## 3. Adaptadores de proveedor (`integration=qapaq-provider`)

| ID | Padre | Nivel | Ctx | Condición |
|---|---|---|---|---|
| 101620 ↑ | 101210 (10) | 13 | CA | PowerShell codificado con padre inusual |
| 101621 ↑ | 101210 (10) | 12 | SW | Ídem en estación sensible |
| 101622 ↑ | 101211 (10) | 12 | CA | Tarea/servicio sin cambio aprobado |
| 101623 ↑ | 101212 (9) | 12 | CA | Cambio FIM en ruta de persistencia |
| 101624 ↑ | 101214 (9) | 12 | CA | sudo privilegiado sin cambio aprobado |
| 101625 ↑ | 101213 (12) | 13 | CA | Ráfaga SSH contra activo crítico (movimiento lateral) |
| 101626 ↓ | 101213 (12) | 6 | — | Ráfaga SSH contra expuesto **no** crítico (ruido de Internet) |
| 101627 ↑ | 101209 (13) | 14 | CA | Antimalware en tiempo real deshabilitado |
| 101628 ↑ | 101209 (13) | 14 | SW | Ídem en estación sensible |
| 101629 ↑ | 101205 (13) | 14 | PI | Inicio de sesión de riesgo alto de identidad privilegiada |

## 4. Microsoft 365 / Entra

| ID | Padre | Nivel | Ctx | Condición |
|---|---|---|---|---|
| 101640 ↑ | 100506 + `if_matched_sid` 101643 | 15 | PI | Inicio de sesión tras fuerza bruta contra identidad privilegiada |
| 101641 ↑ | 100510 (12) | 14 | PI | Regla de bandeja que reenvía/oculta en buzón privilegiado o de aprobador de pagos (BEC) |
| 101642 ↑ | 100512 (12) | 14 | PI | Reenvío SMTP de identidad privilegiada |
| 101643 ↑ | 100503 (10) | 12 | PI | Fuerza bruta contra identidad privilegiada |
| 101644 ↑ | 100526 (8) | 12 | PI | Cambio de métodos MFA de identidad privilegiada |
| 101645 ↑ | 100506 (3) | 10 | PI, OH | Login tier0/cloud-admin 01:00–12:00 UTC (20:00–07:00 Lima) |
| 101646 ↑ | 100506 (3) | 10 | PI, OH | Login tier0/cloud-admin en fin de semana |

## 5. Listas CDB

| Lista | Clave | Valores admitidos | Plantilla |
|---|---|---|---|
| `qapaq-critical-assets` | FQDN como lo registra Windows (`win.system.computer`) o el adaptador (`qapaq_host`) | `dc`, `core`, `db`, `pago`, `paw`, `backup`, `infra`, `web` | `lists/qapaq-critical-assets.example` |
| `qapaq-privileged-identities` | sAMAccountName (AD) y UPN (Entra) | `tier0`, `tier1`, `cloud-admin`, `payment-approver`, `service` | `lists/qapaq-privileged-identities.example` |
| `qapaq-sensitive-workstations` | FQDN | `tesoreria`, `operaciones`, `creditos`, `ti-priv`, `riesgos`, `contabilidad` | `lists/qapaq-sensitive-workstations.example` |
| `qapaq-internet-facing` | FQDN | `web`, `vpn`, `mail`, `api`, `dns`, `sftp` | `lists/qapaq-internet-facing.example` |

`match_key` distingue mayúsculas: `apply-priority.sh` añade variantes en minúsculas y
mayúsculas de cada clave y rechaza valores fuera de la tabla y claves `.example` en listas
reales. Las listas reales viven fuera del repositorio (`/etc/qapaq/priority-lists` en el
manager) y se mantienen sincronizadas con `QAPAQ_DETECTION_PRIVILEGED_IDENTITIES`,
`QAPAQ_DETECTION_CRITICAL_ASSETS` y `QAPAQ_DETECTION_INTERNET_FACING_ASSETS` del núcleo.

## 6. Pruebas

| Prueba | Cubre |
|---|---|
| `tests/logtest-cases.jsonl` + `expected-rules.txt` (63 casos) | Cada regla del archivo con su caso `sube:`/`baja:` y el `mantiene:` del mismo evento sin contexto, salvo 101625 (ver §7) |
| `tests/test_priority_rules.py` | Rango y colisiones de ID, padres existentes, dirección del ajuste respecto al padre, etiquetas `qapaq_ctx_*` respaldadas por la lista correcta, plantillas sintéticas, render del aplicador |
| `modules/detection/test/prioritization.spec.ts` | Matriz nivel → P1–P4 y lectura de etiquetas |

Ejecución con Docker (mismos pasos que `.github/workflows/wazuh-priority-agents.yml`):

```bash
bash infra/wazuh/priority/tests/run-logtest.sh qapaq-wazuh-priority-test
```

## 7. Lecciones del motor (wazuh-logtest 4.14.8)

- **Una hija que eleva al padre lo oculta para `if_matched_sid`.** Wazuh solo guarda la regla
  final: al elevar 100503 con 101643, la regla 100505 (éxito tras fuerza bruta) deja de ver
  100503. 101640 correlaciona contra 101643.
- **`if_matched_sid` se resuelve al cargar:** la regla referida debe estar antes en el archivo.
- **RDP (tipo 10) desciende también por la regla oficial 67022 (nivel 3).** Los casos que
  mantienen el nivel aceptan 60106, 60119 o 67022.
