#!/usr/bin/env python3
"""Assemble catalog.json, the one file the portal reads first, from work/layers.json, work/stats.json and work/series_parts.json.

--hosts assigns archive files to named hosts (the public copy spreads them over GitHub Pages repositories; js/config.js
maps host names to base URLs; the lab copy ignores hosts). Format: "f1:daily/TCA_SM_*,daily/TCA_CODE_*;f2:daily/TCA_LGBM_*,daily/TCA_DNN_*;s1:series/TCA_series_r0*".
"""
import argparse, fnmatch, json, os, time
from datetime import date, timedelta
import numpy as np

EASE = {"name": "EASE-Grid 2.0 global, 36 km (EPSG:6933)", "rows": 406, "cols": 964, "cell_m": 36032.220840584,
        "x0_m": -17367530.445161, "y0_m": 7314540.830638, "a": 6378137.0, "e2": 0.00669437999014, "lat1": 30.0}
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("--work", default="/data/personal_data/project_tca_portal/work")
ap.add_argument("--out", default="/data/personal_data/project_tca_portal/out")
ap.add_argument("--root", default="/home/data_4/finished_projects/project_TCA_ML/manuscript_EASE_036/after_correct_TCA/2015_2023_SMAP")
ap.add_argument("--version", default=time.strftime("v1-%Y-%m-%d"))
ap.add_argument("--hosts", default="")
a = ap.parse_args()
L = json.load(open(os.path.join(a.work, "layers.json"))); S = json.load(open(os.path.join(a.work, "stats.json")))
lats = np.load(os.path.join(a.work, "lats.npy")); lons = np.load(os.path.join(a.work, "lons.npy"))
first = date.fromisoformat(L["first"]); last = date.fromisoformat(L["last"]); ndays = (last - first).days + 1
steps = L["steps"]
# days: one row per calendar day with both half-days
days = {}
for t, d, half, n_sm, n_raw, n_rec, n_miss, m_sm, m_err, m_lgbm, m_dnn, flags in steps:
    r = days.setdefault(d, {"d": d, "i": (date.fromisoformat(d) - first).days, "t": t if half == L["order"][0] else t - 1, "n": 0})
    r[half] = {"n": n_sm, "raw": n_raw, "rec": n_rec, "miss": n_miss, "SM": m_sm, "ERR": m_err, "LGBM": m_lgbm, "DNN": m_dnn, "flags": flags}
    r["n"] += n_sm
all_days = [(first + timedelta(days=i)).isoformat() for i in range(ndays)]
missing = [d for d in all_days if days.get(d, {}).get("n", 0) == 0]
with_data = [d for d in all_days if d not in set(missing)]
# months: possible steps vs steps with data
month_rows = []
for m in L["months"]:
    ym = m["ym"]; ds_ = [r for d, r in days.items() if d.startswith(ym)]
    month_rows.append({**m, "days_with_data": sum(1 for r in ds_ if r["n"] > 0), "days": sum(1 for d in all_days if d.startswith(ym)),
                       "cover": m.get("cover_SM", 0)})
series = None; sp = os.path.join(a.work, "series_parts.json"); archives = dict(L["archives"])
if os.path.exists(sp):
    series = json.load(open(sp)); archives.pop("series/TCA_series.pmtiles", None)
    for p in series["parts"]: archives[p["file"]] = {"bytes": p["bytes"], "entries": p["cells"]}
hosts = {}
for spec in filter(None, a.hosts.split(";")):
    name, pats = spec.split(":", 1)
    for f in archives:
        if any(fnmatch.fnmatch(f, p.strip()) for p in pats.split(",")): archives[f]["host"] = name; hosts.setdefault(name, 0); hosts[name] += archives[f]["bytes"]
years = []
for y in L["years"]:
    p = os.path.join(a.root, y["file"]); years.append({**y, "bytes": os.path.getsize(p) if os.path.exists(p) else y.get("bytes", 0),
                                                      "days_with_data": sum(1 for d, r in days.items() if d.startswith(str(y["year"])) and r["n"] > 0),
                                                      "missing": [d for d in missing if d.startswith(str(y["year"]))]})
