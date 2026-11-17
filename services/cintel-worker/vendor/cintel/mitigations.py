"""Mapeo a MITRE ATT&CK y plan de mitigación priorizado.

Cada hallazgo se relaciona con técnicas de MITRE ATT&CK (Enterprise) y con
controles concretos para Microsoft 365 / Entra ID, DNS, el gateway de correo,
los procesos internos y la concientización. Las referencias apuntan a fuentes
oficiales (Microsoft Learn, RFC, CISA, MITRE) y a herramientas open source
reconocidas que complementan a `cintel`.
"""
from __future__ import annotations

# --------------------------------------------------------------------------
# MITRE ATT&CK (Enterprise)
# --------------------------------------------------------------------------
ATTACK = {
    "T1566": ("Phishing", "https://attack.mitre.org/techniques/T1566/"),
    "T1566.001": ("Phishing: Spearphishing Attachment", "https://attack.mitre.org/techniques/T1566/001/"),
    "T1566.002": ("Phishing: Spearphishing Link", "https://attack.mitre.org/techniques/T1566/002/"),
    "T1566.004": ("Phishing: Spearphishing Voice", "https://attack.mitre.org/techniques/T1566/004/"),
    "T1598": ("Phishing for Information", "https://attack.mitre.org/techniques/T1598/"),
    "T1656": ("Impersonation", "https://attack.mitre.org/techniques/T1656/"),
    "T1583.001": ("Acquire Infrastructure: Domains", "https://attack.mitre.org/techniques/T1583/001/"),
    "T1586.002": ("Compromise Accounts: Email Accounts", "https://attack.mitre.org/techniques/T1586/002/"),
    "T1557": ("Adversary-in-the-Middle", "https://attack.mitre.org/techniques/T1557/"),
    "T1528": ("Steal Application Access Token", "https://attack.mitre.org/techniques/T1528/"),
    "T1204.001": ("User Execution: Malicious Link", "https://attack.mitre.org/techniques/T1204/001/"),
    "T1204.002": ("User Execution: Malicious File", "https://attack.mitre.org/techniques/T1204/002/"),
    "T1187": ("Forced Authentication", "https://attack.mitre.org/techniques/T1187/"),
    "T1027": ("Obfuscated Files or Information", "https://attack.mitre.org/techniques/T1027/"),
    "T1027.006": ("Obfuscated Files or Information: HTML Smuggling", "https://attack.mitre.org/techniques/T1027/006/"),
}

CODE_TO_ATTACK = {
    "DMARC_FAIL": ["T1566"], "COMPAUTH_FAIL": ["T1566"], "INTERNO_EXTERNO": ["T1566"], "SIN_ALINEACION": ["T1566"],
    "FROM_PARECIDO": ["T1583.001", "T1656"], "DOMINIO_PARECIDO": ["T1583.001"], "REPLY_PARECIDO": ["T1583.001"],
    "DOMINIO_NUEVO": ["T1583.001"], "PARECIDO_LIBRE": ["T1583.001"],
    "VIP_SUPLANTADO": ["T1656"], "NOMBRE_MARCA": ["T1656"], "MARCA_SUPLANTADA": ["T1656"], "GRATUITO_CARGO": ["T1656"],
    "NOMBRE_CON_CORREO": ["T1656"], "REPLY_GRATUITO": ["T1656"], "PATRON_BEC": ["T1656", "T1566"],
    "HILO_SECUESTRADO": ["T1586.002"],
    "URL_RIESGO": ["T1566.002", "T1204.001"], "URL_MEDIO": ["T1566.002"], "QR": ["T1566.002"],
    "AITM_ENLACE_PERSONALIZADO": ["T1557", "T1566.002"], "KIT_LOGIN_M365": ["T1557", "T1598"],
    "CAPTCHA_EVASION": ["T1557", "T1566.002"],
    "PATRON_CREDENCIALES": ["T1598"], "FORM_PASSWORD": ["T1598"], "FORM_CUERPO": ["T1598"],
    "ADJUNTO": ["T1566.001", "T1204.002"],
    "OAUTH_CONSENTIMIENTO": ["T1528"], "CODIGO_DISPOSITIVO": ["T1528"],
    "CALLBACK_TOAD": ["T1566.004"],
    "PROTOCOLO_PELIGROSO": ["T1187", "T1204.001"],
    "TRUCO_HTML": ["T1027"], "ALFABETOS_MEZCLADOS": ["T1027"],
}

