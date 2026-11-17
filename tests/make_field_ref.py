#!/usr/bin/env python3
"""Write tests/field_ref.json: checksums of a few fields read straight from the archives.

Run where the archives are (the CPU server's venv has pmtiles, numpy and Pillow, or the dashboard Mac's miniconda):

    python tests/make_field_ref.py /data/personal_data/project_tca_portal/out > tests/field_ref.json

tests/smoke.py --ref compares what the browser decodes against these numbers, cell for cell.
Keys are the portal's layer keys "CODE|mode|when"; the archive entry follows from them.
"""
import io, json, sys
import numpy as np
from PIL import Image
from pmtiles.reader import MmapSource, Reader

FIELDS = [("SM|all|", "clim/TCA_SM_clim.pmtiles", 9, 0),
          ("LGBM|clim|07", "clim/TCA_LGBM_clim.pmtiles", 9, 7),
          ("ERR|month|2018-07", "monthly/TCA_ERR_monthly.pmtiles", 9, (2018 - 2015) * 12 + 6),
          ("PREC|all|", "clim/TCA_PREC_clim.pmtiles", 9, 0),
          ("SM|day|2020-10-28AM", "daily/TCA_SM_2020.pmtiles", 10, 2 * 301),          # 2020-10-28 is day 302 (leap year), a.m.
          ("LGBM|day|2020-10-28PM", "daily/TCA_LGBM_2020.pmtiles", 10, 2 * 301 + 1)]

root, out = sys.argv[1].rstrip("/"), {}
for key, name, z, x in FIELDS:
    with open(f"{root}/{name}", "rb") as f:
        data = Reader(MmapSource(f)).get(z, x, 0)
    a = np.array(Image.open(io.BytesIO(data)))
    assert a.shape == (406, 964), a.shape
    out[key] = {"sum": int(a.astype(np.int64).sum()), "n255": int((a == 255).sum()),
                "px": [int(a[248, 296]), int(a[67, 284]), int(a[201, 540]), int(a[82, 823])]}   # Amazon, New York, Congo, Korea
print(json.dumps(out, indent=1))
