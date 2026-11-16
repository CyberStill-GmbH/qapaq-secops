"""Reporte PDF profesional de cada caso (reportlab).

Cada página lleva el encabezado "Qapaq Phishing Contra-inteligencia", la
clasificación CONFIDENCIAL y el pie "Authored by: Cesar Guevara — Trainee de
Riesgos No Financieros". Todos los enlaces e IOCs se muestran neutralizados
(hxxps://dominio[.]com) para evitar clics accidentales.
"""
from __future__ import annotations

import os
from html import escape as _html_escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import CondPageBreak, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from cintel.assessment import SEVERITY_LABEL
from cintel.report.markdown import defang_text
from cintel.util import defang

# Paleta institucional sobria
NAVY = colors.HexColor("#0B2545")
TEAL = colors.HexColor("#13756B")
LIGHT = colors.HexColor("#F2F5F8")
GRID = colors.HexColor("#C9D3DD")
MUTED = colors.HexColor("#5B6B7B")
SEVERITY_COLORS = {"critico": "#B00020", "alto": "#E65100", "medio": "#C77700", "bajo": "#1565C0", "info": "#607D8B"}

FONT_CANDIDATES = (
    # (regular, negrita)
    (r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\arialbd.ttf"),
    (r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\segoeuib.ttf"),
    (r"C:\Windows\Fonts\DejaVuSans.ttf", r"C:\Windows\Fonts\DejaVuSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"),
    ("/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf", "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
    ("/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf", "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf"),
    ("/usr/share/fonts/noto/NotoSans-Regular.ttf", "/usr/share/fonts/noto/NotoSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"),
    ("/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
)

_FONTS = None
_FONT_ERRORS = []  # Fuentes que no se pudieron cargar (diagnóstico)


def _fonts() -> tuple[str, str, bool]:
    """Registra una fuente TrueType con soporte Unicode; si no hay, usa Helvetica (latin-1)."""
    global _FONTS
    if _FONTS:
        return _FONTS
    windir = os.environ.get("WINDIR", r"C:\Windows")
    for regular, bold in FONT_CANDIDATES:
        regular = regular.replace(r"C:\Windows", windir)
        bold = bold.replace(r"C:\Windows", windir)
        if Path(regular).is_file() and Path(bold).is_file():
            try:
                pdfmetrics.registerFont(TTFont("CintelSans", regular))
                pdfmetrics.registerFont(TTFont("CintelSans-Bold", bold))
                pdfmetrics.registerFontFamily("CintelSans", normal="CintelSans", bold="CintelSans-Bold",
                                              italic="CintelSans", boldItalic="CintelSans-Bold")
                _FONTS = ("CintelSans", "CintelSans-Bold", True)
                return _FONTS
            except Exception as exc:  # noqa: BLE001 - fuente dañada: probar la siguiente
                _FONT_ERRORS.append(f"{regular}: {exc}")
    _FONTS = ("Helvetica", "Helvetica-Bold", False)
    return _FONTS


def _clean(text) -> str:
    """Escapa XML y, si no hay fuente Unicode, reemplaza caracteres fuera de cp1252."""
    text = "" if text is None else str(text)
    if not _fonts()[2]:
        text = text.encode("cp1252", "replace").decode("cp1252")
    # Caracteres de control rompen el PDF.
    text = "".join(c if c >= " " or c in "\n\t" else " " for c in text)
    return _html_escape(text, quote=False)


class _Styles:
    def __init__(self):
        regular, bold, _ = _fonts()
        self.regular, self.bold = regular, bold
        base = dict(fontName=regular, fontSize=8.6, leading=11.2, textColor=colors.HexColor("#1B2733"), alignment=TA_LEFT)
        self.body = ParagraphStyle("body", **base)
        self.small = ParagraphStyle("small", **{**base, "fontSize": 7.4, "leading": 9.4})
        self.mono = ParagraphStyle("mono", **{**base, "fontName": "Courier", "fontSize": 7.2, "leading": 9})
        self.cell = ParagraphStyle("cell", **{**base, "fontSize": 7.8, "leading": 9.8})
        self.cell_bold = ParagraphStyle("cellb", **{**base, "fontName": bold, "fontSize": 7.8, "leading": 9.8})
        self.title = ParagraphStyle("title", **{**base, "fontName": bold, "fontSize": 19, "leading": 23, "textColor": NAVY})
        self.subtitle = ParagraphStyle("subtitle", **{**base, "fontSize": 10.5, "leading": 14, "textColor": MUTED})
        self.h1 = ParagraphStyle("h1", **{**base, "fontName": bold, "fontSize": 12.5, "leading": 16, "textColor": NAVY,
                                          "spaceBefore": 10, "spaceAfter": 5})
        self.h2 = ParagraphStyle("h2", **{**base, "fontName": bold, "fontSize": 10, "leading": 13, "textColor": TEAL,
                                          "spaceBefore": 7, "spaceAfter": 3})
        self.verdict = ParagraphStyle("verdict", **{**base, "fontName": bold, "fontSize": 17, "leading": 21,
                                                    "textColor": colors.white})
        self.score = ParagraphStyle("score", **{**base, "fontName": bold, "fontSize": 26, "leading": 30,
                                                "textColor": colors.white, "alignment": 1})
        self.verdict_small = ParagraphStyle("verdicts", **{**base, "fontSize": 9, "leading": 12, "textColor": colors.white})


def _p(text, style, raw=False):
    return Paragraph(text if raw else _clean(text), style)


def _table(rows, widths, st, header=True, zebra=True, extra=None):
    """Tabla con estilo uniforme. `rows` puede contener strings o Paragraphs."""
    data = []
    for r_index, row in enumerate(rows):
        cells = []
        for cell in row:
            if isinstance(cell, str) or cell is None:
                cells.append(_p(cell or "-", st.cell_bold if header and r_index == 0 else st.cell))
            else:
                cells.append(cell)
        data.append(cells)
    table = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, GRID),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), LIGHT)]
    if zebra:
        for i in range(1 if header else 0, len(data)):
            if i % 2 == 0:
                style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#FAFBFC")))
    table.setStyle(TableStyle(style + (extra or [])))
    return table


