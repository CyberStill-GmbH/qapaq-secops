"""Presentación del análisis en la terminal (cmd, PowerShell, Windows Terminal, bash, zsh, macOS).

Usa `rich` (open source, multiplataforma) para mostrar paneles, tablas, barras
y un indicador de progreso. Si la salida no es una terminal (redirección a
archivo, CI) rich la convierte automáticamente en texto plano.
"""
from __future__ import annotations

from pathlib import Path

from rich import box
from rich.columns import Columns
from rich.console import Console, Group
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text

from cintel import __author__, __author_role__, __version__
from cintel.assessment import SEVERITY_LABEL
from cintel.util import defang

SEV_STYLE = {"critico": "bold white on red3", "alto": "bold red1", "medio": "bold yellow3", "bajo": "bold deep_sky_blue1",
             "info": "grey62"}
VERDICT_STYLE = {"critico": "red3", "alto": "dark_orange3", "medio": "yellow3", "info": "green4"}
BRAND = "cyan"


def make_console(stderr: bool = False, color: bool = True, record: bool = False, width: int | None = None,
                 file=None) -> Console:
    if record and file is None:
        import io

        file = io.StringIO()  # Captura para exportar a SVG sin escribir en la consola
    return Console(stderr=stderr, no_color=not color, highlight=False, record=record, width=width,
                   emoji=False, soft_wrap=False, file=file)


def banner(console: Console) -> None:
    title = Text.assemble(("QAPAQ ", "bold white"), ("PHISHING CONTRA-INTELIGENCIA", f"bold {BRAND}"))
    subtitle = Text(f"v{__version__} · Riesgos No Financieros · Authored by: {__author__}, {__author_role__}", style="grey62")
    console.print(Panel(Group(title, subtitle), box=box.HEAVY, border_style=BRAND, padding=(0, 2), expand=False))


def _sev(sev: str) -> Text:
    return Text(f" {SEVERITY_LABEL.get(sev, sev)} ", style=SEV_STYLE.get(sev, ""))


def _risk_bar(score: int, style: str, width: int = 30) -> Text:
    filled = round(score / 100 * width)
    return Text.assemble(("█" * filled, style), ("░" * (width - filled), "grey35"), (f"  {score}/100", f"bold {style}"))


def _kv_table(rows: list) -> Table:
    table = Table.grid(padding=(0, 2))
    table.add_column(style="grey62", no_wrap=True)
    table.add_column(overflow="fold")
    for key, value in rows:
        if value:
            table.add_row(key, value if isinstance(value, Text) else Text(str(value)))
    return table


def _origin_text(case: dict, target: dict) -> str | None:
    info = case.get("ip_origen") or {}
    ip = info.get("ip") or target["ruta"]["ip_origen"]
    if not ip:
        return None
    ptr = ", ".join((info.get("ptr") or {}).get("registros", [])[:1])
    text = ip + (f" ({ptr.rstrip('.')})" if ptr else "")
    if info.get("ip_conectante_m365"):
        text += f" · conectó a M365 desde {info['ip_conectante_m365']}"
    return text


