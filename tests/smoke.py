#!/usr/bin/env python3
"""Browser smoke test for the SMAP time-variant TCA error portal (headless, Playwright).

    python tests/smoke.py --base http://127.0.0.1:8791/ --shots /tmp/shots --ref tests/field_ref.json
    python tests/smoke.py --browser webkit ...        # Safari's engine; also firefox

Checks that the page boots without console errors, that fields decode to the exact numbers the pipeline
wrote (--ref, see tests/make_field_ref.py), that the analytic EASE-Grid row/column mapping matches the
catalogue, that hover, click, the cell series, the full record and its CSV, the day/month/climatology
modes, the tabs and the narrow layout work, and saves screenshots to look at. Exit code 1 on any failure.

Against the lab dashboard the portal needs a session cookie: put "hydroai_rd=<token>" in the SMOKE_COOKIE
environment variable and use the /rd/tca-error/ address as --base.
"""
import argparse
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8791/")
ap.add_argument("--shots", required=True)
ap.add_argument("--ref", default="")
ap.add_argument("--query", default="intro=0")
ap.add_argument("--browser", default="chromium", choices=["chromium", "webkit", "firefox"])
ap.add_argument("--cookie", default="", help="name=value to send with every request (internal copy); or set SMOKE_COOKIE")
a = ap.parse_args()
a.cookie = a.cookie or os.environ.get("SMOKE_COOKIE", "")
shots = Path(a.shots)
shots.mkdir(parents=True, exist_ok=True)
fails, notes = [], []


def check(ok, msg):
    (notes if ok else fails).append(("ok   " if ok else "FAIL ") + msg)


def settle(page, ms=900, key_prefix=None):
    """Wait for the layer switch to land (the field may come over the internet), then for the tiles."""
    if key_prefix:
        page.wait_for_function("p => window.__portal.current().spec.key.startsWith(p)", arg=key_prefix, timeout=60000)
    page.wait_for_timeout(ms)
    page.wait_for_function("window.__portal.map.areTilesLoaded()", timeout=60000)


