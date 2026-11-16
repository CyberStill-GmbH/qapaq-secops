"""Detección de técnicas de phishing sofisticadas.

Cubre ataques que la autenticación (SPF/DKIM/DMARC) y los filtros clásicos
no detectan por sí solos:

- Kits AiTM (adversary-in-the-middle, p. ej. EvilProxy/Tycoon 2FA): enlaces
  personalizados con el correo de la víctima, páginas con CAPTCHA para evadir
  análisis automático y réplicas del inicio de sesión de Microsoft 365.
- Phishing de consentimiento OAuth (aplicaciones maliciosas con permisos).
- Phishing de código de dispositivo (device code).
- Callback phishing / TOAD (el atacante pide llamar a un teléfono).
- Secuestro de conversaciones y falsos hilos ("RE:" sin conversación previa).
- Invitaciones de calendario con enlaces.
- Protocolos que ejecutan código o filtran credenciales NTLM (search-ms:, ms-msdt:, UNC).
- Suplantación de marcas conocidas y mezcla de alfabetos para evadir filtros.
- Envíos masivos con destinatarios ocultos.
"""
from __future__ import annotations

import base64
import binascii
import re
from email.utils import getaddresses
from urllib.parse import parse_qs, unquote, urlsplit

from cintel.content import keyword_hits
from cintel.util import norm_text, org_domain, same_org

EMAIL_RE = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+")

# Marca -> (expresiones en el nombre visible/asunto, dominios legítimos)
BRANDS = {
    "Microsoft 365": (("microsoft", "office 365", "office365", "microsoft 365", "outlook", "onedrive", "sharepoint",
                       "microsoft teams", "exchange online"),
                      ("microsoft.com", "office.com", "office365.com", "outlook.com", "sharepoint.com", "onmicrosoft.com",
                       "live.com", "microsoftonline.com", "microsoft365.com", "hotmail.com")),
    "Google": (("google", "gmail", "google drive", "google workspace"), ("google.com", "gmail.com", "googlemail.com")),
    "DocuSign": (("docusign",), ("docusign.com", "docusign.net")),
    "Adobe": (("adobe", "acrobat sign"), ("adobe.com", "adobesign.com", "echosign.com")),
    "DHL": (("dhl",), ("dhl.com", "dhl.de")),
    "FedEx": (("fedex",), ("fedex.com",)),
    "SUNAT": (("sunat",), ("sunat.gob.pe",)),
    "SBS": (("superintendencia de banca", "sbs peru"), ("sbs.gob.pe",)),
    "RENIEC": (("reniec",), ("reniec.gob.pe",)),
    "BCP": (("bcp", "banco de credito"), ("viabcp.com", "bcp.com.pe")),
    "Interbank": (("interbank",), ("interbank.pe", "interbank.com.pe")),
    "BBVA": (("bbva",), ("bbva.pe", "bbva.com", "bbva.com.pe")),
    "Scotiabank": (("scotiabank",), ("scotiabank.com.pe", "scotiabank.com")),
    "Yape": (("yape",), ("yape.com.pe",)),
    "PayPal": (("paypal",), ("paypal.com",)),
    "Netflix": (("netflix",), ("netflix.com",)),
    "Amazon": (("amazon",), ("amazon.com", "amazon.es", "amazonses.com")),
    "Apple": (("apple", "icloud"), ("apple.com", "icloud.com")),
    "WhatsApp": (("whatsapp",), ("whatsapp.com", "facebook.com", "facebookmail.com")),
    "LinkedIn": (("linkedin",), ("linkedin.com",)),
    "Zoom": (("zoom",), ("zoom.us", "zoom.com")),
    "Dropbox": (("dropbox",), ("dropbox.com",)),
    "WeTransfer": (("wetransfer",), ("wetransfer.com",)),
}

DANGEROUS_SCHEMES = re.compile(r"^(search-ms|search|ms-msdt|ms-officecmd|ms-word|ms-excel|ms-powerpoint|ms-appinstaller|"
                               r"ms-cxh|ms-settings|ms-its|mk|file|smb|webdav|library-ms)\s*:", re.I)
UNC_RE = re.compile(r"^\\\\[\w.-]+\\", re.I)
DEVICE_CODE_URL = re.compile(r"(microsoft\.com/devicelogin|aka\.ms/devicelogin|login\.microsoftonline\.com/[^/\s]+/oauth2/deviceauth|"
                             r"google\.com/device)", re.I)