def _kv(pairs, st, widths=(42 * mm, 132 * mm)):
    rows = [[_p(k, st.cell_bold), v if not isinstance(v, (str, type(None))) else _p(v or "-", st.cell)] for k, v in pairs]
    t = _table(rows, list(widths), st, header=False, zebra=False,
               extra=[("BACKGROUND", (0, 0), (0, -1), LIGHT)])
    return t


def _sev_cell(sev, st):
    color = SEVERITY_COLORS.get(sev, "#607D8B")
    return Paragraph(f'<font color="{color}"><b>{_clean(SEVERITY_LABEL.get(sev, sev))}</b></font>', st.cell)


class _NumberedCanvas(rl_canvas.Canvas):
    """Canvas que conoce el total de páginas para imprimir 'Página X de Y'."""

    def __init__(self, *args, case=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved = []
        self._case = case

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self._decorate(total)
            super().showPage()
        super().save()

    def _decorate(self, total):
        regular, bold, _ = _fonts()
        width, height = A4
        tool = self._case["herramienta"]
        # Encabezado
        self.setFillColor(NAVY)
        self.rect(0, height - 15 * mm, width, 15 * mm, stroke=0, fill=1)
        self.setFillColor(TEAL)
        self.rect(0, height - 16.2 * mm, width, 1.2 * mm, stroke=0, fill=1)
        self.setFillColor(colors.white)
        self.setFont(bold, 10.5)
        self.drawString(16 * mm, height - 9.5 * mm, tool["nombre"].upper())
        self.setFont(regular, 7.5)
        self.drawRightString(width - 16 * mm, height - 7.6 * mm, "CONFIDENCIAL — USO INTERNO")
        self.drawRightString(width - 16 * mm, height - 11.4 * mm, "Riesgos No Financieros")
        # Pie de página con autoría
        self.setStrokeColor(GRID)
        self.setLineWidth(0.5)
        self.line(16 * mm, 13 * mm, width - 16 * mm, 13 * mm)
        self.setFillColor(MUTED)
        self.setFont(regular, 7)
        author = f"Authored by: {tool['autor']} — {tool['rol_autor']} · {tool['organizacion']}"
        self.drawString(16 * mm, 9 * mm, author if _fonts()[2] else author.encode("cp1252", "replace").decode("cp1252"))
        self.drawRightString(width - 16 * mm, 9 * mm, f"{self._case['id']} · Página {self._pageNumber} de {total}")


def render_pdf(case: dict, path: Path) -> Path:
    st = _Styles()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tool = case["herramienta"]
    doc = SimpleDocTemplate(
        str(path), pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=22 * mm, bottomMargin=18 * mm,
        title=f"{tool['nombre']} — {case['id']}", author=f"{tool['autor']} — {tool['rol_autor']}, {tool['organizacion']}",
        subject="Informe de análisis de correo sospechoso", creator=f"{tool['nombre']} v{tool['version']}",
        keywords="phishing, contrainteligencia, riesgos no financieros, qapaq",
    )
    story = []
    story += _cover(case, st)
    story += _findings_section(case, st)
    story += _evasion_section(case, st)
    if case.get("mensaje"):
        story += _message_sections(case["mensaje"], case, st, "Mensaje analizado")
        for index, nested in enumerate(case["mensaje"].get("mensajes_adjuntos", []), 1):
            story += [CondPageBreak(70 * mm)]
            story += _message_sections(nested, case, st, f"Mensaje adjunto N.° {index} (correo reenviado)")
    if case.get("direccion"):
        d = case["direccion"]
        story += [_p("Dirección de correo analizada", st.h1),
                  _kv([("Dirección", defang(d["direccion"])), ("Parte local", d["local"]),
                       ("Dominio", d["dominio"]), ("Dominio (Unicode)", d["dominio_unicode"]), ("Nota", d["nota"])], st)]
    if case.get("url"):
        u = case["url"]
        story += [_p("URL analizada", st.h1),
                  _kv([("URL (neutralizada)", defang(u["url"])), ("Destino final", defang(u["url_final"])),
                       ("Host", u.get("host")), ("Capas de redirección", " > ".join(u.get("capas") or []) or "-"),
                       ("Riesgo", SEVERITY_LABEL.get(u.get("riesgo"), "-"))], st)]
    story += _domain_sections(case, st)
    story += _correlation_section(case, st)
    story += _ioc_section(case, st)
    story += _recommendations(case, st)
    story += _mitigation_section(case, st)
    story += _methodology(case, st)
    doc.build(story, canvasmaker=lambda *a, **k: _NumberedCanvas(*a, case=case, **k))
    return path


def _cover(case, st):
    v = case["veredicto"]
    tool = case["herramienta"]
    m = case.get("mensaje")
    story = [Spacer(1, 2 * mm), _p("Informe de análisis de correo sospechoso", st.title),
             _p(f"{tool['nombre']} · Herramienta de contrainteligencia de Riesgos No Financieros", st.subtitle),
             Spacer(1, 5 * mm)]
    score_cell = [_p("Índice de riesgo", st.verdict_small),
                  Paragraph(f"<b>{v['indice_riesgo']}</b><font size='10'>/100</font>", st.score)]
    verdict_table = Table([[_p(v["etiqueta"], st.verdict), score_cell], [_p(v["resumen"], st.verdict_small), ""]],
                          colWidths=[130 * mm, 48 * mm])
    verdict_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(v["color"])),
        ("SPAN", (1, 0), (1, 1)), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("ALIGN", (1, 0), (1, -1), "CENTER"),
        ("LINEBEFORE", (1, 0), (1, -1), 0.8, colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(verdict_table)
    story.append(Spacer(1, 3 * mm))
    counts = v["conteo"]
    chips = [[Paragraph(f'<font color="{SEVERITY_COLORS[s]}"><b>{counts[s]}</b></font> {SEVERITY_LABEL[s].capitalize()}', st.cell)
              for s in ("critico", "alto", "medio", "bajo", "info")]]
    chip_table = Table(chips, colWidths=[35.6 * mm] * 5)
    chip_table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, GRID), ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                                    ("BACKGROUND", (0, 0), (-1, -1), LIGHT)]))
    story += [chip_table, Spacer(1, 4 * mm)]
    pairs = [("Caso", case["id"]), ("Fecha de análisis", case["generado_en"]),
             ("Objetivo", defang(case["objetivo"]) if case["tipo_objetivo"] != "mensaje" else Path(case["objetivo"]).name),
             ("Tipo de objetivo", case["tipo_objetivo"]),
             ("Consultas de red", "Sí (DNS, RDAP, descubrimiento M365)" if case["en_linea"] else "No (--sin-red)"),
             ("Dominios protegidos", ", ".join(case["dominios_protegidos"]))]
    if m and m.get("mensajes_adjuntos"):
        pairs.append(("Reportado por", defang_text(m["cabeceras"].get("from"))))
        m = m["mensajes_adjuntos"][0]
    if m:
        h = m["cabeceras"]
        pairs += [("Remitente (From)", defang_text(h.get("from"))), ("Asunto", h.get("subject")),
                  ("Fecha del correo", h.get("date")),
                  ("Plataforma receptora", ", ".join(m["plataforma"]["receptor"]) or "No identificada"),
                  ("SHA-256 evidencia", Paragraph(_clean(m["hashes"]["sha256"]) if m.get("hashes") else "-", st.mono))]
    pairs.append(("Herramienta", f"{tool['nombre']} v{tool['version']} — Authored by: {tool['autor']}, {tool['rol_autor']}"))
    story.append(_kv(pairs, st))
    return story


