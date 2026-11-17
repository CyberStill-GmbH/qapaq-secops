"""Análisis de cabeceras: autenticación, ruta de entrega y huellas de plataforma.

Cubre las cabeceras que agregan Microsoft 365 / Exchange Online / Outlook.com,
Gmail / Google Workspace y pasarelas de seguridad habituales.
"""
from __future__ import annotations

import re
from email.utils import parsedate_to_datetime

from cintel.util import is_public_ip

# --------------------------------------------------------------------------
# Authentication-Results (RFC 8601)
# --------------------------------------------------------------------------

AUTH_METHODS = ("spf", "dkim", "dmarc", "compauth", "arc", "bimi", "iprev", "auth", "smime", "dkim-atps")


def _split_top_level(value: str, sep: str = ";") -> list:
    """Divide por `sep` ignorando lo que esté entre paréntesis (comentarios RFC)."""
    parts, depth, current = [], 0, []
    for ch in value:
        if ch == "(":
            depth += 1
        elif ch == ")" and depth:
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def parse_auth_results(value: str) -> dict:
    """Interpreta un Authentication-Results en servidor + lista de métodos."""
    value = re.sub(r"\s+", " ", value or "").strip()
    segments = _split_top_level(value)
    server = ""
    methods = []
    method_re = re.compile(r"(?<![\w.-])(" + "|".join(re.escape(x) for x in AUTH_METHODS) +
                           r")\s*=\s*([a-z]+)\b(.*)$", re.I)
    expecting_server = True
    for seg in segments:
        if re.match(r"^i=\d+$", seg):
            continue  # Instancia ARC (i=1), no es un método.
        if expecting_server:
            # El primer segmento es el authserv-id (p. ej. "mx.google.com"); Microsoft lo omite
            # y comienza directamente con "spf=...".
            expecting_server = False
            first = seg.split()[0]
            if "=" not in first:
                server = first
                seg = seg[len(first):].strip()
                if not seg:
                    continue
        m = method_re.search(seg)
        if not m:
            continue
        method, result, rest = m.group(1).lower(), m.group(2).lower(), m.group(3)
        comments = re.findall(r"\(([^)]*)\)", rest)
        props = {}
        for key, val in re.findall(r"\b([a-z]+(?:\.[a-z-]+)?)\s*=\s*([^\s;()]+)", re.sub(r"\([^)]*\)", " ", rest), re.I):
            props[key.lower()] = val.strip('"')
        entry = {"metodo": method, "resultado": result, "propiedades": props}
        if comments:
            entry["comentario"] = "; ".join(c.strip() for c in comments)
        # Política DMARC publicada que informa Google: (p=REJECT sp=REJECT dis=NONE)
        if method == "dmarc" and comments:
            pol = re.search(r"\bp=(\w+)", comments[0], re.I)
            dis = re.search(r"\bdis=(\w+)", comments[0], re.I)
            if pol:
                entry["politica"] = pol.group(1).lower()
            if dis:
                entry["disposicion"] = dis.group(1).lower()
        methods.append(entry)
    return {"servidor": server, "metodos": methods}


def summarize_auth(auth_list: list) -> dict:
    """Resultado por método tomando la cabecera más reciente (la superior = receptor final)."""
    summary = {}
    for header in auth_list:
        for method in header["metodos"]:
            summary.setdefault(method["metodo"], method)
    return summary


# Códigos compauth reason de Microsoft (primer dígito).
COMPAUTH_REASONS = {
    "0": "Falla explícita: el mensaje no superó la autenticación compuesta",
    "1": "Aprobado (pass)",
    "2": "Aprobado parcialmente (softpass)",
    "3": "No verificado",
    "4": "Omitido / bypass por regla o configuración",
    "6": "Suplantación intraorganizacional (falla)",
    "7": "Aprobado por ARC o remitente de confianza",
    "9": "Omitido: dominio aceptado sin MX hacia Microsoft",
}


