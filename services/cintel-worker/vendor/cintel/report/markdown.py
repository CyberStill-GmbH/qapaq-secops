"""Reporte en Markdown (útil para tickets, correos al SOC o wikis internas)."""
from __future__ import annotations

from cintel.assessment import SEVERITY_LABEL
from cintel.util import defang


def _md(text) -> str:
    return str(text if text is not None else "-").replace("|", "\\|").replace("\n", " ")


def render_markdown(case: dict) -> str:
    v = case["veredicto"]
    tool = case["herramienta"]
    out = [
        f"# {tool['nombre']} — Informe {case['id']}",
        "",
        f"**Veredicto:** {v['etiqueta']} (índice de riesgo {v['indice_riesgo']}/100)  ",
        f"**Objetivo:** `{defang(case['objetivo'])}` ({case['tipo_objetivo']})  ",
        f"**Fecha:** {case['generado_en']}  ",
        f"**Autor de la herramienta:** {tool['autor']} — {tool['rol_autor']}, {tool['organizacion']}  ",
        "**Clasificación:** CONFIDENCIAL — uso interno",
        "",
        v["resumen"],
        "",
        "## Hallazgos",
        "",
        "| Severidad | Ámbito | Hallazgo | Detalle |",
        "|---|---|---|---|",
    ]
    for f in case["hallazgos"]:
        out.append(f"| {SEVERITY_LABEL[f['severidad']]} | {_md(f['ambito'])} | {_md(f['titulo'])} | {_md(defang_text(f['detalle']))} |")
    if not case["hallazgos"]:
        out.append("| - | - | Sin hallazgos automáticos | Requiere análisis humano |")
    ev = case.get("evasion")
    if ev:
        out += ["", "## Diagnóstico de suplantación y evasión de controles", "",
                f"**Tipo de suplantación:** {ev['tipo_suplantacion']['tipo']} — {_md(defang_text(ev['tipo_suplantacion']['detalle']))}  ",
                f"**Destino del correo:** {ev['destino']['carpeta']}", ""]
        if ev["vias"]:
            out += ["| Severidad | Control | Cómo lo superó | Evidencia | Acción correctiva |", "|---|---|---|---|---|"]
            for v in ev["vias"]:
                out.append(f"| {SEVERITY_LABEL[v['severidad']]} | {_md(v['control'])} | {_md(v['como'])} | "
                           f"{_md(defang_text(v['evidencia']))} | {_md(v['accion'])} |")
        for item in ev.get("postura_propia", []):
            out.append(f"- {_md(item)}")
    m = case.get("mensaje")
    if m:
        h = m["cabeceras"]
        out += ["", "## Mensaje", "",
                f"- **From:** {_md(h.get('from'))}", f"- **Reply-To:** {_md(h.get('reply-to'))}",
                f"- **Return-Path:** {_md(h.get('return-path'))}", f"- **Asunto:** {_md(h.get('subject'))}",
                f"- **Fecha:** {_md(h.get('date'))}", f"- **Message-ID:** {_md(h.get('message-id'))}",
                f"- **Plataforma receptora:** {', '.join(m['plataforma']['receptor']) or '-'}",
                f"- **Plataforma emisora:** {', '.join(m['plataforma']['emisor']) or '-'}",
                f"- **IP de origen:** {m['ruta']['ip_origen'] or '-'}"]
        if m.get("hashes"):
            out.append(f"- **SHA-256 de la evidencia:** `{m['hashes']['sha256']}`")
        out += ["", "### Autenticación", ""]
        for method, data in m["autenticacion_resumen"].items():
            out.append(f"- **{method.upper()}**: {data['resultado']} {_md(data.get('propiedades'))}")
        if m["urls"]:
            out += ["", "### URLs (neutralizadas)", "", "| Riesgo | URL | Indicadores |", "|---|---|---|"]
            for u in m["urls"][:100]:
                out.append(f"| {u.get('riesgo', '-')} | `{defang(u['url_final'])[:150]}` | "
                           f"{_md('; '.join(i['texto'] for i in u['indicadores'][:3]))} |")
        if m["adjuntos"]:
            out += ["", "### Adjuntos", "", "| Nombre | Tipo real | SHA-256 |", "|---|---|---|"]
            for a in m["adjuntos"]:
                out.append(f"| {_md(a['nombre'])} | {_md(a['tipo_real'])} | `{a['sha256']}` |")
    if case["iocs"]:
        out += ["", "## IOCs", "", "| Tipo | Valor (neutralizado) | Contexto |", "|---|---|---|"]
        for i in case["iocs"]:
            out.append(f"| {i['tipo']} | `{_md(defang(i['valor']) if i['tipo'] != 'sha256' else i['valor'])}` | {_md(i['contexto'])} |")
    corr = case.get("correlacion") or {}
    if corr.get("casos_relacionados"):
        out += ["", f"## Correlación{' — campaña ' + corr['campana'] if corr.get('campana') else ''}", "",
                "| Caso | Fecha | Veredicto | IOCs en común |", "|---|---|---|---|"]
        for r in corr["casos_relacionados"][:15]:
            common = "; ".join(f"{c['tipo']}: {defang(c['valor'])[:60]}" for c in r["coincidencias"][:4])
            out.append(f"| {r['id']} | {(r.get('fecha') or '')[:16]} | {_md(r.get('veredicto'))} | {_md(common)} |")
    out += ["", "## Recomendaciones", ""] + [f"1. {r}" for r in case["recomendaciones"]]
    if case.get("mitre"):
        out += ["", "## MITRE ATT&CK", ""] + [f"- [{t['id']}]({t['url']}) {t['nombre']} — {', '.join(t['codigos'])}"
                                             for t in case["mitre"]]
    if case.get("mitigaciones"):
        out += ["", "## Plan de mitigación", ""]
        for item in case["mitigaciones"]:
            out.append(f"### P{item['prioridad']} · {item['titulo']} ({item['plataforma']})")
            out += [f"- {s}" for s in item["pasos"]]
            out.append("- Referencias: " + "; ".join(f"[{r['titulo']}]({r['url']})" for r in item["referencias"]))
            out.append("")
    out += ["", "---", f"Generado por {tool['nombre']} v{tool['version']} · Autor: {tool['autor']}, {tool['rol_autor']} · {tool['organizacion']}", ""]
    return "\n".join(out)


def defang_text(text: str) -> str:
    """Neutraliza URLs dentro de un texto libre."""
    import re

    return re.sub(r"https?://\S+", lambda m: defang(m.group(0)), text or "")

