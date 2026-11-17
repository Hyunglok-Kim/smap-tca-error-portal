#!/usr/bin/env python3
"""compose_tca_westus.py FRAMES_DIR SERIES_JSON OUT_DIR [test] — the TCA card (v2) from the raw frames of cap_tca_westus.py:
the globe turn and the zoom as captured; on the western-US stage the box fades in, a chart panel rises, and the region's
monthly area-mean error sigma draws itself month by month in step with the maps (faint dots: every overpass set); a short
dissolve back to the first frame closes the loop. Adapted from the HDCA portal's compose_hdca_amazon.py."""
import sys, json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
src, series_path, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]); test = "test" in sys.argv[4:]
out.mkdir(parents=True, exist_ok=True)
tl = json.loads((src / "timeline.json").read_text()); W, H, FPS = tl["W"], tl["H"], tl["fps"]
NA, NB, NC0, NHOLD, MONTHS = tl["NA"], tl["NB"], tl["NC0"], tl["NHOLD"], tl["months"]; NM = len(MONTHS); NTAIL, NBLEND = 12, 8
ser = json.loads(series_path.read_text())
mon = np.array([m["mean"] if m["mean"] is not None else np.nan for m in ser["months"]], dtype=float); assert len(mon) == NM
def mpos(iso):  # months since the first month, mid-month = .5
    y, m, d = int(iso[:4]), int(iso[5:7]), int(iso[8:10]) if len(iso) >= 10 else 15
    return (y - int(MONTHS[0][:4])) * 12 + (m - int(MONTHS[0][5:7])) + (d - 0.5) / 30.5