DEVICE_CODE = re.compile(r"\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,9}\b")
OAUTH_HOSTS = {"login.microsoftonline.com", "login.live.com", "login.windows.net", "accounts.google.com"}
RISKY_SCOPES = re.compile(r"offline_access|mail\.|files\.|contacts\.|user\.readwrite|directory\.|sites\.|full_access_as_user|"
                          r"mail\.google\.com|gmail\.|drive", re.I)
CAPTCHA_RE = re.compile(r"challenges\.cloudflare\.com|cf-turnstile|turnstile/v0|hcaptcha\.com|google\.com/recaptcha|"
                        r"recaptcha/api\.js", re.I)
M365_KIT_RE = re.compile(r"aadcdn\.msauth\.net|aadcdn\.msftauth\.net|logincdn\.msauth\.net|login\.microsoftonline\.com|"
                         r"ests/2\.1/content|converged_v2|appverify|cdn\.office\.net", re.I)
PHONE_RE = re.compile(r"(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3}[\s.-]\d{3,4}\b|\b\+?\d{9,12}\b")
CALL_WORDS = ("llame", "llamar", "llamenos", "comuniquese", "contactenos", "linea gratuita", "central telefonica",
              "call us", "call now", "contact our", "helpline", "toll free", "whatsapp", "telefono", "tel:")
TOAD_WORDS = ("suscripcion", "renovacion", "renovado", "cargo", "cobro", "debito", "factura", "pedido", "orden",
              "subscription", "renewal", "renewed", "charged", "order", "invoice", "refund", "cancelar", "cancel")
REPLY_PREFIX = re.compile(r"^\s*(re|rv|fw|fwd|res|enc|tr|aw|wg)\s*(\[\d+\])?\s*:", re.I)
CYRILLIC_GREEK = re.compile(r"[Ͱ-ϿЀ-ӿ]")
LATIN = re.compile(r"[a-zA-Z]")


def _finding(code, severity, title, detail):
    return {"codigo": code, "severidad": severity, "titulo": title, "detalle": detail}


def _recipients(m: dict) -> list:
    h = m["cabeceras"]
    values = [h.get("to") or "", h.get("cc") or "", h.get("delivered-to") or ""]
    return [addr.lower() for _, addr in getaddresses(values) if "@" in addr]


def _encodings(address: str) -> set:
    raw = address.encode()
    std = base64.b64encode(raw).decode()
    url = base64.urlsafe_b64encode(raw).decode()
    return {address, address.replace("@", "%40"), std, std.rstrip("="), url, url.rstrip("=")}


def _decoded_emails(url: str) -> list:
    """Correos ocultos en base64 dentro de la URL (típico de kits AiTM: #dmljdGltYUBlbXByZXNhLmNvbQ==)."""
    found = []
    for token in re.findall(r"[A-Za-z0-9+/_-]{16,}={0,2}", unquote(url)):
        padded = token + "=" * (-len(token) % 4)
        for decoder in (base64.b64decode, base64.urlsafe_b64decode):
            try:
                text = decoder(padded).decode("utf-8")
            except (binascii.Error, ValueError, UnicodeDecodeError):
                continue
            match = EMAIL_RE.search(text)
            if match:
                found.append(match.group(0))
                break
    return found


def _mixed_script_words(text: str) -> list:
    return [w for w in re.findall(r"\w+", text or "") if CYRILLIC_GREEK.search(w) and LATIN.search(w)]


