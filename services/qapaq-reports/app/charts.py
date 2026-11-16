"""Graficos como SVG en linea con matplotlib (paleta QAPAQ). Sin red, sin archivos."""
from __future__ import annotations

import io
import re

import matplotlib

matplotlib.use("svg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import MaxNLocator  # noqa: E402

from .common import INK, SERIES_COLORS, fmt_number  # noqa: E402
from .spec import ChartSection  # noqa: E402

MUTED = "#6B6B72"
GRID = "#E4E4E7"
_counter = 0


def _style() -> None:
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Noto Sans", "DejaVu Sans"],
        "font.size": 8.5,
        "text.color": INK,
        "axes.labelcolor": MUTED,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "axes.edgecolor": "#BBBBD0",
        "svg.fonttype": "path",
    })


def _categories(sec: ChartSection) -> list[str]:
    xs: list[str] = []
    seen: set[str] = set()
    for s in sec.series:
        for x, _ in s.points:
            if x not in seen:
                seen.add(x)
                xs.append(x)
    return xs


def chart_svg(sec: ChartSection) -> str:
    """Devuelve el <svg>...</svg> listo para incrustar (width fluida via viewBox)."""
    global _counter
    _counter += 1
    _style()
    plt.rcParams["svg.hashsalt"] = f"qapaq-chart-{_counter}"
    fig, ax = plt.subplots(figsize=(7.0, 2.9 if sec.chart != "donut" else 3.0), dpi=100)
    try:
        if sec.chart == "donut":
            _donut(fig, ax, sec)
        else:
            _xy(fig, ax, sec)
        buf = io.StringIO()
        fig.savefig(buf, format="svg", transparent=True)
    finally:
        plt.close(fig)
    svg = buf.getvalue()
    svg = svg[svg.index("<svg"):]
    # tamano fluido: se elimina width/height absolutos y se deja el viewBox
    head_end = svg.index(">")
    head = re.sub(r'\s(width|height)="[^"]*"', "", svg[:head_end])
    svg = head + svg[head_end:]
    svg = re.sub(r"<metadata>.*?</metadata>", "", svg, flags=re.S)
    return svg


def _xy(fig, ax, sec: ChartSection) -> None:
    xs = _categories(sec)
    n = len(xs)
    idx = {x: i for i, x in enumerate(xs)}
    k = len(sec.series)
    for j, s in enumerate(sec.series):
        color = SERIES_COLORS[j % len(SERIES_COLORS)]
        label = s.label or f"Serie {j + 1}"
        pos = [idx[x] for x, _ in s.points]
        ys = [y for _, y in s.points]
        if sec.chart == "bar":
            width = 0.78 / k
            off = [p - 0.39 + width * (j + 0.5) for p in pos]
            ax.bar(off, ys, width=width * 0.92, color=color, label=label, linewidth=0)
        else:
            ax.plot(pos, ys, color=color, label=label, linewidth=2, marker="o" if n <= 40 else None,
                    markersize=3.5, markeredgewidth=0)
    ax.set_xticks(range(n))
    step = max(1, -(-n // 14))
    ax.set_xticklabels([x if i % step == 0 else "" for i, x in enumerate(xs)],
                       rotation=0 if n <= 8 else 35, ha="center" if n <= 8 else "right")
    ax.yaxis.set_major_locator(MaxNLocator(integer=all(float(y).is_integer() for s in sec.series for _, y in s.points),
                                           nbins=5))
    ax.yaxis.set_major_formatter(lambda v, _p: fmt_number(v))
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.tick_params(axis="both", length=0)
    ax.margins(x=0.02)
    if sec.chart == "bar":
        ax.set_xlim(-0.6, n - 0.4)
    if k > 1:
        ax.legend(loc="upper left", bbox_to_anchor=(0, 1.16), ncol=min(k, 6), frameon=False,
                  handlelength=1.2, columnspacing=1.4)
    fig.subplots_adjust(left=0.07, right=0.955, top=0.88 if k > 1 else 0.96, bottom=0.2 if n > 8 else 0.12)


def _donut(fig, ax, sec: ChartSection) -> None:
    if len(sec.series) == 1:
        data = [(x or "—", y) for x, y in sec.series[0].points]
    else:
        data = [(s.label or f"Serie {i + 1}", sum(y for _, y in s.points)) for i, s in enumerate(sec.series)]
    data = [(l, v) for l, v in data if v > 0] or [("Sin datos", 1.0)]
    total = sum(v for _, v in data)
    colors = [SERIES_COLORS[i % len(SERIES_COLORS)] for i in range(len(data))]
    wedges, _ = ax.pie([v for _, v in data], colors=colors, startangle=90, counterclock=False,
                       wedgeprops={"width": 0.38, "edgecolor": "white", "linewidth": 1.5})
    ax.text(0, 0.06, fmt_number(total), ha="center", va="center", fontsize=17, fontweight="bold", color=INK)
    ax.text(0, -0.2, "total", ha="center", va="center", fontsize=8, color=MUTED)
    ax.set_aspect("equal")
    labels = [f"{l}  ·  {fmt_number(v)} ({v / total:.0%})" for l, v in data]
    ax.legend(wedges, labels, loc="center left", bbox_to_anchor=(1.02, 0.5), frameon=False,
              fontsize=8.5, labelcolor=INK)
    fig.subplots_adjust(left=0.02, right=0.58, top=0.98, bottom=0.02)