cat = {
    "id": "smap-tca-error-36km", "version": a.version, "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "grid": {**EASE, "lats": [round(float(x), 4) for x in lats], "lons": [round(float(x), 4) for x in lons]},
    "encoding": {"kind": "numeric-8bit-field", "nodata_dn": 255, "field": "964 x 406 PNG, value = DN x step, DN 255 = no data",
                 "code_bits": {"1": "flag 1 correlation", "2": "flag 2 valid number", "4": "flag 3 fMSE", "8": "flag 4 negative error variance", "16": "raw TCA sigma present", "32": "reconstructed sigma present", "64": "SMAP SM present", "128": "flags known"},
                 "series": f"uint16 little-endian [{L['T']} steps][SM, LGBM, DNN, CODE] per land cell, 65535 = no value, value = raw x series_scale; raw sigma = LGBM where CODE bit 16 is set"},
    "archives": {"daily": "daily/TCA_{VAR}_{YYYY}.pmtiles  z10/x=step index within the year/y0  (VAR: SM, LGBM, DNN, CODE)",
                 "monthly": "monthly/TCA_{VAR}_monthly.pmtiles  z9/x=(year-2015)*12+month-1/y0  (SM, ERR, LGBM, DNN, NSM, PRAW, PREC, PMISS)",
                 "clim": "clim/TCA_{VAR}_clim.pmtiles  z9/x=0 record, 1..12 calendar month/y0  (+ SDERR, SDLGBM at x=0)",
                 "series": "series/TCA_series_r<r0>-<r1>.pmtiles  z10/x=column/y=row", "hosts": hosts, "files": archives},
    "series": series,
    "variables": {"SM": {"step": 0.0035, "series_scale": 1e-4, "units": "m3 m-3"}, "ERR": {"step": 0.001, "series_scale": 1e-5, "units": "m3 m-3"},
                  "LGBM": {"step": 0.001, "series_scale": 1e-5, "units": "m3 m-3"}, "DNN": {"step": 0.001, "series_scale": 1e-5, "units": "m3 m-3"},
                  "NSM": {"step": 1, "step_record": 32, "units": "steps"}, "PRAW": {"step": 0.4, "units": "%"}, "PREC": {"step": 0.4, "units": "%"}, "PMISS": {"step": 0.4, "units": "%"},
                  "SDERR": {"step": 0.0002, "units": "m3 m-3"}, "SDLGBM": {"step": 0.0002, "units": "m3 m-3"}, "CODE": {"step": 1, "units": ""}},
    "land_px": L["land_px"],
    "steps": {"per_day": 2, "order": L["order"], "n": L["T"], "first": L["first"], "last": L["last"], "with_data": sum(1 for s in steps if s[3] > 0),
              "note": "step index = 2 x (day index) + (0 for the 6 a.m. descending overpass, 1 for the 6 p.m. ascending one); each file's time axis starts at the year's first step (2015: 20 Feb; 2023: 1 Jan ... 11 Nov)"},
    "record": {"first": L["first"], "last": L["last"], "n": ndays, "with_tiles": len(with_data), "unit": "day", "missing": missing, "train": None},
    "all": L["all"], "clim": L["clim"],
    "source": {"grid": "EASE-Grid 2.0 global 36 km, 406 x 964 cells", "format": "NetCDF-4, float32, contiguous; dimensions latitude x longitude x time; no time coordinate",
               "input": "SMAP L3 Radiometer Global Daily 36 km EASE-Grid Soil Moisture (SPL3SMP v9), AM and PM, no quality screening; ASCAT H SAF CDR v7; GLDAS Noah 0.25 deg 3-hourly",
               "files": "ML_{YYYY}/SMAP_VARerr_reconstruct_{YYYY}.nc", "years": years, "total_bytes": sum(y["bytes"] for y in years),
               "zenodo": {"doi": "10.5281/zenodo.14850520", "url": "https://zenodo.org/records/14850520", "file": "SMAP_VARerr_reconstruct_2022.nc", "bytes": 9145874437, "years": [2022], "license": "CC BY 4.0"}},
    "stats": {v: {"min": S["vars"][v]["min"], "max": S["vars"][v]["max"], "pct": S["vars"][v]["pct"], "n": S["vars"][v]["n"]} for v in ("SM", "ERR", "LGBM", "DNN")},
    "cells": S["cells"],
    "days": [days[d] for d in all_days if d in days],
    "months": month_rows,
}
out = os.path.join(a.out, "catalog.json")
with open(out + ".part", "w") as fh: json.dump(cat, fh, separators=(",", ":"))
os.replace(out + ".part", out)
print(f"{out}: {len(cat['days'])} days ({len(with_data)} with data, {len(missing)} missing) of {ndays}, {len(month_rows)} months, {os.path.getsize(out) / 1024:.0f} KB; hosts {hosts}")
