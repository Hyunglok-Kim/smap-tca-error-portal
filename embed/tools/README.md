# The TCA card's loop on hydroai.net/data, and how it is made

The Data page's hub shows one card per dataset with a short silent loop (`../media/<name>.webm`, `.mp4`, and `.jpg`, the
first frame). The TCA card's loop (`tca-v2`, 2026-11-17, at the PI's word "TCA 지구본도, SMAP time varying 에러를 미국 서부에서
보여줘, hdca처럼") follows the HDCA card's: the globe turns briskly with the record-mean error σ (gap-filled, LGBM), zooms into
the western United States (125–102°W, 31–49°N; 2,976 cells, 2,587 with data), and the region's σ then plays month by month,
February 2015 to November 2023, while a chart draws the region's monthly area mean over it (faint dots: every overpass set);
a short dissolve back to the globe closes the loop. 768 × 432, 24 frames a second, 9.5 s. The three tools are the HDCA
repository's `amazon_series.py`, `cap_hdca_amazon.py` and `compose_hdca_amazon.py` adapted; `encode.sh` is a copy.

```bash
# Python with playwright (chromium installed), numpy, Pillow, matplotlib, pmtiles; ffmpeg with libx264 and libvpx-vp9.
# The portal's preview must be running: ~/.venvs/hydroai/bin/python dev_server.py --data ~/.hydroai/datasets/tca-error --port 8793
python westus_series.py ~/.hydroai/datasets/tca-error westus_sigma.json       # area means from the portal's own fields (kept here)
python cap_tca_westus.py "http://127.0.0.1:8793/?intro=0&hidefooter=1&data=/data/" frames/raw     # add 'test' for a handful of frames
python compose_tca_westus.py frames/raw westus_sigma.json frames/final
./encode.sh frames/final tca-v2 ../media 30 44 768 24      # the maps change every frame, so CRF a step higher than a still loop
```

Rules kept (from the HDCA tools' notes, which are the canonical ones): a re-made loop gets a new file name so a cached old
picture never plays under new captions; the turn and the zoom are short (1.7 s each; the PI found longer too slow); no credit
line on the cards (the PI, 2026-11-17 afternoon; the basemap's attribution stays in the portal's own map control); the numbers
on the card are the portal's own; a caption is at most about 44 characters; after the embed text changes run the HDCA repo's
`check_captions.py` and `check_playback.py` on a local copy and on the live page. The fixed colour range of σ on the portal
was tightened from 0–0.1 to 0–0.06 for this loop (and the maps in general): at 0–0.1 the fields were nearly uniform.