def analyze(m: dict, cfg, full_text: str, raw_hrefs: list, html_texts: list, calendar_texts: list) -> list:
    findings = []
    h = m["cabeceras"]
    subject = h.get("subject") or ""
    from_dom = m["remitente"].get("dominio") or ""
    display = m["remitente"].get("nombre_visible") or ""
    own_sender = any(same_org(from_dom, p) for p in cfg.protected_domains)
    urls = [u["url_final"] for u in m.get("urls", [])] + [u["url"] for u in m.get("urls", [])]
    text_norm = norm_text(full_text)
    all_html = "\n".join(html_texts)

    # ---- Kit AiTM: el enlace lleva el correo de la víctima (texto plano, URL-encoded o base64)
    recipients = _recipients(m)
    for url in dict.fromkeys(urls):
        hit = next((r for r in recipients for enc in _encodings(r) if enc and enc in url), None)
        hidden = _decoded_emails(url)
        if hit or hidden:
            who = hit or hidden[0]
            findings.append(_finding(
                "AITM_ENLACE_PERSONALIZADO", "alto",
                "Enlace personalizado con el correo de la víctima (kit AiTM / phishing dirigido)",
                f"La URL hacia {urlsplit(url).hostname} incluye {who}"
                f"{' codificado en base64' if not hit else ''}: la página falsa precarga la cuenta para robar "
                "contraseña y sesión (token) incluso con MFA."))
            break

    # ---- CAPTCHA para evadir análisis y réplica del login de Microsoft
    if CAPTCHA_RE.search(all_html) or any(CAPTCHA_RE.search(u) for u in urls):
        findings.append(_finding(
            "CAPTCHA_EVASION", "alto", "Página protegida con CAPTCHA (Cloudflare Turnstile / hCaptcha / reCAPTCHA)",
            "Los kits de phishing usan CAPTCHA para que los escáneres automáticos (Safe Links, sandboxes) no vean la página real."))
    if M365_KIT_RE.search(all_html) and re.search(r"<form|fetch\(|xmlhttprequest|\$\.ajax|password", all_html, re.I):
        findings.append(_finding(
            "KIT_LOGIN_M365", "critico", "El HTML replica el inicio de sesión de Microsoft 365",
            "Carga recursos del login de Microsoft (aadcdn/msauth) y envía datos por formulario o JavaScript: kit de robo de credenciales."))

    # ---- OAuth consent phishing
    for url in dict.fromkeys(urls):
        try:
            parts = urlsplit(url)
        except ValueError:
            continue
        host = (parts.hostname or "").lower()
        if host in OAUTH_HOSTS and "oauth2" in parts.path.lower():
            query = {k.lower(): v for k, v in parse_qs(parts.query).items()}
            if "client_id" in query:
                scope = " ".join(query.get("scope", []))
                redirect = (query.get("redirect_uri") or [""])[0]
                redirect_host = (urlsplit(redirect).hostname or "-") if redirect else "-"
                severity = "alto" if RISKY_SCOPES.search(scope) or "consent" in parts.query.lower() else "medio"
                findings.append(_finding(
                    "OAUTH_CONSENTIMIENTO", severity, "Phishing de consentimiento OAuth (aplicación que pide permisos)",
                    f"client_id={query['client_id'][0][:60]}; permisos: {scope[:160] or '-'}; redirige a {redirect_host}. "
                    "Si el usuario acepta, la aplicación accede al buzón/archivos sin necesitar la contraseña."))
                break

    # ---- Device code phishing
    device_url = DEVICE_CODE_URL.search(full_text) or next((DEVICE_CODE_URL.search(u) for u in urls if DEVICE_CODE_URL.search(u)), None)
    if device_url:
        code = DEVICE_CODE.search(full_text)
        findings.append(_finding(
            "CODIGO_DISPOSITIVO", "critico" if code else "alto", "Phishing de código de dispositivo (device code)",
            f"Pide ingresar un código en {device_url.group(0)}{' (código ' + code.group(0) + ')' if code else ''}: "
            "al hacerlo, la víctima autoriza la sesión del atacante en su cuenta, saltando el MFA."))

    # ---- Callback phishing / TOAD
    phones = [p.strip() for p in PHONE_RE.findall(full_text) if sum(c.isdigit() for c in p) >= 9]
    if phones and any(w in text_norm for w in CALL_WORDS) and \
            (any(w in text_norm for w in TOAD_WORDS) or "financiero" in keyword_hits(full_text)) and len(m.get("urls", [])) <= 2:
        findings.append(_finding(
            "CALLBACK_TOAD", "alto", "Callback phishing (TOAD): pide llamar a un teléfono",
            f"Teléfono(s): {', '.join(dict.fromkeys(phones))[:120]}. Sin enlaces maliciosos para evadir filtros; en la "
            "llamada se induce a instalar software de acceso remoto o a entregar datos."))

    # ---- Hilos de conversación falsos o secuestrados
    in_reply = (h.get("in-reply-to") or "").strip()
    references = (h.get("references") or "").strip()
    is_report = bool(m.get("mensajes_adjuntos"))
    if REPLY_PREFIX.match(subject) and not in_reply and not references and not is_report and not own_sender:
        findings.append(_finding(
            "HILO_FALSO", "medio", "Asunto con 'RE:/RV:' sin conversación previa",
            f"'{subject[:100]}' simula responder a un correo anterior para generar confianza, pero no tiene In-Reply-To ni References."))
    if (in_reply or references) and not own_sender and not is_report:
        ref_domains = {org_domain(x.rsplit("@", 1)[-1].strip("> ")) for x in re.findall(r"<[^>]+@[^>]+>", in_reply + " " + references)}
        internal = [d for d in ref_domains if any(same_org(d, p) for p in cfg.protected_domains) or d.endswith("outlook.com")]
        if internal and from_dom and not any(same_org(from_dom, d) for d in ref_domains):
            findings.append(_finding(
                "HILO_SECUESTRADO", "alto", "Posible secuestro de conversación (thread hijacking)",
                f"Responde a un hilo con mensajes de {', '.join(sorted(internal))}, pero llega desde {from_dom}. "
                "Típico de cuentas de proveedores comprometidas o de atacantes que copiaron una conversación real."))

    # ---- Invitaciones de calendario
    for cal in calendar_texts:
        cal_urls = re.findall(r"https?://\S+", cal)
        organizer = re.search(r"ORGANIZER[^:]*:mailto:([^\s]+)", cal, re.I)
        if cal_urls or organizer:
            findings.append(_finding(
                "CALENDARIO", "medio", "Invitación de calendario con enlaces",
                f"Organizador: {organizer.group(1) if organizer else '-'}; {len(cal_urls)} enlace(s). Las invitaciones se "
                "agregan solas al calendario y sus enlaces no siempre pasan por Safe Links."))
            break

    # ---- Protocolos que ejecutan código o filtran hashes NTLM
    dangerous = [x for x in raw_hrefs if DANGEROUS_SCHEMES.match(x.strip()) or UNC_RE.match(x.strip())]
    dangerous += re.findall(r"(?:search-ms|ms-msdt|ms-officecmd|ms-appinstaller):[^\s\"'<>]+", full_text + all_html, re.I)
    if dangerous:
        findings.append(_finding(
            "PROTOCOLO_PELIGROSO", "critico", "Enlace a protocolo que ejecuta código o filtra credenciales",
            f"{', '.join(dict.fromkeys(d[:80] for d in dangerous[:3]))}. search-ms:/ms-msdt:/ms-appinstaller: abren "
            "contenido remoto como si fuera local (Follina, carga de malware) y file://, \\\\servidor filtran el hash NTLM."))

    # ---- Suplantación de marcas conocidas
    if not own_sender:
        display_n, subject_n = norm_text(display), norm_text(subject)
        for brand, (words, domains) in BRANDS.items():
            legit = any(same_org(from_dom, d) for d in domains)
            if legit:
                continue
            pattern = r"(?<![a-z0-9])(" + "|".join(re.escape(w) for w in words) + r")(?![a-z0-9])"
            if re.search(pattern, display_n):
                findings.append(_finding(
                    "MARCA_SUPLANTADA", "alto", f"Suplantación de marca: {brand}",
                    f"El nombre visible '{display}' usa {brand}, pero el correo viene de {from_dom or '-'} (no es un dominio de {brand})."))
                break
            if re.search(pattern, subject_n) and "credenciales" in keyword_hits(full_text):
                findings.append(_finding(
                    "MARCA_EN_ASUNTO", "medio", f"Asunto usa la marca {brand} con solicitud de credenciales",
                    f"Asunto: '{subject[:100]}'; remitente {from_dom or '-'}."))
                break

    # ---- Mezcla de alfabetos (homoglifos en el texto visible)
    mixed = _mixed_script_words(subject) + _mixed_script_words(display)
    if mixed:
        findings.append(_finding(
            "ALFABETOS_MEZCLADOS", "alto", "Letras de otros alfabetos mezcladas en el asunto o nombre",
            f"Palabras: {', '.join(mixed[:5])}. Se usan letras cirílicas/griegas idénticas a las latinas para evadir filtros por palabras."))

    # ---- Envío masivo con destinatarios ocultos
    to = (h.get("to") or "").lower()
    if not to.strip() or "undisclosed" in to or "no revelados" in to or "destinatarios ocultos" in to:
        findings.append(_finding(
            "DESTINATARIOS_OCULTOS", "bajo", "Destinatarios ocultos (envío masivo en copia oculta)",
            "El campo Para está vacío o es genérico: el mismo correo probablemente llegó a muchas personas."))
    return findings

