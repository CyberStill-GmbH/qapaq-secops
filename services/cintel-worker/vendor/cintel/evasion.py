"""Diagnóstico de suplantación y de evasión de controles.

Responde dos preguntas que el área de Riesgos No Financieros necesita para
cerrar un incidente:

1. ¿Qué tipo de suplantación se usó? (spoofing directo, dominio parecido,
   nombre visible, cuenta gratuita, cuenta comprometida, desvío de respuestas)
2. ¿Cómo superó el correo cada control? (DMARC débil, override del receptor,
   listas de permitidos, gateway sin Enhanced Filtering, protección contra
   suplantación no configurada, entrega en bandeja pese al veredicto, etc.)

Cada vía de evasión incluye la evidencia observada y la acción correctiva.
"""
from __future__ import annotations

import re

from cintel.urls import ABUSED_SERVICES, SHORTENERS
from cintel.util import same_org

# Pasarelas de seguridad que suelen ubicarse delante de Microsoft 365.
GATEWAY_RE = re.compile(r"hornetsecurity|antispameurope|spamh\.com|pphosted|ppe-hosted|mimecast|barracuda|cudamail|"
                        r"messagelabs|iphmx|ironport|trendmicro|sophos|forcepoint|mailcontrol|securence|everycloud|"
                        r"spamtitan|mailguard|libraesva|zerospam|cloudmark", re.I)
IMPERSONATION_SFTY = {"9.19", "9.20"}
IMPERSONATION_CAT = {"DIMP", "UIMP", "BIMP", "GIMP"}
SPAM_SFV = {"SPM", "SKS", "SKB"}
BYPASS_SFV = {"SKA": "lista de remitentes/dominios permitidos de la política antispam",
              "SFE": "lista de remitentes seguros del propio usuario",
              "SKN": "regla de flujo de correo (transport rule) que lo marcó como no spam",
              "SKI": "mensaje tratado como interno del tenant",
              "SKQ": "liberado manualmente desde cuarentena"}


def _target_message(m: dict) -> tuple[dict, str]:
    """En reportes reenviados se evalúa el correo original adjunto."""
    if m.get("mensajes_adjuntos"):
        return m["mensajes_adjuntos"][0], "Mensaje adjunto 1"
    return m, "Mensaje"


def _gateway_hop(target: dict) -> str | None:
    """Pasarela de terceros que entregó el correo a Microsoft 365, si la hay."""
    hops = target["ruta"]["saltos"]
    for i, hop in enumerate(hops):
        if (hop.get("por") or "").lower().endswith("protection.outlook.com"):
            # El salto que entrega a M365 y los anteriores.
            for prev in reversed(hops[: i + 1]):
                for host in (prev.get("desde"), prev.get("helo")):
                    if host and GATEWAY_RE.search(host):
                        return GATEWAY_RE.search(host).group(0)
            break
    for ff in target["microsoft"]["forefront"]:
        for key in ("H", "PTR"):
            if ff.get(key) and GATEWAY_RE.search(ff[key]):
                return GATEWAY_RE.search(ff[key]).group(0)
    return None


def _destination(ms: dict) -> dict:
    """Carpeta donde terminó el correo (real si M365 lo informa; si no, inferida)."""
    delivery = ms.get("entrega_buzon")
    if delivery and delivery.get("destino"):
        return {"carpeta": delivery["destino"], "fuente": "X-Microsoft-Antispam-Mailbox-Delivery",
                "motivo": delivery.get("motivo")}
    ff = ms["forefront"][0] if ms["forefront"] else {}
    if not ff:
        return {"carpeta": "No determinable con las cabeceras disponibles", "fuente": None, "motivo": None}
    sfv = (ff.get("SFV") or "").upper()
    try:
        scl = int(ff.get("SCL", "0"))
    except ValueError:
        scl = 0
    if sfv in BYPASS_SFV or scl == -1:
        carpeta = "Bandeja de entrada (omitió el filtro)"
    elif sfv in SPAM_SFV or scl >= 5:
        carpeta = "Correo no deseado o cuarentena (según la política)"
    else:
        carpeta = "Bandeja de entrada"
    return {"carpeta": carpeta + " — inferido", "fuente": "X-Forefront-Antispam-Report (SFV/SCL)", "motivo": None}


