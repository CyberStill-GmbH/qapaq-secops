"""Reglas de evaluación: convierten la evidencia en hallazgos explicables y un veredicto.

Cada hallazgo tiene severidad (critico, alto, medio, bajo, info), un título y
el detalle que justifica la conclusión. El índice de riesgo es la suma de
pesos por severidad (tope 100) y sirve como apoyo, no como prueba.
"""
from __future__ import annotations

import re

from cintel.domain import DISPOSABLE_MAIL, FREE_MAIL
from cintel.lookalike import brand_in_text, check_lookalike, skeleton
from cintel.util import norm_text, org_domain, same_org, to_unicode_domain

SEVERITY_ORDER = ("critico", "alto", "medio", "bajo", "info")
SEVERITY_WEIGHT = {"critico": 40, "alto": 20, "medio": 10, "bajo": 3, "info": 0}
SEVERITY_LABEL = {"critico": "CRÍTICO", "alto": "ALTO", "medio": "MEDIO", "bajo": "BAJO", "info": "INFO"}

ROLE_WORDS = ("gerente", "presidente", "director", "directora", "ceo", "cfo", "coo", "jefe", "jefa",
              "tesoreria", "finanzas", "recursos humanos", "rrhh", "soporte", "mesa de ayuda", "helpdesk",
              "seguridad", "administrador", "sistemas", "ti ", "junta", "directorio")


class Findings:
    def __init__(self, scope: str = "Mensaje"):
        self.items = []
        self.scope = scope
        self._codes = set()

    def add(self, code, severity, title, detail, unique=True):
        key = (code, title)
        if unique and key in self._codes:
            return
        self._codes.add(key)
        self.items.append({"codigo": code, "severidad": severity, "titulo": title, "detalle": detail,
                           "ambito": self.scope})


# --------------------------------------------------------------------------
# Mensaje
# --------------------------------------------------------------------------

def assess_message(m: dict, cfg, domains: dict, scope: str = "Mensaje") -> list:
    f = Findings(scope)
    sender = m["remitente"]
    from_dom = sender.get("dominio") or ""
    display = sender.get("nombre_visible") or ""
    protected = cfg.protected_domains
    from_is_protected = any(same_org(from_dom, p) for p in protected)

    _assess_auth(m, f, from_dom, from_is_protected)
    _assess_identity(m, f, cfg, from_dom, display, from_is_protected)
    _assess_platform(m, f, from_is_protected)
    _assess_route(m, f)
    # Técnicas sofisticadas detectadas por advanced.py (AiTM, OAuth, device code, TOAD, hilos…)
    for item in m.get("avanzado", []):
        f.add(item["codigo"], item["severidad"], item["titulo"], item["detalle"])
    if not m["solo_cabeceras"]:
        _assess_content(m, f)
        _assess_urls(m, f)
        _assess_attachments(m, f)
    elif m["cuerpo"]["palabras_clave"]:
        cats = ", ".join(m["cuerpo"]["palabras_clave"].keys())
        f.add("ASUNTO_KEYWORDS", "bajo", "Asunto con lenguaje de ingeniería social", f"Categorías: {cats}")
    # Dominios del remitente / respuesta.
    for role, party in (("From", m["remitente"]), ("Reply-To", m.get("reply_to")), ("Return-Path", m.get("return_path"))):
        if party and party.get("dominio") and party["dominio"] in domains:
            if role == "Return-Path" and same_org(party["dominio"], from_dom):
                continue
            if role == "Reply-To" and same_org(party["dominio"], from_dom):
                continue
            f.items.extend(assess_domain(domains[party["dominio"]], cfg, role, scope, sender_role=True))
    # Mensajes reenviados como adjunto.
    for index, nested in enumerate(m.get("mensajes_adjuntos", []), 1):
        f.add("MENSAJE_ADJUNTO", "info", "Contiene un correo adjunto (reenvío de reporte)",
              f"Se analizó también el mensaje adjunto N.° {index}: {nested['cabeceras'].get('subject') or '(sin asunto)'}")
        f.items.extend(assess_message(nested, cfg, domains, f"Mensaje adjunto {index}"))
    return f.items


