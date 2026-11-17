/* SMAP time-variant TCA error portal — single-page app, no build step. Built from the HDCA portal (same 36 km grid).

   How the map gets its data
     The grid is SMAP's 36 km EASE-Grid 2.0 (406 x 964 cells), so one overpass set is one 8-bit PNG of 30–45 KB:
     pixel = value in whole steps (DN x step), DN 255 = no value. catalog.json says which overpasses, months and
     climatology layers exist and where they live (PMTiles archives used as range-readable key-value stores, spread
     over a few GitHub Pages repositories on the public copy). The browser fetches the one field it needs, keeps the
     numbers, and projects them onto Web Mercator tiles itself through the "tca://" protocol, so the cursor readout
     is exact and no tile server is involved. A click reads the cell's whole 2015–2023 record (soil moisture, the
     error, the two reconstructions and the flags, every overpass) from the series store with one range request. */
(() => {
"use strict";

/* ───────────────────────────── configuration ───────────────────────────── */
const CFG = Object.assign({ dataBase: "./data/", hosts: {}, ncBase: "", zenodo: null, paper: null, contactEmail: "", dataContact: "", dataContactEmail: "", nasPath: "" }, window.PORTAL_CONFIG || {});
const Q = new URLSearchParams(location.search);
let LOCAL_DATA = false;
{
  const d = Q.get("data");                       // same-origin absolute path only
  if (d && /^\/(?!\/)[\w\-./]*\/$/.test(d)) { CFG.dataBase = d; LOCAL_DATA = true; }
  const nas = Q.get("nas");                      // lab storage path, shown on the internal copy
  if (nas && /^\/[\w\-./]+$/.test(nas)) CFG.nasPath = nas;
}
const EMBED = Q.get("embed") === "1";
if (EMBED) document.documentElement.classList.add("embed");
if (Q.get("hidefooter") === "1") document.body.classList.add("hide-footer");
const DATA = new URL(CFG.dataBase, location.href).href;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const INTRO = !REDUCED && Q.get("intro") !== "0";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TILE = 256, W = 964, H = 406, Y0 = 2015;
const NODATA = 255;
const B = { F1: 1, F2: 2, F3: 4, F4: 8, RAW: 16, REC: 32, SM: 64, KNOWN: 128 };
const FLAG_NAMES = ["correlation", "valid number", "fMSE", "negative error variance"];
const FLAG_SHORT = ["flag 1 · correlation", "flag 2 · too few points", "flag 3 · fMSE outside 0–1", "flag 4 · negative variance"];
const GLOBE = { center: [12, 18], zoom: 1.55 };
function globeView() {
  const el = document.getElementById("map");
  const s = Math.min(el ? el.clientWidth || 990 : 990, el ? el.clientHeight || 720 : 720);
  return { center: GLOBE.center, zoom: clamp(Math.log2(0.8 * s / 140), 0.6, GLOBE.zoom) };
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const RAMPS = {
  SM: ["#ffffd9", "#edf8b1", "#c7e9b4", "#7fcdbb", "#41b6c4", "#1d91c0", "#225ea8", "#253494", "#081d58"].map(hex),
  SIG: ["#ffffcc", "#ffeda0", "#fed976", "#feb24c", "#fd8d3c", "#fc4e2a", "#e31a1c", "#bd0026", "#800026"].map(hex),
  SD: ["#fff5eb", "#fee6ce", "#fdd0a2", "#fdae6b", "#fd8d3c", "#f16913", "#d94801", "#a63603", "#7f2704"].map(hex),
  NSM: ["#fcfbfd", "#efedf5", "#dadaeb", "#bcbddc", "#9e9ac8", "#807dba", "#6a51a3", "#54278f", "#3f007d"].map(hex),
  PRAW: ["#f7fbff", "#deebf7", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"].map(hex),
  PREC: ["#f7fcf5", "#e5f5e0", "#c7e9c0", "#a1d99b", "#74c476", "#41ab5d", "#238b45", "#006d2c", "#00441b"].map(hex),
  PMISS: ["#fff5f0", "#fee0d2", "#fcbba1", "#fc9272", "#fb6a4a", "#ef3b2c", "#cb181d", "#a50f15", "#67000d"].map(hex),
};
/* Categorical layers (overpass mode): status of each SMAP retrieval, and how many flags were raised where TCA failed. */
const CATS = {
  STATUS: [[1, "#2E7BA8", "TCA value (raw σ)"], [2, "#E9A23B", "filled by the model"], [3, "#B85434", "soil moisture, but no σ (a predictor is missing)"]],
  NFLAG: [[1, "#fcbba1", "1 flag"], [2, "#fb6a4a", "2 flags"], [3, "#cb181d", "3 flags"], [4, "#67000d", "4 flags"]],
};
const SIG_FIXED = [0, 0.1];
const VARS = {
  SM: { name: "Soil moisture", short: "SM", units: "m³/m³", digits: 3, fixed: [0.02, 0.5], tick: 0.05, ramp: "SM" },
  ERR: { name: "TCA error σ", short: "σ, TCA", units: "m³/m³", digits: 4, fixed: SIG_FIXED, tick: 0.01, ramp: "SIG" },
  LGBM: { name: "σ, gaps filled by LGBM", short: "σ, LGBM", units: "m³/m³", digits: 4, fixed: SIG_FIXED, tick: 0.01, ramp: "SIG" },
  DNN: { name: "σ, gaps filled by DNN", short: "σ, DNN", units: "m³/m³", digits: 4, fixed: SIG_FIXED, tick: 0.01, ramp: "SIG" },
  COV: { name: "Coverage", short: "coverage", units: "", digits: 1, fixed: null, tick: 10 },
};
/* Coverage sub-layers: which modes they exist in, how they are read. */
const COVS = {
  STATUS: { name: "Status of each retrieval", modes: ["day"], cat: true, units: "", digits: 0 },
  NFLAG: { name: "Flags raised where TCA failed", modes: ["day"], cat: true, units: "", digits: 0 },
  PREC: { name: "Share of retrievals filled by the model", modes: ["all", "clim", "month"], units: "%", digits: 1, fixed: [0, 100], tick: 10, ramp: "PREC" },
  PRAW: { name: "Share of retrievals with a TCA value", modes: ["all", "clim", "month"], units: "%", digits: 1, fixed: [0, 100], tick: 10, ramp: "PRAW" },
  PMISS: { name: "Share of retrievals with no σ at all", modes: ["all", "clim", "month"], units: "%", digits: 1, fixed: [0, 100], tick: 10, ramp: "PMISS" },
  NSM: { name: "Overpasses with a retrieval", modes: ["all", "clim", "month"], units: "overpasses", digits: 0, fixed: null, tick: 1, ramp: "NSM" },
  SDERR: { name: "Temporal spread of the TCA σ", modes: ["all"], units: "m³/m³", digits: 4, fixed: [0, 0.025], tick: 0.005, ramp: "SD" },
  SDLGBM: { name: "Temporal spread of the filled σ (LGBM)", modes: ["all"], units: "m³/m³", digits: 4, fixed: [0, 0.025], tick: 0.005, ramp: "SD" },
};
const COVER_STEPS = ["#D9E8F1", "#A9CBDF", "#74A9C9", "#2E7BA8", "#1F5F85"];
/* The six points whose series the paper shows (Figs 4 and 9), then regions worth a look. */
const SITES = [["North America (paper)", -93.92, 37.08], ["South America (paper)", -67.78, -4.95], ["Europe (paper)", 18.11, 48.58],
  ["Africa (paper)", 5.04, 20.93], ["Asia (paper)", 111.47, 27.10], ["Australia (paper)", 126.41, -22.44]];
const REGIONS = [["Korean Peninsula", 127.5, 37.0], ["Amazon Basin", -62, -5], ["Sahara and Sahel", 10, 18], ["Indian subcontinent", 78, 22],
  ["Central Asia", 65, 45], ["Southern Africa", 25, -22], ["Western Europe", 8, 48], ["Great Plains", -100, 42], ["Australia", 134, -25]];

/* EASE-Grid 2.0 global 36 km (EPSG:6933): x is linear in longitude, y is linear in the authalic q(φ). */
const EASE = { a: 6378137.0, e2: 0.00669437999014, cell: 36032.220840584, y0: 7314540.830638 };
EASE.e = Math.sqrt(EASE.e2);
{ const s = Math.sin(30 * Math.PI / 180); EASE.k0 = Math.cos(30 * Math.PI / 180) / Math.sqrt(1 - EASE.e2 * s * s); }
function latToRow(lat) {
  const s = Math.sin(lat * Math.PI / 180), e = EASE.e;
  const q = (1 - EASE.e2) * (s / (1 - EASE.e2 * s * s) - Math.log((1 - e * s) / (1 + e * s)) / (2 * e));
  const r = Math.floor((EASE.y0 - EASE.a * q / (2 * EASE.k0)) / EASE.cell);
  return r >= 0 && r < H ? r : -1;
}
const lonToCol = (lon) => { const c = Math.floor((lon + 180) / 360 * W); return ((c % W) + W) % W; };
const tileLat = (yf) => Math.atan(Math.sinh(Math.PI * (1 - 2 * yf))) * 180 / Math.PI;

/* ───────────────────────────── small helpers ───────────────────────────── */
const $ = (s) => document.querySelector(s);
function el(tag, attrs, kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(kids == null ? [] : kids)) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const svgEl = (tag, attrs) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pad2 = (n) => String(n).padStart(2, "0");
const ymLabel = (ym) => `${MONL[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const dLabel = (d) => `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const halfLabel = (h) => (h === "AM" ? "6 a.m." : "6 p.m.");
function fmtBytes(b) { return b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB"; }
const isoOf = (date) => `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
const dateOf = (iso) => new Date(iso + "T00:00:00Z");
const dayIndex = (iso) => Math.round((dateOf(iso) - dateOf(CAT.record.first)) / 86400e3);
const isoAt = (i) => isoOf(new Date(dateOf(CAT.record.first).getTime() + i * 86400e3));
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const HALF = () => CAT.steps.order;                                  // ["AM", "PM"]
const stepOf = (iso, half) => 2 * dayIndex(iso) + HALF().indexOf(half);
const stepDate = (t) => isoAt(Math.floor(t / 2));
const stepHalf = (t) => HALF()[t % 2];
const popcount4 = (c) => (c & 1) + ((c >> 1) & 1) + ((c >> 2) & 1) + ((c >> 3) & 1);
function rampRGB(ramp, t) {
  const x = clamp(t, 0, 1) * (ramp.length - 1), i = Math.min(ramp.length - 2, Math.floor(x)), f = x - i;
  return [0, 1, 2].map((c) => Math.round(ramp[i][c] + (ramp[i + 1][c] - ramp[i][c]) * f));
}
function niceCeil(v) { const p = Math.pow(10, Math.floor(Math.log10(v || 1))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function download(name, text, type) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = el("textarea", { style: "position:fixed;opacity:0" }, text); document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
  }
  if (btn) { const old = btn.textContent; btn.textContent = "Copied"; setTimeout(() => { btn.textContent = old; }, 1400); }
}
const tip = $("#tip");
function showTip(nodes, x, y) {
  tip.replaceChildren(...nodes); tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = clamp(x + 14, 6, innerWidth - r.width - 6) + "px";
  tip.style.top = clamp(y - r.height - 12 < 6 ? y + 16 : y - r.height - 12, 6, innerHeight - r.height - 6) + "px";
}
const hideTip = () => { tip.hidden = true; };

/* ───────────────────────────── state ───────────────────────────── */
let CAT = null, map = null, landGeo = null, pickMarker = null;
let dayByDate = new Map(), dayList = [], monthByYm = new Map();
const state = { var: "SM", cov: "PREC", mode: "all", climMonth: 7, ym: null, day: null, half: "AM", scale: "fixed", pick: null, seriesYear: null, playing: null };
let chartModel = null, recordModel = null;

/* ───────────────────────────── catalog ───────────────────────────── */
/* Where a file lives: the lab copy keeps everything under ?data=; the public copy spreads the big archives over
   repositories named in catalog.json (host) and mapped to addresses in config.js. */
function fileURL(rel) {
  if (LOCAL_DATA) return DATA + rel;
  const f = CAT && CAT.archives && CAT.archives.files && CAT.archives.files[rel];
  const base = f && f.host && CFG.hosts[f.host] ? new URL(CFG.hosts[f.host], location.href).href : DATA;
  return base + rel;
}
async function loadCatalog() {
  const r = await fetch(DATA + "catalog.json", { cache: "no-cache" });
  if (r.status === 401 || r.status === 403) {
    if (window.parent !== window) window.parent.postMessage({ type: "portalAuth" }, "*");
    throw new Error("Sign-in required — open this page from the lab dashboard.");
  }
  if (!r.ok) throw new Error(`Could not load the catalog (HTTP ${r.status}).`);
  CAT = await r.json();
  dayList = CAT.days.filter((d) => d.n > 0); dayByDate = new Map(CAT.days.map((d) => [d.d, d]));
  monthByYm = new Map(CAT.months.map((m) => [m.ym, m]));
  const julys = CAT.months.filter((m) => m.ym.endsWith("-07") && m.days_with_data >= 25);
  state.ym = (julys[julys.length - 1] || CAT.months[CAT.months.length - 1]).ym;
  state.seriesYear = state.ym.slice(0, 4);
  const mid = dayList.find((d) => d.d.startsWith(state.ym) && d.d.slice(8) === "15") || dayList.find((d) => d.d.startsWith(state.ym));
  state.day = mid ? mid.d : dayList[dayList.length - 1].d; state.half = HALF()[0];
  const vq = Q.get("var"); if (vq && VARS[vq]) state.var = vq;
  const cq = Q.get("cov"); if (cq && COVS[cq]) { state.var = "COV"; state.cov = cq; }
  const dq = Q.get("date"); if (dq && dayByDate.has(dq)) { state.mode = "day"; state.day = dq; state.ym = dq.slice(0, 7); state.seriesYear = dq.slice(0, 4); }
  const hq = Q.get("overpass"); if (hq && HALF().includes(hq.toUpperCase())) state.half = hq.toUpperCase();
  const bad = CAT.grid.lats.map((la, i) => [i, latToRow(la)]).filter(([i, r]) => i !== r);
  if (bad.length) console.warn("[grid] analytic row differs from the catalogue's row centres for", bad.length, "rows", bad.slice(0, 5));
}
const V = () => VARS[state.var];
const isCov = () => state.var === "COV";
const covSpec = () => COVS[state.cov];
const YEARS = () => CAT.source.years.map((y) => String(y.year));
const RECORD_YEARS = () => `${CAT.record.first.slice(0, 4)}–${CAT.record.last.slice(0, 4)}`;
const yearOf = (y) => CAT.source.years.find((r) => r.year === +y);
/* Keep the coverage sub-layer valid for the mode. */
function fixCov() { if (!covSpec().modes.includes(state.mode)) state.cov = state.mode === "day" ? "STATUS" : "PREC"; }

/* What is on the map: which archive, which entry, how to read the numbers. */
function layerSpec() {
  fixCov();
  const cov = isCov(), code = cov ? state.cov : state.var, cs = cov ? covSpec() : V();
  const spec = { var: state.var, cov: cov ? state.cov : null, code, mode: state.mode, step: 1, units: cs.units, digits: cs.digits, cat: !!cs.cat, mean: null, cover: null, z: 9 };
  const varStep = (k) => (CAT.variables[k] ? CAT.variables[k].step : 1);
  if (state.mode === "all" || state.mode === "clim") {
    const m = state.mode === "all" ? 0 : state.climMonth, agg = state.mode === "all" ? CAT.all : CAT.clim[String(m)];
    spec.archive = `clim/TCA_${code}_clim.pmtiles`; spec.x = m; spec.step = code === "NSM" ? (m === 0 ? CAT.variables.NSM.step_record : 1) : varStep(code);
    const when = state.mode === "all" ? `record mean ${RECORD_YEARS()}` : `${MONL[m - 1]} mean ${RECORD_YEARS()}`;
    if (cov) {
      spec.label = `${cs.name}, ${state.mode === "all" ? RECORD_YEARS() : MONL[m - 1] + "s " + RECORD_YEARS()}`;
      spec.mean = code === "NSM" ? null : agg[code];
      spec.sub = code === "NSM" ? (m === 0 ? `How many of the ${fmt(CAT.steps.n)} overpass sets in the record had a SMAP retrieval at the cell (in steps of 32).` : `Average number of overpass sets with a retrieval in that calendar month, over ${agg.years} years.`)
        : code.startsWith("SD") ? `Standard deviation over time of ${code === "SDERR" ? "the raw TCA σ" : "the filled σ"} at each cell, over the whole record.`
        : `Per cent of the cell's SMAP retrievals ${code === "PRAW" ? "that have a TCA value" : code === "PREC" ? "whose σ was predicted by the model (no TCA value)" : "that have neither a TCA value nor a prediction"}${state.mode === "all" ? "" : ", in that calendar month"}.`;
    } else {
      spec.mean = agg[code]; spec.cover = agg[`cover_${code}`];
      spec.label = `${cs.name}, ${when}`;
      spec.sub = state.mode === "all" ? `Mean of every overpass with a value at the cell; on average a cell has ${fmt(CAT.all.steps_per_cell_mean)} retrievals.` : `Mean of all ${MONL[m - 1]} overpasses with a value over ${agg.years} years.`;
    }
  } else if (state.mode === "month") {
    const ym = state.ym, rec = monthByYm.get(ym), y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    spec.archive = `monthly/TCA_${code}_monthly.pmtiles`; spec.x = (y - Y0) * 12 + m - 1; spec.rec = rec; spec.step = code === "NSM" ? 1 : varStep(code);
    if (cov) {
      spec.label = `${cs.name}, ${ymLabel(ym)}`; spec.mean = code === "NSM" ? null : rec[code];
      spec.sub = code === "NSM" ? `Overpass sets with a retrieval at the cell in the month (${rec.steps} possible).` : `Per cent of the month's retrievals at the cell · ${rec.days_with_data} of ${rec.days} days have data.`;
    } else {
      spec.mean = rec[code]; spec.cover = rec[`cover_${code}`];
      spec.label = `${cs.name}, ${ymLabel(ym)} mean`;
      spec.sub = `Mean over the month's overpasses with a value · ${rec.days_with_data} of ${rec.days} days have data.`;
    }
  } else {
    const d = state.day, half = state.half, rec = dayByDate.get(d), sr = rec && rec[half], y = d.slice(0, 4), yr = yearOf(y);
    const tLocal = stepOf(d, half) - yr.t0;
    spec.z = 10; spec.x = tLocal; spec.rec = sr; spec.year = y;
    spec.lgbmArchive = `daily/TCA_LGBM_${y}.pmtiles`; spec.codeArchive = `daily/TCA_CODE_${y}.pmtiles`;
    if (cov) { spec.derive = code; spec.archive = spec.codeArchive; spec.label = `${cs.name}, ${dLabel(d)} ${halfLabel(half)}`; }
    else if (code === "ERR") { spec.derive = "ERR"; spec.archive = spec.lgbmArchive; spec.step = varStep("ERR"); spec.label = `${cs.name}, ${dLabel(d)} ${halfLabel(half)}`; }
    else { spec.archive = `daily/TCA_${code}_${y}.pmtiles`; spec.step = varStep(code); spec.label = `${cs.name}, ${dLabel(d)} ${halfLabel(half)}`; }
    spec.sub = sr && sr.n ? `One overpass set (${half === "AM" ? "descending, 6 a.m. local" : "ascending, 6 p.m. local"}) · ${fmt(sr.n)} retrievals, ${fmt(sr.raw)} with a TCA value, ${fmt(sr.rec)} filled, ${fmt(sr.miss)} without σ.`
      : "No SMAP retrieval anywhere on this overpass set.";
    if (sr && sr.n && !cov) { spec.mean = sr[code]; spec.cover = (code === "SM" ? sr.n : code === "ERR" ? sr.raw : sr.raw + sr.rec) / CAT.land_px; }
  }
  spec.key = `${code}|${state.mode}|${state.mode === "all" ? "" : state.mode === "clim" ? pad2(state.climMonth) : state.mode === "month" ? state.ym : state.day + state.half}`;
  return spec;
}
function currentRange(spec, st) {
  const cs = isCov() ? covSpec() : V();
  if (state.scale === "fixed") {
    if (cs.fixed) return cs.fixed;
    if (spec.code === "NSM") return spec.mode === "all" ? [0, 6400] : [0, 62];
    return [0, 1];
  }
  const t = cs.tick || 1;
  const lo = Math.floor((st ? st.p02 : 0) / t) * t, hi = Math.ceil((st ? st.p98 : t) / t) * t;
  return [lo, Math.max(hi, lo + t)];
}

/* ───────────────────────────── fields (one PNG per layer) ───────────────────────────── */
const archives = new Map(), rawFields = new Map(), fields = new Map(), pendingF = new Map();
const FIELD_MAX = 80;
function archive(rel) {
  let a = archives.get(rel);
  if (!a) { a = new pmtiles.PMTiles(new pmtiles.FetchSource(fileURL(rel))); archives.set(rel, a); }
  return a;
}
/* Fields carry numbers, so they are decoded byte for byte and not through a canvas (Safari colour-manages canvas
   pixels). An 8-bit grayscale PNG is a zlib stream of filtered rows. */
async function decodePNG8(buf, w, h) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 45 || dv.getUint32(0) !== 0x89504e47 || dv.getUint32(4) !== 0x0d0a1a0a) throw new Error("not a PNG");
  let p = 8, pw = 0, ph = 0;
  const idat = [];
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p), type = dv.getUint32(p + 4);
    if (type === 0x49484452) {
      pw = dv.getUint32(p + 8); ph = dv.getUint32(p + 12);
      if (pw !== w || ph !== h || b[p + 16] !== 8 || b[p + 17] !== 0 || b[p + 20] !== 0) throw new Error("unexpected PNG layout");
    } else if (type === 0x49444154) idat.push(b.subarray(p + 8, p + 8 + len));
    else if (type === 0x49454e44) break;
    p += 12 + len;
  }
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  if (!pw || raw.length !== ph * (pw + 1)) throw new Error("unexpected PNG size");
  const out = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const f = raw[y * (pw + 1)], src = y * (pw + 1) + 1, dst = y * pw, up = dst - pw;
    for (let x = 0; x < pw; x++) {
      const a = x ? out[dst + x - 1] : 0, u = y ? out[up + x] : 0, c = x && y ? out[up + x - 1] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += u; else if (f === 3) v += (a + u) >> 1;
      else if (f === 4) { const q = a + u - c, pa = Math.abs(q - a), pu = Math.abs(q - u), pc = Math.abs(q - c); v += pa <= pu && pa <= pc ? a : pu <= pc ? u : c; }
      else if (f !== 0) throw new Error("unexpected PNG filter");
      out[dst + x] = v;
    }
  }
  return out;
}
const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : Object.assign(document.createElement("canvas"), { width: W, height: H });
const cx = cv.getContext("2d", { willReadFrequently: true });
async function decodeViaCanvas(buf) {
  const bmp = await createImageBitmap(new Blob([buf], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  cx.clearRect(0, 0, W, H); cx.drawImage(bmp, 0, 0); bmp.close();
  const d = cx.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}
let exactDecode = typeof DecompressionStream !== "undefined";
async function decodeDN(buf) {
  if (exactDecode) {
    try { return await decodePNG8(buf, W, H); }
    catch (e) { console.warn("[fields] exact PNG decode failed, falling back to canvas:", e.message); exactDecode = false; }
  }
  return decodeViaCanvas(buf);
}
/* One archive entry as a Uint8Array(W*H), or null when the archive has no such entry. Cached by address. */
function rawField(rel, z, x) {
  const key = `${rel}|${z}|${x}`;
  if (rawFields.has(key)) { const v = rawFields.get(key); rawFields.delete(key); rawFields.set(key, v); return Promise.resolve(v); }
  if (pendingF.has(key)) return pendingF.get(key);
  const p = (async () => {
    const res = await archive(rel).getZxy(z, x, 0);
    const dn = res && res.data && res.data.byteLength ? await decodeDN(res.data) : null;
    rawFields.set(key, dn);
    if (rawFields.size > FIELD_MAX) rawFields.delete(rawFields.keys().next().value);
    return dn;
  })().finally(() => pendingF.delete(key));
  pendingF.set(key, p);
  return p;
}
/* The field of a layer. Overpass-mode layers that are not stored as such are derived from the LGBM and CODE fields:
   the raw TCA σ (LGBM where bit RAW is set), the status of each retrieval, the number of flags raised. */
async function getField(spec) {
  if (fields.has(spec.key)) return fields.get(spec.key);
  let dn;
  if (!spec.derive) dn = await rawField(spec.archive, spec.z, spec.x);
  else {
    const code = await rawField(spec.codeArchive, 10, spec.x);
    if (!code) dn = null;
    else if (spec.derive === "ERR") {
      const l = await rawField(spec.lgbmArchive, 10, spec.x);
      dn = new Uint8Array(W * H).fill(NODATA);
      if (l) for (let i = 0; i < dn.length; i++) { const c = code[i]; if (c !== NODATA && (c & B.RAW)) dn[i] = l[i]; }
    } else if (spec.derive === "STATUS") {
      dn = new Uint8Array(W * H).fill(NODATA);
      for (let i = 0; i < dn.length; i++) { const c = code[i]; if (c !== NODATA && (c & B.SM)) dn[i] = (c & B.RAW) ? 1 : (c & B.REC) ? 2 : 3; }
    } else if (spec.derive === "NFLAG") {
      dn = new Uint8Array(W * H).fill(NODATA);
      for (let i = 0; i < dn.length; i++) { const c = code[i]; if (c !== NODATA && (c & B.SM) && !(c & B.RAW)) dn[i] = popcount4(c); }
    }
  }
  fields.set(spec.key, dn);
  if (fields.size > FIELD_MAX) fields.delete(fields.keys().next().value);
  return dn;
}
/* Statistics of a field, computed here: the grid is equal-area, so a plain mean over cells is an area mean. */
const statCache = new Map();
function fieldStats(spec, dn) {
  if (statCache.has(spec.key)) return statCache.get(spec.key);
  const hist = new Float64Array(255);
  let n = 0, sum = 0;
  if (dn) for (let i = 0; i < dn.length; i++) { const d = dn[i]; if (d !== NODATA) { hist[d]++; n++; sum += d; } }
  const pct = (p) => { let c = 0; for (let d = 0; d < 255; d++) { c += hist[d]; if (c >= n * p) return d * spec.step; } return 254 * spec.step; };
  const st = { n, mean: n ? sum / n * spec.step : null, cover: n / CAT.land_px, p02: n ? pct(0.02) : 0, p98: n ? pct(0.98) : spec.step, hist };
  statCache.set(spec.key, st);
  return st;
}

/* ───────────────────────────── colouring and the tile protocol ───────────────────────────── */
const luts = new Map();
function lutFor(spec, lo, hi) {
  const key = `${spec.code}_${spec.step}_${lo}_${hi}`;
  let lut = luts.get(key);
  if (!lut) {
    lut = new Uint32Array(256);
    if (spec.cat) { for (const [dn, col] of CATS[spec.code]) { const [r, g, b] = hex(col); lut[dn] = (255 << 24 | b << 16 | g << 8 | r) >>> 0; } }
    else {
      const ramp = RAMPS[(isCov() ? covSpec() : V()).ramp];
      for (let d = 0; d < 255; d++) { const [r, g, b] = rampRGB(ramp, (d * spec.step - lo) / (hi - lo)); lut[d] = (255 << 24 | b << 16 | g << 8 | r) >>> 0; }
    }
    lut[NODATA] = 0;
    luts.set(key, lut);
  }
  return { key, lut };
}
let current = null;                                            // { spec, lut, lutKey, stats, field, code }
const specsByKey = new Map();
function registerProtocol() {
  maplibregl.addProtocol("tca", async (params) => {
    const m = /^tca:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\?k=(.+)$/.exec(params.url);
    const spec = m && specsByKey.get(decodeURIComponent(m[1]));
    const lut = m && luts.get(decodeURIComponent(m[5]));
    const dn = spec && lut ? await getField(spec) : null;
    if (!dn) return { data: await createImageBitmap(new ImageData(1, 1)) };
    const z = +m[2], tx = +m[3], ty = +m[4], n = 2 ** z;
    const rows = new Int16Array(TILE), cols = new Int16Array(TILE);
    for (let i = 0; i < TILE; i++) { rows[i] = latToRow(tileLat((ty + (i + 0.5) / TILE) / n)); cols[i] = lonToCol(((tx + (i + 0.5) / TILE) / n) * 360 - 180); }
    const img = new ImageData(TILE, TILE), px = new Uint32Array(img.data.buffer);
    for (let j = 0; j < TILE; j++) {
      const r = rows[j]; if (r < 0) continue;
      const base = r * W, o = j * TILE;
      for (let i = 0; i < TILE; i++) px[o + i] = lut[dn[base + cols[i]]];
    }
    return { data: await createImageBitmap(img) };
  });
}
const tileURL = () => `tca://${encodeURIComponent(current.spec.key)}/{z}/{x}/{y}?k=${encodeURIComponent(current.lutKey)}`;

/* Switch the map to the layer the controls describe. Fetches the field first so the stats, legend and card agree. */
let applySeq = 0;
async function applyLayer() {
  const seq = ++applySeq, spec = layerSpec();
  specsByKey.set(spec.key, spec);
  renderWhen(); renderCalendar();
  let dn = null, code = null;
  try {
    dn = await getField(spec);
    if (spec.mode === "day") code = await rawField(spec.codeArchive, 10, spec.x);      // for the readout: raw / filled / flags
  } catch (e) { console.warn("[field]", e.message); }
  if (seq !== applySeq) return;
  const st = fieldStats(spec, dn);
  const [lo, hi] = currentRange(spec, st);
  const { key: lutKey, lut } = lutFor(spec, lo, hi);
  current = { spec, lut, lutKey, stats: st, field: dn, code, lo, hi };
  const src = map && map.getSource("data");
  if (src) src.setTiles([tileURL()]);
  renderLayerCard(); renderLegend();
  if (!state.pick) renderGlobalSeries(); else renderPickCharts();
}

/* ───────────────────────────── map ───────────────────────────── */
function webglWorks() {
  try {
    const c = document.createElement("canvas"), gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return false;
    const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    return true;
  } catch (e) { return false; }
}
function noMap(on, why) {
  if (on) stopSpin();
  document.documentElement.classList.toggle("nomap", on);
  $("#noMap").hidden = !on;
  const boot = $("#boot");
  if (boot) { boot.classList.add("out"); setTimeout(() => boot.remove(), 500); }
  if (on && why) console.warn("[map] not drawn:", why);
  if (!window.__portal) window.__portal = { map: null, state, getField, fields, exact: () => exactDecode, latToRow, lonToCol, current: () => current, layerSpec };
  window.__portal.noMap = on;
  sendHeight();
}
const LOST_WAIT = 6000;

function initMap() {
  registerProtocol();
  const gv = globeView();
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      projection: { type: "globe" },
      sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 4.5, 1, 6.5, 0] },
      sources: {
        sat: { type: "raster", tileSize: 256, maxzoom: 18, tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
               attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
        data: { type: "raster", tileSize: 256, minzoom: 0, maxzoom: 7, tiles: [tileURL()], attribution: "Kim et al. 2025, HydroAI Lab (GIST) · SMAP L3 (NASA)" },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0F1318" } },
        { id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.45, "raster-brightness-max": 0.8 } },
        { id: "data", type: "raster", source: "data", paint: { "raster-opacity": INTRO ? 0 : 1, "raster-fade-duration": 120, "raster-resampling": "nearest" } },
      ],
    },
    center: INTRO ? [GLOBE.center[0] - 140, 4] : gv.center, zoom: INTRO ? Math.max(0.5, gv.zoom - 0.9) : gv.zoom,
    minZoom: 0.5, maxZoom: 9, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-left");
  window.__portal = { map, state, getField, fields, exact: () => exactDecode, latToRow, lonToCol, current: () => current, layerSpec };
  map.on("error", (e) => console.warn("[map]", e && e.error ? e.error.message : e));
  let lost = 0;
  map.on("webglcontextlost", () => { clearTimeout(lost); lost = setTimeout(() => noMap(true, "the WebGL context was lost and has not come back"), LOST_WAIT); });
  map.on("webglcontextrestored", () => { clearTimeout(lost); if (document.documentElement.classList.contains("nomap")) { noMap(false); map.resize(); } });
  map.on("load", () => {
    $("#boot").classList.add("out"); setTimeout(() => $("#boot").remove(), 500);
    addMarkers(); loadLand();
    if (INTRO) startIntro();
  });
  map.on("movestart", () => { if (!ownMove) stopSpin(); });
  map.on("zoom", onZoom);
  map.on("mousemove", onHover);
  map.on("mouseout", () => { $("#roVal").textContent = ""; });
  map.on("click", onClick);
}
async function loadLand() {
  try {
    landGeo = await (await fetch(new URL("assets/land-110m.json", location.href))).json();
    map.addSource("land", { type: "geojson", data: landGeo });
    map.addLayer({ id: "land-line", type: "line", source: "land", paint: { "line-color": "#F0EEE6", "line-width": 0.6, "line-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.45, 5, 0.25, 7, 0] } });
  } catch (e) { console.warn("[land outline]", e.message); }
}
let siteMarkers = [];
/* ── opening sequence: the globe sweeps in from the west, the data fade up, the cards rise, then a slow idle turn
   until the first touch (as on the HDCA portal). Off with ?intro=0 and prefers-reduced-motion. */
let spinning = false, spinUntil = 0, ownMove = false;
function startIntro() {
  document.documentElement.classList.add("intro");
  setTimeout(() => document.documentElement.classList.remove("intro"), 3000);
  map.setPaintProperty("data", "raster-opacity-transition", { duration: 1600, delay: 600 });
  map.setPaintProperty("data", "raster-opacity", $("#opacity").value / 100);
  setTimeout(() => map.setPaintProperty("data", "raster-opacity-transition", { duration: 0, delay: 0 }), 2600);
  setTimeout(() => {
    if (spinUntil < 0) return;
    ownMove = true; map.easeTo({ ...globeView(), duration: 3200, easing: (t) => 1 - Math.pow(1 - t, 3) }); ownMove = false;
    map.once("moveend", () => setTimeout(() => { if (spinUntil < 0) return; spinning = true; spinUntil = Date.now() + 180000; spin(); }, 0));
  }, 650);
  ["wheel", "mousedown", "touchstart", "dragstart"].forEach((ev) => map.on(ev, stopSpin));
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopSpin(); });
}
function spin() {
  if (!spinning || Date.now() > spinUntil) { spinning = false; return; }
  const c = map.getCenter();
  ownMove = true; map.easeTo({ center: [c.lng + 10, c.lat], duration: 7000, easing: (t) => t }); ownMove = false;
  map.once("moveend", () => setTimeout(spin, 0));
}
function stopSpin() { spinning = false; spinUntil = -1; }
function addMarkers() {
  siteMarkers = SITES.map(([name, lng, lat]) =>
    new maplibregl.Marker({ element: el("div", {}, el("span", { class: "city" }, "● " + name.replace(" (paper)", ""))), anchor: "left" }).setLngLat([lng, lat]).addTo(map));
  onZoom();
}
function onZoom() {
  if (!map) return;
  const z = map.getZoom();
  for (const m of siteMarkers) m.getElement().firstChild.style.opacity = z >= 3.2 ? "1" : "0";
  if (map.getLayer("data")) map.setPaintProperty("data", "raster-resampling", z > 2.5 ? "nearest" : "linear");
}
function cellAt(lng, lat) {
  const row = latToRow(lat); if (row < 0) return null;
  const col = lonToCol(lng);
  return { row, col, lat: CAT.grid.lats[row], lng: CAT.grid.lons[col] };
}
function readout(row, col) {
  if (!current) return "";
  const { spec, field, code } = current;
  const i = row * W + col, d = field ? field[i] : NODATA, c = code ? code[i] : null;
  const flagsOf = (cc) => FLAG_NAMES.filter((_, k) => cc & (1 << k)).join(", ");
  if (spec.cat) {
    if (d === NODATA) return c != null && c !== NODATA && (c & B.KNOWN) ? "no retrieval on this overpass" : "no value";
    if (spec.code === "STATUS") return `${CATS.STATUS[d - 1][2]}${d === 1 ? "" : c != null ? " · flags: " + flagsOf(c) : ""}`;
    return `${d} flag${d > 1 ? "s" : ""}: ${c != null ? flagsOf(c) : ""}`;
  }
  if (d === NODATA) {
    if (spec.mode === "day" && c != null && c !== NODATA && (c & B.SM)) return spec.code === "SM" ? "" : `no σ · flags: ${flagsOf(c)}${(c & B.REC) ? "" : " · no prediction (a predictor is missing)"}`;
    return "no value";
  }
  let s = `${fmt(d * spec.step, spec.digits)} ${spec.units}`.trim();
  if (spec.mode === "day" && c != null && c !== NODATA && spec.code !== "SM") s += (c & B.RAW) ? " · TCA value" : (c & B.REC) ? ` · filled · flags: ${flagsOf(c)}` : "";
  if (spec.code === "NSM" || spec.code === "PRAW" || spec.code === "PREC" || spec.code === "PMISS") s = `${fmt(d * spec.step, spec.digits)} ${spec.units}`.trim();
  return s;
}
let hoverRAF = 0;
function onHover(e) {
  cancelAnimationFrame(hoverRAF);
  hoverRAF = requestAnimationFrame(() => {
    const out = $("#roVal"), c = cellAt(e.lngLat.lng, e.lngLat.lat);
    out.textContent = !c || !current ? "" : readout(c.row, c.col);
  });
}
function onClick(e) {
  const { lng, lat } = e.lngLat, c = cellAt(lng, lat); if (!c) return;
  if (map.getZoom() < 3.4) map.flyTo({ center: [lng, lat], zoom: 4.4, duration: 1400 });
  pickLocation(c);
}

/* ───────────────────────────── layer controls ───────────────────────────── */
function renderWhen() {
  const box = $("#when"); box.replaceChildren();
  document.querySelectorAll("#varSeg button").forEach((b) => b.classList.toggle("on", b.dataset.var === state.var));
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
  const sel = $("#covSel"); sel.hidden = !isCov();
  if (isCov()) {
    sel.replaceChildren(...Object.entries(COVS).filter(([, c]) => c.modes.includes(state.mode)).map(([k, c]) => el("option", { value: k, selected: k === state.cov }, c.name)));
    sel.onchange = () => { stopPlay(); state.cov = sel.value; applyLayer(); };
  }
  if (state.mode === "all") { box.append(el("span", { class: "sub" }, `Every overpass of ${RECORD_YEARS()}`)); return; }
  if (state.mode === "clim") {
    box.append(el("div", { class: "mon", role: "group", "aria-label": "Month" }, MON.map((name, i) =>
      el("button", { class: state.climMonth === i + 1 ? "on" : "", title: MONL[i], onclick: () => { stopPlay(); state.climMonth = i + 1; applyLayer(); } }, name))));
    box.append(playBtn()); return;
  }
  const y = state.mode === "month" ? state.ym.slice(0, 4) : state.day.slice(0, 4);
  box.append(el("select", { "aria-label": "Year", onchange: (e) => { stopPlay(); setYear(e.target.value); } }, YEARS().map((yy) => el("option", { value: yy, selected: yy === y }, yy))));
  const curM = state.mode === "month" ? +state.ym.slice(5, 7) : +state.day.slice(5, 7);
  const have = new Set(CAT.months.filter((m) => m.ym.startsWith(y) && m.days_with_data > 0).map((m) => +m.ym.slice(5, 7)));
  box.append(el("div", { class: "mon", role: "group", "aria-label": "Month" }, MON.map((name, i) =>
    el("button", { class: curM === i + 1 ? "on" : "", disabled: !have.has(i + 1), title: MONL[i], onclick: () => { stopPlay(); setMonth(i + 1); } }, name))));
  if (state.mode === "day") {
    const inp = el("input", { type: "date", class: "daypick", value: state.day, min: CAT.record.first, max: CAT.record.last, "aria-label": "Day",
      onchange: (e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { stopPlay(); setDay(e.target.value, +1); } } });
    box.append(el("div", { class: "daynav" }, [
      el("button", { class: "mbtn", title: "Previous overpass with data", onclick: () => { stopPlay(); stepStep(-1); } }, "◀"), inp,
      el("button", { class: "mbtn", title: "Next overpass with data", onclick: () => { stopPlay(); stepStep(+1); } }, "▶"),
    ]));
    box.append(el("div", { class: "seg seg-sm", role: "group", "aria-label": "Overpass" }, HALF().map((h) =>
      el("button", { class: state.half === h ? "on" : "", title: h === "AM" ? "Descending overpass, 6 a.m. local time" : "Ascending overpass, 6 p.m. local time", onclick: () => { stopPlay(); state.half = h; applyLayer(); } }, halfLabel(h)))));
  }
  box.append(playBtn());
}
function playBtn() { return el("button", { class: "play", onclick: togglePlay, "aria-pressed": state.playing ? "true" : "false" }, state.playing ? "Pause" : "Play"); }
function setYear(y) {
  state.seriesYear = y;
  if (state.mode === "month") {
    const have = CAT.months.filter((m) => m.ym.startsWith(y) && m.days_with_data > 0);
    state.ym = (have.find((m) => m.ym.slice(5) === state.ym.slice(5)) || have[0]).ym;
  } else {
    const want = `${y}-${state.day.slice(5)}`;
    state.day = dayByDate.has(want) && dayByDate.get(want).n > 0 ? want : nearestDay(want, +1); state.ym = state.day.slice(0, 7);
  }
  applyLayer(); if (state.pick) renderPickCharts();
}
function setMonth(m) {
  const y = state.mode === "month" ? state.ym.slice(0, 4) : state.day.slice(0, 4);
  if (state.mode === "month") state.ym = `${y}-${pad2(m)}`;
  else { const want = `${y}-${pad2(m)}-${pad2(Math.min(+state.day.slice(8), daysIn(+y, m)))}`; state.day = dayByDate.has(want) && dayByDate.get(want).n > 0 ? want : nearestDay(want, +1); state.ym = state.day.slice(0, 7); }
  applyLayer();
}
const hasData = (iso) => { const r = dayByDate.get(iso); return !!(r && r.n > 0); };
function nearestDay(iso, dir) {
  const i = dayIndex(iso);
  for (const d of [dir, -dir]) for (let k = 1; k < 400; k++) { const j = i + k * d; if (j >= 0 && j < CAT.record.n && hasData(isoAt(j))) return isoAt(j); }
  return dayList[0].d;
}
function setDay(iso, dir) {
  iso = iso < CAT.record.first ? CAT.record.first : iso > CAT.record.last ? CAT.record.last : iso;
  const missing = !hasData(iso);
  state.day = missing ? nearestDay(iso, dir) : iso; state.ym = state.day.slice(0, 7);
  if (state.seriesYear !== state.day.slice(0, 4)) { state.seriesYear = state.day.slice(0, 4); if (state.pick) renderPickCharts(); }
  if (missing) flagText = `${dLabel(iso)} has no SMAP retrieval — showing ${dLabel(state.day)}, the next day with one.`;
  applyLayer();
}
/* The next overpass set with data: a.m. → p.m. of the same day → a.m. of the next day with data. */
function stepStep(dir) {
  const order = HALF(), k = order.indexOf(state.half);
  const d = dayByDate.get(state.day);
  const tryHalf = (rec, h) => rec && rec[h] && rec[h].n > 0;
  if (dir > 0 && k === 0 && tryHalf(d, order[1])) { state.half = order[1]; applyLayer(); return; }
  if (dir < 0 && k === 1 && tryHalf(d, order[0])) { state.half = order[0]; applyLayer(); return; }
  const i = dayList.findIndex((x) => x.d === state.day), nxt = dayList[clamp(i + dir, 0, dayList.length - 1)];
  if (!nxt || nxt.d === state.day) return;
  state.half = dir > 0 ? (tryHalf(nxt, order[0]) ? order[0] : order[1]) : (tryHalf(nxt, order[1]) ? order[1] : order[0]);
  setDay(nxt.d, dir);
}
let flagText = "";
function stopPlay() { if (state.playing) { clearInterval(state.playing); state.playing = null; } }
function togglePlay() {
  if (state.playing) { stopPlay(); renderWhen(); return; }
  if (state.mode === "day") state.playing = setInterval(() => stepStep(+1), 700);
  else if (state.mode === "month") state.playing = setInterval(() => {
    const months = CAT.months.filter((m) => m.ym.startsWith(state.ym.slice(0, 4)) && m.days_with_data > 0).map((m) => +m.ym.slice(5, 7));
    setMonth(months[(months.indexOf(+state.ym.slice(5, 7)) + 1) % months.length]);
  }, 1300);
  else state.playing = setInterval(() => { state.climMonth = state.climMonth % 12 + 1; applyLayer(); }, 1300);
  renderWhen();
}

/* ───────────────────────────── legend + layer card ───────────────────────────── */
function renderLegend() {
  const { spec, lo, hi, stats } = current, cs = isCov() ? covSpec() : V();
  $("#lgTitle").textContent = isCov() ? cs.name : `${cs.short}${spec.units ? ", " + spec.units : ""}`;
  document.querySelectorAll("#scaleSeg button").forEach((b) => b.classList.toggle("on", b.dataset.scale === state.scale));
  const cats = $("#lgCats"), numeric = [$("#lgHist"), $("#lgBar"), $("#lgTicks"), $("#scaleSeg")];
  cats.hidden = !spec.cat; numeric.forEach((n) => { n.style.display = spec.cat ? "none" : ""; });
  if (spec.cat) {
    const counts = new Map(); if (current.field) for (const d of current.field) if (d !== NODATA) counts.set(d, (counts.get(d) || 0) + 1);
    const tot = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
    cats.replaceChildren(...CATS[spec.code].map(([dn, col, name]) => el("div", { class: "lg-cat" }, [el("i", { style: `background:${col}` }), el("span", {}, name), el("b", {}, counts.get(dn) ? fmt(counts.get(dn) / tot * 100, 1) + " %" : "—")])));
    $("#lgNodata").textContent = spec.code === "STATUS" ? "No SMAP retrieval on this overpass" : "TCA value present, or no retrieval";
    return;
  }
  const ramp = RAMPS[cs.ramp];
  $("#lgBar").style.background = `linear-gradient(90deg, ${ramp.map((c) => `rgb(${c.join(",")})`).join(",")})`;
  const d = spec.digits;
  $("#lgTicks").replaceChildren(el("span", {}, lo > 0 ? `≤ ${fmt(lo, d)}` : fmt(lo, d)), el("span", {}, fmt((lo + hi) / 2, d)), el("span", {}, `≥ ${fmt(hi, d)}`));
  $("#lgNodata").textContent = spec.code === "SM" ? (spec.mode === "day" ? "No retrieval — no overpass, frozen, or water" : "No retrieval in any overpass")
    : spec.code === "ERR" ? (spec.mode === "day" ? "No TCA value — a flag was raised, or no retrieval" : "No TCA value in any overpass")
    : spec.code === "LGBM" || spec.code === "DNN" ? (spec.mode === "day" ? "No σ — no retrieval, or a predictor is missing" : "No σ in any overpass")
    : "No retrieval";
  const c = $("#lgHist"), LW = 240, LH = 34, dpr = Math.min(2, devicePixelRatio || 1);
  c.width = LW * dpr; c.height = LH * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, LW, LH);
  if (!stats.n) return;
  const cols = new Float64Array(LW);
  stats.hist.forEach((n, dn) => { cols[clamp(Math.round((dn * spec.step - lo) / (hi - lo) * (LW - 1)), 0, LW - 1)] += n; });
  const top = Math.max(...cols.slice(1, LW - 1), 1);
  g.fillStyle = "#8C8A80";
  for (let x = 0; x < LW; x++) { const h = Math.min(LH, cols[x] / top * (LH - 2)); if (h > 0.3) g.fillRect(x, LH - h, 1, h); }
}
function renderLayerCard() {
  if (!current) return;
  const { spec, stats } = current;
  $("#lyTitle").textContent = spec.label; $("#lySub").textContent = spec.sub;
  const mean = spec.mean != null ? spec.mean : stats.mean;
  const srow = $("#lyStatus"); srow.hidden = true;
  if (spec.cat) {
    $("#lyMeanL").textContent = "Retrievals on this overpass"; $("#lyMean").textContent = fmt(spec.rec ? spec.rec.n : stats.n); $("#lyUnit").textContent = "cells";
  } else {
    $("#lyMeanL").textContent = spec.code === "NSM" ? "Mean over land cells" : isCov() ? "Mean over land cells with a retrieval" : "Mean over land with a value";
    $("#lyMean").textContent = fmt(mean, spec.digits); $("#lyUnit").textContent = spec.units;
  }
  const cov = Math.min(100, (spec.cover != null ? spec.cover : stats.cover) * 100);
  $("#lyCoverL").textContent = spec.mode === "day" ? "Land cells with a value on this overpass" : "Land cells with a value";
  $("#lyCover").textContent = fmt(cov, cov < 99.5 ? 1 : 0); $("#lyCoverBar").style.width = cov + "%";
  if (spec.mode === "day" && spec.rec && spec.rec.n) {
    const r = spec.rec, parts = [["TCA value", r.raw, CATS.STATUS[0][1]], ["filled", r.rec, CATS.STATUS[1][1]], ["no σ", r.miss, CATS.STATUS[2][1]]];
    srow.hidden = false;
    srow.replaceChildren(el("p", { class: "tile-l" }, `Of the ${fmt(r.n)} retrievals on this overpass`),
      el("div", { class: "stack" }, parts.map(([, n, col]) => el("i", { style: `width:${n / r.n * 100}%;background:${col}` }))),
      el("div", { class: "stack-key" }, parts.map(([name, n, col]) => el("span", {}, [el("i", { style: `background:${col}` }), `${name} ${fmt(n / r.n * 100, 0)} %`]))));
  }
  const flag = $("#lyFlag");
  let f = flagText; flagText = "";
  if (!f && !current.field) f = spec.mode === "day" ? "No field for this overpass — SMAP produced no retrieval (safe mode or missing file)." : "This layer has no field.";
  else if (!f && spec.mode === "day" && spec.code === "SM") f = "A single overpass set shows SMAP's swath pattern: about a third of the land is seen at 6 a.m. on any given day, and again at 6 p.m.";
  else if (!f && spec.mode === "day" && spec.code === "ERR") f = "TCA could be computed on only part of the retrievals; the Coverage layer shows why the rest are missing.";
  else if (!f && (spec.code === "LGBM" || spec.code === "DNN")) f = "Wherever a TCA value exists this layer shows it; elsewhere the model's prediction (mean absolute error about 0.007 m³/m³ on held-out data). Hover to see which is which on an overpass.";
  else if (!f && spec.code === "PMISS") f = "No σ at all: SMAP retrieved soil moisture but one of the 18 predictors (often the ancillary sand fraction) is missing, so the model could not be applied.";
  flag.hidden = !f; flag.textContent = f || "";
}