def render_case(console: Console, case: dict, paths: dict | None, verbose: bool = False) -> None:
    v = case["veredicto"]
    vstyle = VERDICT_STYLE.get(v["nivel"], "green4")
    m = case.get("mensaje")
    target = (m["mensajes_adjuntos"][0] if m and m.get("mensajes_adjuntos") else m) if m else None
    shown_target = Path(case["objetivo"]).name if case["tipo_objetivo"] == "mensaje" else defang(case["objetivo"])
    console.print()
    console.print(Rule(Text.assemble((f" {case['id']} ", f"bold {BRAND}"), (f"· {shown_target} ", "white")), style=BRAND))

    # ---------------------------------------------------------------- Datos del objetivo
    if target:
        h = target["cabeceras"]
        auth = target["autenticacion_resumen"]
        auth_text = Text()
        for method in ("spf", "dkim", "dmarc", "compauth"):
            if method in auth:
                res = auth[method]["resultado"]
                style = "green" if res == "pass" else "red1" if res in ("fail", "permerror") else "yellow3"
                auth_text.append(f"{method.upper()} ", style="grey62")
                auth_text.append(f"{res}   ", style=f"bold {style}")
        rows = [("De", h.get("from")), ("Asunto", h.get("subject")), ("Fecha", h.get("date")),
                ("Autenticación", auth_text if auth_text.plain else None),
                ("Receptor", ", ".join(target["plataforma"]["receptor"]) or None),
                ("IP de origen", _origin_text(case, target))]
        if m is not target:
            rows.insert(0, ("Reportado por", m["cabeceras"].get("from")))
        console.print(_kv_table(rows))

    # ---------------------------------------------------------------- Veredicto
    counts = v["conteo"]
    chips = Text()
    for sev in ("critico", "alto", "medio", "bajo"):
        chips.append_text(_sev(sev))
        chips.append(f" {counts[sev]}   ")
    verdict = Group(Text(v["etiqueta"], style=f"bold {vstyle}"), _risk_bar(v["indice_riesgo"], vstyle),
                    Text(v["resumen"], style="white"), chips)
    console.print(Panel(verdict, title="Veredicto", title_align="left", border_style=vstyle, box=box.ROUNDED, padding=(0, 2)))

    # ---------------------------------------------------------------- Hallazgos
    findings = [f for f in case["hallazgos"] if verbose or f["severidad"] != "info"]
    if findings:
        table = Table(box=box.SIMPLE_HEAD, show_edge=False, pad_edge=False, expand=True, header_style="grey62")
        table.add_column("Severidad", no_wrap=True)
        table.add_column("Hallazgo", ratio=3, overflow="fold")
        table.add_column("Ámbito", ratio=1, style="grey62", overflow="fold")
        limit = len(findings) if verbose else 14
        for f in findings[:limit]:
            title = Text(f["titulo"])
            if verbose and f["detalle"]:
                title.append(f"\n{f['detalle'][:400]}", style="grey62")
            table.add_row(_sev(f["severidad"]), title, f["ambito"])
        console.print(table)
        if len(findings) > limit:
            console.print(Text(f"  … {len(findings) - limit} hallazgos más en el PDF (use -v para verlos aquí)", style="grey62"))

    # ---------------------------------------------------------------- Suplantación y evasión
    ev = case.get("evasion")
    if ev and (ev["vias"] or ev["tipo_suplantacion"]["tipo"] != "Sin suplantación evidente"):
        body = [Text.assemble(("Tipo: ", "grey62"), (ev["tipo_suplantacion"]["tipo"], "bold white")),
                Text.assemble(("Destino: ", "grey62"), (ev["destino"]["carpeta"], "white"))]
        for t in ev["tecnicas"][1:]:
            body.append(Text.assemble(("  + ", "grey62"), (t["tipo"], "white")))
        if ev["vias"]:
            body.append(Text("Cómo superó los controles:", style="grey62"))
            for via in ev["vias"]:
                line = Text.assemble(("  › ", SEV_STYLE.get(via["severidad"], "")), (via["control"], "white"))
                if verbose:
                    line.append(f"\n      {via['como']}", style="grey62")
                body.append(line)
        console.print(Panel(Group(*body), title="Suplantación y evasión de controles", title_align="left",
                            border_style="magenta", box=box.ROUNDED, padding=(0, 2)))

    # ---------------------------------------------------------------- Campaña / MITRE / mitigaciones
    corr = case.get("correlacion") or {}
    if corr.get("campana"):
        console.print(Panel(Text(f"{corr['campana']}: relacionado con {corr['total_relacionados']} caso(s) anteriores por IOCs compartidos.",
                                 style="bold white"), title="Campaña detectada", title_align="left", border_style="red1",
                            box=box.ROUNDED, padding=(0, 2)))
    if case.get("mitre"):
        tags = [Text(f" {t['id']} ", style="bold black on grey70") for t in case["mitre"]]
        console.print(Columns([Text("MITRE ATT&CK", style="grey62")] + tags, padding=(0, 1)))
    plan = [p for p in case.get("mitigaciones") or [] if p["prioridad"] == 1]
    if plan:
        table = Table(box=box.SIMPLE, show_edge=False, pad_edge=False, expand=True, header_style="grey62",
                      title="Mitigaciones prioritarias", title_style="bold white", title_justify="left")
        table.add_column("Control", ratio=2, overflow="fold")
        table.add_column("Plataforma", ratio=1, style="grey62", overflow="fold")
        for item in plan[: (len(plan) if verbose else 6)]:
            table.add_row(item["titulo"], item["plataforma"])
        console.print(table)

    # ---------------------------------------------------------------- Archivos
    if paths:
        rows = [("Reporte PDF", Text(paths["pdf"], style=f"bold {BRAND}") if paths.get("pdf") else None),
                ("Evidencias", paths.get("evidencias")),
                ("IOCs", "iocs.csv · iocs.stix.json · iocs.misp.json")]
        console.print(Panel(_kv_table(rows), border_style="grey35", box=box.ROUNDED, padding=(0, 2)))


def render_batch(console: Console, cases: list, root: Path) -> None:
    table = Table(title=f"Resumen: {len(cases)} análisis en {root}", title_justify="left", box=box.ROUNDED,
                  header_style="grey62", expand=True)
    table.add_column("Veredicto", no_wrap=True)
    table.add_column("Caso", no_wrap=True, style=BRAND)
    table.add_column("Objetivo", overflow="fold")
    table.add_column("Riesgo", justify="right")
    for case in cases:
        v = case["veredicto"]
        table.add_row(Text(v["etiqueta"], style=f"bold {VERDICT_STYLE.get(v['nivel'], 'green4')}"), case["id"],
                      Path(case["objetivo"]).name, str(v["indice_riesgo"]))
    console.print()
    console.print(table)

