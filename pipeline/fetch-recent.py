#!/usr/bin/env python3
"""Fetch this year's NOAA-20 VIIRS fire detections through the FIRMS area API (needs the free MAP_KEY).

Usage:  python3 fetch-recent.py Sri_Lanka [More_Countries ...]
Needs:  ../../resources/data/firms-key.txt (the key, kept out of git) and the country's yearly files (fetch-country.sh).
Writes: ../../resources/data/firms/viirs-jpss1/viirs-jpss1_<this year>_<Country>.csv, up to the last full month.
        harmonize.py reads it like a yearly file.

Why NOAA-20 only: it is the VIIRS satellite that continues. Suomi NPP had gaps in June to August 2026 and
stopped on 2 November 2026, so from January 2026 the joined record is NOAA-20 scaled by the hand-over factor.
Science-quality data (VIIRS_NOAA20_SP) are used where NASA has them, near-real-time (VIIRS_NOAA20_NRT) after.
NRT rows keep their version (e.g. 2.0NRT), so the page can mark those months provisional.

The API has no working country endpoint, so each call asks for a box around the country's past fires, and a detection
is kept when it falls inside the country's Natural Earth 10m border (../../resources/data/borders/, public domain:
https://github.com/nvkelso/natural-earth-vector). Tested on eight past months, this matched FIRMS's own country files
to within 1.4% (six of the eight exactly).
NRT rows carry no type, so detections within about 1 km of a non-vegetation source seen in the country's own files
(type 1 to 3: volcanoes, factories and gas flares, offshore) get type 2 here, and harmonize.py drops them.
"""
import csv
import glob
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "resources", "data")
API = "https://firms.modaps.eosdis.nasa.gov/api"
YEAR = date.today().year
FINE = 0.1          # the grid of the country's past fires, which sets the box asked for
NEAR = 0.01         # the fixed-hot-source grid, about 1 km
BAND = 0.05         # latitude bands that index the border's edges, so each point is tested against few edges
BORDERS = os.path.join(DATA, "borders", "ne_10m_admin_0_countries.geojson")
FIELDS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "version", "frp", "daynight", "type"]


def get(url, key):
    """GET text from the API; retries network errors. The key is never printed."""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                text = r.read().decode()
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == 3:
                sys.exit(f"network error: {str(e).replace(key, 'KEY')}")
            time.sleep(10 * (attempt + 1))
    if text.strip() and not text.startswith(("latitude", "data_id")):
        sys.exit(f"FIRMS said: {text.strip()[:200].replace(key, 'KEY')}")   # e.g. a wrong key or too many calls
    return text