def _assess_auth(m, f, from_dom, from_is_protected):
    summary = m["autenticacion_resumen"]
    if not summary:
        f.add("AUTH_AUSENTE", "info", "Sin resultados de autenticación (Authentication-Results)",
              "El mensaje no trae el veredicto SPF/DKIM/DMARC del servidor receptor. Ocurre con cabeceras "
              "incompletas, correo interno o mensajes exportados desde Enviados.")
        return
    dmarc = summary.get("dmarc", {}).get("resultado")
    spf = summary.get("spf", {}).get("resultado")
    dkim = summary.get("dkim", {}).get("resultado")
    comp = summary.get("compauth")
    if dmarc in ("fail", "permerror"):
        sev = "critico" if from_is_protected else "alto"
        f.add("DMARC_FAIL", sev, "DMARC falló",
              f"El dominio del From ({from_dom}) no superó DMARC: el remitente visible probablemente está "
              f"suplantado.{' ¡Es un dominio propio de la organización!' if from_is_protected else ''}")
    if comp and comp.get("resultado") == "fail":
        reason = comp.get("propiedades", {}).get("reason", "")
        f.add("COMPAUTH_FAIL", "critico" if from_is_protected else "alto",
              "Microsoft 365 reporta autenticación compuesta fallida (compauth=fail)",
              f"reason={reason}: {comp.get('razon_texto') or 'ver documentación de Microsoft'}")
    elif comp and comp.get("resultado") == "softpass":
        f.add("COMPAUTH_SOFT", "bajo", "compauth=softpass", "Autenticación parcial según Microsoft 365.")
    if spf == "fail":
        f.add("SPF_FAIL", "medio", "SPF falló", "La IP que envió no está autorizada por el dominio del sobre (Return-Path).")
    elif spf == "softfail":
        f.add("SPF_SOFTFAIL", "bajo", "SPF softfail", "La IP que envió no está autorizada (política ~all).")
    elif spf in ("permerror", "temperror"):
        f.add("SPF_ERROR", "bajo", f"SPF {spf}", "Error al evaluar SPF del dominio del sobre.")
    if dkim == "fail":
        f.add("DKIM_FAIL", "medio", "Firma DKIM inválida", "El contenido o las cabeceras firmadas fueron alterados, o la firma es falsa.")
    if dmarc == "pass":
        f.add("DMARC_PASS", "info", "DMARC aprobado",
              "El dominio del From está autenticado. No descarta phishing desde una cuenta comprometida o "
              "desde un dominio registrado por el atacante.")
    # Alineación calculada a partir de los resultados reportados.
    dkim_domains = [x.get("propiedades", {}).get("header.d", "") for h in (m["autenticacion"] or m["arc"])
                    for x in h["metodos"] if x["metodo"] == "dkim" and x["resultado"] == "pass"]
    mailfrom = summary.get("spf", {}).get("propiedades", {}).get("smtp.mailfrom", "")
    mailfrom_dom = mailfrom.rsplit("@", 1)[-1].lower() if mailfrom else ""
    spf_aligned = spf == "pass" and same_org(mailfrom_dom, from_dom)
    dkim_aligned = any(same_org(d.lower(), from_dom) for d in dkim_domains)
    if from_dom and dmarc is None and (spf or dkim) and not spf_aligned and not dkim_aligned:
        f.add("SIN_ALINEACION", "medio", "Ni SPF ni DKIM están alineados con el dominio del From",
              f"From={from_dom}; SPF mailfrom={mailfrom_dom or '-'}; DKIM d={', '.join(dkim_domains) or '-'}.")
    pol = summary.get("dmarc", {}).get("politica")
    if dmarc == "fail" and pol == "none":
        f.add("DMARC_FAIL_NONE", "medio", "DMARC falló pero el dominio tiene política p=none",
              "El receptor no está obligado a rechazar el mensaje; por eso pudo llegar a la bandeja.")


