#!/usr/bin/env python3
"""Browse fields and the cell-series store for the SMAP time-variant TCA error portal (Kim et al. 2025).

Source: nine annual NetCDF files SMAP_VARerr_reconstruct_<YYYY>.nc, float32 [406 lat][964 lon][T time], no time
coordinate. T = two steps per day (SMAP's 6 a.m. descending and 6 p.m. ascending overpasses; which comes first is
checked against SPL3SMP by stats.py and read from work/stats.json). 2015 has 630 steps = 315 days ending 31 Dec
(from 20 Feb; SMAP data begin 31 Mar), 2023 has 630 steps = 1 Jan … 11 Nov, the other years are whole.

The grid is SMAP's 36 km EASE-Grid 2.0 (406 x 964), so one step is one 8-bit PNG and the browser projects it itself.

Field contract (every PNG): 964 x 406, 8-bit grayscale, DN 255 = no data.
  SM             value = DN x 0.0035 m3/m3 (SMAP L3 soil moisture, no quality screening)
  ERR, LGBM, DNN value = DN x 0.001  m3/m3 (sigma: TCA error standard deviation; DN 254 = 0.254, larger clipped)
  CODE           bit 0..3 the four TCA flags raised (correlation, valid number, fMSE, negative error variance),
                 bit 4 raw sigma present, bit 5 reconstructed sigma present (SM present, raw absent, model value present),
                 bit 6 SM present, bit 7 flags known. Cells off the land mask are 255.
  NSM            steps with SM: record total in steps of 32, calendar-month mean in steps of 1
  PRAW/PREC/PMISS per cent of the SM steps with raw sigma / with a reconstructed sigma / with neither, DN x 0.4
  SDERR, SDLGBM  temporal standard deviation of raw sigma and of the LGBM-reconstructed sigma, DN x 0.0002

Archives (PMTiles as a range-readable key-value store):
  daily/TCA_<VAR>_<YYYY>.pmtiles     z 10, x = step index within the year (0..T-1), y = 0      VAR in SM, LGBM, DNN, CODE
                                     (raw sigma = LGBM where CODE bit 4 is set: the files hold the raw value there)
  monthly/TCA_<VAR>_monthly.pmtiles  z 9, x = (year-2015)*12 + month-1, y = 0                  VAR in SM, ERR, LGBM, DNN, NSM, PRAW, PREC, PMISS
  clim/TCA_<VAR>_clim.pmtiles        z 9, x = 0 record, x = 1..12 calendar month, y = 0        VAR as monthly + SDERR, SDLGBM (x = 0 only)
  series/TCA_series.pmtiles          z 10, x = column, y = row -> uint16 LE [T_total][SM, LGBM, DNN, CODE]
                                     SM x 1e-4, sigma x 1e-5, CODE as above; 65535 = no value (CODE is never 65535)
Statistics for the catalog go to work/layers.json.
"""
import argparse, calendar, io, json, os, time
from datetime import date, timedelta
from multiprocessing import Pool

import netCDF4 as nc
import numpy as np
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

SRC_VARS = {"SMAP_SM": "SM", "SMAP_TCA_err": "ERR", "SMAP_TCA_err_recons_LGBM": "LGBM", "SMAP_TCA_err_recons_DNN": "DNN"}
FLAG_VARS = ["flags_corr", "flags_n_valid", "flags_fMSE", "flags_negative_vars_err"]
STEP = {"SM": 0.0035, "ERR": 0.001, "LGBM": 0.001, "DNN": 0.001, "PRAW": 0.4, "PREC": 0.4, "PMISS": 0.4, "SDERR": 0.0002, "SDLGBM": 0.0002}
SCALE = {"SM": 1e-4, "LGBM": 1e-5, "DNN": 1e-5}
UNITS = {"SM": "m3 m-3", "ERR": "m3 m-3", "LGBM": "m3 m-3", "DNN": "m3 m-3", "PRAW": "%", "PREC": "%", "PMISS": "%", "SDERR": "m3 m-3", "SDLGBM": "m3 m-3", "NSM": "steps"}
NODATA_DN = 255; SER_NODATA = 65535; Y0 = 2015
B_RAW, B_REC, B_SM, B_KNOWN = 16, 32, 64, 128
G = {}


