# 02 · Cobertura MITRE ATT&CK y análisis de brechas

Parte de [17 · Ingeniería de detección](../17-ingenieria-de-deteccion.md). Informe generado (no editar):
[`detections/reports/mitre-coverage.md`](../../detections/reports/mitre-coverage.md) y su JSON.

## Cómo se mide

`detections/tools/qapaq_detections.py coverage` lee **el XML de todas las reglas QAPAQ** del catálogo (incluido el
paquete AWS de otro owner si está en el árbol) y de `detections/*/*/rule.xml`, extrae `<mitre><id>`, lo cruza con
[`detections/mitre/attack-qapaq.json`](../../detections/mitre/attack-qapaq.json) (técnica → tácticas, ATT&CK
Enterprise v16) y produce:

- resumen **antes / con** el programa (reglas, técnicas, padres, tácticas);
- matriz por táctica con las reglas de cada técnica;
- brechas: cada técnica priorizada para el entorno QAPAQ queda **cubierta**, **parcial** (solo la técnica padre o
  una subtécnica hermana) o **brecha**, con el bloqueo que la mantiene abierta;
- con `--official <ruleset/rules>`, cuántas reglas del ruleset oficial de Wazuh mapean cada técnica.

La cobertura por reglas **no** prueba detección: una regla sin datos no ve nada. El dashboard «QAPAQ · Cobertura
MITRE ATT&CK» muestra lo que efectivamente dispara (campo `rule.mitre.*` de las alertas).

## Resultado (2026-11-04)

| Métrica | Antes del programa | Con el programa |
| --- | ---: | ---: |
| Reglas QAPAQ | 137 | 161 |
| Reglas con técnica MITRE | 93 | 117 |
| Técnicas y subtécnicas | 49 | 60 |
| Técnicas padre | 32 | 33 |
| Tácticas con cobertura | 12/14 | 13/14 |

Nuevas: `T1021.004`, `T1053.003`, `T1053.006`, `T1078.003`, `T1098.004`, `T1098.005`, `T1543.002`, `T1548`,
`T1556`, `T1556.003`, `T1595.002` (servidores Linux, persistencia por FIM, MFA tras compromiso, escaneo
distribuido). Movimiento lateral pasa a tener cobertura (SSH). **Descubrimiento** sigue en cero: necesita eventos
de lectura (CloudTrail read-only, Graph), que hoy no se ingieren por costo.

Prioridades para QAPAQ (58 técnicas): **Alta** 20 cubiertas, 8 brechas · **Media** 14 cubiertas, 1 parcial, 10
brechas · **Baja** 3 cubiertas, 4 brechas.

## Brechas por entorno y qué las cierra

| Entorno | Brechas de prioridad alta/media | Bloqueo | Backlog |
| --- | --- | --- | --- |
| **M365 / Entra** | T1621 fatiga MFA, T1557 AiTM, T1539 robo de cookie, T1213.002 SharePoint; ampliar cobertura con datos reales | El feed de auditoria Office 365 tiene ActivityFeed.Read concedido; logs de inicio de sesion de Entra requieren permisos adicionales (`AuditLog.Read.All`, Identity Protection P2) | BL-I02, BL-I03 |
| **Correo** | T1566.001/.002 phishing | Defender for Office 365 P2 (presupuesto) | BL-B02 |
| **Windows / AD** | T1003.001 LSASS, T1486 ransomware, T1490, T1021.001 RDP, T1219 | Agentes en estaciones y DC; Sysmon con gate de privacidad (N2) | BL-E01, BL-E02 |
| **Linux** | T1505.003 web shell, T1609/T1610/T1611 contenedores | auditd y eventos del daemon de Docker en el nodo | BL-L01, BL-L02 |
| **AWS** | T1552.005 credenciales de instancia, T1580/T1087.004 descubrimiento, T1648, T1651 | Hallazgos de GuardDuty (ya llegan), eventos read-only (costo) | BL-A01, BL-A02 |
| **SaaS** | T1195.001 (parcial: solo T1195 genérico) | Clasificación de paquetes maliciosos de Snyk | BL-S02 |

## Mantenimiento

- Cada PR que agrega o cambia `<mitre>` regenera el informe y las vistas (la CI avisa si quedan viejos).
- `attack-qapaq.json` se revisa con cada versión de ATT&CK; una técnica nueva en una regla exige agregarla ahí (lint).
- Las prioridades se revisan trimestralmente con el Líder SOC (inteligencia de amenazas del sector financiero
  peruano, incidentes propios y resultados de caza).
