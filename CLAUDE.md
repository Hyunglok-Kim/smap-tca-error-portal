# SMAP time-variant TCA error — data portal

Web portal for the dataset of Kim, S., Kim, H., Kwon, Y., and Nguyen, H. H. (2025), *A stand-alone framework for
predicting spatiotemporal errors in satellite-based soil moisture using tree-based models and deep neural networks*,
GIScience & Remote Sensing 62(1), 2475572, doi:10.1080/15481603.2025.2475572 (open access, CC BY 4.0): for every SMAP
L3 soil-moisture retrieval on the 36 km EASE-Grid 2.0 global grid, both overpasses, 20 Feb 2015 – 11 Nov 2023, the
random error (standard deviation σ) from triple collocation (SMAP · ASCAT · GLDAS, 201-step moving window), the same
with the TCA gaps filled by an LGBM and by a DNN trained on SMAP's own variables, and the four TCA flags.

**Status (2026-11-17): public on GitHub Pages** at https://hyunglok-kim.github.io/smap-tca-error-portal/ and embedded on
hydroai.net/data#tca the way HDCA and Hampyeong are; lab dashboard entry `tca-error` (shell `/tca-error.html`, local
copy at `/rd/tca-error/`). The 2022 NetCDF is on Zenodo (doi:10.5281/zenodo.14850520); the other eight years are on
the lab storage only and are given on request. Built from the HDCA portal (`~/orca/projects/hdca/portal/`, same grid,
same machinery); read that folder's `CLAUDE.md` for the shared background (Prithvi-ET → HDCA → this).

## Where things are

| What | Where |
|---|---|
| Portal app (this folder) | `~/orca/projects/tv_TCA/portal/` — static site, no build step; git repository github.com/Hyunglok-Kim/smap-tca-error-portal (GitHub Pages, `main`, root). Holds `data/catalog.json`, `data/monthly/`, `data/clim/` (≈60 MB) |
| Public overpass fields | github.com/Hyunglok-Kim/smap-tca-error-portal-fields-1 (SM + CODE, 411 MB) and `…-fields-2` (LGBM + DNN, 439 MB); working copies `~/orca/projects/tv_TCA/public/fields-1`, `fields-2` |
| Public series store | github.com/Hyunglok-Kim/smap-tca-error-portal-series-1 (700 MB) and `…-series-2` (544 MB); working copies `~/orca/projects/tv_TCA/public/series-1`, `series-2`. Which file lives where is written in `catalog.json` (`archives.files[*].host`) and `js/config.js` maps hosts to addresses |
| Source NetCDF (CPU server, NAS data_4) | `/home/data_4/finished_projects/project_TCA_ML/manuscript_EASE_036/after_correct_TCA/2015_2023_SMAP/ML_{year}/SMAP_VARerr_reconstruct_{year}.nc`, 2015–2023, 7.9–9.2 GB each, 80 GB. Owner Subin Kim |
| Build workspace (CPU server) | `/data/personal_data/project_tca_portal/` (`scripts/`, `venv/`, `out/`, `work/`, `logs/`, `out_test/`) |
| Browse data served to the lab (3.1 GB) | `~/.hydroai/datasets/tca-error/` on the dashboard Mac (catalog, daily, monthly, clim, series) |
| Dashboard pages | `hydroai-dashboard/gateway/static/research-data.html` (hub), `tca-error.html` (shell); registry `gateway/research_datasets.json` entry `tca-error`; sidebar predicate in `gateway/static/shared/nav.js` |
| Paper | `../37.Kim_etal_2025_GISRS.pdf`; figures used on the site are JPEG copies of its embedded images (`assets/figures/`) |

```
portal/
  index.html          one page: Explore / Download / Use in code / About the data
  css/portal.css      the HDCA stylesheet plus the coverage select, categorical legend, status bar, flag strips, data-use box
  js/config.js        deployment settings (hosts of the public archives, Zenodo, paper DOI, contacts)
  js/app.js           the app (MapLibre GL globe + in-browser projection + SVG charts), one IIFE
  assets/land-110m.json   Natural Earth land outline (public domain); assets/logos: HydroAI, GIST, KIAPS; assets/figures: Fig 1, 2, 4, 5, 7, 8, 9, 10
  pipeline/           stats → ampm → layers → pack → catalog; runs on the CPU server, not here
  tests/smoke.py      headless-browser test (Playwright); field_ref.json holds field checksums
  dev_server.py       local preview with HTTP Range support
```

## The data, as the pipeline found them (stats.py, 2026-11-17)