def _findings_section(case, st):
    story = [_p("Hallazgos", st.h1)]
    if not case["hallazgos"]:
        return story + [_p("Sin hallazgos automáticos. Se recomienda revisión humana de la evidencia.", st.body)]
    rows = [["Severidad", "Ámbito", "Hallazgo y justificación"]]
    for f in case["hallazgos"]:
        text = f"<b>{_clean(f['titulo'])}</b>" + (f"<br/>{_clean(defang_text(f['detalle']))}" if f["detalle"] else "")
        rows.append([_sev_cell(f["severidad"], st), _p(f["ambito"], st.cell), Paragraph(text, st.cell)])
    story.append(_table(rows, [20 * mm, 26 * mm, 132 * mm], st))
    return story


def _evasion_section(case, st):
    """Tipo de suplantación y controles que el correo logró superar."""
    ev = case.get("evasion")
    if not ev:
        return []
    story = [_p("Diagnóstico de suplantación y evasión de controles", st.h1)]
    tipo = ev["tipo_suplantacion"]
    pairs = [("Tipo principal", Paragraph(f"<b>{_clean(tipo['tipo'])}</b><br/>{_clean(defang_text(tipo['detalle']))}", st.cell))]
    others = [t for t in ev["tecnicas"][1:]]
    if others:
        pairs.append(("Técnicas combinadas", Paragraph("<br/>".join(
            f"• <b>{_clean(t['tipo'])}</b>: {_clean(defang_text(t['detalle']))}" for t in others), st.cell)))
    dest = ev["destino"]
    pairs.append(("Destino del correo", f"{dest['carpeta']}" + (f" · fuente: {dest['fuente']}" if dest.get("fuente") else "")))
    if ev["mensaje_evaluado"] != "Mensaje":
        pairs.append(("Mensaje evaluado", f"{ev['mensaje_evaluado']} (correo original reenviado)"))
    story.append(_kv(pairs, st))
    story.append(_p("Cómo superó los controles", st.h2))
    if ev["vias"]:
        rows = [["Control", "Cómo lo superó y evidencia", "Acción correctiva"]]
        for v in ev["vias"]:
            control = f'<font color="{SEVERITY_COLORS.get(v["severidad"], "#607D8B")}"><b>{_clean(SEVERITY_LABEL.get(v["severidad"], ""))}</b></font><br/><b>{_clean(v["control"])}</b>'
            how = f"{_clean(v['como'])}<br/><font color='#5B6B7B'>Evidencia: {_clean(defang_text(v['evidencia']))}</font>"
            rows.append([Paragraph(control, st.cell), Paragraph(how, st.small), Paragraph(_clean(v["accion"]), st.small)])
        story.append(_table(rows, [38 * mm, 80 * mm, 60 * mm], st))
    else:
        story.append(_p("No se identificaron controles evadidos con la evidencia disponible.", st.body))
    if ev.get("postura_propia"):
        story.append(_p("Postura de correo del dominio propio", st.h2))
        story += [_p("• " + item, st.small) for item in ev["postura_propia"]]
    return story


