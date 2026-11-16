"""Inteligencia PASIVA de dominio: DNS, políticas de correo, proveedor, antigüedad y tenant.

No se envía tráfico SMTP, no se verifica la existencia de buzones y no se
recolectan datos personales. Las consultas externas son:
  - DNS a su resolver configurado (MX, NS, A, TXT/SPF, DMARC, DKIM, MTA-STS, TLS-RPT, BIMI, DNSSEC, PTR)
  - RDAP (registro público del dominio) para fecha de creación y registrador; si el TLD no
    ofrece RDAP (p. ej. .pe) se usa WHOIS (puerto 43) y solo se guardan registrador, fechas y estado
  - Endpoint público de descubrimiento OpenID de Microsoft para saber si el dominio tiene tenant M365
Todas se desactivan con --sin-red.
"""
from __future__ import annotations

import json
import re
import socket
import ssl
import urllib.error
import urllib.request
from datetime import datetime, timezone

from cintel import __version__

try:
    import dns.exception
    import dns.resolver
    import dns.reversename
    DNS_AVAILABLE = True
except ImportError:  # pragma: no cover - dnspython es dependencia obligatoria
    DNS_AVAILABLE = False

USER_AGENT = f"qapaq-cintel/{__version__} (analisis defensivo de phishing)"
HTTP_TIMEOUT = 8

# Selectores DKIM habituales por proveedor (se prueban si el correo no trae DKIM-Signature).
COMMON_DKIM_SELECTORS = ("selector1", "selector2", "google", "default", "dkim", "k1", "k2", "s1", "s2",
                         "mail", "smtp", "zoho", "mxvault", "everlytickey1", "mandrill", "pm", "protonmail")

MX_PROVIDERS = (
    (r"\.mail\.protection\.outlook\.com$", "Microsoft 365 / Exchange Online"),
    (r"olc\.protection\.outlook\.com$|hotmail\.com$", "Outlook.com / Hotmail"),
    (r"(aspmx\.l\.google\.com|googlemail\.com|smtp\.google\.com)$", "Google Workspace / Gmail"),
    (r"pphosted\.com$|ppe-hosted\.com$", "Proofpoint"),
    (r"mimecast\.com$|mimecast-offshore\.com$", "Mimecast"),
    (r"barracudanetworks\.com$|cudamail\.com$", "Barracuda"),
    (r"messagelabs\.com$", "Broadcom/Symantec Email Security"),
    (r"iphmx\.com$", "Cisco Secure Email (IronPort)"),
    (r"trendmicro\.com$|tmes\.trendmicro", "Trend Micro Email Security"),
    (r"sophos\.com$", "Sophos Email"),
    (r"forcepoint\.net$|mailcontrol\.com$", "Forcepoint"),
    (r"zoho\.(com|eu|in)$", "Zoho Mail"),
    (r"yahoodns\.net$", "Yahoo Mail"),
    (r"protonmail\.ch$", "Proton Mail"),
    (r"icloud\.com$", "iCloud Mail"),
    (r"secureserver\.net$", "GoDaddy (Microsoft 365 revendido o Workspace Email)"),
    (r"amazonaws\.com$|amazonses\.com$", "Amazon SES / WorkMail"),
    (r"mailgun\.org$", "Mailgun"),
    (r"emailsrvr\.com$", "Rackspace"),
    (r"hostinger\.(com|io)$|titan\.email$", "Hostinger / Titan"),
    (r"ovh\.net$", "OVH"),
    (r"hornetsecurity\.com$", "Hornetsecurity (pasarela de seguridad)"),
    (r"spamh\.com$|antispameurope\.com$", "Hornetsecurity / Antispam Europe"),
    (r"securence\.com$|everycloudtech\.com$", "Pasarela de seguridad de correo"),
)

SPF_PROVIDERS = (
    ("spf.protection.outlook.com", "Microsoft 365"), ("_spf.google.com", "Google Workspace"),
    ("sendgrid.net", "SendGrid"), ("mailgun.org", "Mailgun"), ("amazonses.com", "Amazon SES"),
    ("servers.mcsv.net", "Mailchimp"), ("spf.mandrillapp.com", "Mandrill"), ("zoho", "Zoho"),
    ("pphosted.com", "Proofpoint"), ("mimecast", "Mimecast"), ("salesforce.com", "Salesforce"),
    ("hubspot", "HubSpot"), ("sendinblue", "Brevo"), ("brevo", "Brevo"), ("mktomail.com", "Marketo"),
    ("zendesk.com", "Zendesk"), ("freshdesk", "Freshdesk"), ("secureserver.net", "GoDaddy"),
    ("hornetsecurity.com", "Hornetsecurity"),
)