- Files: float32 `[latitude 406][longitude 964][time T]`, contiguous, **no time coordinate, no units, NaN = no value**.
  T = 630 (2015, 2023), 732 (2016, 2020), 730 otherwise; 6,374 steps in all, 3,187 days.
- **Time axis**: two steps per day, the **even step is the 6 a.m. descending overpass, the odd one the 6 p.m. ascending**
  (checked on 2022-07-01: the even step shares 98 % of its cells with the SPL3SMP AM swath and 52 % with PM; values match
  `soil_moisture` (DCA baseline) with a median difference of 0.0016 — the L3 file on disk is a later release).
  2015 runs 20 Feb – 31 Dec (the first 78 steps are empty: SMAP data begin 31 Mar), 2023 runs 1 Jan – 11 Nov; the
  201-step window cuts 50 days at each end of the record. The global step index (0 at 2015-02-20 a.m.) equals the
  study's own `time_index`; 2022 starts at 5014.
- **The reconstructed fields are merges**: wherever `SMAP_TCA_err` exists, `_recons_LGBM` and `_recons_DNN` equal it
  exactly; elsewhere they hold the model's value where SMAP SM and the predictors exist (never where SM is missing).
  About 15 % of SM retrievals have no σ at all (a predictor missing). LGBM and DNN supports differ by ~0.2 %.
- **Flags** are 0/1 where `SMAP_SM` exists and NaN elsewhere (1,826 exceptions in 2022); all four are 0 wherever the raw
  σ exists, and at least one is 1 wherever SM exists without it. Flag 3 (fMSE) is raised most often, then flag 1.