def _message_sections(m, case, st, title):
    h = m["cabeceras"]
    story = [_p(title, st.h1)]
    if m["solo_cabeceras"]:
        story.append(_p("Se analizaron únicamente las cabeceras (sin cuerpo ni adjuntos).", st.small))
    pairs = [("From", defang_text(h.get("from"))), ("Nombre visible", m["remitente"].get("nombre_visible")),
             ("Reply-To", h.get("reply-to")), ("Return-Path", h.get("return-path")), ("Sender", h.get("sender")),
             ("Para (To)", h.get("to")), ("CC", h.get("cc")), ("Asunto", h.get("subject")), ("Fecha", h.get("date")),
             ("Message-ID", h.get("message-id")), ("Cliente de correo", m["plataforma"].get("cliente_correo")),
             ("Plataforma receptora", ", ".join(m["plataforma"]["receptor"]) or "No identificada"),
             ("Plataforma emisora", ", ".join(m["plataforma"]["emisor"]) or "No identificada"),
             ("Formato de evidencia", m["tipo_fuente"]), ("Tamaño", f"{m['tamano_bytes']:,} bytes" if m.get("tamano_bytes") else None)]
    if m.get("hashes"):
        pairs += [("MD5", Paragraph(m["hashes"]["md5"], st.mono)), ("SHA-1", Paragraph(m["hashes"]["sha1"], st.mono)),
                  ("SHA-256", Paragraph(m["hashes"]["sha256"], st.mono))]
    story.append(_kv([(k, v) for k, v in pairs if v], st))

    # Autenticación
    story.append(_p("Autenticación del remitente (SPF · DKIM · DMARC · compauth · ARC)", st.h2))
    rows = [["Cabecera", "Servidor", "Método", "Resultado", "Detalle"]]
    for header in (m["autenticacion"] + m["arc"])[:8]:
        for meth in header["metodos"]:
            props = ", ".join(f"{k}={v}" for k, v in meth["propiedades"].items())
            if meth.get("politica"):
                props += f" · política publicada p={meth['politica']}"
            res = meth["resultado"]
            color = "#2E7D32" if res == "pass" else "#B00020" if res in ("fail", "permerror") else "#C77700" if res in ("softfail", "none", "temperror", "neutral", "softpass") else "#1B2733"
            rows.append([_p(header["origen"].replace("-Authentication-Results", "").replace("Authentication-Results", "Auth-Results"), st.cell),
                         _p(header["servidor"] or "-", st.cell), _p(meth["metodo"].upper(), st.cell_bold),
                         Paragraph(f'<font color="{color}"><b>{_clean(res)}</b></font>', st.cell), _p(props or meth.get("comentario", ""), st.small)])
    if len(rows) == 1:
        story.append(_p("El mensaje no contiene cabeceras Authentication-Results ni ARC.", st.body))
    else:
        story.append(_table(rows, [20 * mm, 28 * mm, 22 * mm, 17 * mm, 91 * mm], st))
    comp = m["autenticacion_resumen"].get("compauth")
    if comp and comp.get("razon_texto"):
        story.append(_p(f"compauth reason {comp['propiedades'].get('reason')}: {comp['razon_texto']}", st.small))
    if m["dkim_firmas"]:
        story.append(_p("Firmas DKIM presentes: " + "; ".join(f"d={s['d']} s={s['s']} ({s['a']})" for s in m["dkim_firmas"]), st.small))
    story.append(_p("Nota: Authentication-Results solo es confiable si lo agregó el servidor receptor de su organización "
                    "(la cabecera superior). Un atacante puede insertar cabeceras falsas antes de la entrega.", st.small))

    # Veredicto de plataformas
    interp = m["microsoft"]["interpretacion"]
    ms = m["microsoft"]
    if interp or ms.get("tenant_id") or ms.get("network_message_id"):
        story.append(_p("Veredicto de Microsoft 365 / Exchange Online", st.h2))
        pairs = [("Interpretación", Paragraph("<br/>".join(_clean(x) for x in interp) or "-", st.cell)),
                 ("Autenticado como", ms.get("autenticado_como")), ("Dirección", ms.get("direccion")),
                 ("Tenant receptor", ms.get("tenant_id")), ("Network-Message-Id", ms.get("network_message_id")),
                 ("Llegada original", ms.get("llegada_original"))]
        story.append(_kv([(k, v) for k, v in pairs if v], st))
    g = m["google"]
    if g.get("cabeceras"):
        story.append(_p("Indicadores de Gmail / Google Workspace", st.h2))
        story.append(_kv([(k, v[:300]) for k, v in g["cabeceras"].items()], st))
    if m["antispam_otros"]:
        story.append(_p("Otras pasarelas / filtros antispam", st.h2))
        story.append(_kv([(k, v[:300]) for k, v in m["antispam_otros"].items()], st))

    # Ruta de entrega
    hops = m["ruta"]["saltos"]
    if hops:
        story.append(_p(f"Ruta de entrega ({len(hops)} saltos, orden cronológico)", st.h2))
        rows = [["#", "Desde", "Por", "IP", "Fecha", "Retraso"]]
        for hop in hops[:25]:
            delay = hop.get("retraso_s")
            rows.append([str(hop["indice"]), hop.get("desde"), hop.get("por"), hop.get("ip"),
                         (hop.get("fecha") or "-")[:25], f"{delay} s" if delay is not None else "-"])
        story.append(_table(rows, [7 * mm, 46 * mm, 46 * mm, 27 * mm, 36 * mm, 16 * mm], st))
        origin = m["ruta"]["ip_origen"]
        if origin:
            ptr = (case.get("ip_origen") or {}).get("ptr") or {}
            ptr_text = ", ".join(ptr.get("registros", [])) if ptr.get("registros") else ptr.get("estado", "no consultado")
            story.append(_p(f"IP pública de origen: {origin} · DNS inverso (PTR): {ptr_text}", st.small))
        for anomaly in m["ruta"]["anomalias"]:
            story.append(_p("⚠ " + anomaly if _fonts()[2] else "! " + anomaly, st.small))

    # Contenido
    body = m["cuerpo"]
    if not m["solo_cabeceras"]:
        story.append(_p("Contenido e ingeniería social", st.h2))
        from cintel.content import CATEGORY_LABELS

        if body["palabras_clave"]:
            rows = [["Técnica", "Expresiones encontradas"]]
            for cat, words in body["palabras_clave"].items():
                rows.append([CATEGORY_LABELS.get(cat, cat), ", ".join(words[:12])])
            story.append(_table(rows, [62 * mm, 116 * mm], st))
        else:
            story.append(_p("No se encontraron expresiones típicas de ingeniería social.", st.body))
        if body["extracto"]:
            story.append(Spacer(1, 2 * mm))
            story.append(_kv([("Extracto del cuerpo", Paragraph(_clean(defang_text(body["extracto"][:900])), st.small))], st))
        extras = []
        if body["formularios"]:
            extras.append(f"Formularios en el cuerpo: {len(body['formularios'])}")
        if body["scripts"]:
            extras.append(f"Scripts: {body['scripts']}")
        if body["recursos_externos"]:
            extras.append(f"Recursos externos cargados (píxeles de rastreo/imágenes): {len(body['recursos_externos'])}")
        extras += body["trucos_html"]
        if not m.get("qr_disponible"):
            extras.append("Lectura de códigos QR no disponible (instale el extra [qr]).")
        for e in extras:
            story.append(_p("• " + e, st.small))
        if m["qr"]:
            story.append(_p("Códigos QR detectados", st.h2))
            rows = [["Origen", "Contenido (neutralizado)"]] + [[q["origen"], defang(q["contenido"])] for q in m["qr"]]
            story.append(_table(rows, [45 * mm, 133 * mm], st))

    # URLs
    if m["urls"]:
        story.append(_p(f"Enlaces ({len(m['urls'])}{'+, lista truncada' if m['urls_truncadas'] else ''}) — análisis estático, ninguno fue visitado", st.h2))
        rows = [["Riesgo", "URL neutralizada / texto visible", "Indicadores"]]
        for u in m["urls"][:60]:
            url_text = _clean(defang(u["url_final"])[:400])
            if u.get("texto_visible"):
                url_text += f"<br/><font color='#5B6B7B'>Texto visible: {_clean(u['texto_visible'][:120])}</font>"
            if u["url_final"] != u["url"]:
                url_text += f"<br/><font color='#5B6B7B'>Original: {_clean(defang(u['url'])[:200])}</font>"
            ind = "<br/>".join("• " + _clean(i["texto"]) for i in u["indicadores"][:6]) or "-"
            rows.append([_sev_cell(u.get("riesgo", "info"), st), Paragraph(url_text, st.small), Paragraph(ind, st.small)])
        story.append(_table(rows, [17 * mm, 88 * mm, 73 * mm], st))
        if len(m["urls"]) > 60:
            story.append(_p(f"... {len(m['urls']) - 60} enlaces adicionales en reporte.json / iocs.csv", st.small))

    # Adjuntos
    if m["adjuntos"]:
        story.append(_p(f"Adjuntos ({len(m['adjuntos'])}) — análisis estático, no se abrieron ni ejecutaron", st.h2))
        for a in m["adjuntos"]:
            top = min([i["nivel"] for i in a["indicadores"]] or ["info"], key=list(SEVERITY_COLORS).index)
            ind = "<br/>".join("• " + _clean(i["texto"]) for i in a["indicadores"]) or "Sin indicadores de riesgo"
            if a.get("contenido_zip"):
                ind += "<br/>Contenido: " + _clean(", ".join(a["contenido_zip"][:15]))
            pairs = [("Nombre", a["nombre"]), ("Riesgo", _sev_cell(top, st)),
                     ("Tipo declarado / real", f"{a['tipo_declarado']} / {a['tipo_real'] or 'no identificado'}"),
                     ("Tamaño", f"{a['tamano_bytes']:,} bytes"), ("Indicadores", Paragraph(ind, st.cell)),
                     ("MD5", Paragraph(a["md5"], st.mono)), ("SHA-256", Paragraph(a["sha256"], st.mono))]
            story.append(KeepTogether([_kv(pairs, st), Spacer(1, 2 * mm)]))
    return story


