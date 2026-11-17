#!/usr/bin/env bash
# Build everything the portal needs, on the CPU server as `discover` (workspace /data/personal_data/project_tca_portal).
#
#   run.sh stats      value ranges, land mask, per-step coverage, cross-checks   -> work/stats.json (+ .npy, cov_<year>.npz)
#   run.sh ampm       which half-day step is the a.m. overpass (against SPL3SMP)  -> written into work/stats.json
#   run.sh layers     daily/monthly/climatology fields + series store              -> out/{daily,monthly,clim,series}
#   run.sh pack       gzip + split the series store for publishing                 -> out/series/*_r*.pmtiles
#   run.sh catalog    catalog.json (HOSTS assigns archives to public repositories) -> out/catalog.json
#   run.sh all        stats, ampm, layers, pack, catalog in order
#
# Environment: ROOT (workspace), SRC (folder with the ML_<year> directories), PROCS (PNG encoders), HOSTS (see make_catalog.py)
set -euo pipefail
ROOT=${ROOT:-/data/personal_data/project_tca_portal}
SRC=${SRC:-/home/data_4/finished_projects/project_TCA_ML/manuscript_EASE_036/after_correct_TCA/2015_2023_SMAP}
PROCS=${PROCS:-16}
HOSTS=${HOSTS:-}
PY=$ROOT/venv/bin/python
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$ROOT/out" "$ROOT/work" "$ROOT/logs"
step() {
  case "$1" in
    stats)   "$PY" "$HERE/stats.py" --root "$SRC" --work "$ROOT/work" 2>&1 | tee "$ROOT/logs/stats.log" ;;
    ampm)    "$PY" "$HERE/check_ampm.py" 2>&1 | tee "$ROOT/logs/ampm.log" ;;
    layers)  "$PY" "$HERE/build_layers.py" --root "$SRC" --work "$ROOT/work" --out "$ROOT/out" --procs "$PROCS" 2>&1 | tee "$ROOT/logs/layers.log" ;;
    pack)    "$PY" "$HERE/pack_series.py" --src "$ROOT/out/series/TCA_series.pmtiles" --out-dir "$ROOT/out/series" --work "$ROOT/work" 2>&1 | tee "$ROOT/logs/pack.log" ;;
    catalog) "$PY" "$HERE/make_catalog.py" --work "$ROOT/work" --out "$ROOT/out" --root "$SRC" --hosts "$HOSTS" 2>&1 | tee "$ROOT/logs/catalog.log" ;;
    *) echo "usage: $0 stats | ampm | layers | pack | catalog | all" >&2; exit 2 ;;
  esac
}
if [ "${1:-}" = all ]; then step stats; step ampm; step layers; step pack; step catalog; else step "${1:-}"; fi