def compauth_reason_text(code: str) -> str:
    code = (code or "").strip()
    if code == "001":
        return "Falla implícita: el dominio del remitente no publica DMARC y la autenticación no alineó"
    if code == "000":
        return "Falla explícita: DMARC del dominio remitente falló con política reject/quarantine"
    if code == "002":
        return "La organización bloqueó explícitamente el par remitente/dominio"
    if code == "010":
        return "DMARC falló con política reject/quarantine del dominio remitente"
    return COMPAUTH_REASONS.get(code[:1], "Código no documentado") if code else ""


# --------------------------------------------------------------------------
# Cabeceras de Microsoft 365 / Exchange Online / Outlook.com
# --------------------------------------------------------------------------

FOREFRONT_KEYS = ("CIP", "CTRY", "LANG", "SCL", "SRV", "IPV", "SFV", "PTR", "CAT", "SFTY", "SFS", "DIR", "H", "PCL")

SFV_TEXT = {
    "BLK": "Bloqueado: remitente o dominio en lista de bloqueo del usuario",
    "NSPM": "Filtro de spam lo marcó como NO spam",
    "SFE": "Omitido: remitente en lista de remitentes seguros del usuario",
    "SKA": "Omitido: remitente permitido en la política antispam",
    "SKB": "Marcado como spam por lista de bloqueo de la política",
    "SKI": "Omitido: mensaje interno del mismo tenant",
    "SKN": "Omitido: clasificado como no spam por regla de flujo de correo",
    "SKQ": "Liberado desde cuarentena",
    "SKS": "Marcado como spam antes del filtro (regla de flujo)",
    "SPM": "Marcado como SPAM por el filtro de contenido",
}

CAT_TEXT = {
    "AMP": "Antimalware", "BIMP": "Suplantación de marca (brand impersonation)", "BULK": "Correo masivo",
    "DIMP": "Suplantación de dominio", "FTBP": "Filtro de tipo de adjunto", "GIMP": "Suplantación por inteligencia de buzón",
    "HPHSH": "Phishing de alta confianza", "HPHISH": "Phishing de alta confianza", "HSPM": "Spam de alta confianza",
    "INTOS": "Intra-organización", "MALW": "Malware", "OSPM": "Spam saliente", "PHSH": "Phishing",
    "SAP": "Adjuntos seguros (Safe Attachments)", "SPM": "Spam", "SPOOF": "Suplantación (spoofing)",
    "UIMP": "Suplantación de usuario", "NONE": "Sin categoría de amenaza",
}

SFTY_TEXT = {
    "9.1": "Clasificado como phishing (URL o contenido de phishing)",
    "9.11": "Suplantación intraorganizacional o propia (self-to-self)",
    "9.19": "Suplantación de dominio protegido (domain impersonation)",
    "9.20": "Suplantación de usuario protegido (user impersonation)",
    "9.25": "Consejo de seguridad de primer contacto (remitente nuevo)",
}


def parse_forefront(value: str) -> dict:
    fields = {}
    for token in (value or "").split(";"):
        if ":" in token:
            key, val = token.strip().split(":", 1)
            if key.strip().upper() in FOREFRONT_KEYS:
                fields[key.strip().upper()] = val.strip()
    return fields


DELIVERY_DEST = {"I": "Bandeja de entrada", "J": "Correo no deseado", "C": "Carpeta personalizada (regla del usuario)",
                 "Q": "Cuarentena"}


def parse_mailbox_delivery(value: str) -> dict | None:
    """X-Microsoft-Antispam-Mailbox-Delivery: carpeta final (dest) y motivo (OFR) en el buzón."""
    if not value:
        return None
    tags = {}
    for token in value.split(";"):
        if ":" in token:
            key, val = token.strip().split(":", 1)
            tags[key.strip().lower()] = val.strip()
    dest = tags.get("dest", "").upper()
    return {"destino": DELIVERY_DEST.get(dest, dest or None), "codigo_destino": dest or None,
            "motivo": tags.get("ofr"), "regla_usuario": tags.get("ucf") == "1", "cruda": value[:300]}


