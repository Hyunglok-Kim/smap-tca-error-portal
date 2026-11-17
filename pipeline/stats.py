#!/usr/bin/env python3
"""First look at the nine annual files SMAP_VARerr_reconstruct_{year}.nc (Kim et al. 2025, GIScience & RS).

Each file: float32 [latitude 406][longitude 964][time T], contiguous, no time coordinate, NaN = no value.
T = 2 half-days per day: 630 (2015, 2023), 732 (2016, 2020), 730 (other years).

Writes work/stats.json and, per year, work/cov_<YYYY>.npz with
  cov_<VAR>[T]      finite cells per time step, for SM, ERR, LGBM, DNN
  flag_<F>[T]       cells with the flag raised (value 1) per time step
and the record-wide per-cell counts work/n_<VAR>.npy [406, 964] (int32).
Also checks: are the reconstructed fields a merge (raw where it exists) or a model prediction everywhere;
where does the reconstruction extend beyond SMAP SM; the first/last step with any SM in 2015/2023;
and for 2022-07-01 which of the two half-day steps is SMAP's AM and which the PM overpass (against SPL3SMP).
"""
import argparse, glob, json, os, time
import numpy as np
import netCDF4 as nc

VARS = {"SMAP_SM": "SM", "SMAP_TCA_err": "ERR", "SMAP_TCA_err_recons_LGBM": "LGBM", "SMAP_TCA_err_recons_DNN": "DNN"}
FLAGS = {"flags_corr": "corr", "flags_n_valid": "nvalid", "flags_fMSE": "fmse", "flags_negative_vars_err": "negvar"}
HIST = {"SM": (0.0, 1.2, 1e-4), "ERR": (0.0, 1.0, 1e-5), "LGBM": (0.0, 1.0, 1e-5), "DNN": (0.0, 1.0, 1e-5)}

ap = argparse.ArgumentParser()
ap.add_argument("--root", default="/home/data_4/finished_projects/project_TCA_ML/manuscript_EASE_036/after_correct_TCA/2015_2023_SMAP")
ap.add_argument("--work", default="/data/personal_data/project_tca_portal/work")
ap.add_argument("--years", default="2015-2023")
ap.add_argument("--smap-l3", default="/home/data_1/SMAP/SPL3SMP.009")
a = ap.parse_args()
y0, y1 = (int(x) for x in a.years.split("-"))
t0 = time.time()
def log(m): print(time.strftime("%H:%M:%S"), m, flush=True)

hist = {s: np.zeros(int(round((hi - lo) / st)) + 1, np.int64) for s, (lo, hi, st) in HIST.items()}
vmin = {s: np.inf for s in HIST}; vmax = {s: -np.inf for s in HIST}; below = {s: 0 for s in HIST}; above = {s: 0 for s in HIST}; nfin = {s: 0 for s in HIST}
n_cell = {s: np.zeros((406, 964), np.int32) for s in HIST}
n_cell_flag = {f: np.zeros((406, 964), np.int32) for f in FLAGS.values()}
years = {}
lats = lons = None

def ampm_check(A_sm, year):
    """Compare the two half-day steps of 2022-07-01 with SPL3SMP's AM and PM soil moisture."""
    try:
        from osgeo import gdal
    except Exception as e:
        return {"checked": False, "why": f"no GDAL: {e}"}
    files = sorted(glob.glob(os.path.join(a.smap_l3, "**", f"SMAP_L3_SM_P_{year}0701_*.h5"), recursive=True))
    if not files:
        return {"checked": False, "why": "no SPL3SMP file for 2022-07-01 found"}
    f = files[-1]
    def rd(sub):
        d = gdal.Open(f'HDF5:"{f}":/{sub}')
        if d is None: return None
        x = d.ReadAsArray().astype(np.float32); x[x <= -9998] = np.nan; return x
    am = rd("Soil_Moisture_Retrieval_Data_AM/soil_moisture"); pm = rd("Soil_Moisture_Retrieval_Data_PM/soil_moisture_pm")
    if am is None or pm is None:
        return {"checked": False, "why": "could not read AM/PM subdatasets", "file": f}
    doy0 = 181                                   # 2022-07-01 is day 182 -> 0-based 181
    out = {"checked": True, "file": f, "am_shape": list(am.shape), "pm_shape": list(pm.shape)}
    for name, t in (("t_even", 2 * doy0), ("t_odd", 2 * doy0 + 1)):
        v = A_sm[:, :, t]
        for lab, ref in (("AM", am), ("PM", pm)):
            if ref.shape != v.shape: out[f"{name}_vs_{lab}"] = {"why": "shape differs"}; continue
            both = np.isfinite(v) & np.isfinite(ref)
            n = int(both.sum())
            out[f"{name}_vs_{lab}"] = {"n_both": n, "n_step": int(np.isfinite(v).sum()), "n_ref": int(np.isfinite(ref).sum()),
                                       "max_abs_diff": float(np.abs(v[both] - ref[both]).max()) if n else None,
                                       "frac_equal_1e-6": float((np.abs(v[both] - ref[both]) < 1e-6).mean()) if n else None}
    return out

