# Correo de alertas críticas/altas (QAPAQ SOC)

`qapaq_alert_mail.py` envía por Microsoft Graph `sendMail` (client credentials) un correo por
intervalo (`ALERT_INTERVAL_MIN`, timer `qapaq-alert-mail.timer`) con las alertas Wazuh de
`rule.level >= 8` nuevas en `alerts.json`. Severidad según `modules/telemetry`: 12+ crítica,
8–11 alta (umbral 8: críticas y altas según QAPAQ; `min_level` es configurable). Lotes de hasta 50 alertas,
máximo 6 correos/hora, dedupe por id de alerta, cola acotada si Graph falla o se alcanza el límite.
HTML + texto en español con enlace a https://dev.security.qapaq.pe/app/qapaq-alerts. No registra
secretos, tokens ni contenido de alertas.

Requisito: permiso de aplicación **Microsoft Graph `Mail.Send`** con consentimiento de
administrador en la app de `CLIENT_ID` (recomendado: limitarlo al buzón `ALERT_EMAIL_FROM` con una
Application Access Policy de Exchange). Estado 2026-11-04: la app "Soc Interno" **no** lo tiene
(roles: Organization.Read.All, Policy.Read.All, SecurityEvents.Read.All, User.Read.All,
UserAuthenticationMethod.Read.All); el instalador deja el timer apagado hasta que exista.

Lo instala `wazuh/provider-ingestion/install-qapaq-collectors.sh`. Comprobación y prueba:

```bash
sudo python3 /opt/qapaq/collectors/alert-mail/qapaq_alert_mail.py --config /opt/qapaq/collectors/etc/alert-mail.json --check
sudo python3 /opt/qapaq/collectors/alert-mail/qapaq_alert_mail.py --config /opt/qapaq/collectors/etc/alert-mail.json --test
```

Pruebas: `python -m unittest tests/test_qapaq_alert_mail.py`.