def border(country):
    """Return inside(lon, lat) for the country's Natural Earth outline: even-odd ray casting over all its rings."""
    if not os.path.exists(BORDERS):
        sys.exit(f"missing {BORDERS}: download ne_10m_admin_0_countries.geojson from natural-earth-vector/geojson")
    with open(BORDERS) as fh:
        geo = next((f["geometry"] for f in json.load(fh)["features"] if f["properties"]["ADMIN"] == country.replace("_", " ")), None)
    if geo is None:
        sys.exit(f"{country}: no such ADMIN name in the Natural Earth file")
    bands = defaultdict(list)
    for poly in geo["coordinates"] if geo["type"] == "MultiPolygon" else [geo["coordinates"]]:
        for ring in poly:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                if y1 != y2:
                    for b in range(int(min(y1, y2) // BAND), int(max(y1, y2) // BAND) + 1):
                        bands[b].append((x1, y1, x2, y2))

    def inside(lon, lat):
        odd = False
        for x1, y1, x2, y2 in bands.get(int(lat // BAND), ()):
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                odd = not odd
        return odd
    return inside


def own_files(country):
    """The cells of the country's past VIIRS fires (for the box), its fixed-hot-source cells, and every 100th past detection."""
    cells, hot, sample = set(), set(), []
    for folder in ("viirs-snpp", "viirs-jpss1"):
        for path in glob.glob(os.path.join(DATA, "firms", folder, f"{folder}_*_{country}.csv")):
            if f"_{YEAR}_" in path:
                continue
            with open(path, newline="") as fh:
                for k, row in enumerate(csv.DictReader(fh)):
                    lon, lat = float(row["longitude"]), float(row["latitude"])
                    cells.add((int(lon // FINE), int(lat // FINE)))
                    if row.get("type") in ("1", "2", "3"):   # volcano, fixed hot source, offshore
                        hot.add((int(lon // NEAR), int(lat // NEAR)))
                    elif k % 100 == 0:
                        sample.append((lon, lat))
    return cells, hot, sample


def chunks(sp_until, nrt_from):
    """(source, first day, days) for 1 January to the end of last month, 5 days per call at most."""
    d, last = date(YEAR, 1, 1), date.today().replace(day=1) - timedelta(1)
    while d <= last:
        sp = sp_until is not None and d <= sp_until
        if not sp and (nrt_from is None or d < nrt_from):
            sys.exit(f"no NOAA-20 data in the API for {d} (science-quality ends {sp_until}, near-real-time starts {nrt_from})")
        end = min(d + timedelta(4), last, sp_until if sp else last)
        yield ("VIIRS_NOAA20_SP" if sp else "VIIRS_NOAA20_NRT"), d, (end - d).days + 1
        d = end + timedelta(1)


def fetch(country, key, spans):
    cells, hot, sample = own_files(country)
    if not cells:
        return f"{country}: no past VIIRS files; run fetch-country.sh {country} first"
    inside = border(country)
    share = sum(inside(lon, lat) for lon, lat in sample) / len(sample)
    assert share > 0.95, f"{country}: only {share:.0%} of its past detections fall inside the border"   # wrong outline or a broken test
    xs, ys = [x for x, _ in cells], [y for _, y in cells]
    box = f"{min(xs) * FINE:.1f},{min(ys) * FINE:.1f},{(max(xs) + 1) * FINE:.1f},{(max(ys) + 1) * FINE:.1f}"
    rows, in_box, marked = [], 0, 0
    for source, day, n in spans:
        for row in csv.DictReader(io.StringIO(get(f"{API}/area/csv/{key}/{source}/{box}/{n}/{day}", key))):
            in_box += 1
            lon, lat = float(row["longitude"]), float(row["latitude"])
            if not inside(lon, lat):
                continue
            assert row["confidence"] in ("l", "n", "h"), f"{country}: unexpected confidence {row['confidence']!r}"
            if not row.get("type"):
                nx, ny = int(lon // NEAR), int(lat // NEAR)
                if any((nx + i, ny + j) in hot for i in (-1, 0, 1) for j in (-1, 0, 1)):
                    row["type"], marked = "2", marked + 1
            rows.append(row)
    rows.sort(key=lambda r: (r["acq_date"], r["acq_time"]))
    out = os.path.join(DATA, "firms", "viirs-jpss1", f"viirs-jpss1_{YEAR}_{country}.csv")
    with open(out + ".part", "w", newline="") as fh:
        w = csv.DictWriter(fh, FIELDS, extrasaction="ignore", restval="")
        w.writeheader()
        w.writerows(rows)
    os.replace(out + ".part", out)
    nrt = sum("NRT" in r.get("version", "") for r in rows)
    return f"{country}: kept {len(rows)} of {in_box} detections in its box ({nrt} near-real-time, {marked} marked as fixed hot sources), {rows[0]['acq_date'] if rows else '-'} to {rows[-1]['acq_date'] if rows else '-'}"


def main():
    countries = sys.argv[1:] or sys.exit(__doc__)
    with open(os.path.join(DATA, "firms-key.txt")) as fh:
        key = fh.read().strip()
    avail = {r["data_id"]: r for r in csv.DictReader(io.StringIO(get(f"{API}/data_availability/csv/{key}/all", key)))}
    day = lambda k, f: date.fromisoformat(avail[k][f]) if k in avail else None
    sp_until, nrt_from = day("VIIRS_NOAA20_SP", "max_date"), day("VIIRS_NOAA20_NRT", "min_date")
    print(f"NOAA-20 in the API: science-quality to {sp_until}, near-real-time from {nrt_from}")
    spans = list(chunks(sp_until, nrt_from))
    with ThreadPoolExecutor(4) as pool:   # 4 countries at once keeps far under the 5000 calls per 10 minutes
        for line in pool.map(lambda c: fetch(c, key, spans), countries):
            print(line)


if __name__ == "__main__":
    main()