FREE_MAIL = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.es", "live.com", "msn.com",
    "outlook.es", "yahoo.com", "yahoo.es", "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com",
    "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "yandex.com", "yandex.ru",
    "mail.ru", "zoho.com", "tutanota.com", "tuta.io", "hushmail.com", "fastmail.com", "inbox.com",
    "terra.com.pe", "qq.com", "163.com", "126.com",
}
DISPOSABLE_MAIL = {
    "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com", "10minutemail.com",
    "temp-mail.org", "tempmail.com", "yopmail.com", "trashmail.com", "getnada.com", "dispostable.com",
    "maildrop.cc", "mailnesia.com", "throwawaymail.com", "fakeinbox.com", "mohmal.com", "emailondeck.com",
    "tempail.com", "minuteinbox.com", "mintemail.com", "spamgourmet.com", "burnermail.io", "tmail.ws",
    "1secmail.com", "tempr.email", "discard.email", "moakt.com", "emailfake.com", "crazymailing.com",
}


def lookup(name: str, record: str, lifetime: float = 6.0) -> dict:
    if not DNS_AVAILABLE:
        return {"estado": "dependencia_faltante", "registros": [], "error": "Instale dnspython"}
    try:
        answer = dns.resolver.resolve(name, record, lifetime=lifetime)
        return {"estado": "ok", "registros": [str(r).strip() for r in answer]}
    except dns.resolver.NXDOMAIN:
        return {"estado": "nxdomain", "registros": []}
    except dns.resolver.NoAnswer:
        return {"estado": "sin_respuesta", "registros": []}
    except dns.resolver.NoNameservers as exc:
        return {"estado": "servfail", "registros": [], "error": str(exc)[:200]}
    except (dns.exception.DNSException, OSError) as exc:
        return {"estado": "error", "registros": [], "error": str(exc)[:200]}


def txt_values(result: dict) -> list:
    """Une los fragmentos TXT ("parte1" "parte2") que devuelve dnspython."""
    values = []
    for record in result.get("registros", []):
        pieces = re.findall(r'"((?:\\.|[^"\\])*)"', record)
        values.append("".join(pieces) if pieces else record)
    return values


def parse_tags(value: str) -> dict:
    tags = {}
    for kv in value.split(";"):
        if "=" in kv:
            k, v = kv.strip().split("=", 1)
            tags[k.lower().strip()] = v.strip()
    return tags


def analyze_spf(records: list) -> dict:
    info = {"registros": records, "multiples": len(records) > 1, "all": None, "includes": [],
            "consultas_estimadas": 0, "proveedores": []}
    if not records:
        return info
    spf = records[0]
    terms = spf.split()[1:]
    for term in terms:
        low = term.lower()
        if low.lstrip("+-~?") in ("all",):
            info["all"] = low if low[0] in "+-~?" else "+all"
        mech = low.lstrip("+-~?")
        if mech != "all" and re.match(r"^(include:|a\b|a:|a/|mx\b|mx:|mx/|ptr|exists:|redirect=)", mech):
            info["consultas_estimadas"] += 1
        if mech.startswith("include:"):
            info["includes"].append(mech.split(":", 1)[1])
        if mech.startswith("redirect="):
            info["includes"].append(mech.split("=", 1)[1])
    for marker, name in SPF_PROVIDERS:
        if marker in spf.lower() and name not in info["proveedores"]:
            info["proveedores"].append(name)
    return info


def mail_provider(mx_hosts: list) -> list:
    providers = []
    for host in mx_hosts:
        for pattern, name in MX_PROVIDERS:
            if re.search(pattern, host.lower()) and name not in providers:
                providers.append(name)
    return providers