/* ───────────────────────────── charts (SVG) ─────────────────────────────
   One chart for everything: n equally spaced slots, series as values[n] with nulls for gaps. A series may be drawn as
   a line (default) or as dots only (dots: true — one path, so thousands of points are cheap). strips draws rows of
   marks above the plot (the flags). */
function drawLine(box, model) {
  box.replaceChildren();
  const all = model.series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { box.append(el("p", { class: "chart-empty" }, model.empty || "No data at this location.")); return; }
  box.append(el("div", { class: "chart-legend" }, model.series.map((s) => el("span", {}, [el("i", { class: s.dots ? "key dot" : "key", style: s.dots ? `background:${s.color}` : `border-color:${s.color}` }), s.name]))));
  const strips = model.strips || [], SH = strips.length ? strips.length * 7 + 6 : 0;
  const CW = 360, CH = (model.height || 200) + SH, m = { l: 38, r: model.rightPad == null ? 12 : model.rightPad, t: 8 + SH, b: 22 }, pw = CW - m.l - m.r, ph = CH - m.t - m.b;
  const n = model.n, yMin = model.yMin == null ? 0 : model.yMin;
  const yMax = model.yMax != null ? model.yMax : niceCeil(Math.max(...all) * 1.04) || 1;
  const X = (i) => m.l + (n === 1 ? pw / 2 : pw * i / (n - 1)), Y = (v) => m.t + ph * (1 - (v - yMin) / (yMax - yMin));
  const svg = svgEl("svg", { viewBox: `0 0 ${CW} ${CH}`, role: "img", tabindex: "0", "aria-label": `${model.title}. Use the table below for values.` });
  const nY = model.yLines || 4, stepY = (yMax - yMin) / nY;
  const yDigits = model.yDigits != null ? model.yDigits : stepY >= 1 ? 0 : stepY >= 0.1 ? 1 : stepY >= 0.01 ? 2 : stepY >= 0.001 ? 3 : 4;
  for (let k = 0; k <= nY; k++) {
    const v = yMin + stepY * k, y = Y(v);
    svg.append(svgEl("line", { class: k ? "gridline" : "axisline", x1: m.l, x2: CW - m.r, y1: y, y2: y }));
    const t = svgEl("text", { x: m.l - 6, y: y + 3.5, "text-anchor": "end" }); t.textContent = fmt(v, yDigits); svg.append(t);
  }
  for (const [i, lb] of model.ticks) {
    if (model.tickMarks) svg.append(svgEl("line", { class: "axisline", x1: X(i), x2: X(i), y1: m.t + ph, y2: m.t + ph + 3 }));
    const t = svgEl("text", { x: X(i), y: CH - 6, "text-anchor": "middle" }); t.textContent = lb; svg.append(t);
  }
  strips.forEach((s, k) => {
    const y0 = 4 + k * 7, lab = svgEl("text", { x: m.l - 6, y: y0 + 5.5, "text-anchor": "end", class: "strip-l" }); lab.textContent = s.name; svg.append(lab);
    svg.append(svgEl("rect", { x: m.l, y: y0, width: pw, height: 6, class: "strip-bg" }));
    let d = ""; const w = Math.max(0.6, pw / n);
    s.values.forEach((v, i) => { if (v) d += `M${(X(i) - w / 2).toFixed(2)},${y0}h${w.toFixed(2)}v6h${(-w).toFixed(2)}z`; });
    svg.append(svgEl("path", { d, fill: s.color || "#1F1E1D" }));
  });
  for (const b of model.bands || []) svg.append(svgEl("rect", { class: "band", x: X(b[0]), y: m.t, width: X(b[1]) - X(b[0]), height: ph }));
  const ends = [];
  for (const s of model.series) {
    if (s.dots) {
      let d = ""; const r = s.r || (n > 800 ? 1.1 : n > 200 ? 1.6 : 2.4);
      s.values.forEach((v, i) => { if (v != null) d += `M${X(i).toFixed(1)},${Y(v).toFixed(1)}h0.01`; });
      svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": r * 2, "stroke-linecap": "round" }));
    } else {
      let d = "", pen = false, lone = [];
      s.values.forEach((v, i) => {
        if (v == null) { if (!s.spanGaps) pen = false; return; }
        d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true;
        if (!s.spanGaps && s.values[i - 1] == null && s.values[i + 1] == null) lone.push(i);
      });
      svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dash || "" }));
      for (const i of lone) svg.append(svgEl("circle", { cx: X(i), cy: Y(s.values[i]), r: n > 60 ? 1.4 : 2.5, fill: s.color }));
      if (s.marks) s.values.forEach((v, i) => { if (v != null) svg.append(svgEl("circle", { cx: X(i), cy: Y(v), r: 2.6, fill: s.color })); });
    }
    let last = -1; for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) { last = i; break; }
    if (last >= 0 && model.endLabels) ends.push({ s, i: last, y: Y(s.values[last]) });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 12) { const mid = (ends[k].y + ends[k - 1].y) / 2; ends[k - 1].ly = mid - 6; ends[k].ly = mid + 6; }
  for (const e of ends) {
    svg.append(svgEl("circle", { cx: X(e.i), cy: e.y, r: 4, fill: e.s.color, stroke: "#fff", "stroke-width": 2 }));
    const t = svgEl("text", { class: "lbl", x: X(e.i) + 8, y: (e.ly ?? e.y) + 3.5 }); t.textContent = e.s.short || e.s.name; svg.append(t);
  }
  const cross = svgEl("line", { class: "cross", y1: m.t, y2: m.t + ph, visibility: "hidden" });
  const dots = model.series.map((s) => svgEl("circle", { r: 4, fill: s.color, stroke: "#fff", "stroke-width": 2, visibility: "hidden" }));
  svg.append(cross, ...dots);
  let cur = -1;
  const show = (i, cxp, cyp) => {
    cur = i;
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
    model.series.forEach((s, k) => { const v = s.values[i]; dots[k].setAttribute("visibility", v == null ? "hidden" : "visible"); if (v != null) { dots[k].setAttribute("cx", X(i)); dots[k].setAttribute("cy", Y(v)); } });
    showTip([el("div", { class: "t-h" }, model.tipHead(i)),
      ...model.series.filter((s) => !(s.spanGaps && s.values[i] == null)).map((s) => el("div", { class: "t-r" }, [el("i", { class: s.dots ? "key dot" : "key", style: s.dots ? `background:${s.color}` : `border-color:${s.color}` }),
        el("b", {}, s.values[i] == null ? (model.noneText || "—") : `${fmt(s.values[i], model.digits || 0)} ${model.units}`.trim()), el("span", { class: "n" }, s.name)])),
      ...(model.tipFoot ? [model.tipFoot(i)].filter(Boolean) : [])], cxp, cyp);
  };
  const hide = () => { cur = -1; cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTip(); };
  svg.addEventListener("pointermove", (e) => { const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * CW; show(clamp(Math.round((x - m.l) / pw * (n - 1)), 0, n - 1), e.clientX, e.clientY); });
  svg.addEventListener("pointerleave", hide); svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = clamp((cur < 0 ? 0 : cur) + (cur < 0 ? 0 : e.key === "ArrowRight" ? 1 : -1), 0, n - 1), r = svg.getBoundingClientRect();
    show(i, r.left + X(i) / CW * r.width, r.top + r.height * 0.35);
  });
  box.append(svg);
}
function tableOf(model) {
  return el("table", { class: "grid" }, [
    el("thead", {}, el("tr", {}, [el("th", {}, model.rowLabel || "When"), ...model.series.map((s) => el("th", { class: "num" }, `${s.name}${model.units ? ` (${model.units})` : ""}`))])),
    el("tbody", {}, Array.from({ length: model.n }, (_, i) => i).filter((i) => model.series.some((s) => s.values[i] != null) || !model.skipEmptyRows)
      .map((i) => el("tr", {}, [el("td", {}, model.rowName(i)), ...model.series.map((s) => el("td", { class: "num" }, s.values[i] == null ? (model.noneText || "—") : fmt(s.values[i], model.digits || 0)))]))),
  ]);
}
function csvOf(model) {
  const rows = [[model.csvKey || "when", ...model.series.map((s) => s.csvName || s.name)].join(",")];
  for (let i = 0; i < model.n; i++) if (!model.skipEmptyRows || model.series.some((s) => s.values[i] != null)) rows.push([model.rowName(i), ...model.series.map((s) => s.values[i] == null ? "" : s.values[i])].join(","));
  return `# ${model.title}\n# ${model.note || ""}\n` + rows.join("\n") + "\n";
}
const monthTicks = () => MON.map((mn, i) => [i, mn[0]]);
/* Which catalogue column the chart of the current layer follows. */
function chartMetric() {
  if (!isCov()) return state.var;
  return ["PRAW", "PREC", "PMISS"].includes(state.cov) ? state.cov : "PREC";
}

