"""Línea de comandos `cintel`.

Ejemplos:
  cintel correo_sospechoso.eml          # .eml de Outlook, Gmail ("Descargar mensaje") o M365
  cintel mensaje.msg                    # .msg arrastrado desde Outlook de escritorio
  cintel cabeceras.txt                  # cabeceras copiadas ("Ver código fuente"/"Mostrar original")
  cintel remitente@dominio-raro.com     # dirección de correo
  cintel dominio-raro.com               # dominio
  cintel "https://enlace-sospechoso/x"  # URL (no se visita)
  cintel carpeta_con_correos/           # todos los .eml/.msg de una carpeta
  Get-Clipboard | cintel -              # cabeceras pegadas desde el portapapeles (PowerShell)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess  # nosec B404
import sys
from pathlib import Path

from cintel import __author__, __author_role__, __product__, __version__
from cintel.assessment import SEVERITY_LABEL
from cintel.case import EVIDENCE_EXT, analyze_target
from cintel.config import config_file_path, default_output_root, load_config
from cintel.parsers import EvidenceError
from cintel.util import defang

# --------------------------------------------------------------------------
# Salida por consola con colores ANSI (Windows Terminal, PowerShell, cmd, bash)
# --------------------------------------------------------------------------

COLORS = {"critico": "\033[1;97;41m", "alto": "\033[1;91m", "medio": "\033[1;93m", "bajo": "\033[94m",
          "info": "\033[90m", "ok": "\033[1;92m", "titulo": "\033[1;96m", "reset": "\033[0m", "dim": "\033[2m"}


def _enable_console():
    """Habilita UTF-8 y secuencias ANSI en consolas de Windows."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            continue
    if os.name == "nt":
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            for handle_id in (-11, -12):  # STD_OUTPUT_HANDLE, STD_ERROR_HANDLE
                handle = kernel32.GetStdHandle(handle_id)
                mode = ctypes.c_uint32()
                if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                    kernel32.SetConsoleMode(handle, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
        except Exception:  # noqa: BLE001 - sin consola real (p. ej. salida redirigida): se omite el color
            return


def _use_color(no_color: bool) -> bool:
    return not no_color and "NO_COLOR" not in os.environ and sys.stdout.isatty()


def _c(key: str, text: str, color: bool) -> str:
    return f"{COLORS[key]}{text}{COLORS['reset']}" if color else text


BANNER = """
  ╔══════════════════════════════════════════════════════════╗
  ║        QAPAQ  PHISHING  CONTRA-INTELIGENCIA  (cintel)    ║
  ║        Riesgos No Financieros · análisis defensivo       ║
  ╚══════════════════════════════════════════════════════════╝"""


def print_banner(color: bool):
    print(_c("titulo", BANNER, color), file=sys.stderr)
    print(_c("dim", f"  {__product__} v{__version__} · Authored by: {__author__}, {__author_role__}\n", color),
          file=sys.stderr)


def print_summary(case: dict, paths: dict | None, color: bool, verbose: bool):
    v = case["veredicto"]
    sev_key = {"critico": "critico", "alto": "alto", "medio": "medio"}.get(v["nivel"], "ok")
    print()
    print(_c("titulo", f"═══ {case['id']} · {defang(case['objetivo']) if case['tipo_objetivo'] != 'mensaje' else Path(case['objetivo']).name}", color))
    m = case.get("mensaje")
    if m:
        h = m["cabeceras"]
        print(f"  From:    {h.get('from') or '-'}")
        print(f"  Asunto:  {h.get('subject') or '-'}")
        auth = m["autenticacion_resumen"]
        if auth:
            print("  Auth:    " + "  ".join(f"{k.upper()}={d['resultado']}" for k, d in auth.items()
                                         if k in ("spf", "dkim", "dmarc", "compauth")))
        if m["plataforma"]["receptor"]:
            print(f"  Receptor: {', '.join(m['plataforma']['receptor'])}")
    print(f"  Veredicto: {_c(sev_key, ' ' + v['etiqueta'] + ' ', color)}  índice {v['indice_riesgo']}/100")
    print(_c("dim", f"  {v['resumen']}", color))
    shown = [f for f in case["hallazgos"] if verbose or f["severidad"] != "info"]
    if shown:
        print()
    for f in shown[: (200 if verbose else 15)]:
        label = SEVERITY_LABEL[f["severidad"]].ljust(7)
        scope = f" [{f['ambito']}]" if f["ambito"] not in ("Mensaje",) else ""
        print(f"  {_c(f['severidad'], label, color)} {f['titulo']}{_c('dim', scope, color)}")
        if verbose and f["detalle"]:
            print(_c("dim", f"          {f['detalle'][:300]}", color))
    if not verbose and len(shown) > 15:
        print(_c("dim", f"  ... {len(shown) - 15} hallazgos más en el PDF", color))
    corr = case.get("correlacion") or {}
    if corr.get("campana"):
        print()
        print(_c("alto", f"  Campaña {corr['campana']}: relacionado con {corr['total_relacionados']} caso(s) anteriores", color))
    if case.get("mitre"):
        print(_c("dim", "  MITRE ATT&CK: " + ", ".join(t["id"] for t in case["mitre"]), color))
    ev = case.get("evasion")
    if ev and (ev["vias"] or ev["tipo_suplantacion"]["tipo"] != "Sin suplantación evidente"):
        print()
        print(_c("titulo", f"  Suplantación: {ev['tipo_suplantacion']['tipo']}", color) +
              _c("dim", f"  · destino: {ev['destino']['carpeta']}", color))
        if ev["vias"]:
            print("  Cómo superó los controles:")
            for v in ev["vias"]:
                print(f"    {_c(v['severidad'], '›', color)} {v['control']}")
                if verbose:
                    print(_c("dim", f"        {v['como']}", color))
    if paths:
        print()
        if paths.get("pdf"):
            print(f"  {_c('ok', 'PDF:', color)}        {paths['pdf']}")
        print(f"  Evidencias: {paths['evidencias']}")


def _load_ui():
    """Interfaz enriquecida si `rich` está instalado; si no, salida de texto clásica."""
    try:
        from cintel import ui
    except ImportError:
        return None
    return ui


def _print_campaigns(root: Path, color: bool) -> int:
    from cintel.correlation import campaigns

    found = campaigns(root)
    if not found:
        print(f"No hay campañas: ningún IOC fuerte se repite entre los casos de {root}")
        return 0
    print(_c("titulo", f"Campañas detectadas en {root}", color))
    for c in found:
        print()
        print(_c("alto", f"  {c['campana']}", color) + f"  {c['casos']} casos  ({c['primero'][:10]} → {c['ultimo'][:10]})")
        for s in c["asuntos"][:3]:
            print(f"    Asunto:     {s}")
        if c["remitentes"]:
            print(f"    Remitentes: {', '.join(c['remitentes'][:5])}")
        for ioc in c["iocs_compartidos"][:6]:
            print(f"    IOC {ioc['tipo']:<8} {defang(ioc['valor'])[:90]}  ({ioc['casos']} casos)")
        print(_c("dim", f"    Casos: {', '.join(c['ids'][:8])}", color))
    return 0


def _run_watch(domains: list, cfg, root: Path, color: bool) -> int:
    from cintel.watch import watch

    targets = [d for d in domains if d and d != "-"] or cfg.protected_domains
    for target in targets:
        result = watch(target.lower().strip("."), root, progress=lambda t: print(_c("dim", t, color), file=sys.stderr))
        print()
        print(_c("titulo", f"Dominios parecidos a {target}: {len(result['registrados'])} registrados de {result['variantes']} variantes", color))
        for x in result["registrados"][:60]:
            age = f"{x['antiguedad_dias']} días" if x.get("antiguedad_dias") is not None else "antigüedad n/d"
            mx = "con MX (puede enviar/recibir correo)" if x["mx"] else "sin MX"
            print(f"  {_c(x['riesgo'], SEVERITY_LABEL[x['riesgo']].ljust(7), color)} {defang(x['dominio']):<38} "
                  f"{x['tecnica']:<26} {age:<16} {mx}")
        print(f"\n  CSV: {result['csv']}")
    return 0


def _open_file(path: str):
    """Abre el PDF recién generado (ruta creada por la propia herramienta, nunca del correo)."""
    try:
        if os.name == "nt":
            os.startfile(path)  # type: ignore[attr-defined]  # nosec B606
            return
        opener = shutil.which("open" if sys.platform == "darwin" else "xdg-open")
        if opener:
            subprocess.Popen([opener, path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # nosec B603
    except OSError as exc:
        print(f"[aviso] No se pudo abrir el PDF: {exc}", file=sys.stderr)


def _expand_targets(targets: list) -> list:
    """Expande carpetas a los archivos de evidencia que contienen."""
    expanded = []
    for t in targets:
        p = Path(t).expanduser()
        if p.is_dir():
            files = sorted(x for x in p.iterdir() if x.is_file() and x.suffix.lower() in EVIDENCE_EXT)
            if not files:
                print(f"[aviso] La carpeta {p} no contiene archivos .eml/.msg/.txt", file=sys.stderr)
            expanded += [str(x) for x in files]
        else:
            expanded.append(t)
    return expanded


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="cintel",
        description=f"{__product__}: análisis defensivo de correos sospechosos (Outlook, Gmail, Microsoft 365) "
                    "con reporte PDF automático.",
        epilog="Ejemplos:\n  cintel sospechoso.eml\n  cintel mensaje.msg\n  cintel remitente@dominio.com\n"
               "  cintel dominio.com\n  cintel https://enlace.raro/login\n  Get-Clipboard | cintel -\n\n"
               f"Authored by: {__author__}, {__author_role__} · Qapaq",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("objetivos", nargs="*", metavar="OBJETIVO",
                   help="archivo .eml/.msg/.txt, carpeta, dirección de correo, dominio, URL o '-' para entrada estándar")
    p.add_argument("-o", "--salida", "--out", dest="salida", type=Path,
                   help="carpeta donde guardar reportes (por defecto: Documentos/Qapaq Phishing Contra-inteligencia)")
    p.add_argument("--sin-red", "--offline", dest="sin_red", action="store_true",
                   help="no realizar consultas DNS/RDAP (análisis 100%% local)")
    p.add_argument("--sin-pdf", "--no-pdf", dest="sin_pdf", action="store_true", help="no generar PDF (solo JSON/MD/CSV)")
    p.add_argument("--no-guardar", dest="no_guardar", action="store_true", help="solo mostrar el resultado, sin guardar archivos")
    p.add_argument("--proteger", action="append", default=[], metavar="DOMINIO",
                   help="dominio propio adicional a vigilar contra suplantación (repetible)")
    p.add_argument("--vip", action="append", default=[], metavar="NOMBRE",
                   help="nombre de directivo/VIP para detectar suplantación (repetible)")
    p.add_argument("--abrir", action="store_true", help="abrir el PDF al terminar")
    p.add_argument("--json", action="store_true", help="imprimir el caso completo en JSON por la salida estándar")
    p.add_argument("-v", "--detalle", action="store_true", help="mostrar todos los hallazgos con su detalle")
    p.add_argument("-q", "--silencioso", action="store_true", help="no mostrar banner ni progreso")
    p.add_argument("--sin-color", action="store_true", help="desactivar colores en la consola")
    p.add_argument("--campanas", action="store_true", help="listar las campañas detectadas por correlación de casos y salir")
    p.add_argument("--vigilar", action="append", default=[], metavar="DOMINIO",
                   help="buscar dominios parecidos registrados (typosquatting) y salir; por defecto los dominios protegidos")
    p.add_argument("--sin-correlacion", action="store_true", help="no comparar con casos anteriores")
    p.add_argument("--config", action="store_true", help="mostrar la ruta del archivo de configuración y salir")
    p.add_argument("--carpeta", action="store_true", help="mostrar la carpeta de reportes y salir")
    p.add_argument("-V", "--version", action="version", version=f"{__product__} {__version__} — {__author__}")
    return p


def main(argv: list | None = None) -> int:
    _enable_console()
    parser = build_parser()
    args = parser.parse_args(argv)
    color = _use_color(args.sin_color) and not args.json
    cfg = load_config()
    for d in args.proteger:
        d = d.lower().strip().rstrip(".")
        if d and d not in cfg.protected_domains:
            cfg.protected_domains.append(d)
            label = d.split(".")[0]
            if len(label) >= 4 and label not in cfg.brands:
                cfg.brands.append(label)
    cfg.vip_names += [v for v in args.vip if v.strip()]
    root = args.salida.expanduser() if args.salida else default_output_root(cfg)

    if args.config:
        path = config_file_path()
        print(f"{path} ({'existe' if path.exists() else 'no existe; se usan valores por defecto'})")
        return 0
    if args.carpeta:
        print(root)
        return 0
    if args.campanas:
        return _print_campaigns(root, color)
    if args.vigilar:
        return _run_watch(args.vigilar, cfg, root, color)
    if not args.objetivos:
        parser.print_help()
        return 2

    quiet = args.silencioso or args.json
    ui = _load_ui() if not args.json else None
    out = ui.make_console(color=not args.sin_color) if ui else None
    err = ui.make_console(stderr=True, color=not args.sin_color) if ui else None
    if not quiet:
        if ui:
            ui.banner(err)
        else:
            print_banner(color)
    stdin_data = None
    if "-" in args.objetivos:
        stdin_data = sys.stdin.buffer.read()

    targets = _expand_targets(args.objetivos)
    exit_code = 0
    cases = []
    for target in targets:
        try:
            if ui and not quiet:
                # Indicador de progreso animado con el paso actual del análisis.
                with err.status(f"Analizando {Path(target).name if target != '-' else 'entrada estándar'}…", spinner="dots") as status:
                    case = analyze_target(target, cfg, online=not args.sin_red, quiet=True, stdin_data=stdin_data,
                                          on_progress=lambda text: status.update(f"[cyan]{text}…"))
            else:
                if not quiet:
                    print(_c("dim", f"Analizando {target} ...", color), file=sys.stderr)
                case = analyze_target(target, cfg, online=not args.sin_red, quiet=quiet, stdin_data=stdin_data)
        except EvidenceError as exc:
            if err:
                err.print(f"[bold red]✗ Error:[/] {exc}")
            else:
                print(f"[error] {exc}", file=sys.stderr)
            exit_code = 2
            continue
        except KeyboardInterrupt:
            print("\nCancelado por el usuario.", file=sys.stderr)
            return 130
        if not args.sin_correlacion:
            # Compara con casos anteriores (campañas) y recalcula veredicto y mitigaciones.
            from cintel.case import finalize_case
            from cintel.correlation import correlate

            try:
                correlate(case, root, write=not args.no_guardar)
                finalize_case(case)
            except OSError as exc:
                print(f"[aviso] No se pudo usar el índice de correlación: {exc}", file=sys.stderr)
        paths = None
        if not args.no_guardar:
            from cintel.report import save_case

            try:
                paths = save_case(case, root, make_pdf=not args.sin_pdf)
            except PermissionError as exc:
                print(f"[error] Sin permiso para escribir en {root}: {exc}", file=sys.stderr)
                exit_code = 2
            except OSError as exc:
                print(f"[error] No se pudo guardar el reporte: {exc}", file=sys.stderr)
                exit_code = 2
        case["archivos"] = paths
        cases.append(case)
        if not args.json:
            if ui:
                ui.render_case(out, case, paths, args.detalle)
            else:
                print_summary(case, paths, color, args.detalle)
        if args.abrir and paths and paths.get("pdf"):
            _open_file(paths["pdf"])
    if args.json:
        print(json.dumps(cases[0] if len(cases) == 1 else cases, ensure_ascii=False, indent=2, default=str))
    elif len(cases) > 1 and ui:
        ui.render_batch(out, cases, root)
    elif len(cases) > 1:
        print()
        print(_c("titulo", f"Resumen: {len(cases)} análisis guardados en {root}", color))
        for case in cases:
            print(f"  {case['veredicto']['etiqueta']:<28} {case['id']}  {Path(case['objetivo']).name}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

