#!/var/ossec/framework/python/bin/python3
"""Integración Wazuh → QAPAQ (push de alertas, docs/07 «Ingesta: push más reconciliación»).

integratord la invoca por cada alerta que pasa el filtro de <integration>:
    custom-qapaq <archivo-alerta> <api_key> <hook_url>

- Firma el cuerpo con HMAC-SHA256 (clave = <api_key>, que en la instancia se rellena desde
  Secrets Manager al aplicar; nunca se versiona) e incluye un timestamp para evitar replay.
- Es best-effort: integratord no reintenta. El poller de QAPAQ reconcilia por cursor, así que
  una alerta perdida aquí llega igual, con más latencia. Por eso un fallo solo se registra.
- Solo envía los campos que QAPAQ normaliza (minimización N2), no `full_log` completo.
Instalar en /var/ossec/integrations/custom-qapaq con dueño root:wazuh y modo 750.
"""
import hashlib
import hmac
import json
import sys
import time
import urllib.request

LOG = "/var/ossec/logs/integrations.log"
FIELDS = ("id", "timestamp", "rule", "agent", "manager", "decoder", "location", "data")


def log(message: str) -> None:
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(f"{time.strftime('%Y/%m/%d %H:%M:%S')} custom-qapaq: {message}\n")


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        log("argumentos insuficientes")
        return 1
    alert_file, secret, hook_url = argv[1], argv[2], argv[3]
    if not hook_url.startswith("https://"):
        log("hook_url debe ser https")
        return 1
    with open(alert_file, encoding="utf-8") as handle:
        alert = json.load(handle)
    body = json.dumps(
        {key: alert[key] for key in FIELDS if key in alert}, separators=(",", ":")
    ).encode("utf-8")
    timestamp = str(int(time.time()))
    signature = hmac.new(
        secret.encode("utf-8"), timestamp.encode("ascii") + b"." + body, hashlib.sha256
    ).hexdigest()
    request = urllib.request.Request(
        hook_url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-qapaq-timestamp": timestamp,
            "x-qapaq-signature": f"sha256={signature}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status not in (200, 202, 204):
                log(f"respuesta {response.status} para alerta {alert.get('id')}")
    except Exception as error:  # noqa: BLE001 — best-effort; el pull reconcilia
        log(f"fallo para alerta {alert.get('id')}: {type(error).__name__}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