def _domain_sections(case, st):
    story = []
    if not case["dominios"]:
        return story
    story.append(_p("Inteligencia de dominios (consultas pasivas)", st.h1))
    for name, d in case["dominios"].items():
        story.append(_p(name + (f"  ({d.get('dominio')})" if d.get("dominio") != name else ""), st.h2))
        if "consultas" not in d:
            flags = []
            if d.get("gratuito"):
                flags.append("proveedor de correo gratuito")
            if d.get("desechable"):
                flags.append("correo desechable")
            story.append(_p(d.get("nota", "Sin consultas de red.") + (" · " + ", ".join(flags) if flags else ""), st.small))
            continue
        rd = d.get("rdap") or {}
        spf = d.get("spf") or {}
        dm = d.get("dmarc") or {}
        tenant = d.get("microsoft_tenant") or {}
        pairs = [
            ("Existe en DNS", "Sí" if d.get("existe") else "NO"),
            ("Tipo", "Proveedor gratuito" if d.get("gratuito") else "Correo desechable" if d.get("desechable") else "Dominio propio/corporativo"),
            ("Creación (RDAP)", f"{rd.get('creado') or '-'}" + (f" · {rd['antiguedad_dias']} días" if rd.get("antiguedad_dias") is not None else "") +
             (f" · estado RDAP: {rd.get('estado')}" if rd.get("estado") != "ok" else "")),
            ("Registrador", rd.get("registrador")),
            ("Proveedor de correo (MX)", ", ".join(d.get("proveedor_correo") or []) or ("MX nulo: no recibe correo" if d.get("mx_nulo") else "-")),
            ("MX", ", ".join(d.get("mx") or []) or "-"),
            ("SPF", "; ".join(spf.get("registros") or []) or "No publicado"),
            ("Servicios autorizados en SPF", ", ".join(spf.get("proveedores") or []) or "-"),
            ("DMARC", "; ".join(dm.get("registros") or []) or "No publicado"),
            ("Política DMARC efectiva", (dm.get("p") or "-") + (f" (heredada de {dm['heredado_de']})" if dm.get("heredado_de") else "")),
            ("DKIM (selectores hallados)", ", ".join(x["selector"] for x in d.get("dkim_selectores") or []) or "Ninguno de los selectores probados"),
            ("MTA-STS / TLS-RPT / BIMI", f"{'Sí' if d.get('mta_sts') else 'No'} / {'Sí' if d.get('tls_rpt') else 'No'} / {'Sí' if d.get('bimi') else 'No'}"),
            ("DNSSEC", d.get("dnssec")),
            ("Tenant Microsoft 365", tenant.get("tenant_id") if tenant.get("estado") == "ok" else {"sin_tenant": "No", "omitido": "No aplica"}.get(tenant.get("estado"), tenant.get("estado"))),
            ("NS", ", ".join(d["consultas"]["ns"].get("registros", [])[:4]) or "-"),
            ("A", ", ".join(d["consultas"]["a"].get("registros", [])[:4]) or "-"),
        ]
        story.append(_kv([(k, v) for k, v in pairs if v is not None], st))
    return story