def _assess_identity(m, f, cfg, from_dom, display, from_is_protected):
    sender = m["remitente"]
    address = sender.get("direccion") or ""
    if not from_dom:
        f.add("FROM_INVALIDO", "medio", "Remitente sin dirección válida", f"From: {m['cabeceras'].get('from')!r}")
    # Dominio parecido a uno propio.
    for match in check_lookalike(from_dom, cfg.protected_domains):
        f.add("FROM_PARECIDO", "critico", f"El remitente usa un dominio parecido a {match['protegido']}",
              f"{match['dominio_unicode']}: {match['tecnica']}.")
    if from_dom and to_unicode_domain(from_dom) != from_dom:
        f.add("FROM_IDN", "alto", "Dominio del remitente con caracteres internacionales (punycode)",
              f"{from_dom} se muestra como {to_unicode_domain(from_dom)}.")
    # Nombre visible engañoso.
    emails_in_display = re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", display)
    for shown in emails_in_display:
        if shown.lower() != address:
            f.add("NOMBRE_CON_CORREO", "alto", "El nombre visible contiene otra dirección de correo",
                  f"Muestra '{shown}' pero el correo real es '{address}'.")
            break
    brands = brand_in_text(display, cfg.brands)
    if brands and not from_is_protected:
        f.add("NOMBRE_MARCA", "alto", f"Nombre visible usa la marca '{brands[0]}' desde un dominio externo",
              f"Nombre: '{display}'; dominio real: {from_dom}.")
    norm_display = norm_text(display)
    for vip in cfg.vip_names:
        # Se ignora el texto entre paréntesis (cargo), p. ej. "Ana Pérez (Presidenta del Directorio)".
        vip_name = norm_text(re.sub(r"\(.*?\)", " ", vip)).strip()
        if len(vip_name) >= 5 and skeleton(vip_name) in skeleton(norm_display) and not from_is_protected:
            f.add("VIP_SUPLANTADO", "critico", "Suplantación de un directivo/VIP (fraude del CEO)",
                  f"El nombre visible '{display}' coincide con '{vip}' pero el correo viene de {from_dom}.")
            break
    is_free = org_domain(from_dom) in FREE_MAIL or from_dom in FREE_MAIL
    if from_dom in DISPOSABLE_MAIL or org_domain(from_dom) in DISPOSABLE_MAIL:
        f.add("FROM_DESECHABLE", "alto", "Remitente con correo desechable/temporal", from_dom)
    if is_free:
        role = next((w.strip() for w in ROLE_WORDS if w in norm_display + " "), None)
        if role or brands:
            f.add("GRATUITO_CARGO", "alto", "Cuenta de correo gratuita con nombre de cargo o institución",
                  f"'{display}' <{address}>: las instituciones no usan {from_dom} para comunicaciones oficiales.")
        else:
            f.add("FROM_GRATUITO", "info", "Remitente con proveedor de correo gratuito", from_dom)
    # Reply-To / Return-Path / Sender
    reply = m.get("reply_to")
    if reply and reply.get("dominio") and not same_org(reply["dominio"], from_dom):
        rdom = reply["dominio"]
        if check_lookalike(rdom, cfg.protected_domains):
            f.add("REPLY_PARECIDO", "critico", "Las respuestas van a un dominio parecido al propio", rdom)
        elif rdom in FREE_MAIL and not is_free:
            f.add("REPLY_GRATUITO", "alto", "Las respuestas se desvían a una cuenta gratuita",
                  f"From={from_dom}; Reply-To={reply.get('direccion')}. Patrón típico de fraude del CEO/BEC.")
        else:
            f.add("REPLY_DISTINTO", "medio", "Reply-To en un dominio distinto al remitente",
                  f"From={from_dom}; Reply-To={rdom}. Puede ser legítimo (plataformas de envío), verificar.")
    rp = m.get("return_path")
    if rp and rp.get("dominio") and from_dom and not same_org(rp["dominio"], from_dom):
        f.add("RETURN_PATH_DISTINTO", "info", "Return-Path (sobre SMTP) en otro dominio",
              f"Return-Path={rp['dominio']}. Habitual en plataformas de envío masivo; relevante si SPF/DMARC fallan.")
    snd = m.get("sender")
    if snd and snd.get("dominio") and from_dom and not same_org(snd["dominio"], from_dom):
        f.add("SENDER_DISTINTO", "bajo", "Cabecera Sender distinta del From",
              f"Sender={snd.get('direccion')}: el mensaje se envió 'en nombre de' {address}.")
    msgid = m["cabeceras"].get("message-id") or ""
    msgid_dom = msgid.strip("<> ").rsplit("@", 1)[-1].lower() if "@" in msgid else ""
    if from_is_protected and msgid_dom and not any(same_org(msgid_dom, p) for p in cfg.protected_domains) \
            and not msgid_dom.endswith(("outlook.com", "prod.outlook.com", "microsoft.com")):
        f.add("MSGID_EXTERNO", "medio", "Remitente interno con Message-ID generado fuera de la organización",
              f"Message-ID en {msgid_dom}: el correo no parece haberse originado en la infraestructura propia.")