def log(m): print(time.strftime("%H:%M:%S"), m, flush=True)


def year_days(year, T):
    nd = T // 2; assert T == 2 * nd, T
    full = 366 if calendar.isleap(year) else 365
    first = date(year, 1, 1) if nd == full or year != 2015 else date(year, 12, 31) - timedelta(days=nd - 1)
    return [first + timedelta(days=i) for i in range(nd)]


def png_bytes(q):
    buf = io.BytesIO(); Image.fromarray(np.ascontiguousarray(q), "L").save(buf, "PNG", optimize=True); return buf.getvalue()


def quantize(v, step):
    ok = np.isfinite(v); q = np.full(v.shape, NODATA_DN, np.uint8)
    q[ok] = np.minimum(np.rint(v[ok] / step), NODATA_DN - 1); return q


def enc_step(t):
    """One step: PNGs of SM, LGBM, DNN, CODE and the step's statistics."""
    out = {}; st = {}
    for v in ("SM", "LGBM", "DNN"):
        f = G[v][t]; ok = np.isfinite(f); n = int(ok.sum())
        out[v] = png_bytes(quantize(f, STEP[v])) if n else None
        st[v] = (n, float(f[ok].mean()) if n else None)
    code = G["CODE"][t]
    raw = (code & B_RAW) > 0; rec = (code & B_REC) > 0; sm = (code & B_SM) > 0
    n_raw = int(raw.sum()); n_rec = int(rec.sum()); n_sm = int(sm.sum())
    st["ERR"] = (n_raw, float(G["LGBM"][t][raw].mean()) if n_raw else None)
    st["n_miss"] = int((sm & ~raw & ~rec).sum())
    st["flags"] = [int(((code & (1 << i)) > 0).sum()) for i in range(4)]
    q = code.copy(); q[~G["land"]] = NODATA_DN
    out["CODE"] = png_bytes(q) if n_sm or (code & B_KNOWN).any() else None
    return t, out, st


def write_archive(path, tiles, tile_type, meta):
    tiles.sort(key=lambda t: t[0]); tmp = path + ".part"
    with open(tmp, "wb") as fh:
        w = Writer(fh)
        for tid, data in tiles: w.write_tile(tid, data)
        w.finalize({"tile_type": tile_type, "tile_compression": Compression.NONE, "min_lon_e7": -1800000000, "min_lat_e7": -850445000,
                    "max_lon_e7": 1800000000, "max_lat_e7": 850445000, "center_zoom": 0, "center_lon_e7": 0, "center_lat_e7": 0}, meta)
    os.replace(tmp, path); return os.path.getsize(path)


def meta_for(name, var, addressing):
    return {"name": name, "format": "png", "type": "overlay", "addressing": addressing, "field": "964x406 EASE-Grid 2.0 36 km",
            "encoding": {"kind": "numeric-8bit" if var != "CODE" else "bitfield", "step": STEP.get(var, 1), "nodata_dn": NODATA_DN, "units": UNITS.get(var, "")}}


class Acc:
    """Per-cell sums over a set of steps: mean fields and counts."""
    def __init__(s, H, W):
        s.sum = {v: np.zeros((H, W)) for v in ("SM", "ERR", "LGBM", "DNN")}; s.cnt = {v: np.zeros((H, W), np.int64) for v in ("SM", "ERR", "LGBM", "DNN")}
        s.sq = {v: np.zeros((H, W)) for v in ("ERR", "LGBM")}; s.n_rec = np.zeros((H, W), np.int64); s.steps = 0; s.years = set()
    def add(s, o):
        for v in s.sum: s.sum[v] += o.sum[v]; s.cnt[v] += o.cnt[v]
        for v in s.sq: s.sq[v] += o.sq[v]
        s.n_rec += o.n_rec; s.steps += o.steps; s.years |= o.years
    def mean(s, v):
        m = np.full(s.sum[v].shape, np.nan, np.float32); np.divide(s.sum[v], s.cnt[v], out=m, where=s.cnt[v] > 0, casting="unsafe"); return m
    def sd(s, v):
        c = s.cnt[v]; m = np.full(c.shape, np.nan, np.float32)
        with np.errstate(invalid="ignore"):
            var = np.where(c > 1, s.sq[v] / np.maximum(c, 1) - (s.sum[v] / np.maximum(c, 1)) ** 2, np.nan)
        m[c > 1] = np.sqrt(np.maximum(var[c > 1], 0)); return m
    def shares(s):
        n = s.cnt["SM"]; out = {}
        for k, num in (("PRAW", s.cnt["ERR"]), ("PREC", s.n_rec), ("PMISS", n - s.cnt["ERR"] - s.n_rec)):
            f = np.full(n.shape, np.nan, np.float32); np.divide(100.0 * num, n, out=f, where=n > 0, casting="unsafe"); out[k] = f
        return out