days = [(mpos(x["d"]), x["mean"]) for x in ser["steps"] if x["mean"] is not None]
dx, dy = np.array([p for p, _ in days]), np.array([v for _, v in days])
YLO, YHI, YT = 0.018, 0.042, [0.02, 0.03, 0.04]
# ── the panel ──
PX0, PY0, PX1, PY1, R = 24, 318, 936, 480, 14
LINE, GLOW, INK, DIM = "#8BD3F7", "#8BD3F7", "#F3F6FA", "#9AA4B2"
fam = next((f for f in ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"] if any(ff.name == f for ff in font_manager.fontManager.ttflist)), "DejaVu Sans")
plt.rcParams.update({"font.family": fam, "text.color": INK, "axes.edgecolor": "none", "axes.facecolor": "none", "figure.facecolor": "none"})
_bg = None
def panel_bg():
    global _bg
    if _bg is None:
        s = 3; im = Image.new("RGBA", ((PX1 - PX0) * s, (PY1 - PY0) * s), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, im.width - 1, im.height - 1], radius=R * s, fill=(15, 19, 24, 204), outline=(255, 255, 255, 34), width=s)
        _bg = im.resize((PX1 - PX0, PY1 - PY0), Image.LANCZOS)
    return _bg
MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
def chart(k):
    """The panel's drawing with the line up to month k (k = -1: axes only), as RGBA the panel's size."""
    pw, ph = PX1 - PX0, PY1 - PY0
    fig = plt.figure(figsize=(pw / 100, ph / 100), dpi=100)
    ax = fig.add_axes([60 / pw, 30 / ph, (pw - 60 - 26) / pw, (ph - 30 - 50) / ph])
    ax.set_xlim(0, NM); ax.set_ylim(YLO, YHI)
    for y in YT: ax.axhline(y, color="#FFFFFF", alpha=0.10, lw=1)
    ax.axhline(ser["record_mean"], color="#FFFFFF", alpha=0.28, lw=1, ls=(0, (4, 3)))
    ax.set_yticks(YT); ax.set_yticklabels([f"{y:.2f}" for y in YT], fontsize=12.5, color=DIM); ax.tick_params(axis="y", length=0, pad=7)
    ticks = [i for i, ym in enumerate(MONTHS) if ym.endswith("-01")]
    ax.set_xticks(ticks); ax.set_xticklabels([ym[:4] if int(ym[:4]) % 3 == 1 else "" for ym in MONTHS if ym.endswith("-01")], fontsize=15, color=DIM)
    ax.tick_params(axis="x", length=0, pad=8)
    for i in ticks: ax.axvline(i, color="#FFFFFF", alpha=0.07, lw=1)
    if k >= 0:
        sel = dx <= k + 1
        ax.scatter(dx[sel], dy[sel], s=3.5, color=LINE, alpha=0.16, linewidths=0, zorder=2)
        x = np.arange(NM)[: k + 1] + 0.5
        ax.plot(x, mon[: k + 1], color=GLOW, lw=7, alpha=0.18, solid_capstyle="round", zorder=3)
        ax.plot(x, mon[: k + 1], color=LINE, lw=2.6, solid_capstyle="round", solid_joinstyle="round", zorder=4)
        ax.scatter([k + 0.5], [mon[k]], s=260, color=LINE, alpha=0.22, linewidths=0, zorder=5)
        ax.scatter([k + 0.5], [mon[k]], s=52, color="#FFFFFF", edgecolors=LINE, linewidths=2, zorder=6)
        ym = MONTHS[k]; fig.text(1 - 22 / pw, 1 - 18 / ph, f"{MONL[int(ym[5:]) - 1][:3]} {ym[:4]}   {mon[k]:.4f}" if not np.isnan(mon[k]) else f"{MONL[int(ym[5:]) - 1][:3]} {ym[:4]}   no data", ha="right", va="top", fontsize=19, color=INK, fontweight="medium")
    fig.text(22 / pw, 1 - 20 / ph, "Western US  ·  SMAP soil-moisture error σ, monthly mean (m³/m³)", ha="left", va="top", fontsize=15, color=INK, fontweight="medium")
    fig.text(1 - 22 / pw, 1 - 46 / ph, f"dashed: record mean {ser['record_mean']:.4f}  ·  dots: single overpass sets", ha="right", va="top", fontsize=11, color=DIM)
    fig.canvas.draw(); rgba = np.asarray(fig.canvas.buffer_rgba()).copy(); plt.close(fig)
    return Image.fromarray(rgba)
def load(name): return Image.open(src / name).convert("RGB")
def blend(a, b, t): return Image.fromarray((np.asarray(a, dtype=np.float32) * (1 - t) + np.asarray(b, dtype=np.float32) * t).astype(np.uint8))
smooth = lambda t: t * t * (3 - 2 * t)
def with_panel(base, k, a=1.0):
    """base RGB + the panel at opacity a, risen from 24 px below when a < 1."""
    im = base.convert("RGBA"); dy_ = int(round((1 - a) * 24))
    bg = panel_bg().copy(); ch = chart(k)
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0)); layer.alpha_composite(bg, (PX0, PY0 + dy_)); layer.alpha_composite(ch, (PX0, PY0 + dy_))
    if a < 1: al = layer.getchannel("A").point(lambda v: int(v * a)); layer.putalpha(al)
    im.alpha_composite(layer); return im.convert("RGB")
# ── the sequence ──
N = NA + NB + NC0 + NM + NHOLD + NTAIL
def frame(i):
    if i < NA: return load(f"A_{i:04d}.png")
    i -= NA
    if i < NB: return load(f"B_{i:04d}.png")
    i -= NB
    if i < NC0:
        t = smooth((i + 1) / NC0); base = blend(load("C_all.png"), load("C_all_box.png"), t)
        return with_panel(base, -1, t)
    i -= NC0
    if i < NM:
        base = load(f"M_{i:03d}.png")
        if i < NBLEND: base = blend(load("C_all_box.png"), base, smooth((i + 1) / NBLEND))
        return with_panel(base, i)
    i -= NM
    if i < NHOLD: return with_panel(load(f"M_{NM - 1:03d}.png"), NM - 1)
    i -= NHOLD
    return blend(with_panel(load(f"M_{NM - 1:03d}.png"), NM - 1), load("A_0000.png"), smooth((i + 1) / NTAIL))
written = 0
for i in range(N):
    try: im = frame(i)
    except FileNotFoundError:
        if test: continue
        raise
    im.save(out / f"f_{i:04d}.png"); written += 1
marks = [0, NA, NA + NB, NA + NB + NC0 + NM + NHOLD, N]
print("frames", N, "written", written, "| the captions change at", [round(m / FPS, 2) for m in marks], "s | panel from", round((NA + NB) / FPS, 2), "s")