def _http_json(url: str) -> dict | None:
    # Solo se consultan endpoints públicos fijos por HTTPS (RDAP y Microsoft); nunca URLs del correo.
    if not url.startswith("https://"):
        raise ValueError("Solo se permiten consultas HTTPS")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json, application/rdap+json"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT, context=ssl.create_default_context()) as resp:  # nosec B310
            return json.loads(resp.read(2_000_000).decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return {"_error_http": exc.code}
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def _whois_query(server: str, query: str) -> str:
    with socket.create_connection((server, 43), timeout=HTTP_TIMEOUT) as sock:
        sock.sendall((query + "\r\n").encode("idna" if not query.isascii() else "ascii"))
        chunks, total = [], 0
        while total < 200_000:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
    return b"".join(chunks).decode("utf-8", "replace")


def whois(domain: str) -> dict:
    """WHOIS (puerto 43) para TLD sin RDAP. No se guardan datos personales del titular."""
    tld = domain.rsplit(".", 1)[-1]
    try:
        iana = _whois_query("whois.iana.org", tld)
        m = re.search(r"^whois:\s*(\S+)", iana, re.M | re.I)
        if not m:
            return {"estado": "sin_whois"}
        text = _whois_query(m.group(1), domain)
    except (OSError, UnicodeError):
        return {"estado": "sin_conexion_whois"}

    def field(*names):
        for name in names:
            mm = re.search(r"^\s*" + re.escape(name) + r"\s*:\s*(.+)$", text, re.M | re.I)
            if mm and mm.group(1).strip():
                return mm.group(1).strip()
        return None

    if re.search(r"no match|not found|no entries found|no data found|\bfree\b|\bavailable\b", text[:600], re.I) and \
            not field("Domain Name", "domain"):
        return {"estado": "no_registrado", "fuente": "whois"}
    created = field("Creation Date", "Created", "created", "Registration Time", "Registered on", "Domain Create Date",
                    "Registration Date", "Fecha de registro", "Fecha de Creacion")
    return {"estado": "ok", "fuente": "whois", "creado": created,
            "expira": field("Registry Expiry Date", "Expiration Date", "Expiry Date", "paid-till", "Fecha de vencimiento"),
            "registrador": field("Registrar", "Sponsoring Registrar", "registrar"),
            "estados": [s.strip() for s in re.findall(r"^\s*(?:Domain )?Status\s*:\s*(\S+)", text, re.M | re.I)][:6],
            "antiguedad_dias": _age_days(created)}


def _age_days(created: str | None) -> int | None:
    if not created:
        return None
    value = created.strip().replace("Z", "+00:00")
    for candidate in (value, value[:10]):
        try:
            dt = datetime.fromisoformat(candidate)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return (datetime.now(timezone.utc) - dt).days
        except ValueError:
            continue
    return None


def rdap(domain: str) -> dict:
    """Fecha de creación, registrador y estado desde el registro público RDAP (o WHOIS de respaldo)."""
    data = _http_json(f"https://rdap.org/domain/{domain}")
    if data is None or "_error_http" in data:
        fallback = whois(domain)
        if fallback.get("estado") in ("ok", "no_registrado"):
            return fallback
        if data is None:
            return {"estado": "sin_conexion"}
        code = data["_error_http"]
        return {"estado": "no_encontrado" if code == 404 else f"http_{code}",
                "nota": "El registro de este TLD no ofrece RDAP ni WHOIS accesible." if code == 404 else None}
    events = {e.get("eventAction"): e.get("eventDate") for e in data.get("events", []) if isinstance(e, dict)}
    registrar = None
    for entity in data.get("entities", []) or []:
        if "registrar" in (entity.get("roles") or []):
            vcard = entity.get("vcardArray") or []
            if len(vcard) > 1:
                for item in vcard[1]:
                    if item and item[0] == "fn":
                        registrar = item[3]
            registrar = registrar or entity.get("handle")
    created = events.get("registration")
    age_days = _age_days(created)
    return {"estado": "ok", "fuente": "rdap", "creado": created, "expira": events.get("expiration"),
            "actualizado": events.get("last changed"), "antiguedad_dias": age_days,
            "registrador": registrar, "estados": data.get("status", []),
            "nameservers": [ns.get("ldhName") for ns in data.get("nameservers", []) if isinstance(ns, dict)][:8]}


def microsoft_tenant(domain: str) -> dict:
    """Indica si el dominio pertenece a un tenant de Microsoft 365 / Entra ID (endpoint público)."""
    data = _http_json(f"https://login.microsoftonline.com/{domain}/.well-known/openid-configuration")
    if data is None:
        return {"estado": "sin_conexion"}
    if "_error_http" in data or "error" in data:
        return {"estado": "sin_tenant"}
    issuer = data.get("issuer", "")
    m = re.search(r"/([0-9a-f-]{36})/", issuer)
    region = data.get("tenant_region_scope")
    return {"estado": "ok", "tenant_id": m.group(1) if m else None, "region": region}


def reverse_dns(ip: str) -> dict:
    if not DNS_AVAILABLE or not ip:
        return {"estado": "no_disponible", "registros": []}
    try:
        name = dns.reversename.from_address(ip)
    except (dns.exception.SyntaxError, ValueError):
        return {"estado": "ip_invalida", "registros": []}
    return lookup(str(name), "PTR")


def check_domain(domain: str, dkim_selectors: list | None = None, online: bool = True) -> dict:
    """Recolecta toda la información pasiva de un dominio."""
    domain = domain.lower().strip().rstrip(".")
    result = {"dominio": domain, "consultado_en": datetime.now(timezone.utc).isoformat(),
              "gratuito": domain in FREE_MAIL, "desechable": domain in DISPOSABLE_MAIL}
    if not online:
        result["nota"] = "Consultas de red desactivadas (--sin-red)"
        return result
    q = {
        "mx": lookup(domain, "MX"), "ns": lookup(domain, "NS"), "a": lookup(domain, "A"),
        "txt": lookup(domain, "TXT"), "dmarc": lookup("_dmarc." + domain, "TXT"),
        "mta_sts": lookup("_mta-sts." + domain, "TXT"), "tls_rpt": lookup("_smtp._tls." + domain, "TXT"),
        "bimi": lookup("default._bimi." + domain, "TXT"), "ds": lookup(domain, "DS"),
    }
    result["consultas"] = q
    result["existe"] = not all(v["estado"] == "nxdomain" for k, v in q.items() if k in ("mx", "ns", "a", "txt"))
    spf = [v for v in txt_values(q["txt"]) if v.lower().startswith("v=spf1")]
    result["spf"] = analyze_spf(spf)
    dmarc_records = [v for v in txt_values(q["dmarc"]) if v.lower().startswith("v=dmarc1")]
    # Si el subdominio no publica DMARC, aplica la política del dominio organizacional (sp=).
    from cintel.util import org_domain

    org = org_domain(domain)
    inherited = False
    if not dmarc_records and org != domain:
        parent = lookup("_dmarc." + org, "TXT")
        dmarc_records = [v for v in txt_values(parent) if v.lower().startswith("v=dmarc1")]
        inherited = bool(dmarc_records)
    tags = parse_tags(dmarc_records[0]) if dmarc_records else {}
    policy = tags.get("sp", tags.get("p")) if inherited else tags.get("p")
    result["dmarc"] = {"registros": dmarc_records, "heredado_de": org if inherited else None,
                       "p": (policy or "").lower() or None, "sp": tags.get("sp"), "pct": tags.get("pct"),
                       "adkim": tags.get("adkim"), "aspf": tags.get("aspf"), "rua": tags.get("rua"),
                       "ruf": tags.get("ruf"), "multiples": len(dmarc_records) > 1}
    mx_hosts = []
    null_mx = False
    for raw in q["mx"].get("registros", []):
        m = re.match(r"(\d+)\s+(\S+)", raw)
        if m:
            host = m.group(2).rstrip(".")
            if host == "" or m.group(2) == ".":
                null_mx = True
            else:
                mx_hosts.append(host)
    result["mx"] = mx_hosts
    result["mx_nulo"] = null_mx
    result["proveedor_correo"] = mail_provider(mx_hosts)
    result["mta_sts"] = bool([v for v in txt_values(q["mta_sts"]) if v.lower().startswith("v=stsv1")])
    result["tls_rpt"] = bool([v for v in txt_values(q["tls_rpt"]) if v.lower().startswith("v=tlsrptv1")])
    result["bimi"] = bool([v for v in txt_values(q["bimi"]) if v.lower().startswith("v=bimi1")])
    result["dnssec"] = "firmado (DS publicado)" if q["ds"]["estado"] == "ok" else "no firmado / sin DS"
    # DKIM: primero los selectores vistos en el correo; si no hay, los comunes.
    selectors = list(dict.fromkeys((dkim_selectors or []) + list(COMMON_DKIM_SELECTORS)))
    dkim_found = []
    for selector in selectors[:24]:
        res = lookup(f"{selector}._domainkey.{domain}", "TXT", lifetime=3.0)
        values = txt_values(res)
        if res["estado"] == "ok" and any("p=" in v for v in values):
            revoked = any(re.search(r"\bp=\s*(;|$)", v) for v in values)
            dkim_found.append({"selector": selector, "revocada": revoked})
        elif res["estado"] == "ok" and values:
            dkim_found.append({"selector": selector, "revocada": False, "nota": "registro sin p= (posible CNAME)"})
    result["dkim_selectores"] = dkim_found
    result["rdap"] = rdap(org)
    result["microsoft_tenant"] = microsoft_tenant(domain) if not result["gratuito"] else {"estado": "omitido"}
    return result

