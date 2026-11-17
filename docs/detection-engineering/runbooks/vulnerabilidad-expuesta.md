# Runbook · Vulnerabilidad expuesta

Alcance: `snyk/vulnerabilities` (101451–101458), `snyk/exposed-critical-exploit` (101730–101731) y Wazuh
Vulnerability Detection (`wazuh-states-vulnerabilities-*`, dashboard «QAPAQ · Gestión de vulnerabilidades»).

## Triage en 10 minutos

1. **¿Expuesta a Internet?** 101730/101731 (proyecto en `qapaq-internet-facing-projects`) → P1 crítica, P2 alta.
   Si no está en la lista, confirmar con el equipo dueño si el servicio se publica por Cloudflare (y corregir la lista).
2. **¿Explotable?** `exploit_maturity: Mature` o CVE en CISA KEV → sube un nivel de prioridad.
3. **¿Alcanzable?** Snyk reachability / ruta de código; dependencia de desarrollo no desplegada → P3.
4. **¿Hay ataque en curso?** Caza **H07**: WAF (101513/101740) sobre el host del proyecto en las últimas 24 h.

## Contención

- Regla temporal en el WAF de Cloudflare (virtual patching) sobre la ruta afectada, con cambio aprobado.
- Si hay indicios de explotación: tratar como incidente de acceso inicial (T1190) y revisar logs de la app.

## Remediación y SLA objetivo de parcheo [propuesto, N8]

| Caso | Objetivo |
| --- | --- |
| Crítica expuesta con exploit maduro | 72 h (o mitigación WAF en 24 h) |
| Crítica no expuesta / alta expuesta | 15 días |
| Alta no expuesta | 30 días |
| Media/baja | Ciclo normal de dependencias |

Infraestructura (Wazuh VD): priorizar por `vulnerability.score.base`, número de agentes y paquetes del kernel o
servicios expuestos (sshd, nginx, docker). Panel «paquetes a parchar primero».

## Consultas

```text
rule.groups:qapaq_exposure
rule.groups:snyk and data.snyk.issue.exploit_maturity:Mature
vulnerability.severity:(Critical or High)          (índice wazuh-states-vulnerabilities-*)
```