with sync_playwright() as pw:
    gl = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"]
    br = getattr(pw, a.browser).launch(args=gl if a.browser == "chromium" else [])
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    if a.cookie:
        from urllib.parse import urlparse
        name, _, value = a.cookie.partition("=")
        ctx.add_cookies([{"name": name, "value": value, "domain": urlparse(a.base).hostname, "path": "/"}])
    page = ctx.new_page()
    console, bad = [], []
    page.on("console", lambda m: console.append((m.type, m.text)))
    page.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    aborted = ("ERR_ABORTED", "cancelled", "NS_BINDING_ABORTED")
    page.on("requestfailed", lambda r: bad.append((r.url, r.failure)) if not any(x in str(r.failure) for x in aborted) else None)
    page.on("response", lambda r: bad.append((r.url, r.status)) if r.status >= 400 else None)

    sep = "&" if "?" in a.base else "?"
    page.goto(a.base + (sep + a.query if a.query else ""), wait_until="domcontentloaded")
    page.wait_for_function("window.__portal && window.__portal.map && window.__portal.map.loaded()", timeout=60000)
    page.wait_for_function("document.querySelector('#boot') === null", timeout=15000)
    settle(page, 2500)
    page.screenshot(path=str(shots / "01_record_mean.png"))

    info = page.evaluate("""() => { const p = window.__portal, c = p.current();
        return {zoom: p.map.getZoom(), fields: p.fields.size, key: c.spec.key, n: c.stats.n, mean: c.stats.mean, cover: c.stats.cover,
                title: document.querySelector('#lyTitle').textContent, card: document.querySelector('#lyMean').textContent}; }""")
    notes.append(f"info {info}")
    check(info["fields"] >= 1 and info["n"] > 100000, f"record-mean field decoded: {info['n']} land cells, mean {info['mean']:.4f}")
    check(page.evaluate("window.__portal.exact()"), "fields are decoded byte for byte (no canvas round trip)")
    check(abs(info["cover"] - 1) < 0.01, f"record mean covers every land cell ({info['cover']:.4f})")
    # the analytic row mapping against the catalogue's cell-centre latitudes
    rows_ok = page.evaluate("""async () => { const data = new URLSearchParams(location.search).get('data') || './data/';
        const cat = await (await fetch(new URL(data, location.href).href + 'catalog.json')).json();
        let bad = 0; cat.grid.lats.forEach((la, i) => { if (window.__portal.latToRow(la) !== i) bad++; });
        let badc = 0; cat.grid.lons.forEach((lo, i) => { if (window.__portal.lonToCol(lo) !== i) badc++; });
        return [bad, badc, cat.grid.lats.length, cat.grid.lons.length]; }""")
    check(rows_ok[0] == 0 and rows_ok[1] == 0, f"analytic EASE-Grid mapping puts every catalogue centre in its own row/column ({rows_ok})")

    if a.ref:
        ref = json.loads(Path(a.ref).read_text())
        for key, exp in ref.items():
            var, mode, when = key.split("|")
            got = page.evaluate("""async ([v, mode, when]) => { const p = window.__portal, s = p.state;
                const keep = {...s}; s.mode = mode;
                if (['SM', 'ERR', 'LGBM', 'DNN'].includes(v)) s.var = v; else { s.var = 'COV'; s.cov = v; }
                if (mode === 'day') { s.day = when.slice(0, 10); s.half = when.slice(10); } if (mode === 'month') s.ym = when; if (mode === 'clim') s.climMonth = +when;
                const spec = p.layerSpec(); Object.assign(s, keep);
                const dn = await p.getField(spec); if (!dn) return null;
                let sum = 0, n255 = 0; for (const x of dn) { sum += x; if (x === 255) n255++; }
                return {sum, n255, px: [dn[248 * 964 + 296], dn[67 * 964 + 284], dn[201 * 964 + 540], dn[82 * 964 + 823]]}; }""", [var, mode, when])
            check(got is not None and got["sum"] == exp["sum"] and got["n255"] == exp["n255"] and got["px"] == exp["px"],
                  f"field {key} decodes to the pipeline's numbers (sum {got and got['sum']} vs {exp['sum']})")

    # hover readout over the Amazon (the map is scrolled to the middle of the window first: with the lead boxes
    # above it, its centre otherwise sits under the fixed partner strip and the click lands on a logo)
    page.evaluate("document.getElementById('map').scrollIntoView({block: 'center'})")
    page.wait_for_timeout(300)
    box = page.locator("#map").bounding_box()
    page.evaluate("window.__portal.map.jumpTo({center: [-62, -8], zoom: 4.2})")
    settle(page, 1200)
    pt = page.evaluate("(() => { const p = window.__portal.map.project([-62, -8]); return [p.x, p.y]; })()")
    cx, cy = box["x"] + pt[0], box["y"] + pt[1]
    page.mouse.move(cx, cy)
    page.wait_for_timeout(400)
    ro = page.inner_text("#roVal")
    check("m³/m³" in ro, f"hover readout over the Amazon: '{ro}'")
    page.screenshot(path=str(shots / "02_amazon.png"))

    # click: the cell series (daily for the year) and the full record
    page.mouse.click(cx, cy)
    page.wait_for_function("!document.querySelector('#srSub').textContent.startsWith('Reading')", timeout=60000)
    check(page.locator("#chart svg path").count() >= 1, "cell series chart drawn: " + page.inner_text("#srTitle") + " | " + page.inner_text("#srSub")[:90])
    check(page.locator("#chartRecord svg path").count() >= 1 and "have a retrieval here" in page.inner_text("#rcSub"), "full record: " + page.inner_text("#rcSub")[:100])
    with page.expect_download() as dl:
        page.click("#rcCsv")
    csv_text = Path(dl.value.path()).read_text()
    rows = [r for r in csv_text.splitlines() if r and not r.startswith("#")]
    check(rows[0] == "date,overpass,SM_m3m3,sigma_TCA,sigma_LGBM,sigma_DNN,flag1_corr,flag2_nvalid,flag3_fMSE,flag4_negvar,status" and len(rows) > 100 and all(len(r.split(",")) == 11 for r in rows),
          f"record CSV: {len(rows) - 1} rows, first {rows[1]!r}, last {rows[-1]!r}")
    filled = sum(1 for r in rows[1:] if r.split(",")[2])
    check(filled > 200, f"record CSV has {filled} overpasses with a retrieval at this cell")
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(200)
    page.screenshot(path=str(shots / "03_after_click.png"))

    # tooltip on the chart and its table
    page.locator("#chart svg").scroll_into_view_if_needed()          # the chart sits below the fold now that the novelty box comes first
    page.wait_for_timeout(300)
    sv = page.locator("#chart svg").bounding_box()
    if sv:
        page.mouse.move(sv["x"] + sv["width"] * 0.6, sv["y"] + sv["height"] * 0.5)
        page.wait_for_timeout(200)
        check(page.locator("#tip").is_visible(), "chart tooltip: " + page.inner_text("#tip").replace("\n", " / ")[:80])
    page.click("#srTableBtn")
    check(page.locator("#srTable table tbody tr").count() > 30, f"series table has {page.locator('#srTable table tbody tr').count()} rows")
    page.click("#srTableBtn")

    # overpass mode: a single overpass set, the p.m. one, a day without a retrieval
    page.click("#modeSeg button[data-mode=day]")
    settle(page, 1200, "SM|day|")
    key = page.evaluate("window.__portal.current().spec.key")
    check(key.startswith("SM|day|") and key.endswith("AM"), f"overpass layer: {key} — {page.inner_text('#lyTitle')}")
    cov = page.evaluate("window.__portal.current().stats.cover")
    check(0.15 < cov < 0.7, f"a single overpass set shows the swath pattern ({cov * 100:.0f}% of land)")
    page.screenshot(path=str(shots / "04_overpass.png"))
    page.click("#when .seg-sm button >> nth=1")                          # the 6 p.m. overpass
    settle(page, 1000, "SM|day|")
    key = page.evaluate("window.__portal.current().spec.key")
    check(key.endswith("PM") and "6 p.m." in page.inner_text("#lyTitle"), f"p.m. overpass: {key}")
    page.fill("#when input[type=date]", "2019-06-25")                   # SMAP safe mode: no retrievals
    page.dispatch_event("#when input[type=date]", "change")
    settle(page, 1200, "SM|day|2019-07")
    key2 = page.evaluate("window.__portal.current().spec.key")
    check("2019-06-25" not in key2 and "no SMAP retrieval" in page.inner_text("#lyFlag"), f"a day without retrievals falls through to the next day with some ({key2}); flag: {page.inner_text('#lyFlag')[:70]}")
    # the raw TCA error is derived from the LGBM and CODE fields; the readout says which values are raw
    page.click("#varSeg button[data-var=ERR]")
    settle(page, 1000, "ERR|day|")
    check("TCA error" in page.inner_text("#lyTitle"), "raw TCA error on an overpass: " + page.inner_text("#lyTitle"))
    err_cov = page.evaluate("window.__portal.current().stats.cover")
    check(0 < err_cov < cov, f"the raw error covers fewer cells than soil moisture ({err_cov * 100:.0f}% vs {cov * 100:.0f}%)")
    page.click("#varSeg button[data-var=LGBM]")
    settle(page, 1000, "LGBM|day|")
    lg_cov = page.evaluate("window.__portal.current().stats.cover")
    check(err_cov < lg_cov <= cov + 1e-9, f"the filled error covers more cells than the raw one ({lg_cov * 100:.0f}%)")
    # coverage layers: categorical status on an overpass, shares in month and climatology modes
    page.click("#varSeg button[data-var=COV]")
    settle(page, 1000, "STATUS|day|")
    check(page.locator("#lgCats").is_visible() and page.locator("#lgCats .lg-cat").count() == 3 and page.locator("#lyStatus").is_visible(), "status layer with a categorical legend and the stacked bar: " + page.inner_text("#lgCats").replace(chr(10), " ")[:90])
    page.select_option("#covSel", "NFLAG")
    settle(page, 1000, "NFLAG|day|")
    check(page.locator("#lgCats .lg-cat").count() == 4, "flags-raised layer: " + page.inner_text("#lyTitle"))
    page.click("#modeSeg button[data-mode=month]")
    settle(page, 1000, "PREC|month|")
    check("filled" in page.inner_text("#lyTitle") and "%" in page.inner_text("#lgTitle") + page.inner_text("#lyUnit"), "month mode switches the coverage layer to the filled share: " + page.inner_text("#lyTitle"))
    page.select_option("#covSel", "PMISS")
    settle(page, 1000, "PMISS|month|")
    check("no σ" in page.inner_text("#lyTitle"), "share without σ: " + page.inner_text("#lyTitle") + " · " + page.inner_text("#lyMean") + " %")
    page.click("#modeSeg button[data-mode=clim]")
    settle(page, 1000, "PMISS|clim|")
    check(page.locator("#covSel option[value=SDERR]").count() == 0, "the temporal-spread layers are offered only for the record mean")
    page.click("#modeSeg button[data-mode=all]")
    settle(page, 1000, "PMISS|all|")
    page.select_option("#covSel", "SDERR")
    settle(page, 1000, "SDERR|all|")
    check("spread" in page.inner_text("#lyTitle"), "temporal spread of the TCA error: " + page.inner_text("#lyTitle"))
    page.click("#varSeg button[data-var=LGBM]")
    page.click("#modeSeg button[data-mode=clim]")
    settle(page, 1000, "LGBM|clim|")
    check("LGBM" in page.inner_text("#lyTitle"), "LGBM climatology: " + page.inner_text("#lyTitle"))
    page.screenshot(path=str(shots / "05_lgbm_clim.png"))

    # stretch scale + calendar click + globe
    page.click("#scaleSeg button[data-scale=auto]")
    settle(page, 800)
    ticks = page.inner_text("#lgTicks")
    check("≥" in ticks, f"stretched legend: {ticks.replace(chr(10), ' ')}")
    page.click("#cal button.cal-c.built >> nth=40")
    settle(page, 1000, "LGBM|month|")
    check(page.evaluate("window.__portal.state.mode") == "month", "calendar click selects a month: " + page.inner_text("#lyTitle"))
    page.click("#btnGlobe")
    page.wait_for_timeout(2200)
    page.screenshot(path=str(shots / "06_globe.png"))
    page.select_option("#jump", label="Korean Peninsula")
    page.wait_for_timeout(2200)
    c = page.evaluate("(() => { const m = window.__portal.map, c = m.getCenter(); return [c.lng, c.lat, m.getZoom()]; })()")
    check(abs(c[0] - 127.5) < 0.05 and abs(c[1] - 37.0) < 0.05 and page.input_value("#jump") == "", f"jump to Korea: {c[0]:.2f}, {c[1]:.2f}, zoom {c[2]:.2f}")
    page.screenshot(path=str(shots / "07_korea.png"))

    for tab, shot in (("download", "08_download.png"), ("code", "09_code.png"), ("about", "10_about.png")):
        page.click(f".tab[data-tab={tab}]")
        page.wait_for_timeout(250)
        page.screenshot(path=str(shots / shot), full_page=True)
    page.click(".tab[data-tab=download]")
    check(page.locator("#dlTable tbody tr").count() == 9 and page.locator("#dlAxis tbody tr").count() == 9, "download table lists the nine files and the time-axis table: " + page.inner_text("#dlMissing")[:80])
    check("zenodo.org" in (page.get_attribute("#dlTable tbody tr:nth-child(8) td:last-child a", "href") or ""), "the 2022 file links to Zenodo")

    # narrow screen
    page.set_viewport_size({"width": 430, "height": 860})
    page.click(".tab[data-tab=explore]")
    page.wait_for_timeout(1500)
    try:
        page.screenshot(path=str(shots / "11_phone.png"), full_page=True)
    except Exception:                                                   # Chromium with software GL sometimes cannot capture a very tall page
        page.screenshot(path=str(shots / "11_phone.png"))
    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check(over <= 1, f"no horizontal overflow at 430 px (overflow {over}px)")

    # A browser that gives no WebGL context (graphics acceleration switched off, or lost for the session): the page
    # says so where the map would be instead of staying on its loading screen, and the rest of it works.
    def new_context():
        c = br.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        if a.cookie:
            from urllib.parse import urlparse
            name, _, value = a.cookie.partition("=")
            c.add_cookies([{"name": name, "value": value, "domain": urlparse(a.base).hostname, "path": "/"}])
        return c

    url = a.base + (sep + a.query if a.query else "")
    VIS = "const vis = (q) => { const e = document.querySelector(q); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; };"
    pc = new_context()
    pc.add_init_script("""(() => { const real = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/i.test(String(type)) ? null : real.call(this, type, ...rest); }; })();""")
    ng = pc.new_page()
    ng.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    ng.goto(url, wait_until="domcontentloaded")
    try:
        ng.wait_for_function("document.documentElement.classList.contains('nomap') && document.querySelector('#boot') === null", timeout=30000)
        ng.wait_for_function("document.querySelector('#lyMean').textContent.trim() !== '—'", timeout=60000)      # the field came and the card is filled
    except Exception:
        pass
    st = ng.evaluate("() => { " + VIS + """ return {cls: document.documentElement.className.split(' ').filter((k) => k !== 'embed'), boot: !!document.querySelector('#boot'), msg: vis('#noMap'),
        text: document.querySelector('#noMap').innerText, map: vis('#map'), legend: vis('#legend'), controls: vis('.map-tr'), hint: vis('#hint'), cards: vis('#cardLayer'),
        title: document.querySelector('#lyTitle').textContent, mean: document.querySelector('#lyMean').textContent}; }""")
    ng.click("#varSeg button[data-var=LGBM]")                         # the layer buttons drive the cards beside the map too
    try:
        ng.wait_for_function("document.querySelector('#lyTitle').textContent.includes('LGBM')", timeout=30000)
    except Exception:
        pass
    t2 = ng.inner_text("#lyTitle")
    ng.click(".tab[data-tab=download]")
    ng.wait_for_timeout(400)
    dl = ng.locator("#tab-download").is_visible()
    ng.click(".tab[data-tab=explore]")
    ng.wait_for_timeout(300)
    check(st["cls"] == ["nomap"] and not st["boot"] and st["msg"] and "WebGL" in st["text"] and "open it again" in st["text"]
          and not st["map"] and not st["legend"] and not st["controls"] and not st["hint"] and st["cards"] and st["mean"].strip() not in ("", "—"),
          "without WebGL the page says in the map's place why there is no map, and its loading screen goes: " + st["text"].splitlines()[0])
    check(t2 != st["title"] and dl and ng.evaluate("() => { " + VIS + " return vis('#noMap'); }"),
          f"without WebGL the rest of the page works (layer card goes to '{t2}', the Download tab opens)")
    ng.screenshot(path=str(shots / "12_no_webgl.png"))
    pc.close()

    # A WebGL context lost while the page is open (the browser's graphics process failed): if it has not come back
    # after a few seconds the page says the map is gone; when it does come back, so does the map.
    pc = new_context()
    lc = pc.new_page()
    lc.on("pageerror", lambda e: console.append(("pageerror", str(e))))
    lc.goto(url, wait_until="domcontentloaded")
    try:
        lc.wait_for_function("window.__portal && window.__portal.map && window.__portal.map.loaded()", timeout=90000)
        lc.wait_for_function("document.querySelector('#boot') === null", timeout=15000)
        has = True
    except Exception as e:                                               # a busy machine: software GL can take long to give a context
        notes.append(f"   (the lost-context check was skipped: the map did not load in a fresh context — {str(e).splitlines()[0][:80]})")
        has = False
    has = has and lc.evaluate("""() => { const c = window.__portal.map.getCanvas(), gl = c.getContext('webgl2') || c.getContext('webgl');
        const x = gl && gl.getExtension('WEBGL_lose_context'); if (!x) return false; window.__lose = x; x.loseContext(); return true; }""")
    if has:
        lc.wait_for_timeout(2500)
        early = lc.evaluate("document.documentElement.classList.contains('nomap')")      # not at once: a context usually comes back
        try:
            lc.wait_for_function("document.documentElement.classList.contains('nomap')", timeout=12000)
        except Exception:
            pass
        gone = lc.evaluate("() => { " + VIS + " return {msg: vis('#noMap'), map: vis('#map'), noMap: window.__portal.noMap}; }")
        lc.evaluate("window.__lose.restoreContext()")
        try:
            lc.wait_for_function("!document.documentElement.classList.contains('nomap') && window.__portal.map.loaded()", timeout=30000)
        except Exception:
            pass
        lc.wait_for_timeout(800)
        back = lc.evaluate("() => { " + VIS + " return {msg: vis('#noMap'), map: vis('#map'), noMap: window.__portal.noMap, loaded: window.__portal.map.loaded(), zoom: window.__portal.map.getZoom()}; }")
        check(not early and gone["msg"] and not gone["map"] and gone["noMap"] is True,
              "a WebGL context lost while the page is open: after a few seconds without it the page says the map is gone")
        check(not back["msg"] and back["map"] and back["noMap"] is False and back["loaded"],
              f"when the context comes back the map returns (zoom {back['zoom']:.2f})")
        lc.screenshot(path=str(shots / "13_context_restored.png"))
    else:
        notes.append("   (this browser has no WEBGL_lose_context: the lost-context check was skipped)")
    pc.close()

    errs = [c for c in console if c[0] in ("error", "pageerror")]
    check(not errs, f"no console errors ({len(errs)})")
    for c in errs[:12]:
        notes.append(f"   console {c}")
    warn = [c for c in console if c[0] == "warning"]
    for c in warn[:8]:
        notes.append(f"   warning {c[1][:200]}")
    check(not bad, f"no failed or 4xx/5xx requests ({len(bad)})")
    for b in bad[:12]:
        notes.append(f"   request {b}")
    br.close()

print("\n".join(notes))
print("\n".join(fails))
print(f"\n{len(fails)} failed")
sys.exit(1 if fails else 0)