def _assess_platform(m, f, from_is_protected):
    ms = m["microsoft"]
    for ff in ms["forefront"]:
        cat = (ff.get("CAT") or "").upper()
        if cat in ("HPHSH", "HPHISH", "MALW"):
            f.add("M365_CAT_CRIT", "critico", f"Microsoft 365 lo clasificó como {cat}", "Phishing de alta confianza o malware.")
        elif cat in ("PHSH", "SPOOF", "DIMP", "UIMP", "BIMP", "GIMP"):
            f.add("M365_CAT", "alto", f"Microsoft 365 lo clasificó como {cat}", f"Categoría de amenaza: {cat}.")
        elif cat in ("SPM", "HSPM"):
            f.add("M365_SPAM", "medio", f"Microsoft 365 lo clasificó como spam ({cat})", "")
        sfty = ff.get("SFTY", "")
        if sfty in ("9.19", "9.20", "9.11", "9.1"):
            f.add("M365_SFTY", "alto", f"Consejo de seguridad SFTY={sfty}", "Microsoft detectó suplantación o phishing.")
        elif sfty == "9.25":
            f.add("M365_PRIMER_CONTACTO", "bajo", "Primer contacto con este remitente (SFTY 9.25)",
                  "El destinatario nunca había recibido correo de esta dirección.")
        try:
            scl = int(ff.get("SCL", "0"))
        except ValueError:
            scl = 0
        if scl >= 5:
            f.add("M365_SCL", "medio", f"SCL={scl}: Microsoft lo consideró spam", "")
        sfv = (ff.get("SFV") or "").upper()
        if sfv in ("SKA", "SFE", "SKN") or scl == -1:
            f.add("M365_BYPASS", "medio", "El correo omitió el filtro de spam por lista de permitidos o regla",
                  f"SFV={sfv or '-'}, SCL={ff.get('SCL', '-')}. Revisar si un atacante abusa de una excepción configurada.")
        if ff.get("CTRY") and ff["CTRY"].upper() not in ("PE",):
            f.add("M365_PAIS", "info", f"Conexión de origen desde país: {ff['CTRY']}",
                  f"IP conectante (CIP): {ff.get('CIP', '-')}.")
    if (ms.get("autenticado_como") or "").lower() == "anonymous" and from_is_protected:
        f.add("INTERNO_EXTERNO", "alto", "Dice venir de un dominio propio pero llegó desde Internet",
              "X-MS-Exchange-Organization-AuthAs=Anonymous: el correo no se envió desde un buzón autenticado del tenant.")
    if ms.get("bcl") is not None and ms["bcl"] >= 7:
        f.add("M365_BCL", "bajo", f"Correo masivo (BCL={ms['bcl']})", "")
    g = m["google"]
    if (g.get("phishy") or "").strip() == "1":
        f.add("GMAIL_PHISHY", "alto", "Gmail marcó el correo como posible phishing (X-Gm-Phishy: 1)", "")
    if (g.get("spam") or "").strip() == "1":
        f.add("GMAIL_SPAM", "medio", "Gmail marcó el correo como spam (X-Gm-Spam: 1)", "")
    other = m["antispam_otros"]
    if str(other.get("X-Spam-Flag", "")).strip().upper() == "YES":
        f.add("SPAM_FLAG", "medio", "Filtro antispam intermedio marcó el correo como spam", other.get("X-Spam-Status", "")[:200])
    for sender in m["plataforma"]["emisor"]:
        if "PHP" in sender:
            f.add("ENVIO_SCRIPT", "alto", "Enviado desde un script en un servidor web",
                  f"{sender}. Los kits de phishing suelen enviar desde sitios web comprometidos.")
    if m["cabeceras"].get("x-originating-ip"):
        f.add("IP_ORIGINANTE", "info", "IP del cliente que redactó el correo (X-Originating-IP)",
              m["cabeceras"]["x-originating-ip"])


def _assess_route(m, f):
    route = m["ruta"]
    for anomaly in route["anomalias"][:5]:
        f.add("RUTA_ANOMALA", "bajo", "Anomalía en la ruta de entrega (Received)", anomaly, unique=False)
    if route["saltos"] and not route["ip_origen"]:
        f.add("SIN_IP_PUBLICA", "info", "No se identificó IP pública de origen", "Todos los saltos usan IPs privadas o no declaran IP.")