# --------------------------------------------------------------------------
# Catálogo de mitigaciones
# --------------------------------------------------------------------------
ML = "https://learn.microsoft.com"
MITIGATIONS = {
    "DMARC_REJECT": {
        "titulo": "DMARC en p=reject para todos los dominios propios", "plataforma": "DNS / correo", "prioridad": 1,
        "pasos": ["Publicar DMARC con rua y analizar los reportes agregados (parsedmarc) hasta identificar todos los remitentes legítimos.",
                  "Alinear SPF y DKIM de cada servicio que envía en nombre del dominio (M365, marketing, sistemas).",
                  "Escalar p=none → p=quarantine (pct gradual) → p=reject, con sp=reject para subdominios.",
                  "Dominios que no envían correo: SPF 'v=spf1 -all', DMARC p=reject y MX nulo."],
        "refs": [("RFC 7489 · DMARC", "https://www.rfc-editor.org/rfc/rfc7489"),
                 ("Microsoft · Configurar DMARC", f"{ML}/defender-office-365/email-authentication-dmarc-configure"),
                 ("CISA · BOD 18-01", "https://www.cisa.gov/news-events/directives/bod-18-01-enhance-email-and-web-security")],
        "oss": ["checkdmarc", "parsedmarc"],
    },
    "SPF_DKIM": {
        "titulo": "SPF estricto (-all) y DKIM 2048 bits en todos los dominios", "plataforma": "DNS / Microsoft 365", "prioridad": 2,
        "pasos": ["Terminar SPF en '-all' y mantenerlo por debajo de 10 consultas DNS.",
                  "Habilitar la firma DKIM de Microsoft 365 (CNAME selector1/selector2) con clave de 2048 bits para cada dominio aceptado."],
        "refs": [("Microsoft · Configurar DKIM", f"{ML}/defender-office-365/email-authentication-dkim-configure"),
                 ("Microsoft · Configurar SPF", f"{ML}/defender-office-365/email-authentication-spf-configure")],
        "oss": ["checkdmarc"],
    },
    "SPOOF_INTEL": {
        "titulo": "Bloquear la suplantación con Spoof Intelligence", "plataforma": "Microsoft Defender for Office 365", "prioridad": 1,
        "pasos": ["Revisar la información de suplantación (Spoof intelligence insight) y bloquear los pares remitente/infraestructura no autorizados.",
                  "Activar 'Respetar la política DMARC del remitente' en la política anti-phishing con acciones Cuarentena/Rechazar."],
        "refs": [("Microsoft · Spoof intelligence", f"{ML}/defender-office-365/anti-spoofing-spoof-intelligence"),
                 ("Microsoft · Políticas anti-phishing", f"{ML}/defender-office-365/anti-phishing-policies-about")],
        "oss": [],
    },
    "IMPERSONATION": {
        "titulo": "Protección contra suplantación de usuarios y dominios (Junta Directiva y Gerencia)",
        "plataforma": "Microsoft Defender for Office 365", "prioridad": 1,
        "pasos": ["Agregar a los miembros de la Junta Directiva, Alta Gerencia, Tesorería y Finanzas a 'Usuarios que se protegerán'.",
                  "Incluir los dominios propios ('Incluir dominios que poseo') y los de socios críticos en 'Dominios que se protegerán'.",
                  "Activar inteligencia de buzón y protección por inteligencia de buzón; acción: Poner en cuarentena.",
                  "Mostrar los consejos de seguridad de primer contacto, usuario y dominio suplantado.",
                  "Aplicar la directiva de seguridad preestablecida Estricta a los usuarios VIP."],
        "refs": [("Microsoft · Políticas anti-phishing", f"{ML}/defender-office-365/anti-phishing-policies-about"),
                 ("Microsoft · Directivas preestablecidas", f"{ML}/defender-office-365/preset-security-policies")],
        "oss": [],
    },
    "PRESET_STRICT": {
        "titulo": "Directivas de seguridad preestablecidas y acciones de cuarentena", "plataforma": "Microsoft Defender for Office 365",
        "prioridad": 1,
        "pasos": ["Aplicar la directiva preestablecida Estándar a toda la organización y Estricta a VIP y áreas de pagos.",
                  "Configurar Phishing y Phishing de alta confianza con acción 'Poner en cuarentena' (no 'Mover a no deseado').",
                  "Mantener activada la purga automática de hora cero (ZAP) para spam, phishing y malware."],
        "refs": [("Microsoft · Directivas preestablecidas", f"{ML}/defender-office-365/preset-security-policies"),
                 ("Microsoft · Zero-hour auto purge", f"{ML}/defender-office-365/zero-hour-auto-purge")],
        "oss": [],
    },
    "ALLOWLIST": {
        "titulo": "Eliminar excepciones amplias del filtrado", "plataforma": "Microsoft 365 / Exchange Online", "prioridad": 1,
        "pasos": ["Auditar la Tenant Allow/Block List, los remitentes y dominios permitidos de las políticas antispam y las reglas de flujo que fijan SCL=-1.",
                  "Nunca permitir dominios propios, dominios gratuitos ni dominios completos de terceros; usar entradas puntuales con caducidad.",
                  "Revisar las listas de remitentes seguros de los usuarios VIP."],
        "refs": [("Microsoft · Listas de remitentes seguros", f"{ML}/defender-office-365/create-safe-sender-lists-in-office-365"),
                 ("Microsoft · Tenant Allow/Block List", f"{ML}/defender-office-365/tenant-allow-block-list-about")],
        "oss": [],
    },
    "ENHANCED_FILTERING": {
        "titulo": "Enhanced Filtering for Connectors con el gateway de terceros", "plataforma": "Exchange Online + gateway",
        "prioridad": 1,
        "pasos": ["Habilitar Enhanced Filtering (skip listing) en el conector de entrada del gateway para que M365 evalúe SPF/DMARC con la IP real.",
                  "Restringir el conector de entrada para aceptar correo solo desde las IPs del gateway.",
                  "Aplicar también DMARC y anti-spoofing estrictos en el gateway."],
        "refs": [("Microsoft · Enhanced Filtering for Connectors",
                  f"{ML}/exchange/mail-flow-best-practices/use-connectors-to-configure-mail-flow/enhanced-filtering-for-connectors")],
        "oss": [],
    },
    "SAFE_LINKS": {
        "titulo": "Safe Links con verificación al clic", "plataforma": "Microsoft Defender for Office 365", "prioridad": 2,
        "pasos": ["Activar Safe Links para correo, Teams y apps de Office, con análisis de URL en tiempo real y esperar el análisis antes de entregar.",
                  "No permitir que los usuarios continúen hacia la URL original y registrar los clics.",
                  "Complementar con el bloqueo de categorías de 'dominios recién registrados' en el proxy web."],
        "refs": [("Microsoft · Safe Links", f"{ML}/defender-office-365/safe-links-about")],
        "oss": [],
    },
    "SAFE_ATTACHMENTS": {
        "titulo": "Safe Attachments y filtro de tipos de archivo", "plataforma": "Microsoft Defender for Office 365", "prioridad": 2,
        "pasos": ["Safe Attachments en modo Bloquear (o Entrega dinámica para no retrasar el correo).",
                  "Activar el filtro de archivos adjuntos comunes y agregar html, htm, shtml, svg, iso, img, vhd, vhdx, lnk, one, js, wsf, hta y otros ejecutables."],
        "refs": [("Microsoft · Safe Attachments", f"{ML}/defender-office-365/safe-attachments-about"),
                 ("Microsoft · Protección antimalware", f"{ML}/defender-office-365/anti-malware-protection-about")],
        "oss": ["YARA"],
    },
    "EXTERNAL_TAG": {
        "titulo": "Identificar visiblemente el correo externo", "plataforma": "Exchange Online / Outlook", "prioridad": 2,
        "pasos": ["Activar la etiqueta 'Externo' de Outlook: Set-ExternalInOutlook -Enabled $true.",
                  "Mantener activo el consejo de seguridad de primer contacto."],
        "refs": [("Microsoft · Set-ExternalInOutlook", f"{ML}/powershell/module/exchangepowershell/set-externalinoutlook")],
        "oss": [],
    },
    "PHISHING_RESISTANT_MFA": {
        "titulo": "MFA resistente al phishing y protección de sesiones (contra AiTM)", "plataforma": "Microsoft Entra ID",
        "prioridad": 1,
        "pasos": ["Exigir con Acceso condicional la fuerza de autenticación 'MFA resistente a phishing' (FIDO2/passkeys, Windows Hello, certificados) para directivos, administradores y pagos.",
                  "Exigir dispositivo conforme o unido a Entra ID para acceder a M365: un token robado por AiTM no sirve desde el equipo del atacante.",
                  "Bloquear la autenticación heredada y evaluar Token Protection."],
        "refs": [("Microsoft · Fuerzas de autenticación", f"{ML}/entra/identity/authentication/concept-authentication-strengths"),
                 ("Microsoft · Token protection", f"{ML}/entra/identity/conditional-access/concept-token-protection")],
        "oss": [],
    },
    "OAUTH_CONSENT": {
        "titulo": "Restringir el consentimiento de aplicaciones OAuth", "plataforma": "Microsoft Entra ID", "prioridad": 1,
        "pasos": ["Configurar el consentimiento de usuarios en 'No permitir' o solo para publicadores verificados con permisos de bajo impacto.",
                  "Habilitar el flujo de solicitud de consentimiento de administrador.",
                  "Revisar periódicamente las aplicaciones empresariales con permisos Mail.*, Files.* u offline_access."],
        "refs": [("Microsoft · Configurar el consentimiento de usuarios", f"{ML}/entra/identity/enterprise-apps/configure-user-consent"),
                 ("Microsoft · Flujo de consentimiento de administrador", f"{ML}/entra/identity/enterprise-apps/configure-admin-consent-workflow")],
        "oss": [],
    },
    "DEVICE_CODE": {
        "titulo": "Bloquear el flujo de código de dispositivo", "plataforma": "Microsoft Entra ID", "prioridad": 1,
        "pasos": ["Crear una directiva de Acceso condicional que bloquee 'Flujos de autenticación > Flujo de código de dispositivo' para todos, salvo excepciones justificadas."],
        "refs": [("Microsoft · Bloquear flujos de autenticación", f"{ML}/entra/identity/conditional-access/policy-block-authentication-flows")],
        "oss": [],
    },
    "FORWARDING": {
        "titulo": "Bloquear el reenvío automático externo y vigilar reglas de buzón", "plataforma": "Microsoft 365", "prioridad": 2,
        "pasos": ["En la directiva de spam saliente, fijar 'Reglas de reenvío automático' en Desactivado.",
                  "Alertar sobre la creación de reglas de bandeja sospechosas (reenvío, borrado, mover a RSS)."],
        "refs": [("Microsoft · Reenvío externo", f"{ML}/defender-office-365/outbound-spam-policies-external-email-forwarding")],
        "oss": [],
    },
    "LOOKALIKE_MONITORING": {
        "titulo": "Vigilancia y registro defensivo de dominios parecidos", "plataforma": "DNS / marca", "prioridad": 2,
        "pasos": ["Ejecutar periódicamente 'cintel --vigilar qapaq.pe' (o dnstwist) para detectar dominios parecidos registrados.",
                  "Registrar preventivamente las variantes más probables (otras extensiones, guiones, errores tipográficos).",
                  "Bloquear los dominios detectados en correo, proxy y DNS, y solicitar su baja al registrador."],
        "refs": [("dnstwist", "https://github.com/elceef/dnstwist")],
        "oss": ["dnstwist"],
    },
    "PROTOCOL_HANDLERS": {
        "titulo": "Bloquear protocolos peligrosos y fugas NTLM", "plataforma": "Endpoints / red", "prioridad": 1,
        "pasos": ["Deshabilitar por GPO/Intune los manejadores de protocolo no usados (ms-msdt, search-ms) según la guía de Microsoft para CVE-2022-30190.",
                  "Bloquear SMB saliente (TCP 445) hacia Internet para evitar la filtración de hashes NTLM por enlaces file:// o \\\\servidor."],
        "refs": [("MSRC · CVE-2022-30190 (MSDT) y su mitigación", "https://msrc.microsoft.com/update-guide/vulnerability/CVE-2022-30190")],
        "oss": [],
    },
    "BEC_PROCESS": {
        "titulo": "Control de proceso contra fraude del CEO (BEC)", "plataforma": "Procesos (Tesorería / Finanzas)", "prioridad": 1,
        "pasos": ["Toda solicitud de pago urgente, confidencial o de cambio de cuenta bancaria se valida por un canal alterno (llamada al número registrado, nunca al del correo).",
                  "Doble aprobación para pagos fuera de lo habitual y para altas/cambios de cuentas de proveedores.",
                  "Comunicar a la Junta Directiva y Gerencia que nunca solicitarán pagos solo por correo o mensajería."],
        "refs": [("FBI · Business Email Compromise",
                  "https://www.fbi.gov/how-we-can-help-you/scams-and-safety/common-scams-and-crimes/business-email-compromise")],
        "oss": [],
    },
    "AWARENESS": {
        "titulo": "Reporte de usuarios y simulaciones de phishing", "plataforma": "Concientización", "prioridad": 3,
        "pasos": ["Habilitar el botón Reportar de Outlook enviando los reportes a un buzón del área (cintel puede analizarlos en lote).",
                  "Realizar simulaciones periódicas (Attack simulation training o GoPhish) que incluyan QR, código de dispositivo, callback y fraude del CEO.",
                  "Capacitación específica para la Junta Directiva y asistentes de dirección."],
        "refs": [("Microsoft · Attack simulation training", f"{ML}/defender-office-365/attack-simulation-training-get-started"),
                 ("GoPhish", "https://getgophish.com/")],
        "oss": ["GoPhish"],
    },
    "INCIDENT_RESPONSE": {
        "titulo": "Contención del incidente y búsqueda de otros destinatarios", "plataforma": "SOC / Defender", "prioridad": 1,
        "pasos": ["Buscar el mensaje por Network-Message-Id, remitente, asunto o URL en el Explorador de amenazas y purgar todas las copias.",
                  "Bloquear los IOCs (iocs.csv / STIX / MISP) en correo, proxy, DNS y EDR.",
                  "Si hubo clic o credenciales: restablecer contraseña, revocar sesiones, revisar MFA, reglas de buzón y consentimientos OAuth."],
        "refs": [("Microsoft · Investigar y responder", f"{ML}/defender-office-365/threat-explorer-real-time-detections-about"),
                 ("MISP", "https://www.misp-project.org/")],
        "oss": ["MISP", "TheHive"],
    },
}