/* ───────────────────────────── global series (no cell picked) ───────────────────────────── */
function renderGlobalSeries() {
  const k = chartMetric(), y = state.seriesYear, cs = COVS[k] || VARS[k], share = !!COVS[k];
  $("#srKicker").textContent = "Seasonal cycle"; $("#srTitle").textContent = share ? cs.name : "Mean over land with a value"; $("#srReset").hidden = true;
  $("#recordBox").hidden = true; recordModel = null;
  const yr = MON.map((_, i) => { const r = monthByYm.get(`${y}-${pad2(i + 1)}`); return r && r[k] != null ? r[k] : null; });
  const clim = MON.map((_, i) => { const c = CAT.clim[String(i + 1)]; return c && c[k] != null ? c[k] : null; });
  $("#srSub").textContent = share ? `${cs.name.charAt(0).toLowerCase() + cs.name.slice(1)}, averaged over land cells, month by month in ${y} against the ${RECORD_YEARS()} mean of the same months. The SMAP outages of 2019 and 2022 leave gaps.`
    : `${cs.name} averaged over every land cell with a value in each month of ${y}, against the ${RECORD_YEARS()} mean of the same months. Frozen cells drop out in winter, so the set of cells changes with the season.`;
  chartModel = { title: share ? `${cs.name} per month` : `Global mean monthly ${cs.name.toLowerCase()}`, n: 12, ticks: monthTicks(), units: cs.units, digits: cs.digits,
    rowLabel: "Month", rowName: (i) => `${y}-${pad2(i + 1)}`, csvKey: "month", tipHead: (i) => MONL[i], endLabels: true, rightPad: 44, noneText: "no data",
    note: share ? "per cent of SMAP retrievals, averaged over land cells" : "mean over land cells with a value; the set of cells changes with the season",
    series: [{ name: y, short: y, color: "#2E7BA8", values: yr, csvName: `${k}_${y}` }, { name: `${RECORD_YEARS()} mean`, short: "mean", color: "#8C8A80", values: clim, csvName: `${k}_mean` }] };
  drawLine($("#chart"), chartModel); renderSeriesTable();
}
function renderSeriesTable() { const w = $("#srTable"); w.replaceChildren(); if (chartModel) w.append(tableOf(chartModel)); }

