#!/usr/bin/env python3
"""Aplica la política QAPAQ del manager sobre un ossec.conf (docs/16-politicas.md). Idempotente.

Uso: render_ossec_policy.py <ossec.conf> <plantilla> [--check]

Cambios en su sitio (solo el primer bloque activo de cada sección):
  <global><email_notification>no       el correo lo envía el notificador QAPAQ (ADR-022)
  <alerts><log_alert_level>N           QAPAQ_LOG_ALERT_LEVEL (por defecto 3)
  <vulnerability-detection>            enabled=yes, index-status=yes, feed-update-interval
  <indexer><enabled>yes                exigido por la detección de vulnerabilidades
  <ruleset><list>etc/lists/qapaq-break-glass  lista que referencian las reglas QAPAQ de Office 365
  <ruleset><list>etc/lists/qapaq-internet-facing-projects  proyectos Snyk expuestos (detections/snyk, 101730-101731)
Bloque administrado QAPAQ:policy:begin/end (al final): Active Response opt-in y white_list.

Variables: QAPAQ_LOG_ALERT_LEVEL (3), QAPAQ_VD_FEED_INTERVAL (60m), QAPAQ_AR_AUTO_BLOCK (0|1),
           QAPAQ_AR_TIMEOUT (600, 60..86400), QAPAQ_AR_WHITELIST (IPs/CIDR separadas por coma).
--check: no escribe; sale 0 si el archivo ya cumple la política y 3 si no.
"""

import ipaddress
import os
import re
import sys

BEGIN = "<!-- QAPAQ:policy:begin"
END = "<!-- QAPAQ:policy:end -->"
QAPAQ_LISTS = ("etc/lists/qapaq-break-glass", "etc/lists/qapaq-internet-facing-projects")


def env_int(name, default, lo, hi):
    raw = os.environ.get(name, str(default)).strip()
    if not raw.isdigit() or not lo <= int(raw) <= hi:
        sys.exit(f"{name}={raw!r} fuera de rango [{lo}, {hi}]")
    return int(raw)


def strip_comments(text):
    """Mapa de posiciones activas: los comentarios XML no cuentan como configuración."""
    return re.sub(r"<!--.*?-->", lambda m: " " * len(m.group(0)), text, flags=re.S)


def first_block(text, tag):
    active = strip_comments(text)
    m = re.search(rf"<{tag}(\s[^>]*)?>(.*?)</{tag}>", active, flags=re.S)
    return (m.start(), m.end()) if m else None


def set_child(text, tag, child, value, create=True):
    span = first_block(text, tag)
    if span is None:
        return text, False
    start, end = span
    block = text[start:end]
    pat = re.compile(rf"<{child}>[^<]*</{child}>")
    m = pat.search(strip_comments(block))
    if m:
        new_block = f"{block[:m.start()]}<{child}>{value}</{child}>{block[m.end():]}"
    elif create:
        close = block.rfind(f"</{tag}>")
        new_block = f"{block[:close]}  <{child}>{value}</{child}>\n  {block[close:]}"
    else:
        return text, False
    return text[:start] + new_block + text[end:], True


def render_block(template):
    auto = os.environ.get("QAPAQ_AR_AUTO_BLOCK", "0").strip()
    if auto not in ("0", "1"):
        sys.exit("QAPAQ_AR_AUTO_BLOCK debe ser 0 o 1")
    timeout = env_int("QAPAQ_AR_TIMEOUT", 600, 60, 86400)
    entries = [e.strip() for e in os.environ.get("QAPAQ_AR_WHITELIST", "").split(",") if e.strip()]
    for e in entries:
        try:
            ipaddress.ip_network(e, strict=False)
        except ValueError:
            sys.exit(f"QAPAQ_AR_WHITELIST: {e!r} no es IP/CIDR")
    whitelist = ""
    if entries:
        whitelist = "  <global>\n" + "".join(f"    <white_list>{e}</white_list>\n" for e in entries) + "  </global>"
    begin = "  <!-- QAPAQ:ar-auto-block:enabled -->" if auto == "1" else "  <!-- QAPAQ:ar-auto-block:disabled (QAPAQ_AR_AUTO_BLOCK=0)"
    end = "" if auto == "1" else "  -->"
    out = (
        template.replace("${QAPAQ_AR_WHITELIST_BLOCK}", whitelist)
        .replace("${QAPAQ_AR_BLOCK_BEGIN}", begin)
        .replace("${QAPAQ_AR_BLOCK_END}", end)
        .replace("${QAPAQ_AR_TIMEOUT}", str(timeout))
    )
    if "${" in out:
        sys.exit("plantilla con variables sin sustituir")
    return out.strip() + "\n"


def apply(conf, template):
    level = env_int("QAPAQ_LOG_ALERT_LEVEL", 3, 1, 16)
    feed = os.environ.get("QAPAQ_VD_FEED_INTERVAL", "60m").strip()
    if not re.fullmatch(r"\d+[smhd]", feed):
        sys.exit("QAPAQ_VD_FEED_INTERVAL inválido (p. ej. 60m)")

    # Quitar el bloque administrado previo antes de razonar sobre el resto.
    b = conf.find(BEGIN)
    if b != -1:
        e = conf.find(END, b)
        if e == -1:
            sys.exit("bloque QAPAQ:policy sin marcador de cierre")
        conf = conf[:b].rstrip() + "\n" + conf[e + len(END):].lstrip("\n")

    conf, ok = set_child(conf, "global", "email_notification", "no")
    if not ok:
        sys.exit("ossec.conf sin <global> activo")
    conf, ok = set_child(conf, "alerts", "log_alert_level", str(level))
    if not ok:
        sys.exit("ossec.conf sin <alerts> activo")
    if first_block(conf, "indexer") is None:
        sys.exit("ossec.conf sin <indexer>: la detección de vulnerabilidades lo necesita (no se inventa)")
    conf, _ = set_child(conf, "indexer", "enabled", "yes")

    if first_block(conf, "vulnerability-detection") is None:
        idx = conf.rfind("</ossec_config>")
        conf = (conf[:idx] + "  <vulnerability-detection>\n    <enabled>yes</enabled>\n"
                "  </vulnerability-detection>\n\n" + conf[idx:])
    for child, value in (("enabled", "yes"), ("index-status", "yes"), ("feed-update-interval", feed)):
        conf, _ = set_child(conf, "vulnerability-detection", child, value)

    span = first_block(conf, "ruleset")
    if span is None:
        sys.exit("ossec.conf sin <ruleset> activo")
    for lst in QAPAQ_LISTS:
        if f"<list>{lst}</list>" not in strip_comments(conf[span[0]:span[1]]):
            close = conf.rfind("</ruleset>", span[0], span[1])
            conf = f"{conf[:close]}  <list>{lst}</list>\n  {conf[close:]}"
            span = first_block(conf, "ruleset")

    return conf.rstrip() + "\n\n" + render_block(template)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    path, tmpl_path = sys.argv[1], sys.argv[2]
    check = "--check" in sys.argv[3:]
    with open(path, encoding="utf-8") as f:
        original = f.read().replace("\r\n", "\n")
    with open(tmpl_path, encoding="utf-8") as f:
        template = f.read().replace("\r\n", "\n")
    result = apply(original, template)
    if check:
        sys.exit(0 if result == original else 3)
    if result != original:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(result)
        print("changed")
    else:
        print("unchanged")


if __name__ == "__main__":
    main()