for year in range(y0, y1 + 1):
    p = os.path.join(a.root, f"ML_{year}", f"SMAP_VARerr_reconstruct_{year}.nc")
    ds = nc.Dataset(p)
    for v in ds.variables.values(): v.set_auto_mask(False)
    H, W, T = ds["SMAP_SM"].shape
    if lats is None:
        lat2 = ds["latitude"][:]; lon2 = ds["longitude"][:]
        lats = np.nanmedian(np.where(np.isfinite(lat2), lat2, np.nan), axis=1); lons = np.nanmedian(np.where(np.isfinite(lon2), lon2, np.nan), axis=0)
        np.save(os.path.join(a.work, "lats.npy"), lats); np.save(os.path.join(a.work, "lons.npy"), lons)
    A = {}; F = {}
    for v, s in VARS.items():
        tv = time.time(); A[s] = ds[v][:]; log(f"{year} {s}: read {A[s].nbytes/1e9:.2f} GB in {time.time()-tv:.0f}s")
    fin = {s: np.isfinite(A[s]) for s in A}
    yr = {"T": int(T), "bytes": os.path.getsize(p), "cov": {}, "n_steps_with": {}, "first_step_with": {}, "last_step_with": {}}
    cov = {}
    for s in A:
        c = fin[s].sum(axis=(0, 1)).astype(np.int32); cov[s] = c
        n_cell[s] += fin[s].sum(axis=2).astype(np.int32)
        yr["n_steps_with"][s] = int((c > 0).sum()); nz = np.nonzero(c)[0]
        yr["first_step_with"][s] = int(nz[0]) if nz.size else None; yr["last_step_with"][s] = int(nz[-1]) if nz.size else None
        yr["cov"][s] = {"mean_per_step": float(c[c > 0].mean()) if (c > 0).any() else 0, "max": int(c.max())}
        x = A[s][fin[s]]
        if x.size:
            lo, hi, st = HIST[s]
            vmin[s] = min(vmin[s], float(x.min())); vmax[s] = max(vmax[s], float(x.max())); nfin[s] += int(x.size)
            below[s] += int((x < lo).sum()); above[s] += int((x > hi).sum())
            hist[s] += np.bincount(np.clip(np.rint((x - lo) / st).astype(np.int64), 0, hist[s].size - 1), minlength=hist[s].size)
            yr.setdefault("pct", {})[s] = {str(q): round(float(np.percentile(x, q)), 5) for q in (0.1, 1, 50, 99, 99.9)}
    # relationships between the fields
    bothRL = fin["ERR"] & fin["LGBM"]; bothRD = fin["ERR"] & fin["DNN"]; bothLD = fin["LGBM"] & fin["DNN"]
    yr["rel"] = {
        "err_and_lgbm": int(bothRL.sum()), "err_eq_lgbm_1e-6": int((np.abs(A["ERR"] - A["LGBM"])[bothRL] < 1e-6).sum()),
        "err_and_dnn": int(bothRD.sum()), "err_eq_dnn_1e-6": int((np.abs(A["ERR"] - A["DNN"])[bothRD] < 1e-6).sum()),
        "lgbm_and_dnn": int(bothLD.sum()), "lgbm_eq_dnn_1e-6": int((np.abs(A["LGBM"] - A["DNN"])[bothLD] < 1e-6).sum()),
        "mean_abs_lgbm_minus_dnn": float(np.abs(A["LGBM"] - A["DNN"])[bothLD].mean()) if bothLD.any() else None,
        "lgbm_not_sm": int((fin["LGBM"] & ~fin["SM"]).sum()), "sm_not_lgbm": int((fin["SM"] & ~fin["LGBM"]).sum()),
        "dnn_not_sm": int((fin["DNN"] & ~fin["SM"]).sum()), "sm_not_dnn": int((fin["SM"] & ~fin["DNN"]).sum()),
        "err_not_sm": int((fin["ERR"] & ~fin["SM"]).sum()), "sm_not_err": int((fin["SM"] & ~fin["ERR"]).sum()),
        "lgbm_not_err": int((fin["LGBM"] & ~fin["ERR"]).sum()), "lgbm_xor_dnn": int((fin["LGBM"] ^ fin["DNN"]).sum()),
        "n_sm": int(fin["SM"].sum()), "n_err": int(fin["ERR"].sum()), "n_lgbm": int(fin["LGBM"].sum()), "n_dnn": int(fin["DNN"].sum()),
    }
    if year == 2022:
        yr["ampm"] = ampm_check(A["SM"], year)
    # flags
    code = np.zeros((H, W, T), np.uint8); anyflag_nan = np.zeros((H, W, T), bool)
    yr["flags"] = {}
    for i, (v, f) in enumerate(FLAGS.items()):
        x = ds[v][:]
        isnan = ~np.isfinite(x); one = x == 1; zero = x == 0; other = ~(isnan | one | zero)
        yr["flags"][f] = {"nan": int(isnan.sum()), "zero": int(zero.sum()), "one": int(one.sum()), "other": int(other.sum()),
                          "one_where_sm": int((one & fin["SM"]).sum()), "nan_where_sm": int((isnan & fin["SM"]).sum()),
                          "one_where_err": int((one & fin["ERR"]).sum()), "one_where_sm_not_err": int((one & fin["SM"] & ~fin["ERR"]).sum())}
        code |= (one.astype(np.uint8) << i); anyflag_nan |= isnan
        n_cell_flag[f] += one.sum(axis=2).astype(np.int32)
        cov[f"flag_{f}"] = one.sum(axis=(0, 1)).astype(np.int32)
        del x
    yr["flag_code_hist_where_sm"] = np.bincount(code[fin["SM"] & ~anyflag_nan], minlength=16).tolist()
    yr["flag_code_hist_where_sm_not_err"] = np.bincount(code[fin["SM"] & ~fin["ERR"] & ~anyflag_nan], minlength=16).tolist()
    yr["flag_code_hist_all"] = np.bincount(code[~anyflag_nan], minlength=16).tolist()
    yr["flags_nan_any"] = int(anyflag_nan.sum())
    yr["code0_where_sm_not_err"] = int(((code == 0) & fin["SM"] & ~fin["ERR"] & ~anyflag_nan).sum())
    np.savez(os.path.join(a.work, f"cov_{year}.npz"), **{k: v for k, v in cov.items()})
    years[str(year)] = yr
    log(f"{year}: done ({time.time()-t0:.0f}s) n_sm={yr['rel']['n_sm']} n_err={yr['rel']['n_err']} n_lgbm={yr['rel']['n_lgbm']} eq(err,lgbm)={yr['rel']['err_eq_lgbm_1e-6']}/{yr['rel']['err_and_lgbm']} lgbm_not_sm={yr['rel']['lgbm_not_sm']} first_sm={yr['first_step_with']['SM']} last_sm={yr['last_step_with']['SM']}")
    del A, fin, code, anyflag_nan, ds

