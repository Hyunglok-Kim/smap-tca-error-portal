#!/usr/bin/env python3
"""Which of the two half-day steps is SMAP's AM (6 a.m. descending) overpass? Compare 2022-07-01 with SPL3SMP; write into work/stats.json."""
import glob, json, os, subprocess, sys
import numpy as np, netCDF4 as nc
from osgeo import gdal
gdal.UseExceptions()
W = "/data/personal_data/project_tca_portal/work"
root = "/home/data_4/finished_projects/project_TCA_ML/manuscript_EASE_036/after_correct_TCA/2015_2023_SMAP"
f = sorted(glob.glob("/home/data_1/SMAP/SPL3SMP.009/2022/2022.07.01/SMAP_L3_SM_P_20220701_*.h5"))[-1]
info = gdal.Info(f)
subs = [l.split("=", 1)[1] for l in info.splitlines() if "_NAME=" in l and "soil_moisture" in l]
print("\n".join(subs[:12]))
def rd(key):
    name = [s for s in subs if s.endswith(key)]
    if not name: return None
    x = gdal.Open(name[0]).ReadAsArray().astype(np.float32); x[x <= -9998] = np.nan; return x
am = rd("Soil_Moisture_Retrieval_Data_AM/soil_moisture"); pm = rd("Soil_Moisture_Retrieval_Data_PM/soil_moisture_pm")
print("AM", None if am is None else (am.shape, int(np.isfinite(am).sum())), "PM", None if pm is None else (pm.shape, int(np.isfinite(pm).sum())))
ds = nc.Dataset(f"{root}/ML_2022/SMAP_VARerr_reconstruct_2022.nc"); ds["SMAP_SM"].set_auto_mask(False)
doy0 = 181
res = {"checked": True, "file": f}
for name, t in (("t_even", 2 * doy0), ("t_odd", 2 * doy0 + 1)):
    v = ds["SMAP_SM"][:, :, t]
    for lab, ref in (("AM", am), ("PM", pm)):
        if ref is None: res[f"{name}_vs_{lab}"] = {"why": "missing"}; continue
        both = np.isfinite(v) & np.isfinite(ref); n = int(both.sum())
        res[f"{name}_vs_{lab}"] = {"n_both": n, "n_step": int(np.isfinite(v).sum()), "n_ref": int(np.isfinite(ref).sum()),
            "max_abs_diff": float(np.abs(v[both] - ref[both]).max()) if n else None, "frac_equal_1e-6": float((np.abs(v[both] - ref[both]) < 1e-6).mean()) if n else None}
print(json.dumps(res, indent=1))
S = json.load(open(f"{W}/stats.json")); S["years"]["2022"]["ampm"] = res; json.dump(S, open(f"{W}/stats.json", "w"), indent=1); print("stats.json updated")