/* ───────────────────────────── a cell's series ─────────────────────────────
   The series store holds one entry per land cell: uint16 [T][SM, LGBM, DNN, CODE]. One range request gives the whole record. */
const seriesCache = new Map(), seriesArchives = new Map();
function seriesArchive(row) {
  const parts = (CAT.series && CAT.series.parts) || [];
  const part = parts.find((p) => row >= p.rows[0] && row <= p.rows[1]);
  if (!part) return null;
  let a = seriesArchives.get(part.file);
  if (!a) { a = new pmtiles.PMTiles(new pmtiles.FetchSource(fileURL(part.file))); seriesArchives.set(part.file, a); }
  return a;
}
async function getSeries(row, col) {
  const key = `${row}/${col}`;
  if (seriesCache.has(key)) return seriesCache.get(key);
  const arch = seriesArchive(row);
  const res = arch ? await arch.getZxy(10, col, row) : null;
  if (!res || !res.data || !res.data.byteLength) { seriesCache.set(key, null); return null; }
  const T = CAT.steps.n, dv = new DataView(res.data);
  if (res.data.byteLength !== T * 8) throw new Error(`series entry has ${res.data.byteLength} bytes, expected ${T * 8}`);
  const out = { SM: new Float32Array(T), LGBM: new Float32Array(T), DNN: new Float32Array(T), ERR: new Float32Array(T), CODE: new Uint8Array(T) };
  const sc = { SM: CAT.variables.SM.series_scale, LGBM: CAT.variables.LGBM.series_scale, DNN: CAT.variables.DNN.series_scale };
  for (let t = 0; t < T; t++) {
    const o = t * 8;
    const a = dv.getUint16(o, true), l = dv.getUint16(o + 2, true), d = dv.getUint16(o + 4, true), c = dv.getUint16(o + 6, true);
    out.SM[t] = a === 65535 ? NaN : a * sc.SM; out.LGBM[t] = l === 65535 ? NaN : l * sc.LGBM; out.DNN[t] = d === 65535 ? NaN : d * sc.DNN;
    out.CODE[t] = c === 65535 ? 0 : c; out.ERR[t] = (c !== 65535 && (c & B.RAW)) ? out.LGBM[t] : NaN;
  }
  if (seriesCache.size > 40) seriesCache.delete(seriesCache.keys().next().value);
  seriesCache.set(key, out);
  return out;
}
function pickLocation(c) {
  state.pick = c;
  if (!pickMarker) pickMarker = new maplibregl.Marker({ color: "#B85434", scale: 0.75 });
  pickMarker.setLngLat([c.lng, c.lat]).addTo(map);
  renderPickCharts();
}
const SER_COL = { SM: "#2E7BA8", ERR: "#2E7BA8", LGBM: "#E9A23B", DNN: "#D4B23A", mean: "#8C8A80" };
/* Series for a chart over steps [t0, t1): raw σ, model-filled σ (LGBM or DNN, only where no raw value), soil moisture. */
function pickSeries(S, t0, t1, k) {
  const n = t1 - t0, raw = new Array(n).fill(null), fill = new Array(n).fill(null), sm = new Array(n).fill(null);
  const flags = [0, 1, 2, 3].map(() => new Array(n).fill(false));
  for (let i = 0; i < n; i++) {
    const t = t0 + i; if (t < 0 || t >= CAT.steps.n) continue;
    const c = S.CODE[t];
    if (!Number.isNaN(S.SM[t])) sm[i] = S.SM[t];
    if (c & B.RAW) raw[i] = S.LGBM[t];
    else if (k && !Number.isNaN(S[k][t])) fill[i] = S[k][t];
    if ((c & B.SM) && !(c & B.RAW)) for (let f = 0; f < 4; f++) flags[f][i] = !!(c & (1 << f));
  }
  return { raw, fill, sm, flags };
}
let pickSeq = 0;
async function renderPickCharts() {
  const c = state.pick, seq = ++pickSeq; if (!c) return;
  const where = `${Math.abs(c.lat).toFixed(3)}°${c.lat >= 0 ? "N" : "S"}, ${Math.abs(c.lng).toFixed(3)}°${c.lng >= 0 ? "E" : "W"}`;
  $("#srKicker").textContent = `36 km cell · row ${c.row}, column ${c.col}`; $("#srTitle").textContent = where; $("#srReset").hidden = false;
  $("#srSub").textContent = "Reading the cell's record…";
  let S;
  try { S = await getSeries(c.row, c.col); } catch (e) { $("#srSub").textContent = "Could not read the series store: " + e.message; return; }
  if (seq !== pickSeq) return;
  if (!S) {
    $("#srSub").textContent = "No SMAP retrieval at this cell in any overpass — water, ice, or never retrieved.";
    chartModel = null; $("#chart").replaceChildren(el("p", { class: "chart-empty" }, "No data at this cell.")); renderSeriesTable();
    $("#recordBox").hidden = true; recordModel = null; return;
  }
  const y = state.seriesYear, T = CAT.steps.n, k = state.var === "DNN" ? "DNN" : state.var === "ERR" ? null : "LGBM", showSM = state.var === "SM";
  let nSM = 0, nRaw = 0, nFill = 0; for (let t = 0; t < T; t++) { const cc = S.CODE[t]; if (cc & B.SM) nSM++; if (cc & B.RAW) nRaw++; else if (cc & B.REC) nFill++; }
  // the selected year, overpass by overpass
  const i0 = 2 * dayIndex(`${y}-01-01`), nd = daysIn(+y, 2) === 29 ? 366 : 365, n = 2 * nd;
  const ps = pickSeries(S, i0, i0 + n, k);
  const ticks = MON.map((mn, i) => [2 * (dayIndex(`${y}-${pad2(i + 1)}-01`) - dayIndex(`${y}-01-01`)), mn[0]]);
  const strips = [0, 1, 2, 3].map((f) => ({ name: `F${f + 1}`, values: ps.flags[f], color: "#1F1E1D" }));
  const stepName = (i) => { const t = i0 + i; return t < 0 || t >= T ? "—" : `${stepDate(t)} ${stepHalf(t)}`; };
  const stepHead = (i) => { const t = i0 + i; return t < 0 || t >= T ? "—" : `${dLabel(stepDate(t))} · ${halfLabel(stepHalf(t))}`; };
  const tipFoot = (i) => { const t = i0 + i; if (t < 0 || t >= T) return null; const cc = S.CODE[t]; if (!(cc & B.SM)) return el("div", { class: "t-f" }, "no SMAP retrieval"); if (cc & B.RAW) return el("div", { class: "t-f" }, "TCA value"); const fl = FLAG_SHORT.filter((_, f) => cc & (1 << f)); return el("div", { class: "t-f" }, (cc & B.REC ? "filled by the model · " : "no σ (a predictor is missing) · ") + fl.join(", ")); };
  const series = showSM ? [{ name: "soil moisture", color: SER_COL.SM, values: ps.sm, dots: true, csvName: "SM" }]
    : [{ name: "σ, TCA value", color: SER_COL.ERR, values: ps.raw, dots: true, csvName: "sigma_TCA" }, ...(k ? [{ name: `σ, filled (${k})`, color: SER_COL[k], values: ps.fill, dots: true, csvName: `sigma_${k}_filled` }] : [])];
  const nY = ps.sm.filter((v) => v != null).length;
  $("#srSub").textContent = `${fmt(nY)} overpasses of ${y} have a retrieval here (${fmt(nSM)} in the whole record; ${fmt(nRaw)} with a TCA value, ${fmt(nFill)} filled). The strip above the chart marks the four TCA flags where they were raised (F1 correlation, F2 too few points, F3 fMSE, F4 negative variance).`;
  chartModel = { title: `${showSM ? "Soil moisture" : "Error σ"} at ${where}, ${y}, every overpass`, n, ticks, units: "m³/m³", digits: showSM ? 3 : 4, rowLabel: "Overpass", rowName: stepName, csvKey: "overpass",
    tipHead: stepHead, tipFoot, skipEmptyRows: true, strips, yMax: showSM ? 0.5 : undefined, noneText: "—",
    note: `cell row ${c.row} column ${c.col}, centre ${where}; series-store values (precision ${showSM ? CAT.variables.SM.series_scale : CAT.variables.ERR.series_scale})`, series };
  drawLine($("#chart"), chartModel); renderSeriesTable();
  // the full record
  $("#recordBox").hidden = false;
  const pr = pickSeries(S, 0, T, k);
  const rticks = []; for (let yy = +CAT.record.first.slice(0, 4) + 1; yy <= +CAT.record.last.slice(0, 4); yy++) rticks.push([2 * dayIndex(`${yy}-01-01`), String(yy).slice(2)]);
  const rseries = showSM ? [{ name: "soil moisture", color: SER_COL.SM, values: pr.sm, dots: true, r: 0.9, csvName: "SM" }]
    : [{ name: "σ, TCA value", color: SER_COL.ERR, values: pr.raw, dots: true, r: 0.9, csvName: "sigma_TCA" }, ...(k ? [{ name: `σ, filled (${k})`, color: SER_COL[k], values: pr.fill, dots: true, r: 0.9, csvName: `sigma_${k}_filled` }] : [])];
  recordModel = { pick: c, where, S, title: `${showSM ? "Soil moisture" : "Error σ"} at ${where}, ${RECORD_YEARS()}, every overpass`, n: T, units: "m³/m³", digits: showSM ? 3 : 4, yLines: 2, height: 150, rowLabel: "Overpass",
    rowName: (i) => `${stepDate(i)} ${stepHalf(i)}`, csvKey: "overpass", ticks: rticks, tickMarks: true, tipHead: (i) => `${dLabel(stepDate(i))} · ${halfLabel(stepHalf(i))}`, skipEmptyRows: true, yMax: showSM ? 0.5 : undefined,
    strips: [0, 1, 2, 3].map((f) => ({ name: `F${f + 1}`, values: pr.flags[f], color: "#1F1E1D" })), series: rseries };
  $("#rcSub").textContent = `${fmt(nSM)} of ${fmt(T)} overpass sets have a retrieval here; ${fmt(nRaw)} of those have a TCA value and ${fmt(nFill)} a filled one. Gaps are overpasses without a retrieval (no overpass, frozen soil, SMAP outages).`;
  drawLine($("#chartRecord"), recordModel);
  $("#rcTable").replaceChildren(tableOf(recordModel));
}
function recordCSV() {
  const R = recordModel; if (!R) return "";
  const c = R.pick, T = CAT.steps.n, S = R.S, rows = [];
  const f4 = (x) => (Number.isNaN(x) ? "" : x.toFixed(4)), f5 = (x) => (Number.isNaN(x) ? "" : x.toFixed(5));
  for (let t = 0; t < T; t++) {
    const cc = S.CODE[t]; if (!(cc & B.SM) && !(cc & B.KNOWN)) continue;
    const status = (cc & B.RAW) ? "tca" : (cc & B.REC) ? "filled" : (cc & B.SM) ? "no_sigma" : "no_retrieval";
    rows.push([stepDate(t), stepHalf(t), f4(S.SM[t]), f5(S.ERR[t]), f5(S.LGBM[t]), f5(S.DNN[t]), (cc & 1) ? 1 : 0, (cc & 2) ? 1 : 0, (cc & 4) ? 1 : 0, (cc & 8) ? 1 : 0, status].join(","));
  }
  return [`# SMAP time-variant TCA error (Kim et al. 2025) at EASE-Grid 2.0 36 km cell row ${c.row}, column ${c.col} (centre ${c.lat.toFixed(4)}N ${c.lng.toFixed(4)}E), data version ${CAT.version}`,
    "# Values from the portal's series store (precision 0.0001 m3/m3 for SM, 0.00001 for sigma). Use the NetCDF files for analysis.",
    "# sigma_LGBM / sigma_DNN equal sigma_TCA where that exists and are the model's prediction otherwise. Flags 1 = raised. status: tca | filled | no_sigma | no_retrieval",
    "date,overpass,SM_m3m3,sigma_TCA,sigma_LGBM,sigma_DNN,flag1_corr,flag2_nvalid,flag3_fMSE,flag4_negvar,status", ...rows].join("\n") + "\n";
}