def analyze_evasion(case: dict, protected: list, own_posture: dict | None = None) -> dict | None:
    m = case.get("mensaje")
    if not m:
        return None
    target, scope = _target_message(m)
    codes = {f["codigo"] for f in case["hallazgos"] if f["ambito"] == scope}
    auth = target["autenticacion_resumen"]

    def result(method):
        return (auth.get(method) or {}).get("resultado")

    dmarc, spf, dkim = result("dmarc"), result("spf"), result("dkim")
    comp = auth.get("compauth") or {}
    dmarc_props = (auth.get("dmarc") or {}).get("propiedades", {})
    dmarc_action = (dmarc_props.get("action") or "").lower()
    from_dom = target["remitente"].get("dominio") or ""
    own = any(same_org(from_dom, p) for p in protected)
    dom_info = case.get("dominios", {}).get(from_dom) or {}
    published_p = ((dom_info.get("dmarc") or {}).get("p")) if "consultas" in dom_info else None
    if own and own_posture and "consultas" in own_posture:
        published_p = (own_posture.get("dmarc") or {}).get("p")
    reported_p = (auth.get("dmarc") or {}).get("politica")
    ms = target["microsoft"]
    ff = ms["forefront"][0] if ms["forefront"] else {}
    is_m365 = bool(ms["forefront"]) or any("Microsoft" in r for r in target["plataforma"]["receptor"])
    auth_failed = dmarc in ("fail", "permerror") or comp.get("resultado") == "fail"

    # ------------------------------------------------------------ Tipo de suplantación
    techniques = []
    if own and (auth_failed or "INTERNO_EXTERNO" in codes or dmarc == "fail"):
        techniques.append(("Spoofing directo del dominio propio",
                           f"El From usa {from_dom} (dominio de la organización) sin estar autorizado."))
    if "FROM_PARECIDO" in codes:
        techniques.append(("Dominio parecido (lookalike)", f"{from_dom} imita a un dominio protegido."))
    if auth_failed and not own and "FROM_PARECIDO" not in codes:
        techniques.append(("Spoofing directo de un dominio externo",
                           f"El From usa {from_dom} pero la autenticación del dominio falló."))
    if codes & {"VIP_SUPLANTADO", "NOMBRE_MARCA", "NOMBRE_CON_CORREO"}:
        techniques.append(("Suplantación del nombre visible",
                           f"Nombre mostrado: '{target['remitente'].get('nombre_visible') or ''}'."))
    if codes & {"GRATUITO_CARGO", "FROM_DESECHABLE"}:
        techniques.append(("Cuenta gratuita o desechable con identidad falsa", from_dom))
    if codes & {"REPLY_GRATUITO", "REPLY_PARECIDO", "REPLY_DISTINTO"}:
        reply = (target.get("reply_to") or {}).get("direccion")
        techniques.append(("Desvío de respuestas (Reply-To)", f"Las respuestas van a {reply}."))
    risky = codes & {"URL_RIESGO", "ADJUNTO", "PATRON_BEC", "PATRON_CREDENCIALES", "FORM_PASSWORD", "QR"}
    if dmarc == "pass" and not techniques and risky and "FROM_GRATUITO" not in codes:
        techniques.append(("Posible cuenta o servidor legítimo comprometido",
                           f"{from_dom} está autenticado (DMARC pass) pero el contenido es malicioso."))
    primary = techniques[0] if techniques else ("Sin suplantación evidente", "No se observó suplantación de identidad.")

    # ------------------------------------------------------------ Vías de evasión
    vias = []

    def via(control, severity, how, evidence, action):
        vias.append({"control": control, "severidad": severity, "como": how, "evidencia": evidence, "accion": action})

    weak_policy = (published_p in (None, "none") and "consultas" in dom_info) or reported_p == "none" or \
        (dmarc == "fail" and dmarc_action in ("none", ""))
    if (auth_failed or dmarc == "none") and weak_policy and from_dom:
        via("Política DMARC del dominio suplantado", "alto" if own else "medio",
            f"{from_dom} no exige rechazar los correos que fallan DMARC, así que el receptor lo dejó pasar.",
            f"DMARC publicado: p={published_p or reported_p or 'no publicado/desconocido'}; resultado dmarc={dmarc or '-'}"
            f"{', action=' + dmarc_action if dmarc_action else ''}; SPF={spf or '-'}; DKIM={dkim or '-'}.",
            f"Llevar DMARC de {from_dom} a p=quarantine y luego p=reject tras revisar los reportes rua."
            if own else "Bloquear el dominio/remitente y crear una regla anti-spoofing para este dominio en el gateway/M365.")
    if dmarc_action in ("oreject", "pct.quarantine", "pct.reject") or (dmarc == "fail" and reported_p in ("reject", "quarantine")
                                                                       and dmarc_action not in ("reject", "quarantine")):
        via("Acción ante DMARC fallido en el receptor", "alto",
            "El dominio pide rechazar/cuarentenar, pero el receptor aplicó una acción más permisiva (override).",
            f"dmarc=fail con política del dominio p={reported_p or '-'} y action={dmarc_action or '-'}.",
            "En Defender > Anti-phishing, configurar 'Respetar la política DMARC' con acción Rechazar/Cuarentena para p=reject y p=quarantine.")
    if dmarc in ("fail", "none") and comp.get("resultado") in ("pass", "softpass"):
        via("Autenticación implícita de Microsoft (compauth)", "alto",
            "Microsoft 365 aprobó el correo por su autenticación compuesta a pesar del resultado DMARC.",
            f"compauth={comp.get('resultado')} reason={comp.get('propiedades', {}).get('reason', '-')} con dmarc={dmarc}.",
            "Revisar Spoof Intelligence (Defender > Información de suplantación) y bloquear el par remitente/infraestructura.")
    if "FROM_PARECIDO" in codes and not auth_failed:
        via("Autenticación SPF/DKIM/DMARC", "alto",
            "El atacante registró un dominio parecido y lo autenticó correctamente: SPF, DKIM y DMARC solo prueban que "
            "el remitente controla SU dominio, no que se parezca al legítimo.",
            f"{from_dom}: SPF={spf or '-'}, DKIM={dkim or '-'}, DMARC={dmarc or '-'}.",
            "Agregar los dominios propios a 'Dominios protegidos' de la política anti-phishing (domain impersonation) y "
            "bloquear el dominio parecido en la Tenant Allow/Block List, proxy y DNS.")
    impersonation = codes & {"VIP_SUPLANTADO", "NOMBRE_MARCA", "FROM_PARECIDO", "GRATUITO_CARGO"}
    if impersonation and is_m365 and ff.get("SFTY") not in IMPERSONATION_SFTY and (ff.get("CAT") or "").upper() not in IMPERSONATION_CAT:
        via("Protección contra suplantación (Defender anti-phishing)", "alto",
            "La protección de usuarios y dominios suplantados no se activó: Microsoft no marcó el correo como suplantación.",
            f"SFTY={ff.get('SFTY') or '-'}, CAT={ff.get('CAT') or '-'}; indicadores de suplantación: {', '.join(sorted(impersonation))}.",
            "Incluir a los miembros de la Junta Directiva y la Alta Gerencia en 'Usuarios protegidos', activar inteligencia "
            "de buzón y la protección de dominios propios, con acción Cuarentena y consejos de seguridad visibles.")
    sfv = (ff.get("SFV") or "").upper()
    try:
        scl = int(ff.get("SCL", "0"))
    except ValueError:
        scl = 0
    if sfv in BYPASS_SFV or scl == -1:
        via("Filtro antispam/antiphishing", "alto",
            f"El correo omitió el filtrado por una excepción: {BYPASS_SFV.get(sfv, 'regla que fijó SCL=-1')}.",
            f"SFV={sfv or '-'}, SCL={ff.get('SCL', '-')}"
            f"{'; se ejecutaron reglas de transporte' if ms.get('regla_transporte') else ''}.",
            "Auditar la Tenant Allow/Block List, los remitentes/dominios permitidos de la política antispam y las reglas de "
            "flujo que fijan SCL=-1; eliminar permisos amplios (p. ej. dominios gratuitos o del propio dominio).")
    destination = _destination(ms) if is_m365 else {"carpeta": "No informado por la plataforma", "fuente": None, "motivo": None}
    flagged = sfv in SPAM_SFV or scl >= 5 or (ff.get("CAT") or "").upper() in {"PHSH", "HPHSH", "HPHISH", "SPOOF", "MALW"} | IMPERSONATION_CAT
    if flagged and destination["carpeta"].startswith("Bandeja de entrada"):
        via("Acción de la política sobre el veredicto", "alto",
            "Microsoft detectó el correo como amenaza/spam, pero igual se entregó en la bandeja de entrada.",
            f"CAT={ff.get('CAT') or '-'}, SFV={sfv or '-'}, SCL={ff.get('SCL', '-')}; destino: {destination['carpeta']}"
            f"{' (motivo ' + destination['motivo'] + ')' if destination.get('motivo') else ''}.",
            "Configurar Phishing y Phishing de alta confianza con acción 'Poner en cuarentena' y revisar remitentes seguros "
            "de los usuarios y reglas de buzón.")
    elif flagged and "no deseado" in destination["carpeta"].lower():
        via("Acción de la política sobre el veredicto", "medio",
            "El correo llegó a Correo no deseado: sigue siendo accesible y el usuario puede abrirlo desde allí.",
            f"CAT={ff.get('CAT') or '-'}, SFV={sfv or '-'}, SCL={ff.get('SCL', '-')}.",
            "Para phishing, preferir 'Poner en cuarentena' en lugar de 'Mover a correo no deseado'.")
    gateway = _gateway_hop(target) if is_m365 else None
    if gateway:
        via("Gateway de correo de terceros delante de Microsoft 365", "medio",
            f"El correo llegó a M365 a través de {gateway}; si el conector no tiene 'Enhanced Filtering', Microsoft evalúa "
            "SPF/DMARC contra la IP del gateway y pierde la IP real del atacante, lo que degrada la detección de spoofing.",
            f"Salto previo a protection.outlook.com identificado como {gateway}; CIP={ff.get('CIP') or '-'}.",
            "Habilitar Enhanced Filtering for Connectors (skip listing) en el conector de entrada del gateway, o "
            "aplicar DMARC/anti-spoofing estricto en el propio gateway.")
    if "INTERNO_EXTERNO" in codes and comp.get("resultado") != "fail":
        via("Anti-spoofing intraorganizacional", "alto",
            "Un correo externo usó el dominio propio en el From y no fue bloqueado como suplantación interna.",
            f"AuthAs=Anonymous, compauth={comp.get('resultado') or '-'}, dmarc={dmarc or '-'}.",
            "Bloquear en Spoof Intelligence el envío del dominio propio desde infraestructura no autorizada y exigir DMARC p=reject.")
    if codes & {"FROM_GRATUITO", "GRATUITO_CARGO"} or ("Gmail / Google Workspace" in target["plataforma"]["emisor"] and dmarc == "pass"):
        via("Reputación del remitente", "medio",
            "Se envió desde un proveedor de alta reputación (p. ej. Gmail/Outlook.com): SPF, DKIM y DMARC aprueban y los "
            "filtros confían en sus IPs.",
            f"Remitente {target['remitente'].get('direccion') or '-'}; DMARC={dmarc or '-'}.",
            "Etiquetar los correos externos ([EXTERNO]) y mostrar el consejo de primer contacto; capacitar sobre cuentas gratuitas que usan cargos.")
    if any(t[0].startswith("Posible cuenta") for t in techniques):
        via("Confianza en remitentes autenticados", "alto",
            "El correo provino de un dominio legítimo y autenticado: la autenticación no detecta una cuenta comprometida.",
            f"{from_dom}: DMARC=pass con contenido malicioso.",
            "Notificar a la organización remitente, bloquear temporalmente el remitente y buscar otros mensajes del mismo origen.")
    evasive = []
    for u in target["urls"]:
        host = u.get("host") or ""
        if u.get("capas"):
            evasive.append(f"enlace envuelto ({' > '.join(u['capas'])}) hacia {host}")
        if host in SHORTENERS or u.get("dominio") in SHORTENERS:
            evasive.append(f"acortador {host}")
        for service, name in ABUSED_SERVICES.items():
            if host == service or host.endswith("." + service):
                evasive.append(f"servicio legítimo {name} ({host})")
                break
    if target["qr"]:
        evasive.append("código QR (el enlace no es analizable por los filtros de URL y se abre en el celular)")
    for a in target["adjuntos"]:
        texts = " ".join(i["texto"] for i in a["indicadores"])
        if re.search(r"HTML|SVG|contraseña|cifrado|Imagen de disco|smuggling", texts, re.I):
            evasive.append(f"adjunto {a['nombre']}")
    if target["cuerpo"]["trucos_html"]:
        evasive += target["cuerpo"]["trucos_html"]
    if evasive:
        via("Análisis de enlaces y adjuntos (Safe Links / Safe Attachments)", "medio",
            "El contenido malicioso se ocultó tras elementos que los filtros no bloquean o no pueden analizar a tiempo.",
            "; ".join(dict.fromkeys(evasive))[:600] + ".",
            "Activar Safe Links con verificación al clic y Safe Attachments en modo bloqueo; bloquear adjuntos .html/.htm/.svg "
            "con el filtro de tipos de archivo; concientizar sobre QR.")
    if codes & {"DOMINIO_NUEVO", "DOMINIO_RECIENTE"}:
        via("Reputación del dominio", "medio",
            "El dominio es muy reciente: aún no figura en listas de bloqueo ni tiene reputación negativa.",
            next((f["titulo"] for f in case["hallazgos"] if f["codigo"] in ("DOMINIO_NUEVO", "DOMINIO_RECIENTE")), ""),
            "Bloquear dominios registrados recientemente (<30 días) en el proxy/DNS y monitorear dominios parecidos a los propios.")

    # ------------------------------------------------------------ Postura del dominio propio
    posture = []
    if own_posture and "consultas" in own_posture:
        name = own_posture["dominio"]
        p = (own_posture.get("dmarc") or {}).get("p")
        if p in (None, "none"):
            posture.append(f"{name} publica DMARC {'p=none' if p else '(ausente)'}: un atacante puede enviar como "
                           f"usuario@{name} a proveedores, clientes o al correo personal de los directivos sin ser rechazado.")
        spf_all = (own_posture.get("spf") or {}).get("all")
        if spf_all in ("~all", "?all", "+all"):
            posture.append(f"SPF de {name} termina en {spf_all}: no indica rechazo explícito de servidores no autorizados.")
        providers = own_posture.get("proveedor_correo") or []
        if providers and not any("Microsoft 365" in x for x in providers) and (own_posture.get("microsoft_tenant") or {}).get("estado") == "ok":
            posture.append(f"El MX de {name} apunta a {', '.join(providers)} delante de Microsoft 365: verificar que el conector "
                           "tenga Enhanced Filtering habilitado.")
    return {"mensaje_evaluado": scope, "tipo_suplantacion": {"tipo": primary[0], "detalle": primary[1]},
            "tecnicas": [{"tipo": t, "detalle": d} for t, d in techniques], "destino": destination,
            "vias": vias, "postura_propia": posture}