CODE_TO_MITIGATION = {
    "DMARC_FAIL": ["SPOOF_INTEL"], "COMPAUTH_FAIL": ["SPOOF_INTEL"], "INTERNO_EXTERNO": ["SPOOF_INTEL", "DMARC_REJECT"],
    "DMARC_PROPIO_DEBIL": ["DMARC_REJECT", "SPF_DKIM"], "SIN_ALINEACION": ["SPOOF_INTEL"],
    "FROM_PARECIDO": ["IMPERSONATION", "LOOKALIKE_MONITORING"], "DOMINIO_PARECIDO": ["LOOKALIKE_MONITORING"],
    "REPLY_PARECIDO": ["IMPERSONATION", "LOOKALIKE_MONITORING"], "PARECIDO_LIBRE": ["LOOKALIKE_MONITORING"],
    "DOMINIO_NUEVO": ["SAFE_LINKS", "LOOKALIKE_MONITORING"],
    "VIP_SUPLANTADO": ["IMPERSONATION", "BEC_PROCESS", "EXTERNAL_TAG"], "NOMBRE_MARCA": ["IMPERSONATION", "EXTERNAL_TAG"],
    "GRATUITO_CARGO": ["EXTERNAL_TAG", "BEC_PROCESS"], "REPLY_GRATUITO": ["BEC_PROCESS", "EXTERNAL_TAG"],
    "PATRON_BEC": ["BEC_PROCESS", "IMPERSONATION"], "HILO_SECUESTRADO": ["BEC_PROCESS", "AWARENESS"],
    "MARCA_SUPLANTADA": ["IMPERSONATION", "AWARENESS"], "MARCA_EN_ASUNTO": ["AWARENESS"],
    "URL_RIESGO": ["SAFE_LINKS", "PHISHING_RESISTANT_MFA"], "QR": ["AWARENESS", "PHISHING_RESISTANT_MFA"],
    "CAPTCHA_EVASION": ["PHISHING_RESISTANT_MFA", "SAFE_LINKS"],
    "AITM_ENLACE_PERSONALIZADO": ["PHISHING_RESISTANT_MFA", "SAFE_LINKS"], "KIT_LOGIN_M365": ["PHISHING_RESISTANT_MFA", "SAFE_ATTACHMENTS"],
    "PATRON_CREDENCIALES": ["PHISHING_RESISTANT_MFA"], "FORM_PASSWORD": ["PHISHING_RESISTANT_MFA", "SAFE_ATTACHMENTS"],
    "ADJUNTO": ["SAFE_ATTACHMENTS"], "OAUTH_CONSENTIMIENTO": ["OAUTH_CONSENT"], "CODIGO_DISPOSITIVO": ["DEVICE_CODE"],
    "CALLBACK_TOAD": ["AWARENESS", "BEC_PROCESS"], "PROTOCOLO_PELIGROSO": ["PROTOCOL_HANDLERS"],
    "M365_BYPASS": ["ALLOWLIST"], "M365_CAT": ["PRESET_STRICT"], "M365_CAT_CRIT": ["PRESET_STRICT"],
}