/* ───────────────────────────── calendar of the record ───────────────────────────── */
function renderCalendar() {
  const box = $("#cal"); box.replaceChildren(el("span"));
  MON.forEach((mn) => box.append(el("span", { class: "cal-h" }, mn[0])));
  const y0 = +CAT.record.first.slice(0, 4), y1 = +CAT.record.last.slice(0, 4);
  const cls = (c) => COVER_STEPS[clamp(Math.floor(c * 5), 0, 4)];
  const selYm = state.mode === "month" ? state.ym : state.mode === "day" ? state.day.slice(0, 7) : null;
  for (let y = y0; y <= y1; y++) {
    box.append(el("span", { class: "cal-y train" }, String(y)));
    for (let mo = 1; mo <= 12; mo++) {
      const ym = `${y}-${pad2(mo)}`, r = monthByYm.get(ym);
      let node, lines;
      if (!r) { node = el("span", { class: "cal-c none" }); lines = [ymLabel(ym), y === y0 ? "before the record begins" : "after the record ends"]; }
      else if (r.days_with_data === 0) { node = el("span", { class: "cal-c pending", tabindex: "0" }); lines = [ymLabel(ym), "no SMAP retrievals this month"]; }
      else {
        node = el("button", { class: "cal-c built" + (selYm === ym ? " sel" : ""), style: `background:${cls(r.days_with_data / r.days)}`, "aria-label": `${ymLabel(ym)}, ${r.days_with_data} of ${r.days} days`,
          onclick: () => { stopPlay(); state.mode = "month"; state.ym = ym; state.seriesYear = ym.slice(0, 4); applyLayer(); if (state.pick) renderPickCharts(); } });
        lines = [ymLabel(ym), `${r.days_with_data} of ${r.days} days have retrievals`, `${fmt(r.cover_SM * 100, 1)} % of land cells retrieved · ${fmt(r.PRAW, 0)} % with a TCA value, ${fmt(r.PREC, 0)} % filled`];
      }
      const tipNodes = () => [el("div", { class: "t-h" }, lines[0]), ...lines.slice(1).map((s) => el("div", {}, s))];
      node.addEventListener("pointerenter", (e) => showTip(tipNodes(), e.clientX, e.clientY)); node.addEventListener("pointerleave", hideTip);
      node.addEventListener("focus", () => { const b = node.getBoundingClientRect(); showTip(tipNodes(), b.left, b.top); }); node.addEventListener("blur", hideTip);
      box.append(node);
    }
  }
  $("#calSub").textContent = `${fmt(CAT.record.with_tiles)} days with retrievals from ${dLabel(CAT.record.first)} to ${dLabel(CAT.record.last)} (${fmt(CAT.steps.with_data)} overpass sets); ${CAT.record.missing.length} days have none. Click a month to show its mean.`;
  $("#calLegend").replaceChildren(
    el("span", {}, ["Days with retrievals: ", ...COVER_STEPS.map((c) => el("i", { style: `background:${c}` })), " few → all"]),
    el("span", {}, [el("i", { style: "box-shadow:inset 0 0 0 1px #D9D5C7;background:#FAF9F5" }), "none"]),
    el("span", {}, [el("i", { style: "background:radial-gradient(circle,#D9D5C7 1.5px,transparent 2px)" }), "outside the record"]));
}

