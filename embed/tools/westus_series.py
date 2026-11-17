#!/usr/bin/env python3
"""westus_series.py DATA_DIR OUT_JSON — area-mean error sigma (gap-filled, LGBM) of the western-United-States box from the
portal's own fields: the record mean (climatology archive), monthly means (monthly archive) and per-overpass means (daily
archives, LGBM = raw TCA value where it exists, the model's value elsewhere). The grid is equal-area, so a plain mean over
cells is an area mean. Adapted from the HDCA portal's amazon_series.py."""
import sys, json, io, gzip, math
from pathlib import Path
import numpy as np
from PIL import Image
from pmtiles.reader import Reader, MmapSource
data, outp = Path(sys.argv[1]), Path(sys.argv[2])
cat = json.loads((data / "catalog.json").read_text())
BOX = [-125.0, 31.0, -102.0, 49.0]            # lon0, lat0, lon1, lat1: the western United States, Pacific coast to the Rockies' east slope
VAR = "LGBM"
W, Hh = cat["grid"]["cols"], cat["grid"]["rows"]
step = cat["variables"][VAR]["step"]
lats = np.array(cat["grid"]["lats"])
rows = np.where((lats >= BOX[1]) & (lats <= BOX[3]))[0]
c0, c1 = int(math.floor((BOX[0] + 180) / 360 * W)), int(math.floor((BOX[2] + 180) / 360 * W))
print("rows", rows.min(), rows.max(), "cols", c0, c1, "cells", len(rows) * (c1 - c0 + 1))
readers = {}
def tile(rel, z, x):
    r = readers.get(rel)
    if r is None:
        f = open(data / rel, "rb"); r = Reader(MmapSource(f)); readers[rel] = r
    b = r.get(z, x, 0)
    if not b: return None
    if b[:2] == b"\x1f\x8b": b = gzip.decompress(b)
    a = np.asarray(Image.open(io.BytesIO(b)))
    assert a.shape == (Hh, W), a.shape
    return a
def boxmean(a):
    sub = a[rows.min():rows.max() + 1, c0:c1 + 1]
    ok = sub != 255
    return (float(sub[ok].mean() * step) if ok.any() else None), int(ok.sum())
out = {"box": BOX, "rows": [int(rows.min()), int(rows.max())], "cols": [c0, c1], "var": VAR, "step": step, "months": [], "steps": []}
a = tile(f"clim/TCA_{VAR}_clim.pmtiles", 9, 0); m, n = boxmean(a); out["record_mean"] = m; out["record_cells"] = n
print("record mean", m, "cells with data", n)
for rec in cat["months"]:
    y, mo = int(rec["ym"][:4]), int(rec["ym"][5:7])
    a = tile(f"monthly/TCA_{VAR}_monthly.pmtiles", 9, (y - 2015) * 12 + mo - 1)
    m, n = boxmean(a) if a is not None else (None, 0)
    out["months"].append({"ym": rec["ym"], "mean": m, "n": n})
years = {y["year"]: y for y in cat["source"]["years"]}
for rec in cat["days"]:
    d = rec["d"]; y = int(d[:4]); yr = years[y]
    for k, half in enumerate(cat["steps"]["order"]):
        if half not in rec: continue
        t_local = rec["t"] + k - yr["t0"]
        a = tile(f"daily/TCA_{VAR}_{y}.pmtiles", 10, int(t_local))
        m, n = boxmean(a) if a is not None else (None, 0)
        out["steps"].append({"d": d, "half": half, "mean": m, "n": n})
outp.write_text(json.dumps(out))
mm = [x["mean"] for x in out["months"] if x["mean"] is not None]
print("months", len(out["months"]), "with data", len(mm), "min %.4f max %.4f" % (min(mm), max(mm)))
dd = [x["mean"] for x in out["steps"] if x["mean"] is not None]
print("overpasses", len(out["steps"]), "with data", len(dd), "min %.4f max %.4f" % (min(dd), max(dd)))
for x in out["months"][::12]: print(x["ym"], x["mean"], x["n"])