def _assess_content(m, f):
    body = m["cuerpo"]
    hits = body["palabras_clave"]
    cats = set(hits)
    from cintel.content import CATEGORY_LABELS

    def words(*keys):
        return "; ".join(f"{CATEGORY_LABELS[k]}: {', '.join(hits[k][:5])}" for k in keys if k in hits)

    if "credenciales" in cats and cats & {"urgencia", "amenaza"}:
        f.add("PATRON_CREDENCIALES", "alto", "Patrón de robo de credenciales (urgencia/amenaza + verificación de cuenta)",
              words("credenciales", "urgencia", "amenaza"))
    if "financiero" in cats and cats & {"autoridad_confidencialidad", "urgencia"}:
        f.add("PATRON_BEC", "alto", "Patrón de fraude del CEO / compromiso de correo empresarial (BEC)",
              words("financiero", "autoridad_confidencialidad", "urgencia"))
    if "documento_compartido" in cats and ("credenciales" in cats or m["urls"]):
        f.add("PATRON_DOC_COMPARTIDO", "medio", "Señuelo de documento compartido / buzón de voz",
              words("documento_compartido", "credenciales"))
    if "premio_reembolso" in cats:
        f.add("PATRON_PREMIO", "medio", "Señuelo de premio, reembolso o beneficio", words("premio_reembolso"))
    if len(cats) >= 3 and not any(i["codigo"].startswith("PATRON") for i in f.items):
        f.add("INGENIERIA_SOCIAL", "medio", "Múltiples técnicas de ingeniería social", words(*sorted(cats)))
    elif cats and not any(i["codigo"].startswith("PATRON") for i in f.items):
        f.add("LENGUAJE_SOSPECHOSO", "bajo", "Lenguaje asociado a ingeniería social", words(*sorted(cats)))
    for form in body["formularios"]:
        if form.get("pide_clave"):
            f.add("FORM_PASSWORD", "critico", "El cuerpo del correo contiene un formulario con campo de contraseña",
                  f"Envía a: {form.get('action') or '(misma página)'}")
            break
    else:
        if body["formularios"]:
            f.add("FORM_CUERPO", "medio", "El cuerpo del correo contiene un formulario", "Los correos legítimos rara vez incluyen formularios.")
    if body["scripts"]:
        f.add("SCRIPTS", "medio", f"El HTML incluye {body['scripts']} script(s)", "Los clientes de correo los bloquean; su presencia indica intención maliciosa o plantilla anómala.")
    if body["meta_refresh"]:
        f.add("META_REFRESH", "medio", "Redirección automática (meta refresh) en el HTML", "; ".join(body["meta_refresh"][:3]))
    for trick in body["trucos_html"]:
        f.add("TRUCO_HTML", "medio", "Técnica de evasión en el HTML", trick, unique=False)
    if m["qr"]:
        urls_qr = [q["contenido"] for q in m["qr"] if q["contenido"].lower().startswith("http")]
        f.add("QR", "alto" if urls_qr else "medio", "Código QR detectado (quishing)",
              "Contenido: " + "; ".join(q["contenido"][:120] for q in m["qr"][:3]) +
              ". Los QR evaden los filtros de enlaces y se abren en el celular, fuera de los controles corporativos.")


def _assess_urls(m, f):
    risky = [u for u in m["urls"] if u.get("riesgo") in ("critico", "alto")]
    medium = [u for u in m["urls"] if u.get("riesgo") == "medio"]
    for entry in risky[:12]:
        texts = [i["texto"] for i in entry["indicadores"] if i["nivel"] in ("critico", "alto")]
        f.add("URL_RIESGO", "alto", f"Enlace de alto riesgo: {entry['host']}",
              "; ".join(texts[:4]) + f" (encontrado en {entry['origen']}).", unique=False)
    if len(risky) > 12:
        f.add("URL_RIESGO_MAS", "alto", f"{len(risky) - 12} enlace(s) adicionales de alto riesgo", "Ver anexo de URLs.")
    if medium:
        hosts = sorted({u["host"] for u in medium})
        f.add("URL_MEDIO", "medio", f"{len(medium)} enlace(s) con indicadores de riesgo medio",
              "Dominios: " + ", ".join(hosts[:10]))
    if m["urls"]:
        hosts = {u["host"] for u in m["urls"] if u.get("host")}
        f.add("URLS", "info", f"{len(m['urls'])} enlace(s) en {len(hosts)} dominio(s)",
              "Extracción estática: ningún enlace fue visitado.")


def _assess_attachments(m, f):
    for a in m["adjuntos"]:
        levels = [i["nivel"] for i in a["indicadores"]]
        if not levels:
            continue
        top = min(levels, key=SEVERITY_ORDER.index)
        if top in ("critico", "alto", "medio"):
            f.add("ADJUNTO", top, f"Adjunto peligroso: {a['nombre']}",
                  "; ".join(i["texto"] for i in a["indicadores"]) + f". SHA-256: {a['sha256']}", unique=False)
    if m["adjuntos"]:
        f.add("ADJUNTOS", "info", f"{len(m['adjuntos'])} adjunto(s)",
              "Analizados de forma estática: no se abrieron ni ejecutaron. Hashes en el anexo.")