- Values: SM 0.02–0.5 m³/m³ (SMAP's bounds); σ 0–0.236 (DNN to 0.267), median 0.026, 99 % below 0.08.
- Land (any SM in the record): 100,300 cells; 96,206 have a raw σ at some point.

## How the data reach the map

```
nine annual NetCDF files [406 x 964 x T]                         CPU server
  └─ pipeline/stats.py        ranges, land mask, per-step counts, cross-checks        -> work/stats.json, n_<VAR>.npy
  └─ pipeline/check_ampm.py   even/odd step against SPL3SMP AM/PM                       -> stats.json["years"]["2022"]["ampm"]
  └─ pipeline/build_layers.py (7 min with 16 processes, ~12 GB)
       daily/TCA_<VAR>_<YYYY>.pmtiles     VAR in SM, LGBM, DNN, CODE: one 964x406 8-bit PNG per step (z10/x=step in year/y0)
       monthly/TCA_<VAR>_monthly.pmtiles  SM, ERR, LGBM, DNN means; NSM, PRAW, PREC, PMISS           (z9/x=(year-2015)*12+month-1)
       clim/TCA_<VAR>_clim.pmtiles        x=0 record, x=1..12 calendar month; + SDERR, SDLGBM at x=0
       series/TCA_series.pmtiles          per land cell: uint16 LE [6374][SM, LGBM, DNN, CODE] (z10/x=col/y=row), 5.1 GB
  └─ pipeline/pack_series.py  gzip each entry, split by row band into 15 files under 90 MB (1.24 GB)
  └─ pipeline/make_catalog.py catalog.json — the one file the app reads first; --hosts assigns archives to public repositories
rsync to the dashboard Mac → gateway serves /rd/tca-error/data/… → browser                 (lab copy)
copy data/ into this repository, daily/ into fields-1/2, series/ into series-1/2 → push      (public copy)
```

**Field contract.** PNG 964 × 406, 8-bit grayscale, `value = DN × step`, `DN 255 = no value`. SM step 0.0035 m³/m³;
σ (ERR, LGBM, DNN) step 0.001 (DN 254 = 0.254; larger values are drawn as ≥ 0.254); shares (PRAW, PREC, PMISS) step
0.4 %; temporal spread (SDERR, SDLGBM) step 0.0002; NSM step 1 (calendar month) or 32 (record). **CODE** is a bit field:
1 flag 1 correlation, 2 flag 2 valid number, 4 flag 3 fMSE, 8 flag 4 negative variance, 16 raw σ present, 32 reconstructed
σ present, 64 SM present, 128 flags known; off-land cells are 255. The raw σ of an overpass is not stored: the app reads
it as LGBM where CODE bit 16 is set; the status and flag-count layers are read from CODE too. The series store is exact to
1e-4 (SM) and 1e-5 (σ); 65535 = no value; its fourth column is CODE.

**Statistics.** The EASE grid is equal-area, so a plain mean over cells is an area mean; the app computes means, coverage
and the legend histogram from the field it has, and `catalog.json` carries the pipeline's means for the layer card
(`all`, `clim`, `months`, `days[*].AM/PM`).

**Why four public data repositories.** GitHub Pages serves one site of at most 1 GB and files under 100 MB; the overpass
fields are 811 MB and the gzipped series store 1.24 GB. `catalog.json` names a host for every archive; `js/config.js`
maps hosts to the Pages addresses (same origin, no CORS); the lab copy passes `?data=` and ignores hosts.

## Rebuilding

On the CPU server as `discover` (declare the run on the dashboard's server page first; the 2026-11-17 build was declared
as 16 cores / 64 GB / 3 h and took about 25 minutes in all):

```bash
cd /data/personal_data/project_tca_portal       # scripts/ holds a copy of pipeline/*.py and run.sh
scripts/run.sh stats && scripts/run.sh ampm       # 6 min; writes work/stats.json (needed by layers)
scripts/run.sh layers                             # 7 min; out/{daily,monthly,clim,series}
scripts/run.sh pack                               # 1.5 min; out/series/TCA_series_r*.pmtiles, then delete out/series/TCA_series.pmtiles
HOSTS="f1:daily/TCA_SM_*,daily/TCA_CODE_*;f2:daily/TCA_LGBM_*,daily/TCA_DNN_*;s1:<first half of the series parts>;s2:<rest>" scripts/run.sh catalog
venv/bin/python scripts/make_field_ref.py out > field_ref.json   # copy to tests/ if the fields changed
```

`venv/` is `python3 -m venv --system-site-packages` plus `pip install netCDF4 pmtiles` (NumPy, Pillow and GDAL from the
system). Copy to the dashboard Mac with `rsync -a --exclude '*.part' … :/data/personal_data/project_tca_portal/out/
~/.hydroai/datasets/tca-error/` (3.1 GB). No gateway restart is needed; `catalog.json` is read on every page load. To
publish: `rsync -a --delete ~/.hydroai/datasets/tca-error/{catalog.json,monthly,clim} data/` here, the daily archives into
`../public/fields-1` (SM, CODE) and `fields-2` (LGBM, DNN), the series parts into `series-1`/`series-2` as the catalog's
hosts say, commit and push all five repositories (publish per data version, not per experiment).

## Running it

```bash
~/.venvs/hydroai/bin/python dev_server.py --data ~/.hydroai/datasets/tca-error --port 8793     # http://127.0.0.1:8793/?data=/data/
~/miniconda3/bin/python tests/smoke.py --base http://127.0.0.1:8793/ --query "intro=0&data=/data/" --shots /tmp/shots --ref tests/field_ref.json
~/miniconda3/bin/python tests/smoke.py --browser webkit ...      # also firefox
```

`python -m http.server` will not do: PMTiles needs HTTP Range requests. Pass `data=/data/` so the preview reads the local
copy; without it `js/config.js` points the big archives at the public repositories. The test ends with the two WebGL checks
inherited from HDCA (no context at all; a context lost and restored).

**Public site**: https://hyunglok-kim.github.io/smap-tca-error-portal/ — test it with
`tests/smoke.py --base https://hyunglok-kim.github.io/smap-tca-error-portal/index.html --shots /tmp/shots-public --ref tests/field_ref.json`.

**In the lab dashboard**: `/tca-error.html` embeds the public site (`?embed=1`); the gateway also serves this folder at
`/rd/tca-error/` with the data at `/rd/tca-error/data/` for signed-in members:
`/rd/tca-error/index.html?embed=1&data=/rd/tca-error/data/&nas=/home/data_4/finished_projects/project_TCA_ML/manuscript_EASE_036/after_correct_TCA/2015_2023_SMAP`.
Bump the `?v=` on the script and style tags in `index.html` when you change them.

URL parameters: `embed=1`, `hidefooter=1`, `data=/path/`, `nas=/path`, `intro=0`, `tab=download|code|about`,
`var=SM|ERR|LGBM|DNN|COV`, `cov=STATUS|NFLAG|PREC|PRAW|PMISS|NSM|SDERR|SDLGBM`, `date=YYYY-MM-DD`, `overpass=AM|PM`.

## Rules that must survive any redesign

- **Raw and filled σ are never mixed silently.** The filled layers say so in the card; the readout says "TCA value" or
  "filled" on every overpass; the series charts draw them as two series; the CSV has a status column. The Coverage layers
  (status, flags raised, shares) exist to keep that distinction visible.
- **Say why σ is missing.** The four flags are named in full on first mention (correlation, valid number, fMSE, negative
  error variance) and shown where they were raised; "no σ" (predictor missing) is a third state, not a gap.
- **Two overpasses a day, a.m. first.** Every step is one overpass set; nothing is averaged across them except in the
  monthly and record layers, which are means over the steps with a value. Never present a step as a "day".
- **36 km is the grid**; cells are drawn as blocks; the readout says "36 km cell".
- **No quality screening was applied to SMAP** in the study — say so wherever the soil moisture is shown.
- **Data use strip and box** (PI, 2026-11-17, the same on the HDCA and Prithvi-ET portals): Zenodo link for the data,
  "please cite" the paper, "research collaboration" → hyunglokkim@gist.ac.kr. On Explore (one line under the lead boxes),
  on Download (three-part box) and in About (Citation and collaboration).
- **Basemap without labels** (Esri World Imagery); the only labels are the paper's six points.
- **The partner strip is HydroAI, GIST, KIAPS** (the authors' institutions); `?hidefooter=1` hides it.
- **Fields and series are for looking, not analysis**; every CSV says so and points to the NetCDF files.
- Inherited from HDCA: the opening sequence (`startIntro`), the globe sized to the map box, the WebGL message instead of
  an endless loading screen, every block in `main` full width or centred, layouts checked at 2048, 1440 and 390 px.

## Gotchas already paid for

- **Zoom of the daily archives is 10, not 9**: a year has up to 732 steps and zoom 9 has only 512 tiles per axis. The
  pmtiles reader refuses zooms outside the header's min/max, so every daily lookup uses exactly z10; monthly and
  climatology use z9; the series z10 (x=column, y=row).
- **`getField` for derived layers** (ERR, STATUS, NFLAG) reads two archives; `rawField` caches by address and `fields`
  by layer key — keep both caches or the overpass "Play" doubles its requests.
- **catalog.json is 1.1 MB** (per-day a.m./p.m. counts and means). Pages gzips it; keep it under ~2 MB.
- **The "Stretch" scale on categorical layers is hidden**, as are the histogram and ticks; `renderLegend` toggles them.
- **The CPU usage declaration API wants local time** `YYYY-MM-DDTHH:MM`, not UTC ISO (the first attempt got HTTP 400).

## Not done yet

- A Zenodo deposit of all nine years (the paper's data statement points readers to hydroai.net; `ncBase` in config.js
  waits for the address). The student's note says the Zenodo link will change if the data are updated.
- The time-invariant TCA error (`TCA_VARerr_TI_WS201_nodTh100_corrTh0.nc`, 19 MB, one field per variable) is not on the
  site; it would make a sixth layer (the paper's Fig. 5a).
- Korean UI text, a dark theme, a favicon.

## hydroai.net (done 2026-11-17)

The Data page is one Webflow HTML Embed (hub cards + one panel per dataset + routing script); its text is kept equal to
`embed/hydroai-data-page.html` here and in the HDCA repo (`~/orca/projects/hdca/portal/embed/`, the canonical copy; other
sessions edit it for their datasets — message them before opening the Designer). The TCA card follows the hd-card markup
(poster + silent loop from `embed/media/tca.*`, captions in `data-caps`), the panel is an `<iframe data-src>` + logo bar, the
script's `panels` table and the height-message list include `tca`. Four cards: two by two between 1181 and 1699 px and four
across in a 1760 px wrap above that (the PI has not chosen this; it is one rule to change). How the edit was made without
touching the clipboard: Designer → Pages → Data → Navigator → Code Embed → Settings → Edit code; in the page,
`view = document.querySelector('.cm-content').cmView.view`; check `view.state.doc.toString()` (length, sha1) against the
committed copy; `fetch()` the new text from this repository's Pages address; `view.dispatch({changes: {from: 0, to: len,
insert}})`; Save & Close; re-open and hash; Publish to hydroai.net only. Then commit the same text in both repositories.

The card's loop is `tca-v2` (2026-11-17, PI: "TCA 지구본도, SMAP time varying 에러를 미국 서부에서 보여줘, hdca처럼"): the globe
turns with the record-mean σ (LGBM-filled), zooms into the western United States (125–102°W, 31–49°N) and the region's σ plays
month by month with its monthly area mean drawn beneath; 9.5 s, captions at 0 / 1.67 / 3.33 / 9.0 s. Made with
`embed/tools/` (see its README); the σ colour range of the portal was tightened to 0–0.06 for it. A re-made loop gets a new
file name (`tca-v3`…) and the old files go once the new text is live; run the HDCA repo's `check_captions.py` and
`check_playback.py` before and after publishing.
