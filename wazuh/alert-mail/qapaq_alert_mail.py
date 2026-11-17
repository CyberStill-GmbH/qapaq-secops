#!/usr/bin/env python3
"""QAPAQ SecOps: correo de alertas críticas/altas de Wazuh vía Microsoft Graph ``sendMail``.

Se ejecuta cada ``ALERT_INTERVAL_MIN`` (timer systemd). Lee ``alerts.json`` del manager desde el
último offset (detecta rotación por inode/tamaño), filtra ``rule.level >= min_level`` (por defecto
10; QAPAQ/modules/telemetry: 12+ crítica, 8-11 alta), deduplica por ``id`` de alerta y envía UN correo
por ejecución con el lote (máx. ``max_per_email``), limitado a ``max_emails_per_hour``. Lo que no
cabe queda pendiente (acotado) para la siguiente ejecución. Al primer arranque empieza al final del
archivo: no envía el histórico.

Credenciales: client credentials de la app Entra (``tenant/client id`` y secreto en archivos 0600).
Requiere el permiso de aplicación ``Mail.Send`` con consentimiento de administrador (recomendado:
restringirlo al buzón remitente con una Application Access Policy de Exchange).

Nunca registra el secreto, el token ni el contenido de las alertas: solo conteos y códigos HTTP.

Uso: ``qapaq_alert_mail.py --config c.json`` | ``--check`` (roles del token) | ``--test`` (correo de prueba).
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "provider-ingestion" / "common"))
from qapaq_collector import ProviderError, http_json, iso, read_secret, read_state, save_state, utc_now  # noqa: E402

GRAPH = "https://graph.microsoft.com/v1.0"
LOGIN = "https://login.microsoftonline.com"
DEFAULT_CONSOLE = "https://dev.security.qapaq.pe/app/qapaq-alerts"
MAX_READ_BYTES = 64 * 1024 * 1024
MAX_PENDING = 500
TEST_SUBJECT = "[QAPAQ SecOps] Prueba de alertas"


def severity(level: int) -> str:
    return "Crítica" if level >= 12 else "Alta" if level >= 8 else "Media" if level >= 4 else "Baja"


def summarize(alert: dict) -> dict | None:
    rule = alert.get("rule") if isinstance(alert.get("rule"), dict) else {}
    try:
        level = int(rule.get("level", -1))
    except (TypeError, ValueError):
        return None
    agent = alert.get("agent") if isinstance(alert.get("agent"), dict) else {}
    return {
        "id": str(alert.get("id") or "")[:64],
        "timestamp": str(alert.get("timestamp") or "")[:40],
        "level": level,
        "rule_id": str(rule.get("id") or "")[:16],
        "description": str(rule.get("description") or "")[:300],
        "agent": str(agent.get("name") or "")[:120],
    }


def read_new_alerts(path: pathlib.Path, state: dict, min_level: int) -> tuple[list[dict], dict]:
    """Return alerts appended since the stored offset and the new file position."""
    metadata = path.stat()
    inode, size = metadata.st_ino, metadata.st_size
    position = state.get("position")
    if not position:
        return [], {"inode": inode, "offset": size}  # first run: start at the end
    offset = position["offset"] if position.get("inode") == inode and position["offset"] <= size else 0
    with path.open("rb") as stream:
        stream.seek(offset)
        chunk = stream.read(MAX_READ_BYTES)
    complete = chunk.rfind(b"\n") + 1  # only whole lines; a partial last line is read next time
    found = []
    for line in chunk[:complete].splitlines():
        try:
            alert = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        summary = summarize(alert) if isinstance(alert, dict) else None
        if summary and summary["level"] >= min_level and summary["id"]:
            found.append(summary)
    return found, {"inode": inode, "offset": offset + complete}


def render(alerts: list[dict], omitted: int, console: str) -> tuple[str, str, str]:
    alerts = sorted(alerts, key=lambda a: (-a["level"], a["timestamp"]))
    critical = sum(1 for a in alerts if a["level"] >= 12)
    subject = f"[QAPAQ SecOps] {len(alerts) + omitted} alerta(s): {critical} crítica(s), {len(alerts) - critical} alta(s)"
    lines = ["QAPAQ SecOps — alertas críticas y altas de Wazuh", ""]
    rows = []
    for a in alerts:
        lines.append(f"- [{severity(a['level'])} · nivel {a['level']}] {a['description']} "
                     f"(regla {a['rule_id']}, agente {a['agent'] or '-'}, {a['timestamp']}, id {a['id']})")
        color = "#b91c1c" if a["level"] >= 12 else "#c2410c"
        rows.append(
            "<tr>"
            f"<td style='padding:6px;color:{color};font-weight:600'>{html.escape(severity(a['level']))} ({a['level']})</td>"
            f"<td style='padding:6px'>{html.escape(a['description'])}</td>"
            f"<td style='padding:6px'>{html.escape(a['rule_id'])}</td>"
            f"<td style='padding:6px'>{html.escape(a['agent'] or '-')}</td>"
            f"<td style='padding:6px;white-space:nowrap'>{html.escape(a['timestamp'])}</td>"
            "</tr>"
        )
    if omitted:
        lines.append(f"... y {omitted} alerta(s) más; ver la consola.")
    lines += ["", f"Abrir en la consola QAPAQ: {console}", "",
              "Mensaje automático del SOC QAPAQ. No responder a este correo."]
    body_html = (
        "<div style='font-family:Segoe UI,Arial,sans-serif;color:#111827;max-width:880px'>"
        "<div style='background:#0f172a;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0'>"
        "<strong style='font-size:18px'>QAPAQ SecOps</strong> · alertas críticas y altas</div>"
        "<div style='border:1px solid #e5e7eb;border-top:0;padding:16px 18px;border-radius:0 0 8px 8px'>"
        f"<p>{len(alerts) + omitted} alerta(s) nuevas con nivel alto o crítico en Wazuh.</p>"
        "<table style='border-collapse:collapse;width:100%;font-size:13px'>"
        "<tr style='background:#f3f4f6;text-align:left'><th style='padding:6px'>Severidad</th>"
        "<th style='padding:6px'>Descripción</th><th style='padding:6px'>Regla</th>"
        "<th style='padding:6px'>Agente</th><th style='padding:6px'>Fecha</th></tr>"
        + "".join(rows) + "</table>"
        + (f"<p>… y {omitted} alerta(s) más.</p>" if omitted else "")
        + f"<p><a href='{html.escape(console)}' style='background:#2563eb;color:#fff;padding:8px 14px;"
        "border-radius:6px;text-decoration:none'>Abrir en la consola QAPAQ</a></p>"
        "<p style='color:#6b7280;font-size:12px'>Mensaje automático del SOC QAPAQ. No responder.</p>"
        "</div></div>"
    )
    return subject, "\n".join(lines), body_html


class Graph:
    def __init__(self, tenant: str, client_id: str, secret: str, opener=None) -> None:
        self.tenant, self.client_id, self.secret, self.opener = tenant, client_id, secret, opener
        self._token: str | None = None

    def token(self) -> str:
        if self._token:
            return self._token
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials", "client_id": self.client_id,
            "client_secret": self.secret, "scope": "https://graph.microsoft.com/.default",
        }).encode()
        request = urllib.request.Request(f"{LOGIN}/{self.tenant}/oauth2/v2.0/token", data=body, method="POST")
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with (self.opener or urllib.request.urlopen)(request, timeout=20) as response:
                payload = json.loads(response.read(1024 * 1024))
        except urllib.error.HTTPError as error:
            raise ProviderError("Entra token request failed", error.code) from None
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            raise ProviderError("Entra token request failed (network)") from None
        self._token = payload.get("access_token")
        if not isinstance(self._token, str):
            raise ProviderError("Entra token response is invalid")
        return self._token

    def roles(self) -> list[str]:
        part = self.token().split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        return sorted(claims.get("roles") or [])

    def send(self, sender: str, recipients: list[str], subject: str, text: str, body_html: str) -> None:
        message = {
            "message": {
                "subject": subject,
                "body": {"contentType": "HTML", "content": body_html},
                "toRecipients": [{"emailAddress": {"address": r}} for r in recipients],
                # Texto plano para clientes sin HTML (Graph envía un único cuerpo; el texto va como adjunto inline).
                "attachments": [{
                    "@odata.type": "#microsoft.graph.fileAttachment", "name": "alertas.txt",
                    "contentType": "text/plain; charset=utf-8",
                    "contentBytes": base64.b64encode(text.encode()).decode(),
                }],
            },
            "saveToSentItems": False,
        }
        status, _ = http_json("POST", f"{GRAPH}/users/{urllib.parse.quote(sender)}/sendMail",
                              {"Authorization": f"Bearer {self.token()}"}, message, opener=self.opener)
        if status != 202:
            raise ProviderError("Graph sendMail failed", status)


def graph_from(config: dict, opener=None) -> Graph:
    return Graph(
        read_secret(pathlib.Path(config["tenant_id_file"])),
        read_secret(pathlib.Path(config["client_id_file"])),
        read_secret(pathlib.Path(config["client_secret_file"])),
        opener,
    )


def run(config: dict, graph: Graph, now: float | None = None) -> tuple[int, int]:
    """One poll. Returns (alerts sent, alerts still pending)."""
    now = time.time() if now is None else now
    state_path = pathlib.Path(config["state_file"])
    state = read_state(state_path)
    found, position = read_new_alerts(pathlib.Path(config["alerts_file"]), state, int(config.get("min_level", 10)))
    sent_ids = list(state.get("sent_ids") or [])
    known = set(sent_ids) | {a["id"] for a in state.get("queue") or []}
    pending = list(state.get("queue") or [])
    for item in found:
        if item["id"] not in known:
            known.add(item["id"])
            pending.append(item)
    pending = pending[-MAX_PENDING:]
    sends = [t for t in state.get("sends") or [] if now - t < 3600]
    # Commit the read position (alerts move into pending) before any network call.
    base_state = {"position": position, "queue": pending, "sent_ids": sent_ids[-5000:], "sends": sends}
    save_state(state_path, base_state)
    if not pending or len(sends) >= int(config.get("max_emails_per_hour", 6)):
        return 0, len(pending)
    batch_size = int(config.get("max_per_email", 50))
    batch, rest = pending[:batch_size], pending[batch_size:]
    subject, text, body_html = render(batch, len(rest), config.get("console_url", DEFAULT_CONSOLE))
    graph.send(config["from"], config["to"], subject, text, body_html)
    save_state(state_path, {**base_state, "queue": [], "sent_ids": (sent_ids + [a["id"] for a in pending])[-5000:],
                            "sends": sends + [now], "last_send": iso(utc_now())})
    return len(pending), 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=pathlib.Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="report whether the app token has Mail.Send")
    mode.add_argument("--test", action="store_true", help=f"send one '{TEST_SUBJECT}' email")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        graph = graph_from(config)
        if args.check:
            roles = graph.roles()
            print(f"qapaq-alert-mail: token OK; Mail.Send={'yes' if 'Mail.Send' in roles else 'NO'}; roles={','.join(roles)}")
            return 0 if "Mail.Send" in roles else 2
        if args.test:
            synthetic = [{"id": "prueba-0001", "timestamp": iso(utc_now()), "level": 12, "rule_id": "000000",
                          "description": "Alerta sintética de prueba del servicio de correo QAPAQ", "agent": "qapaq-soc"}]
            _, text, body_html = render(synthetic, 0, config.get("console_url", DEFAULT_CONSOLE))
            graph.send(config["from"], config["to"], TEST_SUBJECT, text, body_html)
            print("qapaq-alert-mail: test email accepted by Graph (HTTP 202)")
            return 0
        sent, pending = run(config, graph)
        print(f"qapaq-alert-mail: ok sent={sent} pending={pending}", file=sys.stderr)
        return 0
    except ProviderError as error:
        status = f" (HTTP {error.status})" if error.status else ""
        print(f"qapaq-alert-mail: failed: {error}{status}; alerts kept pending", file=sys.stderr)
        return 1
    except (OSError, KeyError, TypeError, ValueError) as error:
        print(f"qapaq-alert-mail: failed ({type(error).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