def _correlation_section(case, st):
    corr = case.get("correlacion")
    if not corr or not (corr["casos_relacionados"] or corr["mismo_correo"]):
        return []
    title = f"Correlación con casos anteriores — campaña {corr['campana']}" if corr.get("campana") else "Correlación con casos anteriores"
    story = [_p(title, st.h1)]
    rows = [["Caso", "Fecha", "Veredicto", "IOCs en común"]]
    for r in corr["casos_relacionados"][:15]:
        common = "<br/>".join(f"{_clean(c['tipo'])}: {_clean(defang(c['valor'])[:90])}" for c in r["coincidencias"][:5])
        rows.append([r["id"], (r.get("fecha") or "")[:16], r.get("veredicto") or "-", Paragraph(common, st.small)])
    if len(rows) > 1:
        story.append(_table(rows, [42 * mm, 26 * mm, 34 * mm, 76 * mm], st))
    if corr["mismo_correo"]:
        story.append(_p("Este mismo correo (mismo SHA-256) ya fue analizado en: " +
                        ", ".join(e["id"] for e in corr["mismo_correo"]), st.small))
    return story


def _mitigation_section(case, st):
    story = []
    if case.get("mitre"):
        story.append(_p("Mapeo MITRE ATT&CK", st.h1))
        rows = [["Técnica", "Nombre", "Hallazgos relacionados"]]
        for t in case["mitre"]:
            rows.append([t["id"], t["nombre"], ", ".join(t["codigos"])])
        story.append(_table(rows, [24 * mm, 70 * mm, 84 * mm], st))
    plan = case.get("mitigaciones") or []
    if plan:
        story.append(_p("Plan de mitigación (endurecimiento de políticas)", st.h1))
        story.append(_p("Controles priorizados según lo observado en este caso. Prioridad 1 = aplicar de inmediato. "
                        "Las referencias apuntan a documentación oficial y a herramientas open source.", st.small))
        rows = [["P", "Control y motivo", "Pasos"]]
        for item in plan:
            control = (f"<b>{_clean(item['titulo'])}</b><br/><font color='#5B6B7B'>{_clean(item['plataforma'])}</font><br/>"
                       + "<br/>".join("• " + _clean(m[:110]) for m in item["motivos"][:3]))
            steps = "<br/>".join("• " + _clean(s) for s in item["pasos"])
            refs = "; ".join(_clean(r["titulo"]) for r in item["referencias"])
            if item["herramientas_oss"]:
                refs += " · OSS: " + _clean(", ".join(item["herramientas_oss"]))
            steps += f"<br/><font color='#5B6B7B'>Ref.: {refs}</font>"
            rows.append([str(item["prioridad"]), Paragraph(control, st.small), Paragraph(steps, st.small)])
        story.append(_table(rows, [8 * mm, 62 * mm, 108 * mm], st))
    return story


