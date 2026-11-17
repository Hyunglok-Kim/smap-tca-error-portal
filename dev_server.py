#!/usr/bin/env python3
"""Local preview of the portal: serves this folder at / and a tile folder at /data/.

    ~/.venvs/hydroai/bin/python dev_server.py [--data ~/.hydroai/datasets/prithvi-et] [--port 8791]

Why not `python -m http.server`: PMTiles needs HTTP Range requests, which that server ignores.
Starlette's static files answer them. For development only — binds to 127.0.0.1.
"""
import argparse
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

ap = argparse.ArgumentParser()
ap.add_argument("--data", default=str(Path.home() / ".hydroai" / "datasets" / "hdca"))
ap.add_argument("--port", type=int, default=8791)
a = ap.parse_args()

here = Path(__file__).resolve().parent
app = Starlette(routes=[
    Mount("/data", app=StaticFiles(directory=a.data), name="data"),
    Mount("/", app=StaticFiles(directory=str(here), html=True), name="portal"),
])

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=a.port, log_level="warning")