# --------------------------------------------------------------------------
# Dominio y dirección
# --------------------------------------------------------------------------

def assess_domain(d: dict, cfg, role: str = "Dominio", scope: str = "Dominio", sender_role: bool = False) -> list:
    f = Findings(scope)
    name = d["dominio"]
    label = f"{role} {name}"
    if not sender_role:
        for match in check_lookalike(name, cfg.protected_domains):
            f.add("DOMINIO_PARECIDO", "critico", f"Dominio parecido a {match['protegido']}",
                  f"{match['dominio_unicode']}: {match['tecnica']}.")
        if name in DISPOSABLE_MAIL:
            f.add("DESECHABLE", "alto", "Proveedor de correo desechable/temporal", name)
        elif name in FREE_MAIL:
            f.add("GRATUITO", "info", "Proveedor de correo gratuito", f"{name}: cualquiera puede crear una cuenta.")
    if "consultas" not in d:
        return f.items
    if (d.get("rdap") or {}).get("estado") == "no_registrado" and check_lookalike(name, cfg.protected_domains) and not sender_role:
        f.add("PARECIDO_LIBRE", "medio", "Dominio parecido aún NO registrado",
              f"{name} está libre: un atacante podría registrarlo. Evaluar su registro defensivo.")
    if d.get("existe") is False:
        f.add("DOMINIO_INEXISTENTE", "alto", f"{label}: el dominio no existe en DNS",
              "Un remitente con dominio inexistente indica cabeceras falsificadas.")
        return f.items
    if name in FREE_MAIL:
        return f.items  # La postura DNS de Gmail/Outlook no aporta al caso.
    age = (d.get("rdap") or {}).get("antiguedad_dias")
    if age is not None:
        if age < 30:
            f.add("DOMINIO_NUEVO", "critico" if sender_role else "alto", f"{label}: registrado hace solo {age} día(s)",
                  f"Creado el {d['rdap'].get('creado')}. Los dominios recién creados son la señal más fuerte de campaña de phishing.")
        elif age < 180:
            f.add("DOMINIO_RECIENTE", "medio", f"{label}: dominio reciente ({age} días)", f"Creado el {d['rdap'].get('creado')}.")
        else:
            f.add("DOMINIO_ANTIGUEDAD", "info", f"{label}: antigüedad {age // 365} año(s)", f"Creado el {d['rdap'].get('creado')}.")
    dmarc = d.get("dmarc", {})
    own = any(same_org(name, p) for p in cfg.protected_domains)
    if own and dmarc.get("p") in (None, "none"):
        f.add("DMARC_PROPIO_DEBIL", "medio", f"Dominio propio {name} con DMARC {'p=none' if dmarc.get('p') else 'ausente'}",
              "Los receptores no rechazan correos que suplanten este dominio: un atacante puede enviar como "
              f"usuario@{name} y llegar a bandejas externas (proveedores, clientes, directivos con correo personal).")
    if not dmarc.get("registros"):
        f.add("SIN_DMARC", "medio", f"{label}: no publica DMARC",
              "Sin DMARC, cualquiera puede enviar correo usando este dominio en el From sin ser rechazado.")
    elif dmarc.get("p") == "none" and not own:
        f.add("DMARC_NONE", "bajo", f"{label}: DMARC en modo monitoreo (p=none)", "No se pide a los receptores rechazar suplantaciones.")
    elif dmarc.get("pct") and dmarc["pct"] != "100":
        f.add("DMARC_PCT", "info", f"{label}: DMARC aplicado solo al {dmarc['pct']}%", "")
    if dmarc.get("multiples"):
        f.add("DMARC_MULTIPLE", "medio", f"{label}: múltiples registros DMARC (inválido)", "")
    spf = d.get("spf", {})
    if not spf.get("registros"):
        f.add("SIN_SPF", "medio" if not sender_role else "bajo", f"{label}: no publica SPF", "")
    else:
        if spf.get("multiples"):
            f.add("SPF_MULTIPLE", "medio", f"{label}: múltiples registros SPF (permerror)", "")
        if spf.get("all") == "+all":
            f.add("SPF_PLUS_ALL", "alto", f"{label}: SPF con +all", "Autoriza a cualquier servidor de Internet a enviar en su nombre.")
        elif spf.get("all") == "?all":
            f.add("SPF_NEUTRAL", "bajo", f"{label}: SPF neutral (?all)", "")
        if spf.get("consultas_estimadas", 0) > 10:
            f.add("SPF_LOOKUPS", "bajo", f"{label}: SPF con más de 10 consultas DNS (posible permerror)", "")
    if d.get("mx_nulo"):
        f.add("MX_NULO", "medio" if sender_role else "info", f"{label}: declara que no recibe correo (MX nulo)",
              "Un remitente que no puede recibir respuestas es inusual para comunicaciones legítimas.")
    elif not d.get("mx"):
        f.add("SIN_MX", "medio" if sender_role else "bajo", f"{label}: sin registros MX",
              "El dominio no recibe correo: típico de dominios creados solo para enviar phishing.")
    providers = d.get("proveedor_correo") or []
    if providers:
        f.add("PROVEEDOR", "info", f"{label}: correo gestionado por {', '.join(providers)}", ", ".join(d.get("mx", [])[:4]))
    tenant = d.get("microsoft_tenant") or {}
    if tenant.get("estado") == "ok":
        f.add("TENANT_M365", "info", f"{label}: tiene tenant de Microsoft 365 / Entra ID",
              f"Tenant ID: {tenant.get('tenant_id') or '-'}; región: {tenant.get('region') or '-'}.")
    if not sender_role:
        dk = d.get("dkim_selectores") or []
        if dk:
            f.add("DKIM_SELECTORES", "info", f"{label}: selectores DKIM encontrados",
                  ", ".join(x["selector"] + (" (revocada)" if x.get("revocada") else "") for x in dk))
        if not d.get("mta_sts"):
            f.add("SIN_MTA_STS", "info", f"{label}: sin MTA-STS", "No exige TLS para recibir correo.")
    return f.items


