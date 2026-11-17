"""Análisis integral de un mensaje de correo (evidencia ya cargada).

Reúne cabeceras, autenticación, ruta de entrega, plataformas, contenido,
URLs, adjuntos, códigos QR y mensajes reenviados como adjunto.
"""
from __future__ import annotations

import email
import email.errors
from email import policy
from email.utils import parsedate_to_datetime

from cintel import advanced, content, headers, qr, urls
from cintel import attachments as att
from cintel.util import address_of, display_name_of, domain_of, hashes, to_unicode_domain

HEADER_FIELDS = ("from", "sender", "reply-to", "return-path", "to", "cc", "delivered-to", "subject", "date",
                 "message-id", "in-reply-to", "references", "x-mailer", "user-agent", "x-originating-ip",
                 "list-unsubscribe", "organization", "x-priority", "importance", "thread-topic")
MAX_URLS = 300
MAX_DEPTH = 3


def _party(value: str) -> dict:
    dom = domain_of(value)
    return {"cabecera": value or None, "direccion": address_of(value) or None,
            "nombre_visible": display_name_of(value) or None, "dominio": dom or None,
            "dominio_unicode": to_unicode_domain(dom) if dom else None}


def _safe_header(msg, key) -> str:
    try:
        value = msg.get(key)
        return str(value) if value is not None else ""
    except Exception:  # noqa: BLE001 - cabeceras malformadas a propósito
        return ""


def _part_payload(part) -> bytes:
    try:
        return part.get_payload(decode=True) or b""
    except Exception:  # noqa: BLE001
        return b""


def _part_text(part) -> str:
    try:
        text = part.get_content()
        return text if isinstance(text, str) else ""
    except Exception:  # noqa: BLE001 - charset inválido: decodificación tolerante
        return _part_payload(part).decode("utf-8", "replace")


def _walk(part):
    """Como Message.walk(), pero sin descender dentro de mensajes adjuntos (message/rfc822),
    que se analizan por separado como mensajes anidados."""
    yield part
    if part.get_content_type() == "message/rfc822":
        return
    if part.is_multipart():
        for sub in part.get_payload() or []:
            if hasattr(sub, "get_content_type"):
                yield from _walk(sub)


