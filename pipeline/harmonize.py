#!/usr/bin/env python3
"""Join MODIS and VIIRS fire detections for one country into one monthly record, and test the join.

Usage:  python3 harmonize.py Sri_Lanka [More_Countries ...]     (names as in the FIRMS file names)
Reads:  ../../resources/data/firms/<sensor>/<sensor>_<year>_<Country>.csv   (see fetch-country.sh)
Writes: ../site/data/<Country>.json, ../site/data/index.json and ../site/feed/<Country>.xml (RSS), and prints the test.

The join, in short. VIIRS (Suomi NPP) is the reference because VIIRS is the record that continues.
For the years before it, MODIS counts are multiplied by a factor learned where both flew
(2012 to 2021), one factor per calendar month, because the gap changes with the fire season.
The test hides one shared year at a time, predicts it from MODIS and compares with what VIIRS saw.

Only the Python standard library, and files are read as streams: this PC has little memory.
"""
import csv
import glob
import json
import os
import sys
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from email.utils import format_datetime
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "resources", "data", "firms")
SITE = os.path.join(HERE, "..", "site", "data")
FEED = os.path.join(HERE, "..", "site", "feed")
URL = "https://somasiriwar712-rgb.github.io/one-fire-record/"
NAMES = {"Brunei_Darussalam": "Brunei", "Cape_Verde": "Cabo Verde", "Cote_d_Ivoire": "Côte d'Ivoire", "Curacao": "Curaçao",
         "Czech_Republic": "Czechia", "Dem_Rep_Korea": "North Korea", "Lao_PDR": "Laos", "Macedonia_Former_Yugoslav_Republic_of": "North Macedonia",
         "Republic_of_Congo": "Republic of the Congo", "Republic_of_Korea": "South Korea", "Russian_Federation": "Russia",
         "Sao_Tome_and_Principe": "São Tomé and Príncipe", "Swaziland": "Eswatini", "Turkey": "Türkiye", "Reunion": "Réunion"}   # shown names where NASA's file name reads badly
display = lambda c: NAMES.get(c, c.replace("_", " "))
FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

SPOT = 300                      # fire dots for the map are kept on a 1/300-degree grid, about 370 m, one VIIRS pixel
FINE = 0.1                      # degrees, about 11 km: the grid the page gets, so an area can be summed
MAX_ENTRIES = 40000             # cell-months kept for the map; a bigger country gets a coarser grid, so its file stays small for a phone
FOLDERS = {"modis": "modis", "snpp": "viirs-snpp", "n20": "viirs-jpss1"}
START = {"modis": "2000-11", "snpp": "2012-01", "n20": "2018-04"}   # first month of data in the FIRMS archive
FIT_YEARS = range(2012, 2022)   # both sensors flying, before the MODIS orbits drifted far (NASA, 2025)
DRIFT_YEARS = range(2022, 2026)
SHRINK = 30                     # pulls a thin calendar month's factor toward the all-year factor
AQUA_START = "2002-07"          # before this, MODIS means Terra alone
SNPP_START = "2012-02"          # first full Suomi NPP month (its data start on 20 January 2012)


def keep(row, sensor):
    """Vegetation fires only, no low-confidence detections (MODIS and VIIRS user guides, GFED5)."""
    if row.get("type", "0") not in ("0", ""):   # 1 volcano, 2 fixed hot source, 3 offshore
        return False
    c = row["confidence"]
    return int(c) >= 30 if sensor == "modis" else c in ("n", "h")