def assess_address(addr: dict, cfg) -> list:
    f = Findings("Dirección")
    local = addr["local"]
    if addr.get("dominio_unicode") != addr.get("dominio"):
        f.add("DIR_IDN", "alto", "Dirección con dominio internacionalizado", f"{addr['dominio']} = {addr['dominio_unicode']}")
    brands = brand_in_text(local, cfg.brands)
    if brands and not any(same_org(addr["dominio"], p) for p in cfg.protected_domains):
        f.add("DIR_MARCA", "alto", f"La parte local usa la marca '{brands[0]}' en un dominio externo", addr["direccion"])
    if re.search(r"\d{5,}", local):
        f.add("DIR_NUMEROS", "bajo", "Parte local con secuencia numérica larga", "Patrón frecuente en cuentas creadas en masa.")
    role = next((w.strip() for w in ROLE_WORDS if w in norm_text(local.replace(".", " ").replace("_", " ")) + " "), None)
    if role and addr["dominio"] in FREE_MAIL:
        f.add("DIR_CARGO_GRATUITO", "alto", "Cuenta gratuita con nombre de cargo/área", f"'{role}' en {addr['direccion']}")
    return f.items


# --------------------------------------------------------------------------
# Veredicto
# --------------------------------------------------------------------------

def sort_findings(findings: list) -> list:
    return sorted(findings, key=lambda x: SEVERITY_ORDER.index(x["severidad"]))


def verdict(findings: list, target_type: str = "mensaje") -> dict:
    counts = {s: 0 for s in SEVERITY_ORDER}
    for item in findings:
        counts[item["severidad"]] += 1
    score = min(100, sum(SEVERITY_WEIGHT[i["severidad"]] for i in findings))
    if counts["critico"] or score >= 60:
        level, label, color = "critico", "PHISHING MUY PROBABLE" if target_type == "mensaje" else "RIESGO CRÍTICO", "#B00020"
        summary = "Existen indicadores fuertes de suplantación o contenido malicioso. Tratar como incidente."
    elif score >= 30:
        level, label, color = "alto", "SOSPECHOSO" if target_type == "mensaje" else "RIESGO ALTO", "#E65100"
        summary = "Hay varios indicadores de riesgo. No interactuar hasta validar por un canal alterno."
    elif score >= 10:
        level, label, color = "medio", "PRECAUCIÓN", "#F9A825"
        summary = "Indicadores aislados. Validar con el remitente por un canal conocido antes de actuar."
    else:
        level, label, color = "info", "SIN INDICADORES RELEVANTES", "#2E7D32"
        summary = ("No se detectaron indicadores relevantes con la evidencia disponible. "
                   "Esto no garantiza que sea legítimo (p. ej. cuenta comprometida).")
    return {"nivel": level, "etiqueta": label, "color": color, "indice_riesgo": score,
            "conteo": counts, "resumen": summary}