EVASION_TO_MITIGATION = {
    "Política DMARC del dominio suplantado": ["DMARC_REJECT"],
    "Acción ante DMARC fallido en el receptor": ["SPOOF_INTEL"],
    "Autenticación implícita de Microsoft (compauth)": ["SPOOF_INTEL"],
    "Autenticación SPF/DKIM/DMARC": ["IMPERSONATION", "LOOKALIKE_MONITORING"],
    "Protección contra suplantación (Defender anti-phishing)": ["IMPERSONATION"],
    "Filtro antispam/antiphishing": ["ALLOWLIST"],
    "Acción de la política sobre el veredicto": ["PRESET_STRICT"],
    "Gateway de correo de terceros delante de Microsoft 365": ["ENHANCED_FILTERING"],
    "Anti-spoofing intraorganizacional": ["SPOOF_INTEL", "DMARC_REJECT"],
    "Reputación del remitente": ["EXTERNAL_TAG"],
    "Confianza en remitentes autenticados": ["INCIDENT_RESPONSE", "BEC_PROCESS"],
    "Análisis de enlaces y adjuntos (Safe Links / Safe Attachments)": ["SAFE_LINKS", "SAFE_ATTACHMENTS"],
    "Reputación del dominio": ["LOOKALIKE_MONITORING", "SAFE_LINKS"],
}