def analyze_message(msg, cfg, raw: bytes | None = None, source: str = "", kind: str = "eml",
                    headers_only: bool = False, depth: int = 0) -> dict:
    hdrs = {key: _safe_header(msg, key) for key in HEADER_FIELDS}
    auth_raw = [str(v) for v in msg.get_all("Authentication-Results", [])]
    arc_raw = [str(v) for v in msg.get_all("ARC-Authentication-Results", [])]
    auth = [dict(parse, origen="Authentication-Results") for parse in map(headers.parse_auth_results, auth_raw)]
    arc = [dict(parse, origen="ARC-Authentication-Results") for parse in map(headers.parse_auth_results, arc_raw)]
    try:
        date_value = parsedate_to_datetime(hdrs["date"]).isoformat() if hdrs["date"] else None
    except (TypeError, ValueError, IndexError):
        date_value = None

    result = {
        "fuente": source, "tipo_fuente": kind, "solo_cabeceras": headers_only,
        "tamano_bytes": len(raw) if raw is not None else None,
        "hashes": hashes(raw) if raw is not None else None,
        "cabeceras": hdrs, "fecha_iso": date_value,
        "remitente": _party(hdrs["from"]), "sender": _party(hdrs["sender"]) if hdrs["sender"] else None,
        "reply_to": _party(hdrs["reply-to"]) if hdrs["reply-to"] else None,
        "return_path": _party(hdrs["return-path"]) if hdrs["return-path"] else None,
        "autenticacion": auth, "arc": arc,
        "autenticacion_resumen": headers.summarize_auth(auth or arc),
        "received_spf": [str(v)[:400] for v in msg.get_all("Received-SPF", [])],
        "dkim_firmas": headers.dkim_signatures(msg),
        "ruta": headers.delivery_path(msg),
        "plataforma": headers.fingerprint(msg),
        "microsoft": headers.microsoft_details(msg),
        "google": headers.google_details(msg),
        "antispam_otros": headers.generic_antispam(msg),
        "total_cabeceras": len(msg.keys()),
        "cuerpo": {"texto_plano": False, "html": False, "extracto": "", "palabras_clave": {}, "trucos_html": [],
                   "formularios": [], "scripts": 0, "recursos_externos": [], "meta_refresh": []},
        "urls": [], "urls_truncadas": False, "adjuntos": [], "qr": [], "qr_disponible": qr.QR_AVAILABLE,
        "mensajes_adjuntos": [], "avanzado": [],
    }
    compauth = result["autenticacion_resumen"].get("compauth")
    if compauth and compauth.get("propiedades", {}).get("reason"):
        compauth["razon_texto"] = headers.compauth_reason_text(compauth["propiedades"]["reason"])

    if headers_only:
        result["cuerpo"]["palabras_clave"] = content.keyword_hits(hdrs["subject"])
        result["avanzado"] = advanced.analyze(result, cfg, hdrs["subject"], [], [], [])
        return result

    url_entries = {}  # url -> entrada analizada (evita duplicados)

    def register(url, text, origin):
        if len(url_entries) >= MAX_URLS:
            result["urls_truncadas"] = True
            return
        key = url.strip()
        if key in url_entries:
            # Conservar el texto visible si la primera aparición no lo tenía.
            if text and not url_entries[key].get("texto_visible"):
                url_entries[key] = urls.analyze_url(key, text, cfg, origin) or url_entries[key]
            return
        entry = urls.analyze_url(key, text, cfg, origin)
        if entry:
            url_entries[key] = entry

    body_texts = []
    html_parts = []
    raw_hrefs = []        # Todos los href (también search-ms:, file:, \servidor) para técnicas avanzadas
    attachment_html = []  # HTML de adjuntos (CAPTCHA, kits AiTM)
    calendar_texts = []   # Invitaciones de calendario (.ics)
    for part in _walk(msg):
        ctype = part.get_content_type()
        disposition = (part.get_content_disposition() or "").lower()
        filename = part.get_filename()
        # Mensajes reenviados como adjunto (lo más común cuando un usuario reporta phishing).
        if ctype == "message/rfc822" and part is not msg and depth < MAX_DEPTH:
            inner = part.get_payload()
            inner_msg = inner[0] if isinstance(inner, list) and inner else None
            if inner_msg is not None:
                inner_bytes = inner_msg.as_bytes(policy=policy.default.clone(linesep="\r\n"))
                nested = analyze_message(inner_msg, cfg, inner_bytes, f"{source} > adjunto {filename or 'mensaje'}",
                                         "mensaje adjunto (rfc822)", False, depth + 1)
                result["mensajes_adjuntos"].append(nested)
            continue
        if part.is_multipart():
            continue
        if filename or disposition == "attachment":
            data = _part_payload(part)
            name = filename or "(sin nombre)"
            # Adjuntos .eml/.msg dentro del correo: se analizan como mensajes anidados.
            if depth < MAX_DEPTH and (name.lower().endswith((".eml", ".msg")) or ctype == "application/vnd.ms-outlook"):
                nested = _nested_from_bytes(data, name, cfg, source, depth)
                if nested:
                    result["mensajes_adjuntos"].append(nested)
            if ctype == "text/calendar" or name.lower().endswith(".ics"):
                calendar_texts.append(data[:500_000].decode("utf-8", "replace"))
            info = att.analyze_attachment(name, ctype, data)
            html_text = info.pop("html_texto", None)
            if html_text:
                attachment_html.append(html_text)
                scanner = urls.scan_html(html_text)
                raw_hrefs += [a["href"] for a in scanner.anchors]
                for a in scanner.anchors:
                    if a["href"].lower().startswith(("http", "hxxp")):
                        register(a["href"], a["texto"], f"adjunto {name}")
                for f in scanner.forms:
                    if f["action"].lower().startswith("http"):
                        register(f["action"], None, f"formulario en adjunto {name}")
                for u in urls.extract_text_urls(html_text):
                    register(u, None, f"adjunto {name}")
            for u in info.get("urls_pdf", []):
                register(u, None, f"PDF {name}")
            if ctype in qr.IMAGE_TYPES or (info.get("tipo_real") in ("PNG", "JPEG", "GIF")):
                for code in qr.decode_qr(data):
                    result["qr"].append({"origen": f"adjunto {name}", "contenido": code})
                    if code.lower().startswith(("http://", "https://")):
                        register(code, None, f"QR en {name}")
            result["adjuntos"].append(info)
            continue
        if ctype in qr.IMAGE_TYPES:
            # Imágenes en línea (cid:) pueden contener QR maliciosos.
            for code in qr.decode_qr(_part_payload(part)):
                result["qr"].append({"origen": "imagen en el cuerpo", "contenido": code})
                if code.lower().startswith(("http://", "https://")):
                    register(code, None, "QR en el cuerpo")
            continue
        if ctype == "text/calendar":
            calendar_texts.append(_part_text(part))
            continue
        if ctype == "text/plain":
            text = _part_text(part)
            result["cuerpo"]["texto_plano"] = True
            body_texts.append(text)
            for u in urls.extract_text_urls(text):
                register(u, None, "cuerpo (texto)")
        elif ctype == "text/html":
            html = _part_text(part)
            result["cuerpo"]["html"] = True
            html_parts.append(html)

    for html in html_parts:
        scanner = urls.scan_html(html)
        body_texts.append(scanner.text)
        raw_hrefs += [a["href"] for a in scanner.anchors]
        for a in scanner.anchors:
            href = a["href"]
            if href.lower().startswith(("http", "hxxp", "//")):
                register(href if not href.startswith("//") else "https:" + href, a["texto"], "cuerpo (enlace HTML)")
        for f in scanner.forms:
            result["cuerpo"]["formularios"].append(f)
            if f["action"].lower().startswith("http"):
                register(f["action"], None, "formulario en el cuerpo")
        for src in scanner.sources:
            if src["src"].lower().startswith("http"):
                result["cuerpo"]["recursos_externos"].append(src)
        result["cuerpo"]["scripts"] += scanner.scripts
        result["cuerpo"]["meta_refresh"] += scanner.meta_refresh
        result["cuerpo"]["trucos_html"] += content.hidden_text_tricks(html)
        for u in urls.extract_text_urls(scanner.text):
            register(u, None, "cuerpo (texto HTML)")

    full_text = hdrs["subject"] + "\n" + "\n".join(body_texts)
    result["cuerpo"]["palabras_clave"] = content.keyword_hits(full_text)
    result["cuerpo"]["extracto"] = " ".join(" ".join(body_texts).split())[:1500]
    result["cuerpo"]["trucos_html"] = sorted(set(result["cuerpo"]["trucos_html"]))
    result["cuerpo"]["recursos_externos"] = result["cuerpo"]["recursos_externos"][:30]
    entries = list(url_entries.values())
    entries.sort(key=lambda e: urls.LEVEL_ORDER.get(urls.url_risk(e), 9))
    for entry in entries:
        entry["riesgo"] = urls.url_risk(entry)
    for cal in calendar_texts:
        # Las líneas largas del formato iCalendar se pliegan con salto + espacio; se despliegan antes de buscar URLs.
        unfolded = cal.replace("\r\n ", "").replace("\n ", "")
        for u in urls.extract_text_urls(unfolded):
            entry = urls.analyze_url(u, None, cfg, "invitación de calendario")
            if entry and u not in url_entries:
                entry["riesgo"] = urls.url_risk(entry)
                entries.append(entry)
    result["urls"] = entries
    # Técnicas de phishing sofisticadas (AiTM, OAuth, código de dispositivo, TOAD, hilos, etc.)
    result["avanzado"] = advanced.analyze(result, cfg, full_text, raw_hrefs, html_parts + attachment_html, calendar_texts)
    return result


def _nested_from_bytes(data: bytes, name: str, cfg, source: str, depth: int) -> dict | None:
    """Analiza un .eml o .msg que viene como adjunto."""
    from cintel.parsers import MSG_MAGIC, EvidenceError, parse_bytes, parse_msg_file

    try:
        if data.startswith(MSG_MAGIC):
            import tempfile
            from pathlib import Path

            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "adjunto.msg"
                path.write_bytes(data)
                inner = parse_msg_file(path)
            only = False
        else:
            inner, only = parse_bytes(data)
        return analyze_message(inner, cfg, data, f"{source} > adjunto {name}", "mensaje adjunto", only, depth + 1)
    except (EvidenceError, ValueError, TypeError, email.errors.MessageError):
        return None