def recommendations(case: dict) -> list:
    """Acciones sugeridas para Riesgos No Financieros / Seguridad de la Información."""
    v = case["veredicto"]["nivel"]
    codes = {f["codigo"] for f in case["hallazgos"]}
    msg = case.get("mensaje") or {}
    recs = []
    if v in ("critico", "alto"):
        recs.append("No responder, no abrir adjuntos, no hacer clic en enlaces ni escanear códigos QR del mensaje.")
        recs.append("Reportar de inmediato a Seguridad de la Información / SOC adjuntando este PDF y el correo original (.eml/.msg).")
    else:
        recs.append("Ante cualquier duda, validar con el remitente por un canal alterno conocido (teléfono registrado, no los datos del correo).")
    # En reportes reenviados se toma la evidencia del correo original adjunto.
    msgs = [msg] + list(msg.get("mensajes_adjuntos", [])) if msg else []
    ms_msg = next((x for x in reversed(msgs) if (x.get("microsoft") or {}).get("forefront")
                   or (x.get("microsoft") or {}).get("network_message_id")), None)
    nmid = (ms_msg or {}).get("microsoft", {}).get("network_message_id")
    if ms_msg:
        recs.append("Microsoft 365: en Defender > Explorador de amenazas o Seguimiento de mensajes, buscar "
                    f"{'el Network-Message-Id ' + nmid if nmid else 'por remitente/asunto'} para identificar a todos los destinatarios "
                    "y purgar (eliminación temporal) las copias entregadas.")
        recs.append("Microsoft 365: bloquear remitente, dominio y URLs en la Lista de permitidos/bloqueados del inquilino (Tenant Allow/Block List).")
    if any((x.get("google") or {}).get("cabeceras") for x in msgs):
        recs.append("Gmail / Google Workspace: usar 'Denunciar phishing' y, como administrador, la Herramienta de investigación "
                    "de seguridad para localizar y eliminar el mensaje en otros buzones.")
    if codes & {"PATRON_CREDENCIALES", "FORM_PASSWORD", "URL_RIESGO", "QR", "ADJUNTO"}:
        recs.append("Si alguien hizo clic o ingresó credenciales: cambiar la contraseña, revocar sesiones activas en Entra ID/Google, "
                    "revisar métodos MFA registrados, reglas de reenvío de la bandeja y el registro de inicios de sesión.")
    if codes & {"PATRON_BEC", "VIP_SUPLANTADO", "REPLY_GRATUITO", "GRATUITO_CARGO"}:
        recs.append("Posible fraude del CEO: no ejecutar pagos ni cambios de cuenta bancaria. Confirmar por llamada con la persona "
                    "(número del directorio interno) y alertar a Tesorería/Finanzas y a los miembros de la Junta Directiva.")
    if codes & {"FROM_PARECIDO", "DOMINIO_PARECIDO", "REPLY_PARECIDO"} or any(
            "parecido" in f["detalle"].lower() for f in case["hallazgos"] if f["codigo"] == "URL_RIESGO"):
        recs.append("Dominio que imita a la organización: solicitar la baja (takedown) al registrador/hosting mediante su contacto "
                    "de abuso y bloquearlo preventivamente en correo, proxy y DNS corporativo.")
    if "PARECIDO_LIBRE" in codes:
        recs.append("Registrar preventivamente los dominios parecidos que aún están libres para impedir su uso en campañas futuras.")
    if "DMARC_PROPIO_DEBIL" in codes:
        recs.append("Dominio propio: endurecer DMARC a p=quarantine/p=reject para impedir su suplantación.")
    if v in ("critico", "alto"):
        recs.append("Registrar el evento en la base de incidentes/eventos de riesgo operacional del área de Riesgos No Financieros, "
                    "conforme a la normativa SBS de gestión de riesgo operacional y de seguridad de la información y ciberseguridad.")
        recs.append("Evaluar una alerta de concientización a colaboradores y directivos con las características de esta campaña.")
    evasion = case.get("evasion") or {}
    if evasion.get("vias"):
        recs.append(f"Corregir los {len(evasion['vias'])} control(es) que el correo logró superar (ver sección "
                    "'Cómo superó los controles'), priorizando los de severidad alta.")
    recs.append("Conservar el archivo original sin modificar: su hash SHA-256 en este reporte respalda la cadena de custodia.")
    return recs