def apply(case: dict) -> None:
    """Agrega al caso el mapeo MITRE ATT&CK (por hallazgo y global) y el plan de mitigación."""
    techniques = {}
    reasons = {}

    def need(mit_id, reason):
        reasons.setdefault(mit_id, [])
        if reason not in reasons[mit_id]:
            reasons[mit_id].append(reason)

    for finding in case["hallazgos"]:
        ids = CODE_TO_ATTACK.get(finding["codigo"], [])
        finding["mitre"] = ids
        for tid in ids:
            techniques.setdefault(tid, []).append(finding["codigo"])
        for mit_id in CODE_TO_MITIGATION.get(finding["codigo"], []):
            need(mit_id, finding["titulo"])
    for v in (case.get("evasion") or {}).get("vias", []):
        for mit_id in EVASION_TO_MITIGATION.get(v["control"], []):
            need(mit_id, f"Control superado: {v['control']}")
    if case["veredicto"]["nivel"] in ("critico", "alto") and case.get("mensaje"):
        need("INCIDENT_RESPONSE", f"Veredicto {case['veredicto']['etiqueta']}")
        need("FORWARDING", "Contención ante posible compromiso de cuentas")
        need("AWARENESS", "Campaña dirigida a la organización")

    case["mitre"] = [{"id": tid, "nombre": ATTACK[tid][0], "url": ATTACK[tid][1], "codigos": sorted(set(codes))}
                     for tid, codes in sorted(techniques.items())]
    plan = []
    for mit_id, why in reasons.items():
        item = MITIGATIONS[mit_id]
        plan.append({"id": mit_id, "titulo": item["titulo"], "plataforma": item["plataforma"], "prioridad": item["prioridad"],
                     "motivos": why[:4], "pasos": item["pasos"],
                     "referencias": [{"titulo": t, "url": u} for t, u in item["refs"]], "herramientas_oss": item["oss"]})
    plan.sort(key=lambda x: (x["prioridad"], x["titulo"]))
    case["mitigaciones"] = plan