def microsoft_details(msg) -> dict:
    """Extrae y traduce las cabeceras de veredicto de Microsoft."""
    ff_values = [str(v) for v in msg.get_all("X-Forefront-Antispam-Report", [])]
    forefront = [parse_forefront(v) for v in ff_values]
    antispam = " ".join(str(v) for v in msg.get_all("X-Microsoft-Antispam", []))
    bcl = re.search(r"\bBCL:(\d+)", antispam)
    details = {
        "forefront": forefront,
        "bcl": int(bcl.group(1)) if bcl else None,
        "scl_organizacion": str(msg.get("X-MS-Exchange-Organization-SCL", "") or "") or None,
        "autenticado_como": str(msg.get("X-MS-Exchange-Organization-AuthAs", "") or "") or None,
        "direccion": str(msg.get("X-MS-Exchange-Organization-MessageDirectionality", "") or "") or None,
        "tenant_id": str(msg.get("X-MS-Exchange-CrossTenant-Id", "") or "") or None,
        "network_message_id": str(msg.get("X-MS-Exchange-Organization-Network-Message-Id", "") or
                                  msg.get("X-MS-Exchange-CrossTenant-Network-Message-Id", "") or "") or None,
        "llegada_original": str(msg.get("X-MS-Exchange-CrossTenant-OriginalArrivalTime", "") or "") or None,
        "tiene_adjuntos": str(msg.get("X-MS-Has-Attach", "") or "") or None,
        "entrega_buzon": parse_mailbox_delivery(str(msg.get("X-Microsoft-Antispam-Mailbox-Delivery", "") or "")),
        "regla_transporte": bool(msg.get("X-MS-Exchange-Transport-Rules-Loop") or msg.get("X-MS-Exchange-Organization-Rules-Execution-History")),
        "interpretacion": [],
    }
    for ff in forefront:
        if ff.get("SFV"):
            details["interpretacion"].append(f"SFV={ff['SFV']}: {SFV_TEXT.get(ff['SFV'].upper(), 'valor no documentado')}")
        if ff.get("CAT"):
            details["interpretacion"].append(f"CAT={ff['CAT']}: {CAT_TEXT.get(ff['CAT'].upper(), 'categoría no documentada')}")
        if ff.get("SFTY"):
            details["interpretacion"].append(f"SFTY={ff['SFTY']}: {SFTY_TEXT.get(ff['SFTY'], 'consejo de seguridad aplicado')}")
        if ff.get("SCL"):
            details["interpretacion"].append(f"SCL={ff['SCL']}: {scl_text(ff['SCL'])}")
        if ff.get("CTRY"):
            details["interpretacion"].append(f"CTRY={ff['CTRY']}: país de la IP que se conectó a Microsoft 365")
    if details["bcl"] is not None:
        details["interpretacion"].append(f"BCL={details['bcl']}: nivel de correo masivo (0 = no masivo, 9 = muy masivo)")
    return details


def scl_text(value: str) -> str:
    try:
        scl = int(value)
    except (TypeError, ValueError):
        return "valor no numérico"
    if scl == -1:
        return "Omitió el filtro de spam (remitente/regla de confianza)"
    if scl <= 1:
        return "No es spam"
    if scl <= 6:
        return "Spam"
    return "Spam de alta confianza"


def google_details(msg) -> dict:
    """Cabeceras propias de Gmail / Google Workspace."""
    keys = ("X-Gm-Message-State", "X-Google-Smtp-Source", "X-Received", "X-Gm-Spam",
            "X-Gm-Phishy", "X-Google-DKIM-Signature", "X-Gm-Gg", "X-Google-Id")
    found = {k: str(msg.get(k)) for k in keys if msg.get(k) is not None}
    return {
        "cabeceras": found,
        "spam": found.get("X-Gm-Spam"),
        "phishy": found.get("X-Gm-Phishy"),
        "enviado_desde_gmail": "X-Google-Smtp-Source" in found or "X-Gm-Message-State" in found,
    }