/* ───────────────────────────── download + code ───────────────────────────── */
const nasRoot = () => (CFG.nasPath ? CFG.nasPath.replace(/\/$/, "") : "");
function renderDownload() {
  const notice = $("#dlNotice"); notice.replaceChildren();
  const z = CFG.zenodo;
  if (CFG.ncBase) notice.append("Files download directly from the links below.");
  else {
    notice.append(el("b", {}, "The 2022 file is on Zenodo"), " (", el("a", { href: z.url, target: "_blank", rel: "noopener" }, `doi:${z.doi}`), ", CC BY 4.0), as stated in the paper. ",
      "The other eight years are not in a public repository yet: write to ", el("a", { href: `mailto:${CFG.dataContactEmail || CFG.contactEmail}?subject=SMAP%20time-variant%20TCA%20error%20data%20request` }, CFG.dataContactEmail || CFG.contactEmail),
      " (", CFG.dataContact, ") or ", el("a", { href: "mailto:" + CFG.contactEmail }, CFG.contactEmail), " and say which years you need. Links will appear here when the files are deposited.");
    if (nasRoot()) notice.append(el("br"), "Lab members: all nine files are on the lab storage under ", el("code", {}, nasRoot() + "/"), " (CPU server).");
  }
  const body = $("#dlTable tbody"); body.replaceChildren();
  for (const y of CAT.source.years) {
    const file = y.file.split("/").pop(), onZenodo = z && z.years.includes(y.year);
    const where = CFG.ncBase ? el("a", { href: CFG.ncBase.replace(/\/$/, "") + "/" + y.file }, "download")
      : onZenodo ? el("a", { href: z.file, target: "_blank", rel: "noopener" }, "Zenodo · download")
      : nasRoot() ? el("span", { class: "mono" }, `${nasRoot()}/${y.file}`) : el("span", { class: "pill" }, "on request");
    body.append(el("tr", {}, [el("td", {}, String(y.year)), el("td", { class: "mono" }, file), el("td", { class: "num" }, fmt(y.T)),
      el("td", {}, `${dLabel(y.first)} – ${dLabel(y.last)}`), el("td", { class: "num" }, fmtBytes(y.bytes)), el("td", {}, where)]));
  }
  const miss = CAT.record.missing;
  $("#dlMissing").textContent = `All files together: ${fmt(CAT.steps.n)} overpass sets, ${fmtBytes(CAT.source.total_bytes)}. Days without any retrieval (${miss.length}): ${spans(miss)}.`;
  const ax = $("#dlAxis tbody"); ax.replaceChildren(...CAT.source.years.map((y) => el("tr", {}, [el("td", {}, String(y.year)), el("td", { class: "num" }, fmt(y.T)), el("td", {}, y.first), el("td", {}, y.last), el("td", { class: "num" }, fmt(y.t0))])));
}
function spans(days) {
  const out = []; let s = null, p = null;
  for (const d of [...days].sort()) {
    if (s && dayIndex(d) === dayIndex(p) + 1) { p = d; continue; }
    if (s) out.push(s === p ? dLabel(s) : `${dLabel(s)} – ${dLabel(p)}`);
    s = p = d;
  }
  if (s) out.push(s === p ? dLabel(s) : `${dLabel(s)} – ${dLabel(p)}`);
  return out.join(", ");
}
function renderCode() {
  const base = CFG.ncBase ? CFG.ncBase.replace(/\/$/, "") : nasRoot() || "/path/to/2015_2023_SMAP";
  $("#codePt").textContent =
`import numpy as np
import pandas as pd
import netCDF4 as nc

year = 2022
ds = nc.Dataset(f"${base}/ML_{year}/SMAP_VARerr_reconstruct_{year}.nc")   # 9 GB, uncompressed float32 [lat, lon, time]
T = ds.dimensions["time"].size

# the time axis is not in the file: two overpasses per day, a.m. (6:00 descending) then p.m. (18:00 ascending)
first = {2015: "2015-02-20"}.get(year, f"{year}-01-01")          # 2015: 20 Feb-31 Dec (data from 31 Mar); 2023: 1 Jan-11 Nov
days = pd.date_range(first, periods=T // 2, freq="D")
time = pd.DatetimeIndex(np.repeat(days, 2)) + pd.to_timedelta(np.tile([6, 18], T // 2), unit="h")

# nearest cell to a point (the grid is EASE-Grid 2.0, not regular lat/lon, so search the 2-D centre coordinates)
lat2, lon2 = ds["latitude"][:], ds["longitude"][:]
lon, lat = -93.92, 37.08                                           # the paper's North America point
iy, ix = np.unravel_index(np.nanargmin((lat2 - lat) ** 2 + (lon2 - lon) ** 2), lat2.shape)

# one cell's year is contiguous on disk (time is the last dimension), so this is fast
cell = pd.DataFrame({v: ds[v][iy, ix, :] for v in ("SMAP_SM", "SMAP_TCA_err", "SMAP_TCA_err_recons_LGBM",
                     "SMAP_TCA_err_recons_DNN", "flags_corr", "flags_n_valid", "flags_fMSE", "flags_negative_vars_err")}, index=time)
print(cell.dropna(subset=["SMAP_SM"]).head())
print("retrievals:", cell["SMAP_SM"].notna().sum(), " with TCA sigma:", cell["SMAP_TCA_err"].notna().sum(),
      " with sigma after filling:", cell["SMAP_TCA_err_recons_LGBM"].notna().sum())`;
  $("#codeMap").textContent =
`import numpy as np
import netCDF4 as nc

year, month = 2022, 7
ds = nc.Dataset(f"${base}/ML_{year}/SMAP_VARerr_reconstruct_{year}.nc")
import pandas as pd
days = pd.date_range({2015: "2015-02-20"}.get(year, f"{year}-01-01"), periods=ds.dimensions["time"].size // 2, freq="D")
sel = np.flatnonzero(days.month == month)                          # day indices of the month
t0, t1 = 2 * sel[0], 2 * sel[-1] + 2                              # both overpasses of every day of the month

# a whole field is strided on disk; reading a block of steps for all cells takes a while (about 1 GB is touched)
sig = ds["SMAP_TCA_err_recons_LGBM"][:, :, t0:t1]                  # [406, 964, steps]
raw = ds["SMAP_TCA_err"][:, :, t0:t1]
mean_filled = np.nanmean(sig, axis=2)                              # mean over the month's overpasses with a value
n_raw, n_filled = np.isfinite(raw).sum(axis=2), np.isfinite(sig).sum(axis=2)

import matplotlib.pyplot as plt
plt.imshow(mean_filled, vmin=0, vmax=0.1, cmap="YlOrRd"); plt.colorbar(label="sigma, m3/m3")   # row 0 is 83.6 N, column 0 is 179.8 W
plt.title(f"Filled TCA error, {year}-{month:02d} mean"); plt.show()`;
  $("#codeQc").textContent =
`# For one step t (one overpass set) of an open file:
sm   = ds["SMAP_SM"][:, :, t]
raw  = ds["SMAP_TCA_err"][:, :, t]
fill = ds["SMAP_TCA_err_recons_LGBM"][:, :, t]
f1, f2, f3, f4 = (ds[v][:, :, t] for v in ("flags_corr", "flags_n_valid", "flags_fMSE", "flags_negative_vars_err"))

has_sm    = np.isfinite(sm)
is_raw    = np.isfinite(raw)                      # TCA value; all four flags are 0 here
is_filled = has_sm & ~is_raw & np.isfinite(fill)  # the model's prediction
no_sigma  = has_sm & ~np.isfinite(fill)           # soil moisture but no sigma: a predictor is missing
print(is_raw.sum(), is_filled.sum(), no_sigma.sum())

why = {"correlation": f1 == 1, "too few points": f2 == 1, "fMSE outside 0-1": f3 == 1, "negative variance": f4 == 1}
for name, m in why.items():
    print(f"{name:18s} raised on {int((m & has_sm).sum())} retrievals")

# use the filled sigma as an observation error, but keep the two kinds apart
sigma = np.where(is_raw, raw, fill)               # same as the _recons field
kind = np.where(is_raw, "tca", np.where(is_filled, "filled", "none"))`;
  document.querySelectorAll(".copy").forEach((b) => { b.onclick = () => copyText($("#" + b.dataset.copy).textContent, b); });
}