def _ioc_section(case, st):
    if not case["iocs"]:
        return []
    story = [_p("Indicadores de compromiso (IOCs)", st.h1),
             _p("Valores neutralizados para evitar clics. La lista completa sin neutralizar está en iocs.csv.", st.small)]
    rows = [["Tipo", "Valor", "Contexto", "Riesgo"]]
    for i in case["iocs"][:120]:
        value = i["valor"] if i["tipo"] in ("sha256", "asunto") else defang(i["valor"])
        style = st.mono if i["tipo"] == "sha256" else st.small
        rows.append([i["tipo"], Paragraph(_clean(value[:300]), style), _p(i["contexto"], st.small), _sev_cell(i["riesgo"], st)])
    story.append(_table(rows, [17 * mm, 95 * mm, 46 * mm, 20 * mm], st))
    return story


def _recommendations(case, st):
    story = [_p("Recomendaciones para Riesgos No Financieros / Seguridad de la Información", st.h1)]
    rows = [[_p(str(i), st.cell_bold), _p(r, st.cell)] for i, r in enumerate(case["recomendaciones"], 1)]
    story.append(_table(rows, [8 * mm, 170 * mm], st, header=False))
    return story


def _methodology(case, st):
    tool = case["herramienta"]
    text = [
        "Análisis 100 % pasivo y estático: no se visitaron enlaces, no se ejecutaron ni abrieron adjuntos, no se "
        "envió tráfico SMTP ni se verificó la existencia de buzones. Las consultas externas se limitan a DNS, RDAP "
        "y al descubrimiento público de tenants de Microsoft (desactivables con --sin-red).",
        "Las cabeceras Authentication-Results pueden falsificarse antes de la entrega: contraste siempre con "
        "Microsoft Defender / Seguimiento de mensajes o la consola de Google Workspace.",
        "Los registros DNS y RDAP son una instantánea al momento del análisis y pueden diferir de los vigentes cuando se recibió el correo.",
        "El índice de riesgo suma pesos por severidad (crítico 40, alto 20, medio 10, bajo 3) con tope 100. Es una "
        "ayuda para priorizar, no una prueba: la decisión final corresponde al analista.",
        "Este informe puede contener datos personales y URLs con tokens. Clasificación: CONFIDENCIAL — uso interno.",
    ]
    story = [_p("Metodología y limitaciones", st.h1)]
    story += [_p("• " + t, st.small) for t in text]
    story += [Spacer(1, 5 * mm),
              _p(f"<b>{_clean(tool['nombre'])}</b> v{_clean(tool['version'])} — Authored by: <b>{_clean(tool['autor'])}</b>, "
                 f"{_clean(tool['rol_autor'])}, {_clean(tool['organizacion'])}. Herramienta creada a raíz de un ataque de "
                 "phishing dirigido a la Junta Directiva, como capacidad permanente de contrainteligencia del área de "
                 "Riesgos No Financieros.", st.small, raw=True)]
    return story