def generic_antispam(msg) -> dict:
    """SpamAssassin, Proofpoint, Mimecast, Barracuda y similares."""
    keys = ("X-Spam-Status", "X-Spam-Flag", "X-Spam-Score", "X-Spam-Level", "X-Proofpoint-Spam-Details",
            "X-Proofpoint-Virus-Version", "X-Mimecast-Spam-Score", "X-Mimecast-Spam-Signature",
            "X-Barracuda-Spam-Score", "X-Barracuda-Spam-Status", "X-IronPort-Anti-Spam-Result",
            "X-Virus-Scanned", "X-Spam-Report")
    return {k: str(msg.get(k))[:500] for k in keys if msg.get(k) is not None}


# --------------------------------------------------------------------------
# Huellas de plataforma (quién recibió y quién envió)
# --------------------------------------------------------------------------

RECEIVER_FINGERPRINTS = (
    ("Microsoft 365 / Exchange Online", ("x-ms-exchange-crosstenant-id", "x-forefront-antispam-report",
                                         "x-ms-exchange-organization-authas")),
    ("Gmail / Google Workspace", ("x-gm-message-state", "x-received", "x-google-smtp-source")),
    ("Proofpoint", ("x-proofpoint-virus-version", "x-proofpoint-spam-details")),
    ("Mimecast", ("x-mimecast-spam-score", "x-mimecast-spam-signature", "x-mimecast-impersonation-protect")),
    ("Barracuda", ("x-barracuda-spam-score", "x-barracuda-connect")),
    ("Cisco IronPort / Secure Email", ("x-ironport-anti-spam-result", "x-ironport-av")),
    ("Yahoo / AOL", ("x-ymail-osg", "x-sonic-mf")),
    ("SpamAssassin", ("x-spam-status",)),
)

SENDER_FINGERPRINTS = (
    ("Gmail / Google Workspace", ("x-google-smtp-source", "x-gm-message-state")),
    ("Microsoft 365 / Outlook.com", ("x-ms-exchange-crosstenant-authsource", "x-ms-traffictypediagnostic")),
    ("Amazon SES", ("x-ses-outgoing", "feedback-id:.*amazonses")),
    ("SendGrid", ("x-sg-eid", "x-sg-id")),
    ("Mailgun", ("x-mailgun-sid", "x-mailgun-variables")),
    ("Mailchimp / Mandrill", ("x-mc-user", "x-mandrill-user")),
    ("Brevo (Sendinblue)", ("x-sib-id", "x-mailin-eid")),
    ("Zoho Mail", ("x-zohomail", "x-zoho-virus-status")),
    ("PHPMailer (script web, frecuente en phishing)", ("x-mailer:.*phpmailer",)),
    ("Script PHP en servidor web", ("x-php-originating-script", "x-php-script")),
)


def fingerprint(msg) -> dict:
    keys = {k.lower() for k in msg.keys()}
    flat = {k.lower(): str(v).lower() for k, v in msg.items()}

    def match(signatures):
        hits = []
        for name, markers in signatures:
            for marker in markers:
                if ":" in marker:
                    key, pattern = marker.split(":", 1)
                    if key in flat and re.search(pattern, flat[key]):
                        hits.append(name)
                        break
                elif marker in keys:
                    hits.append(name)
                    break
        return hits

    receivers = match(RECEIVER_FINGERPRINTS)
    # Outlook.com (consumo) se distingue de M365 por los servidores receptores.
    received_text = " ".join(str(v).lower() for v in msg.get_all("Received", []))
    if receivers and receivers[0].startswith("Microsoft") and re.search(r"outlook\.com|hotmail\.com", received_text) \
            and "x-ms-exchange-organization-authas" not in keys and "x-ms-exchange-crosstenant-id" not in keys:
        receivers[0] = "Outlook.com / Hotmail"
    if "mx.google.com" in received_text and "Gmail / Google Workspace" not in receivers:
        receivers.append("Gmail / Google Workspace")
    mailer = str(msg.get("X-Mailer", "") or msg.get("User-Agent", "") or "")
    return {"receptor": receivers, "emisor": match(SENDER_FINGERPRINTS), "cliente_correo": mailer or None}