def accumulate(sl, A, code, year):
    H, W = A["SM"].shape[1:]; o = Acc(H, W)
    for v in ("SM", "LGBM", "DNN"):
        x = A[v][sl]; ok = np.isfinite(x); o.sum[v] = np.where(ok, x, 0).sum(axis=0, dtype=np.float64); o.cnt[v] = ok.sum(axis=0)
        if v == "LGBM": o.sq[v] = np.where(ok, x, 0).astype(np.float64).__pow__(2).sum(axis=0)
    c = code[sl]; raw = (c & B_RAW) > 0
    xr = np.where(raw, A["LGBM"][sl], 0).astype(np.float64)
    o.sum["ERR"] = xr.sum(axis=0); o.cnt["ERR"] = raw.sum(axis=0); o.sq["ERR"] = (xr ** 2).sum(axis=0)
    o.n_rec = ((c & B_REC) > 0).sum(axis=0); o.steps = sl.stop - sl.start; o.years = {year}
    return o


def stat(v, land_px):
    ok = np.isfinite(v); n = int(ok.sum())
    return {"mean": round(float(v[ok].mean()), 6) if n else None, "n": n, "cover": round(n / land_px, 4)}


def count_tiles(acc, land, per_year=False):
    """NSM field: total steps (/32) or mean steps per year (/1)."""
    q = np.full(land.shape, NODATA_DN, np.uint8)
    c = acc.cnt["SM"]
    q[land] = np.minimum(np.rint(c[land] / (32 if not per_year else max(1, len(acc.years)))), 254)
    return q


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default="/home/data_4/finished_projects/project_TCA_ML/manuscript_EASE_036/after_correct_TCA/2015_2023_SMAP")
    ap.add_argument("--work", default="/data/personal_data/project_tca_portal/work")
    ap.add_argument("--out", default="/data/personal_data/project_tca_portal/out")
    ap.add_argument("--years", default="2015-2023")
    ap.add_argument("--procs", type=int, default=16)
    ap.add_argument("--skip-series", action="store_true")
    a = ap.parse_args(); t00 = time.time()
    y0, y1 = (int(x) for x in a.years.split("-")); years = list(range(y0, y1 + 1))
    for d in ("daily", "monthly", "clim", "series"): os.makedirs(os.path.join(a.out, d), exist_ok=True)
    S = json.load(open(os.path.join(a.work, "stats.json")))
    am = S["years"]["2022"]["ampm"]
    ov = lambda k: am[k]["n_both"] / max(1, am[k]["n_step"])          # share of the step's cells that the L3 overpass also has
    ev_am, ev_pm, od_am, od_pm = ov("t_even_vs_AM"), ov("t_even_vs_PM"), ov("t_odd_vs_AM"), ov("t_odd_vs_PM")
    assert (ev_am > 0.9 and od_pm > 0.9 and ev_pm < 0.7 and od_am < 0.7) or (ev_pm > 0.9 and od_am > 0.9 and ev_am < 0.7 and od_pm < 0.7), am
    ORDER = ["AM", "PM"] if ev_am > ev_pm else ["PM", "AM"]
    log(f"step order within a day: {ORDER} (even step shares {max(ev_am, ev_pm):.3f} of its cells with the SPL3SMP {ORDER[0]} swath, {min(ev_am, ev_pm):.3f} with the other)")
    n_sm = np.load(os.path.join(a.work, "n_SM.npy")); land = n_sm > 0; land_px = int(land.sum())
    rows, cols = np.nonzero(land); NS = len(rows); G["land"] = land
    # the whole time axis first, so the series store and the global step index are known
    axis = []; t0_of = {}
    for y in range(2015, 2024):
        p = os.path.join(a.root, f"ML_{y}", f"SMAP_VARerr_reconstruct_{y}.nc")
        T = nc.Dataset(p)["SMAP_SM"].shape[2]; t0_of[y] = len(axis)
        for d in year_days(y, T):
            for k in range(2): axis.append((d, ORDER[k]))
    T_ALL = len(axis)
    assert year_days(2015, 630)[0] == date(2015, 2, 20) and S["years"]["2015"]["first_step_with"]["SM"] == 2 * (date(2015, 3, 31) - date(2015, 2, 20)).days
    log(f"{T_ALL} steps {axis[0][0]}..{axis[-1][0]}, {land_px} land cells, {len(years)} years to build")

    mm = None if a.skip_series else np.lib.format.open_memmap(os.path.join(a.work, "series_u16.dat"), mode="w+", dtype=np.uint16, shape=(NS, T_ALL, 4))
    if mm is not None: mm[:] = SER_NODATA
    H, W = land.shape
    rec = Acc(H, W); cal = {m: Acc(H, W) for m in range(1, 13)}; months = {}
    out = {"vars": {v: {"step": STEP.get(v), "scale": SCALE.get(v), "units": UNITS.get(v, "")} for v in ("SM", "ERR", "LGBM", "DNN")},
           "order": ORDER, "land_px": land_px, "T": T_ALL, "first": axis[0][0].isoformat(), "last": axis[-1][0].isoformat(),
           "years": [], "steps": [], "months": [], "clim": {}, "all": {}, "archives": {}}

    for y in years:
        ty = time.time(); p = os.path.join(a.root, f"ML_{y}", f"SMAP_VARerr_reconstruct_{y}.nc"); ds = nc.Dataset(p)
        for v in ds.variables.values(): v.set_auto_mask(False)
        T = ds["SMAP_SM"].shape[2]; days = year_days(y, T); t0 = t0_of[y]
        A = {}
        for sv, v in SRC_VARS.items():
            A[v] = np.ascontiguousarray(ds[sv][:].transpose(2, 0, 1))
        fin = {v: np.isfinite(A[v]) for v in A}
        code = np.zeros((T, H, W), np.uint8); known = np.zeros((T, H, W), bool)
        for i, fv in enumerate(FLAG_VARS):
            x = np.ascontiguousarray(ds[fv][:].transpose(2, 0, 1)); code |= ((x == 1).astype(np.uint8) << i); known |= np.isfinite(x); del x
        code |= (fin["ERR"].astype(np.uint8) * B_RAW) | ((fin["LGBM"] & ~fin["ERR"]).astype(np.uint8) * B_REC) | (fin["SM"].astype(np.uint8) * B_SM) | (known.astype(np.uint8) * B_KNOWN)
        del known, A["ERR"]; fin.pop("ERR")
        log(f"{y}: loaded {T} steps in {time.time() - ty:.0f}s")
        G["SM"], G["LGBM"], G["DNN"], G["CODE"] = A["SM"], A["LGBM"], A["DNN"], code
        with Pool(a.procs) as pool:
            res = pool.map(enc_step, range(T), chunksize=8)
        tiles = {v: [] for v in ("SM", "LGBM", "DNN", "CODE")}
        for t, pngs, st in res:
            for v, b in pngs.items():
                if b is not None: tiles[v].append((zxy_to_tileid(10, t, 0), b))
            d, half = axis[t0 + t]
            out["steps"].append([t0 + t, d.isoformat(), half, st["SM"][0], st["ERR"][0], st["LGBM"][0] - st["ERR"][0], st["n_miss"],
                                 None if st["SM"][1] is None else round(st["SM"][1], 5), None if st["ERR"][1] is None else round(st["ERR"][1], 6),
                                 None if st["LGBM"][1] is None else round(st["LGBM"][1], 6), None if st["DNN"][1] is None else round(st["DNN"][1], 6), st["flags"]])
        for v in tiles:
            pth = os.path.join(a.out, "daily", f"TCA_{v}_{y}.pmtiles")
            size = write_archive(pth, tiles[v], TileType.PNG, meta_for(f"TCA {v} {y} half-day steps", v, f"z=10, x=step index within {y} (0..{T - 1}), y=0; order {ORDER}"))
            out["archives"][f"daily/TCA_{v}_{y}.pmtiles"] = {"bytes": size, "entries": len(tiles[v])}
        del res; log(f"{y}: daily fields written ({time.time() - ty:.0f}s)")
        # months of this year
        by_month = {}
        for t, (d, _) in enumerate(axis[t0:t0 + T]): by_month.setdefault((d.year, d.month), []).append(t)
        for (yy, m), idx in sorted(by_month.items()):
            sl = slice(idx[0], idx[-1] + 1); o = accumulate(sl, A, code, yy)
            months[(yy, m)] = o; rec.add(o); cal[m].add(o)
        if mm is not None:
            for k, v in enumerate(("SM", "LGBM", "DNN")):
                for s0 in range(0, NS, 16384):
                    sl = slice(s0, min(NS, s0 + 16384)); x = A[v][:, rows[sl], cols[sl]]
                    q = np.full(x.shape, SER_NODATA, np.uint16); ok = np.isfinite(x)
                    q[ok] = np.minimum(np.rint(x[ok] / SCALE[v]), SER_NODATA - 1); mm[sl, t0:t0 + T, k] = q.T
            for s0 in range(0, NS, 16384):
                sl = slice(s0, min(NS, s0 + 16384)); mm[sl, t0:t0 + T, 3] = code[:, rows[sl], cols[sl]].T
            mm.flush()
        out["years"].append({"year": y, "T": T, "t0": t0, "first": days[0].isoformat(), "last": days[-1].isoformat(), "bytes": os.path.getsize(p),
                             "file": f"ML_{y}/SMAP_VARerr_reconstruct_{y}.nc"})
        del A, fin, code, ds; G.pop("SM", None); G.pop("LGBM", None); G.pop("DNN", None); G.pop("CODE", None)
        log(f"{y}: months + series done ({time.time() - ty:.0f}s, total {time.time() - t00:.0f}s)")

    # monthly archives
    mkeys = sorted(months)
    tiles = {v: [] for v in ("SM", "ERR", "LGBM", "DNN", "NSM", "PRAW", "PREC", "PMISS")}
    for (yy, m) in mkeys:
        o = months[(yy, m)]; x = (yy - Y0) * 12 + (m - 1); tid = zxy_to_tileid(9, x, 0); row = {"ym": f"{yy}-{m:02d}", "steps": o.steps}
        for v in ("SM", "ERR", "LGBM", "DNN"):
            f = o.mean(v); tiles[v].append((tid, png_bytes(quantize(f, STEP[v])))); s = stat(f, land_px); row[v] = s["mean"]; row[f"cover_{v}"] = s["cover"]
        q = np.full((H, W), NODATA_DN, np.uint8); q[land] = np.minimum(o.cnt["SM"][land], 254); tiles["NSM"].append((tid, png_bytes(q)))
        for k, f in o.shares().items(): tiles[k].append((tid, png_bytes(quantize(f, STEP[k])))); row[k] = stat(f, land_px)["mean"]
        row["cellsteps_sm"] = int(o.cnt["SM"].sum()); row["cellsteps_err"] = int(o.cnt["ERR"].sum()); row["cellsteps_rec"] = int(o.n_rec.sum())
        out["months"].append(row)
    for v, tl in tiles.items():
        pth = os.path.join(a.out, "monthly", f"TCA_{v}_monthly.pmtiles")
        size = write_archive(pth, tl, TileType.PNG, meta_for(f"TCA {v} monthly", v, "z=9, x=(year-2015)*12+month-1, y=0"))
        out["archives"][f"monthly/TCA_{v}_monthly.pmtiles"] = {"bytes": size, "entries": len(tl)}
    log("monthly archives written")
    # climatology: x=0 record, x=1..12 calendar months
    tiles = {v: [] for v in ("SM", "ERR", "LGBM", "DNN", "NSM", "PRAW", "PREC", "PMISS", "SDERR", "SDLGBM")}
    def put(o, x, tag):
        tid = zxy_to_tileid(9, x, 0); row = {"steps": o.steps, "years": len(o.years)}
        for v in ("SM", "ERR", "LGBM", "DNN"):
            f = o.mean(v); tiles[v].append((tid, png_bytes(quantize(f, STEP[v])))); s = stat(f, land_px); row[v] = s["mean"]; row[f"cover_{v}"] = s["cover"]
        tiles["NSM"].append((tid, png_bytes(count_tiles(o, land, per_year=x > 0))))
        for k, f in o.shares().items(): tiles[k].append((tid, png_bytes(quantize(f, STEP[k])))); row[k] = stat(f, land_px)["mean"]
        if x == 0:
            for k, v in (("SDERR", "ERR"), ("SDLGBM", "LGBM")):
                f = o.sd(v); tiles[k].append((tid, png_bytes(quantize(f, STEP[k])))); row[k] = stat(f, land_px)["mean"]
            row["steps_per_cell_mean"] = round(float(o.cnt["SM"][land].mean()), 1)
        row["cellsteps_sm"] = int(o.cnt["SM"].sum()); row["cellsteps_err"] = int(o.cnt["ERR"].sum()); row["cellsteps_rec"] = int(o.n_rec.sum())
        return row
    out["all"] = put(rec, 0, "record")
    for m in range(1, 13): out["clim"][str(m)] = put(cal[m], m, f"month {m}")
    for v, tl in tiles.items():
        pth = os.path.join(a.out, "clim", f"TCA_{v}_clim.pmtiles")
        size = write_archive(pth, tl, TileType.PNG, meta_for(f"TCA {v} climatology", v, "z=9, x=0 record, x=1..12 calendar month, y=0"))
        out["archives"][f"clim/TCA_{v}_clim.pmtiles"] = {"bytes": size, "entries": len(tl)}
    log("climatology archives written")
    if mm is not None:
        ts = time.time(); ids = np.array([zxy_to_tileid(10, int(c), int(r)) for r, c in zip(rows, cols)], np.int64); order = np.argsort(ids)
        pth = os.path.join(a.out, "series", "TCA_series.pmtiles"); tmp = pth + ".part"
        with open(tmp, "wb") as fh:
            w = Writer(fh)
            for i in order: w.write_tile(int(ids[i]), np.ascontiguousarray(mm[i]).astype("<u2").tobytes())
            w.finalize({"tile_type": TileType.UNKNOWN, "tile_compression": Compression.NONE, "min_lon_e7": -1800000000, "min_lat_e7": -850445000,
                        "max_lon_e7": 1800000000, "max_lat_e7": 850445000, "center_zoom": 0, "center_lon_e7": 0, "center_lat_e7": 0},
                       {"name": "TCA cell series", "type": "series", "addressing": "z=10, x=column, y=row",
                        "layout": f"uint16 little-endian [{T_ALL} steps][SM, LGBM, DNN, CODE]; 65535 = no value", "scale": SCALE, "first_step": axis[0][0].isoformat(), "order": ORDER})
        os.replace(tmp, pth); out["archives"]["series/TCA_series.pmtiles"] = {"bytes": os.path.getsize(pth), "entries": NS}
        log(f"series archive: {NS} cells, {os.path.getsize(pth) / 1e9:.2f} GB ({time.time() - ts:.0f}s)"); del mm; os.remove(os.path.join(a.work, "series_u16.dat"))
    json.dump(out, open(os.path.join(a.work, "layers.json"), "w"))
    log(f"done in {time.time() - t00:.0f}s -> {a.work}/layers.json")


if __name__ == "__main__":
    main()