/* ───────────────────────────── tabs, embed, wiring ───────────────────────────── */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle("on", on); t.setAttribute("aria-selected", on); });
  document.querySelectorAll(".tabpane").forEach((p) => { const on = p.id === "tab-" + name; p.hidden = !on; p.classList.toggle("on", on); });
  if (name === "explore" && map) map.resize();
  hideTip(); sendHeight();
}
function sendHeight() {
  if (window.parent === window) return;
  const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  window.parent.postMessage({ type: "portalHeight", height: h }, "*");
}
function wire() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  document.querySelectorAll("#varSeg button").forEach((b) => b.addEventListener("click", () => { stopPlay(); state.var = b.dataset.var; applyLayer(); }));
  document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => { stopPlay(); state.mode = b.dataset.mode; applyLayer(); }));
  document.querySelectorAll("#scaleSeg button").forEach((b) => b.addEventListener("click", () => { state.scale = b.dataset.scale; applyLayer(); }));
  $("#opacity").addEventListener("input", (e) => { if (map) map.setPaintProperty("data", "raster-opacity", e.target.value / 100); });
  const places = [...SITES.map((s) => [...s, "site"]), ...REGIONS.map((r) => [...r, "region"])];
  const og1 = el("optgroup", { label: "Points shown in the paper" }), og2 = el("optgroup", { label: "Regions" });
  places.forEach(([name, , , kind], i) => (kind === "site" ? og1 : og2).append(el("option", { value: i }, name)));
  $("#jump").append(og1, og2);
  $("#jump").onchange = (e) => {
    const p = places[+e.target.value];
    if (e.target.value !== "" && p && map) { map.flyTo({ center: [p[1], p[2]], zoom: p[3] === "site" ? 5.2 : 3.6, duration: 1700 }); if (p[3] === "site") { const c = cellAt(p[1], p[2]); if (c) pickLocation(c); } }
    e.target.value = "";
  };
  $("#btnGlobe").onclick = () => map && map.flyTo({ ...globeView(), duration: 1800 });
  document.querySelectorAll(".novelty-more").forEach((a) => a.addEventListener("click", (e) => {
    const t = document.getElementById(a.getAttribute("href").slice(1)); if (!t) return;
    e.preventDefault(); t.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  }));
  $("#srReset").onclick = () => { state.pick = null; recordModel = null; $("#recordBox").hidden = true; if (pickMarker) pickMarker.remove(); renderGlobalSeries(); };
  $("#rcTableBtn").onclick = (e) => { const t = $("#rcTable"); t.hidden = !t.hidden; e.currentTarget.textContent = t.hidden ? "Show table" : "Hide table"; e.currentTarget.setAttribute("aria-expanded", String(!t.hidden)); sendHeight(); };
  $("#rcCsv").onclick = () => download(`smap_tca_error_cell_r${state.pick ? state.pick.row : 0}_c${state.pick ? state.pick.col : 0}.csv`, recordCSV(), "text/csv");
  $("#srTableBtn").onclick = (e) => { const t = $("#srTable"); t.hidden = !t.hidden; e.currentTarget.textContent = t.hidden ? "Show table" : "Hide table"; e.currentTarget.setAttribute("aria-expanded", String(!t.hidden)); sendHeight(); };
  $("#srCsv").onclick = () => { if (chartModel) download("smap_tca_error_series.csv", csvOf(chartModel), "text/csv"); };
  document.querySelectorAll(".toc a").forEach((lnk) => lnk.addEventListener("click", (e) => {
    const target = document.getElementById(lnk.getAttribute("href").slice(1)); if (!target) return;
    e.preventDefault(); target.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  }));
  addEventListener("resize", sendHeight);
  if (window.ResizeObserver) new ResizeObserver(sendHeight).observe(document.body);
}
async function main() {
  try { await loadCatalog(); }
  catch (e) { $("#bootMsg").textContent = e.message; document.querySelector(".boot-mark").style.display = "none"; return; }
  const f = CAT.record.first, l = CAT.record.last, A = CAT.all;
  $("#factRecord").textContent = `${MON[+f.slice(5, 7) - 1]} ${f.slice(0, 4)} – ${MON[+l.slice(5, 7) - 1]} ${l.slice(0, 4)}`;
  $("#abRecord").textContent = `${dLabel(f)} to ${dLabel(l)}`;
  const share = A && A.cellsteps_sm ? (A.cellsteps_err + A.cellsteps_rec) / A.cellsteps_sm : null;
  if (share != null) { $("#whenShare").textContent = `about ${fmt(share * 100, 0)} %`; $("#abMiss").textContent = `${fmt((1 - share) * 100, 0)} %`; }
  const outages = spans(CAT.record.missing.filter((d) => (d >= "2019-06-19" && d <= "2019-07-24") || (d >= "2022-08-05" && d <= "2022-09-22")));
  $("#abMissing").textContent = `${CAT.record.missing.length} of the ${fmt(CAT.record.n)} days in the record have no SMAP retrieval at all, almost all in the two SMAP outages (${outages}) and before SMAP's first data on 31 March 2015. On other days about a third of the land is seen on each overpass.`;
  $("#glRecord").textContent = `${dLabel(f)} – ${dLabel(l)} · ${fmt(CAT.steps.with_data)} overpass sets with data`;
  $("#abContact").textContent = CFG.dataContact || "";
  if (CFG.dataContactEmail) { $("#abMail2").textContent = CFG.dataContactEmail; $("#abMail2").href = "mailto:" + CFG.dataContactEmail; }
  $("#abMail").textContent = CFG.contactEmail; $("#abMail").href = "mailto:" + CFG.contactEmail;
  $("#footVer").textContent = `Data version ${CAT.version}`;
  wire(); renderDownload(); renderCode();
  const spec = layerSpec(); specsByKey.set(spec.key, spec);
  const st = { n: 0, mean: null, cover: 0, p02: 0, p98: spec.step, hist: new Float64Array(255) };
  const [lo, hi] = currentRange(spec, st), { key, lut } = lutFor(spec, lo, hi);
  current = { spec, lut, lutKey: key, stats: st, field: null, code: null, lo, hi };
  if (!webglWorks()) noMap(true, "the browser gives no WebGL context");
  else { try { initMap(); } catch (e) { noMap(true, e.message); } }
  await applyLayer();
  const tab = Q.get("tab"); if (tab && document.getElementById("tab-" + tab)) showTab(tab);
  sendHeight();
}
main();
})();