# --------------------------------------------------------------------------
# Received: reconstrucción de la ruta de entrega
# --------------------------------------------------------------------------

IP_RE = re.compile(r"\[?((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})\]?", re.I)


def parse_received(value: str) -> dict:
    value = re.sub(r"\s+", " ", value or "").strip()
    head, _, date_part = value.rpartition(";")
    if not head:
        head, date_part = value, ""
    hop = {"cruda": value[:600]}
    m = re.search(r"\bfrom\s+(\S+)", head, re.I)
    hop["desde"] = m.group(1) if m else None
    m = re.search(r"\bby\s+(\S+)", head, re.I)
    hop["por"] = m.group(1) if m else None
    m = re.search(r"\bwith\s+(\S+)", head, re.I)
    hop["protocolo"] = m.group(1) if m else None
    # IP del equipo que se conectó: normalmente entre corchetes en la cláusula from.
    from_clause = re.split(r"\bby\b", head, maxsplit=1, flags=re.I)[0]
    ips = [ip for ip in re.findall(r"\[([0-9a-fA-F.:]+)\]", from_clause)]
    if not ips:
        ips = [ip for ip in IP_RE.findall(from_clause) if "." in ip or ip.count(":") >= 2]
    hop["ip"] = next((ip for ip in ips if is_public_ip(ip)), ips[0] if ips else None)
    m = re.search(r"\(([^()]*\b(?:helo|ehlo)\s*=\s*[^()]*)\)", head, re.I)
    hop["helo"] = m.group(1) if m else None
    try:
        hop["fecha"] = parsedate_to_datetime(date_part.strip()) if date_part.strip() else None
    except (TypeError, ValueError, IndexError):
        hop["fecha"] = None
    return hop


def delivery_path(msg) -> dict:
    """Saltos en orden cronológico (el primero es el más cercano al origen)."""
    hops = [parse_received(str(v)) for v in msg.get_all("Received", [])]
    hops.reverse()
    anomalies = []
    previous = None
    for index, hop in enumerate(hops, 1):
        hop["indice"] = index
        hop["retraso_s"] = None
        if hop["fecha"] and previous is not None:
            try:
                delta = (hop["fecha"] - previous).total_seconds()
                hop["retraso_s"] = int(delta)
                if delta < -300:
                    anomalies.append(f"Salto {index}: fecha anterior al salto previo ({int(delta)} s); posible cabecera falsificada o reloj desfasado")
                elif delta > 6 * 3600:
                    anomalies.append(f"Salto {index}: retraso de {int(delta / 3600)} h respecto al salto anterior")
            except TypeError:
                pass  # Fechas con y sin zona horaria: no comparables.
        if hop["fecha"]:
            previous = hop["fecha"]
    origin_ip = None
    for hop in hops:
        if hop["ip"] and is_public_ip(hop["ip"]):
            origin_ip = hop["ip"]
            break
    for hop in hops:
        hop["fecha"] = hop["fecha"].isoformat() if hop["fecha"] else None
    return {"saltos": hops, "ip_origen": origin_ip, "anomalias": anomalies}


def dkim_signatures(msg) -> list:
    sigs = []
    for value in msg.get_all("DKIM-Signature", []):
        tags = {}
        for part in re.sub(r"\s+", "", str(value)).split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                tags[k.lower()] = v
        sigs.append({"d": tags.get("d", "").lower(), "s": tags.get("s", ""), "a": tags.get("a", ""),
                     "i": tags.get("i", "")})
    return sigs

