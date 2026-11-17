# Runbook · Oleada de ataques en el WAF (Cloudflare)

Alcance: `cloudflare/audit-and-waf` (101501–101513) y `cloudflare/waf-attack-surge` (101740).

## Triage en 10 minutos

1. **¿Una IP o muchas?** 101513 = una IP insistente (20 en 5 min); 101740 = oleada distribuida (50 IPs distintas en
   10 min sobre un host) → P2.
2. **¿Qué buscan?** Rutas (`data.cloudflare.firewall.path`) y regla del WAF (`rule_description`): SQLi, RCE,
   `/login` (credenciales), rutas de un CVE reciente.
3. **¿Pasa algo?** Eventos `log` (101511) con la misma firma = la regla está solo en modo registro: el ataque llega
   a la aplicación → P1 si coincide con una vulnerabilidad expuesta (caza **H07**).
4. **¿Alguien tocó los controles?** 101504/101505 (WAF/ruleset deshabilitado) en la misma ventana → P1.

## Contención (cambio aprobado)

- Rate limiting o regla de bloqueo por ASN/país/ruta; Under Attack mode si afecta disponibilidad.
- Pasar a `block` la regla administrada que está en `log`.
- Nunca bloquear rangos de proveedores de QAPAQ sin confirmar (pagos, monitoreo).

## Investigación y cierre

Top IPs, ASN y países (H08), user agents, horarios; correlacionar con errores 5xx de la aplicación y con logins
exitosos en la misma ventana. Cerrar con la medida aplicada y su vencimiento.

## Consultas

```text
rule.id:(101513 or 101740)
rule.groups:qapaq_waf and data.cloudflare.firewall.host:"<host>"
rule.id:101511
```
