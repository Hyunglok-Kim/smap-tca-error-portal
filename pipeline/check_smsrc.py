#!/usr/bin/env python3
"""Which SPL3SMP field is SMAP_SM? Compare the even step of 2022-07-01 with each AM soil-moisture field of the L3 file."""
import glob, numpy as np, netCDF4 as nc
from osgeo import gdal
gdal.UseExceptions()
f = sorted(glob.glob("/home/data_1/SMAP/SPL3SMP.009/2022/2022.07.01/SMAP_L3_SM_P_20220701_*.h5"))[-1]
subs = [l.split("=", 1)[1] for l in gdal.Info(f).splitlines() if "_NAME=" in l]
ds = nc.Dataset("/home/data_4/finished_projects/project_TCA_ML/manuscript_EASE_036/after_correct_TCA/2015_2023_SMAP/ML_2022/SMAP_VARerr_reconstruct_2022.nc"); ds["SMAP_SM"].set_auto_mask(False)
v = ds["SMAP_SM"][:, :, 362]
for key in ("Soil_Moisture_Retrieval_Data_AM/soil_moisture", "Soil_Moisture_Retrieval_Data_AM/soil_moisture_dca", "Soil_Moisture_Retrieval_Data_AM/soil_moisture_scah", "Soil_Moisture_Retrieval_Data_AM/soil_moisture_scav"):
    name = [s for s in subs if s.endswith(key)]
    if not name: print(key, "missing"); continue
    x = gdal.Open(name[0]).ReadAsArray().astype(np.float32); x[x <= -9998] = np.nan
    both = np.isfinite(v) & np.isfinite(x); d = np.abs(v[both] - x[both])
    print(f"{key.split('/')[-1]:22s} n_both {both.sum():6d} equal {np.mean(d < 1e-6):.4f} |d| p50 {np.percentile(d, 50):.4f} p90 {np.percentile(d, 90):.4f} p99 {np.percentile(d, 99):.4f} corr {np.corrcoef(v[both], x[both])[0, 1]:.4f}")
# also: is the student's field the previous day's or a shifted copy? correlate with neighbouring days' AM
for dd in ("2022.06.30", "2022.07.02"):
    g = sorted(glob.glob(f"/home/data_1/SMAP/SPL3SMP.009/{dd}/*.h5")) or sorted(glob.glob(f"/home/data_1/SMAP/SPL3SMP.009/2022/{dd}/*.h5"))
    if not g: continue
    nm = [s for s in [l.split("=", 1)[1] for l in gdal.Info(g[-1]).splitlines() if "_NAME=" in l] if s.endswith("Soil_Moisture_Retrieval_Data_AM/soil_moisture")][0]
    x = gdal.Open(nm).ReadAsArray().astype(np.float32); x[x <= -9998] = np.nan
    both = np.isfinite(v) & np.isfinite(x); d = np.abs(v[both] - x[both])
    print(f"{dd} AM: n_both {both.sum():6d} equal {np.mean(d < 1e-6):.4f} corr {np.corrcoef(v[both], x[both])[0, 1]:.4f}")