def pct(s, ps):
    lo, hi, st = HIST[s]; c = np.cumsum(hist[s]); n = c[-1]
    return {str(p): round(float(lo + np.searchsorted(c, n * p / 100.0) * st), 6) for p in ps}
for s in HIST: np.save(os.path.join(a.work, f"n_{s}.npy"), n_cell[s])
for f in FLAGS.values(): np.save(os.path.join(a.work, f"n_flag_{f}.npy"), n_cell_flag[f])
for s in HIST: np.save(os.path.join(a.work, f"hist_{s}.npy"), hist[s])
out = {"years": years, "lat_first_last": [float(lats[0]), float(lats[-1])], "lon_first_last": [float(lons[0]), float(lons[-1])],
       "lat_rows_nan": int(np.isnan(lats).sum()), "lon_cols_nan": int(np.isnan(lons).sum()),
       "cells": {s: {"any": int((n_cell[s] > 0).sum()), "ge_100": int((n_cell[s] >= 100).sum())} for s in HIST},
       "vars": {s: {"min": vmin[s], "max": vmax[s], "n": nfin[s], "below": below[s], "above": above[s], "pct": pct(s, [0.1, 1, 2, 25, 50, 75, 98, 99, 99.9, 99.99])} for s in HIST}}
json.dump(out, open(os.path.join(a.work, "stats.json"), "w"), indent=1)
print(json.dumps({k: v for k, v in out.items() if k != "years"}, indent=1))
log("done")