def count_country(country):
    """Return ({series: {"YYYY-MM": detections}}, coarse grid, rows read per sensor).

    Series: terra, aqua, modis (Terra and Aqua together), snpp, n20.
    Grid: {(series, x, y): {"YYYY-MM": detections}} for modis, snpp and n20 on FINE-degree cells.
    Also returns the last month each sensor's files cover (a yearly file is a whole year, fires or not),
    and the first month with near-real-time rows (fetch-recent.py), which the page calls provisional.
    """
    months = defaultdict(lambda: defaultdict(int))
    grid = defaultdict(lambda: defaultdict(int))
    rows_read = defaultdict(int)
    last = {}
    provisional = None
    fires = {}                                      # the newest year's NOAA-20 fires on a 1/300-degree grid (about one VIIRS pixel): spot -> [last day of year, detections]
    for sensor, folder in FOLDERS.items():
        for path in sorted(glob.glob(os.path.join(DATA, folder, f"{folder}_[0-9][0-9][0-9][0-9]_{country}.csv"))):
            year = os.path.basename(path).split("_")[1]
            last[sensor] = year + "-12"             # a past year's file covers the whole year, fires or not
            partial = int(year) >= date.today().year   # this year's file stops at its newest detection
            newest = ""
            with open(path, newline="") as fh:
                for row in csv.DictReader(fh):
                    rows_read[sensor] += 1
                    if not keep(row, sensor):
                        continue
                    month = row["acq_date"][:7]
                    newest = max(newest, month)
                    if "NRT" in row.get("version", "") and (provisional is None or month < provisional):
                        provisional = month
                    months[sensor][month] += 1
                    if sensor == "modis":
                        months[row["satellite"].lower()][month] += 1
                    cell = (int(float(row["longitude"]) // FINE), int(float(row["latitude"]) // FINE))
                    grid[(sensor, *cell)][month] += 1
                    if sensor == "n20" and partial:
                        spot = fires.setdefault((round(float(row["latitude"]) * SPOT), round(float(row["longitude"]) * SPOT)), [0, 0])
                        spot[0] = max(spot[0], date.fromisoformat(row["acq_date"]).timetuple().tm_yday)
                        spot[1] += 1
            if partial:   # fetch-recent.py asks for 1 January to the end of the month before the day it ran: quiet months are 0, not missing
                ran = date.fromtimestamp(os.path.getmtime(path)).replace(day=1) - timedelta(days=1)
                last[sensor] = max(newest, f"{ran.year}-{ran.month:02d}") if ran.year == int(year) else (newest or year + "-01")
    return months, grid, dict(rows_read), last, provisional, fires


def coarsen(grid):
    """Merge cells 2 by 2 until the grid holds at most MAX_ENTRIES cell-months. Returns (cell size in degrees, grid)."""
    size, step = FINE, 1
    while len({(x // step, y // step, m) for (_, x, y), per_month in grid.items() for m in per_month}) > MAX_ENTRIES:
        step *= 2
    merged = defaultdict(lambda: defaultdict(int))
    for (sensor, x, y), per_month in grid.items():
        for month, n in per_month.items():
            merged[(sensor, x // step, y // step)][month] += n
    return size * step, merged


def month_range(first, last):
    y, m = int(first[:4]), int(first[5:])
    while f"{y}-{m:02d}" <= last:
        yield f"{y}-{m:02d}"
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)


def fit(pairs):
    """pairs: [(month, modis, viirs)] -> (all-year factor, {calendar month: factor})."""
    total_m = sum(m for _, m, _ in pairs)
    if not total_m:
        return None, None
    base = round(sum(v for _, _, v in pairs) / total_m, 4)      # rounded here so the page, which reads them from JSON, computes the same values
    by_month = {}
    for mo in range(1, 13):
        ms = sum(m for k, m, _ in pairs if int(k[5:]) == mo)
        vs = sum(v for k, _, v in pairs if int(k[5:]) == mo)
        by_month[mo] = round((vs + SHRINK * base) / (ms + SHRINK), 4)
    return base, by_month


def quantile(values, q):
    s = sorted(values)
    if not s:
        return None
    pos = q * (len(s) - 1)
    lo = int(pos)
    return s[lo] + (s[min(lo + 1, len(s) - 1)] - s[lo]) * (pos - lo)


def test_join(modis, viirs):
    """Hide one shared year at a time. Returns the errors of the monthly factor and of one fixed factor."""
    shared = [m for m in month_range(SNPP_START, f"{FIT_YEARS[-1]}-12")]
    result = {"years": [], "monthly": {"year_err": [], "abs": 0.0}, "fixed": {"year_err": [], "abs": 0.0}}
    ratios = []                                  # (modis count, what VIIRS saw / what we predicted) per hidden month
    seen_total = 0
    for hold in FIT_YEARS:
        train = [(m, modis.get(m, 0), viirs.get(m, 0)) for m in shared if int(m[:4]) != hold]
        hidden = [m for m in shared if int(m[:4]) == hold]
        base, by_month = fit(train)
        if base is None:
            return None
        seen = [viirs.get(m, 0) for m in hidden]
        if not sum(seen):
            continue
        result["years"].append(hold)
        seen_total += sum(seen)
        for name, predict in (("monthly", lambda m: modis.get(m, 0) * by_month[int(m[5:])]), ("fixed", lambda m: modis.get(m, 0) * base)):
            pred = [predict(m) for m in hidden]
            result[name]["year_err"].append(round((sum(pred) - sum(seen)) / sum(seen) * 100, 1))
            result[name]["abs"] += sum(abs(p - s) for p, s in zip(pred, seen))
            if name == "monthly":
                ratios += [(modis.get(m, 0), s / p) for m, p, s in zip(hidden, pred, seen) if p > 0]
    if not ratios:
        return None                              # no month with a prediction: too little fire to test the join
    for name in ("monthly", "fixed"):
        errs = [abs(e) for e in result[name]["year_err"]]
        result[name]["year_err_mean"] = round(sum(errs) / len(errs), 1)
        result[name]["year_err_max"] = round(max(errs), 1)
        result[name]["month_err"] = round(result[name].pop("abs") / seen_total * 100, 1)   # summed monthly misses / summed VIIRS
    # 80% band: where the real VIIRS value fell, relative to our prediction, in thin and in busy months
    thin = [r for m, r in ratios if m < 10]
    busy = [r for m, r in ratios if m >= 10]
    every = [r for _, r in ratios]
    result["band"] = {
        # widened to hold 1, so an estimate always sits inside its own range (thin places can miss both ways in one direction)
        "thin": [f(round(quantile(thin if len(thin) >= 15 else every, q), 2), 1) for q, f in ((0.1, min), (0.9, max))],
        "busy": [f(round(quantile(busy if len(busy) >= 15 else every, q), 2), 1) for q, f in ((0.1, min), (0.9, max))],
    }
    return result


def half_up(v):
    return int(v + 0.5)             # the page rounds with Math.round; Python's round() goes to even


def join(months, last):
    modis, terra, snpp, n20 = (months.get(k, {}) for k in ("modis", "terra", "snpp", "n20"))
    shared = [(m, modis.get(m, 0), snpp.get(m, 0)) for m in month_range(SNPP_START, f"{FIT_YEARS[-1]}-12")]
    base, by_month = fit(shared)
    test = test_join(modis, snpp)
    if base is None or test is None:
        return None
    _, terra_by_month = fit([(m, terra.get(m, 0), v) for m, _, v in shared])
    terra_test = test_join(terra, snpp) if terra_by_month else None
    test["band_terra"] = terra_test["band"] if terra_test else test["band"]
    # the hand-over to NOAA-20, on the full years both VIIRS sensors flew
    last_snpp, last_n20 = last["snpp"], last.get("n20", "")
    both = list(month_range("2019-01", min(last_snpp, last_n20))) if last_n20 else []
    handover = round(sum(snpp.get(m, 0) for m in both) / max(1, sum(n20.get(m, 0) for m in both)), 4)
    out = {"first": START["modis"], "modis": [], "terra": [], "snpp": [], "n20": [], "joined": [], "lo": [], "hi": [], "src": ""}
    for m in month_range(START["modis"], max(last.values())):
        mo = int(m[5:])
        out["modis"].append(modis.get(m, 0) if m <= last["modis"] else None)
        out["terra"].append(terra.get(m, 0) if m <= last["modis"] else None)   # Terra flew the whole time: one instrument, for checking which years were worst
        out["snpp"].append(snpp.get(m, 0) if START["snpp"] <= m <= last_snpp else None)
        out["n20"].append(n20.get(m, 0) if last_n20 and START["n20"] <= m <= last_n20 else None)
        if SNPP_START <= m <= last_snpp:
            src, value, band = "s", snpp.get(m, 0), (1, 1)          # VIIRS itself: nothing to estimate
        elif m > last_snpp:
            src, value, band = "n", n20.get(m, 0) * handover, (1, 1)
        else:
            count = modis.get(m, 0)
            factor = by_month[mo] if m >= AQUA_START or not terra_by_month else terra_by_month[mo]
            src, value = ("m" if m >= AQUA_START else "t"), count * factor
            band = test["band" if src == "m" else "band_terra"]["busy" if count >= 10 else "thin"]
        out["src"] += src
        out["joined"].append(half_up(value))
        out["lo"].append(half_up(value * band[0]))
        out["hi"].append(half_up(value * band[1]))
    drift = {}
    for y in DRIFT_YEARS:                                             # does the pre-drift factor still hold?
        ms = [m for m in month_range(f"{y}-01", f"{y}-12") if m <= last_snpp]
        seen = sum(snpp.get(m, 0) for m in ms)
        if seen:
            drift[y] = {name: round((sum(s.get(m, 0) * f[int(m[5:])] for m in ms) - seen) / seen * 100) for name, s, f in (("modis", modis, by_month), ("terra", terra, terra_by_month or by_month))}
    out.update(factor={"all": base, "by_month": [by_month[mo] for mo in range(1, 13)], "terra_by_month": [terra_by_month[mo] for mo in range(1, 13)] if terra_by_month else None, "handover": handover}, test=test, drift=drift)
    return out


def cell_values(grid, out, step):
    """Joined values per map square of step x FINE degrees: {(x, y): {month index: value}}, by the same rule as join()."""
    index = {m: i for i, m in enumerate(month_range(out["first"], "2099-12")) if i < len(out["src"])}
    f, src = out["factor"], out["src"]
    cells = defaultdict(lambda: defaultdict(float))
    for (sensor, x, y), per_month in grid.items():
        for m, n in per_month.items():
            i = index.get(m)
            s = src[i] if i is not None else ""
            if sensor == "modis" and s in ("m", "t"):
                v = n * (f["terra_by_month"] if s == "t" and f["terra_by_month"] else f["by_month"])[int(m[5:]) - 1]
            elif (sensor, s) == ("snpp", "s"):
                v = n
            elif (sensor, s) == ("n20", "n"):
                v = n * f["handover"]
            else:
                continue
            cells[(x // step, y // step)][i] += v
    return cells


def map_layers(grid, out):
    """The two map layers: when each 0.2-degree square burns most, and how its newest month compares (0.5-degree squares)."""
    first_m = int(out["first"][5:]) - 1
    burn = []
    for (x, y), per in sorted(cell_values(grid, out, 2).items()):
        by = [0.0] * 12
        for i, v in per.items():
            by[(first_m + i) % 12] += v
        if sum(by) >= 1:
            burn.append([x, y, *(round(v) for v in by)])
    i = max(out["src"].rfind("s"), out["src"].rfind("n"))
    same = []
    for (x, y), per in sorted(cell_values(grid, out, 5).items()):
        vals = [round(per.get(j, 0.0), 1) for j in range(i % 12, i + 1, 12)]   # the newest calendar month, oldest year first
        if any(vals):
            same.append([x, y, *vals])
    return {"burn": burn, "burn_deg": FINE * 2, "same": same, "same_deg": FINE * 5, "same_month": i}


def fire_bounds(grid_rows, c):
    """[[west, south], [east, north]] holding 98% of the country's detections, so a far island with little fire does not zoom the map out."""
    totals = [(x, y, sum(sum(s.values()) for s in sensors)) for x, y, *sensors in grid_rows]
    whole = sum(t for *_, t in totals)

    def edge(axis, q):
        run = 0
        for row in sorted(totals, key=lambda r: r[axis]):
            run += row[2]
            if run >= whole * q:
                return row[axis] * c
    return [[round(edge(0, 0.01), 3), round(edge(1, 0.01), 3)], [round(edge(0, 0.99) + c, 3), round(edge(1, 0.99) + c, 3)]]


WORDS = ["far below normal", "below normal", "normal", "above normal", "far above normal"]


def verdict(joined, i):
    """The page's answer for month i (drawAnswer in app.js): its rank among the same calendar month in earlier years."""
    same = sorted(joined[k] for k in range(i - 12, -1, -12))
    v = joined[i]
    rank = (sum(x < v for x in same) + sum(x == v for x in same) / 2) / len(same)
    word = "far below normal" if rank <= 0.1 else "below normal" if rank <= 0.25 else "normal" if rank < 0.75 else "above normal" if rank < 0.9 else "far above normal"
    mid = sorted(same)[len(same) // 2] if len(same) % 2 else (same[len(same) // 2 - 1] + same[len(same) // 2]) / 2
    return word, v, round(mid), len(same)


def write_feed(out):
    """RSS, one item per month of the last year: was it normal? Anyone can follow a place with no server and no sign-up."""
    first_y, first_m = int(out["first"][:4]), int(out["first"][5:])
    newest = max(out["src"].rfind("s"), out["src"].rfind("n"))
    items = []
    for i in range(newest, max(newest - 12, 11), -1):   # the last 12 months, each with at least one earlier year
        k = first_m - 1 + i
        y, m = first_y + k // 12, k % 12
        word, v, mid, n = verdict(out["joined"], i)
        prov = out["provisional_from"] and f"{y}-{m + 1:02d}" >= out["provisional_from"]
        title = f"{FULL[m]} {y} in {out['name']}: fire activity was {word}"
        text = f"{v:,} fire detections. In the {n} earlier {FULL[m]}s on record, the middle year had {mid:,}." + (" Near-real-time data: provisional." if prov else "")
        items.append(f"<item><title>{escape(title)}</title><link>{URL}#{out['id']}</link><guid isPermaLink=\"false\">{out['id']}-{y}-{m + 1:02d}{'-nrt' if prov else ''}</guid>"
                     f"<pubDate>{format_datetime(datetime(y + (m == 11), (m + 1) % 12 + 1, 1, tzinfo=timezone.utc))}</pubDate><description>{escape(text)}</description></item>")
    os.makedirs(FEED, exist_ok=True)
    with open(os.path.join(FEED, f"{out['id']}.xml"), "w") as fh:
        fh.write(f'<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel><title>One Fire Record: {escape(out["name"])}</title><link>{URL}#{out["id"]}</link>'
                 f"<description>Is this month's fire activity normal for {escape(out['name'])}? NASA MODIS and VIIRS fire detections joined into one record since 2000.</description>"
                 f"<lastBuildDate>{format_datetime(datetime.now(timezone.utc))}</lastBuildDate>{''.join(items)}</channel></rss>\n")


def run(country):
    months, grid, rows_read, last, provisional, fires = count_country(country)
    if "modis" not in months or "snpp" not in months:
        print(f"{country}: no fire files in {DATA} (run fetch-country.sh {country}) or no VIIRS fires at all")
        return False
    out = join(months, last)
    if out is None:
        print(f"{country}: too few fires in {FIT_YEARS[0]} to {FIT_YEARS[-1]} to learn a factor")
        return False
    lines = sum(sum(1 for _ in open(p)) - 1 for folder in FOLDERS.values() for p in glob.glob(os.path.join(DATA, folder, f"{folder}_[0-9][0-9][0-9][0-9]_{country}.csv")))
    assert lines == sum(rows_read.values()), f"{country}: read {sum(rows_read.values())} rows, files hold {lines}"
    index = {m: i for i, m in enumerate(month_range(out["first"], "2099-12")) if i < len(out["joined"])}
    layers = map_layers(grid, out)
    coarse_deg, grid = coarsen(grid)
    cells = defaultdict(lambda: {"modis": {}, "snpp": {}, "n20": {}})
    for (sensor, x, y), per_month in grid.items():
        cells[(x, y)][sensor] = {index[m]: n for m, n in per_month.items() if m in index}
    grid_rows = [[x, y, c["modis"], c["snpp"], c["n20"]] for (x, y), c in sorted(cells.items())]
    out.update(id=country, name=display(country), rows_read=rows_read, coarse_deg=coarse_deg, provisional_from=provisional, spot=SPOT,
               bounds=fire_bounds(grid_rows, coarse_deg))
    os.makedirs(SITE, exist_ok=True)
    path = os.path.join(SITE, f"{country}.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    with open(os.path.join(SITE, f"{country}.map.json"), "w") as fh:   # only the map needs these, so the first screen loads without them
        json.dump({"coarse_deg": coarse_deg, "grid": grid_rows, **layers}, fh, separators=(",", ":"))
    write_feed(out)
    if fires:   # per spot: latitude and longitude in 1/SPOT degrees, the last day of year it burned, detections; flat
        with open(os.path.join(SITE, f"{country}.fires.json"), "w") as fh:
            json.dump({"from": last["n20"][:4] + "-01", "to": last["n20"], "year": int(last["n20"][:4]), "scale": SPOT, "pts": [v for p in sorted(fires) for v in (*p, *fires[p])]}, fh, separators=(",", ":"))
    t, f = out["test"], out["factor"]
    print(f"{country:12s} factor {f['all']:5.2f} (by month {min(f['by_month']):.1f} to {max(f['by_month']):.1f})  hand-over {f['handover']:.2f}"
          f" | hidden-year miss: monthly factor {t['monthly']['year_err_mean']:4.1f}% (worst {t['monthly']['year_err_max']:.0f}%), fixed {t['fixed']['year_err_mean']:4.1f}% (worst {t['fixed']['year_err_max']:.0f}%)"
          f" | month miss: {t['monthly']['month_err']:4.1f}% vs fixed {t['fixed']['month_err']:4.1f}%"
          f" | drift {' '.join(f'{y}:{d['modis']:+d}/{d['terra']:+d}' for y, d in out['drift'].items())}"
          f" | {os.path.getsize(path) // 1024} KB")
    return True


def main():
    done = [c for c in sys.argv[1:] if run(c)]
    if not done:
        sys.exit("nothing written")
    names = sorted(n for n in (os.path.basename(p)[:-5] for p in glob.glob(os.path.join(SITE, "*.json"))) if "." not in n and n not in ("index", "countries"))   # not Sri_Lanka.fires etc.
    plain = lambda p: unicodedata.normalize("NFKD", p["name"]).encode("ascii", "ignore").decode()   # Côte sorts with Costa, not after Czechia
    def now(n):   # this place's newest measured month and its verdict, for the world map: [0..4 as in WORDS, "yyyy-mm"]
        with open(os.path.join(SITE, f"{n}.json")) as fh:
            d = json.load(fh)
        i = max(d["src"].rfind("s"), d["src"].rfind("n"))
        k = int(d["first"][5:]) - 1 + i
        return [WORDS.index(verdict(d["joined"], i)[0]), f"{int(d['first'][:4]) + k // 12}-{k % 12 + 1:02d}"]
    part = os.path.join(SITE, f"index.json.{os.getpid()}.part")   # one per run, so overlapping runs never share it
    with open(part, "w") as fh:
        json.dump(sorted(({"id": n, "name": display(n), "now": now(n)} for n in names), key=plain), fh, ensure_ascii=False)   # the place list reads in name order
    os.replace(part, os.path.join(SITE, "index.json"))   # never a half-written list, even when runs overlap


if __name__ == "__main__":
    main()
