#!/var/ossec/framework/python/bin/python3
"""Integración Wazuh → QAPAQ (push de alertas, docs/07 «Ingesta: push más reconciliación»).

integratord la invoca por cada alerta que pasa el filtro de <integration>:
    custom-qapaq <archivo-alerta> QAPAQ_SECRET_FILE_V1 <hook_url>

- Firma el cuerpo con HMAC-SHA256 usando un archivo protegido root:wazuh; la clave nunca pasa por
  argumentos de proceso ni se versiona. Incluye un timestamp para evitar replay.
- Es best-effort: reintenta fallos HTTP transitorios y de red de forma acotada; el poller de QAPAQ
  reconcilia por cursor como recuperacion final. TLS/configuracion invalida no se reintenta.
- Solo envía los campos que QAPAQ normaliza (minimización N2), no `full_log` completo.
Instalar en /var/ossec/integrations/custom-qapaq con dueño root:wazuh y modo 750.
"""
import hashlib
import hmac
import json
import os
import ssl
import sys
import time
import urllib.request

LOG = "/var/ossec/logs/integrations.log"
SECRET_FILE = "/var/ossec/etc/qapaq-wazuh-push.secret"
SECRET_MARKER = "QAPAQ_SECRET_FILE_V1"
CA_FILE_ENV = "QAPAQ_INGEST_CA_FILE"
REQUEST_TIMEOUT_SECONDS = 2
MAX_REQUEST_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = (0.25, 0.5)
# A wake-up needs only the native alert ID, manager name and source timestamp. The alert itself
# is fetched through the Indexer, which remains the authoritative evidence and reconciliation path.


def trusted_tls_context() -> ssl.SSLContext:
    """Use only the host CA bundle explicitly mounted into the Manager container."""
    path = os.environ.get(CA_FILE_ENV)
    if not path or not os.path.isfile(path) or not os.access(path, os.R_OK):
        raise OSError("configured edge CA bundle is unavailable")
    return ssl.create_default_context(cafile=path)


def log(message: str) -> None:
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(f"{time.strftime('%Y/%m/%d %H:%M:%S')} custom-qapaq: {message}\n")


def retryable(error: Exception) -> bool:
    """Retry transient HTTP/network failures; never mask TLS trust or client errors."""
    if isinstance(error, urllib.error.HTTPError):
        return error.code in (408, 425, 429) or 500 <= error.code <= 599
    if isinstance(error, urllib.error.URLError):
        reason = error.reason
        return isinstance(reason, (OSError, TimeoutError)) and not isinstance(reason, ssl.SSLError)
    return isinstance(error, (OSError, TimeoutError)) and not isinstance(error, ssl.SSLError)


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        log("argumentos insuficientes")
        return 1
    alert_file, secret_marker, hook_url = argv[1], argv[2], argv[3]
    if secret_marker != SECRET_MARKER:
        log("marcador de secreto no valido")
        return 1
    try:
        with open(SECRET_FILE, encoding="ascii") as handle:
            secret = handle.read().strip()
    except OSError:
        log("archivo de secreto no disponible")
        return 1
    if len(secret) < 32 or len(secret) > 512:
        log("archivo de secreto no valido")
        return 1
    if not hook_url.startswith("https://"):
        log("hook_url debe ser https")
        return 1
    with open(alert_file, encoding="utf-8") as handle:
        alert = json.load(handle)
    manager = alert.get("manager")
    manager_name = manager.get("name") if isinstance(manager, dict) else None
    alert_id = alert.get("id")
    occurred_at = alert.get("timestamp")
    if (
        isinstance(alert_id, bool)
        or not isinstance(alert_id, (str, int))
        or not isinstance(manager_name, str)
        or not manager_name
        or not isinstance(occurred_at, str)
    ):
        log("alerta sin identificadores validos")
        return 1
    # The receiver verifies parsed canonical JSON. Keep this field order aligned with the API's
    # canonicalHint implementation while sending only a lookup hint.
    hint = {
        "alertId": str(alert_id),
        "managerName": manager_name,
        "occurredAt": occurred_at,
    }
    body = json.dumps(
        hint,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    try:
        context = trusted_tls_context()
        for attempt in range(MAX_REQUEST_ATTEMPTS):
            # Sign each attempt freshly; alertId makes receiver intake idempotent if a timed-out
            # request committed before its response was lost.
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
                with urllib.request.urlopen(
                    request, timeout=REQUEST_TIMEOUT_SECONDS, context=context
                ) as response:
                    if response.status in (200, 202, 204):
                        return 0
                    error: Exception = RuntimeError(f"HTTP {response.status}")
                    status = response.status
            except Exception as request_error:  # noqa: BLE001 - classify without logging payloads
                error = request_error
                status = request_error.code if isinstance(request_error, urllib.error.HTTPError) else None

            if attempt + 1 < MAX_REQUEST_ATTEMPTS and retryable(error):
                log(
                    f"reintento {attempt + 1}/{MAX_REQUEST_ATTEMPTS - 1} para alerta "
                    f"{alert.get('id')}: {type(error).__name__}"
                )
                time.sleep(RETRY_BACKOFF_SECONDS[attempt])
                continue
            detail = f"HTTP {status}" if status is not None else type(error).__name__
            log(f"fallo para alerta {alert.get('id')}: {detail}")
            break
    except Exception as error:  # noqa: BLE001 - TLS/configuration errors; pull remains recovery path
        log(f"fallo para alerta {alert.get('id')}: {type(error).__name__}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
