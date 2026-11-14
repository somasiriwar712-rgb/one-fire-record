#!/usr/bin/env python3
"""Join MODIS and VIIRS fire detections for one country into one monthly record, and test the join.

Usage:  python3 harmonize.py Sri_Lanka [More_Countries ...]     (names as in the FIRMS file names)
Reads:  ../../resources/data/firms/<sensor>/<sensor>_<year>_<Country>.csv   (see fetch-country.sh)
Writes: ../site/data/<Country>.json and ../site/data/index.json, and prints the test.

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
from collections import defaultdict
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "resources", "data", "firms")
SITE = os.path.join(HERE, "..", "site", "data")

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
    Also returns the last month each sensor's files cover: a yearly file is a whole year, fires or not.
    """
    months = defaultdict(lambda: defaultdict(int))
    grid = defaultdict(lambda: defaultdict(int))
    rows_read = defaultdict(int)
    last = {}
    for sensor, folder in FOLDERS.items():
        for path in sorted(glob.glob(os.path.join(DATA, folder, f"{folder}_*_{country}.csv"))):
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
                    months[sensor][month] += 1
                    if sensor == "modis":
                        months[row["satellite"].lower()][month] += 1
                    cell = (int(float(row["longitude"]) // FINE), int(float(row["latitude"]) // FINE))
                    grid[(sensor, *cell)][month] += 1
            if partial and newest:
                last[sensor] = newest
    return months, grid, dict(rows_read), last


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
        "thin": [round(quantile(thin if len(thin) >= 15 else every, q), 2) for q in (0.1, 0.9)],
        "busy": [round(quantile(busy if len(busy) >= 15 else every, q), 2) for q in (0.1, 0.9)],
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
    out = {"first": START["modis"], "modis": [], "snpp": [], "n20": [], "joined": [], "lo": [], "hi": [], "src": ""}
    for m in month_range(START["modis"], max(last.values())):
        mo = int(m[5:])
        out["modis"].append(modis.get(m, 0) if m <= last["modis"] else None)
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


def run(country):
    months, grid, rows_read, last = count_country(country)
    if "modis" not in months or "snpp" not in months:
        print(f"{country}: no fire files in {DATA} (run fetch-country.sh {country}) or no VIIRS fires at all")
        return False
    out = join(months, last)
    if out is None:
        print(f"{country}: too few fires in {FIT_YEARS[0]} to {FIT_YEARS[-1]} to learn a factor")
        return False
    lines = sum(sum(1 for _ in open(p)) - 1 for folder in FOLDERS.values() for p in glob.glob(os.path.join(DATA, folder, f"{folder}_*_{country}.csv")))
    assert lines == sum(rows_read.values()), f"{country}: read {sum(rows_read.values())} rows, files hold {lines}"
    index = {m: i for i, m in enumerate(month_range(out["first"], "2099-12")) if i < len(out["joined"])}
    coarse_deg, grid = coarsen(grid)
    cells = defaultdict(lambda: {"modis": {}, "snpp": {}, "n20": {}})
    for (sensor, x, y), per_month in grid.items():
        cells[(x, y)][sensor] = {index[m]: n for m, n in per_month.items() if m in index}
    out.update(id=country, name=country.replace("_", " "), rows_read=rows_read, coarse_deg=coarse_deg,
               grid=[[x, y, c["modis"], c["snpp"], c["n20"]] for (x, y), c in sorted(cells.items())])
    os.makedirs(SITE, exist_ok=True)
    path = os.path.join(SITE, f"{country}.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
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
    names = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(SITE, "*.json")) if not p.endswith("index.json"))
    with open(os.path.join(SITE, "index.json"), "w") as fh:
        json.dump([{"id": n, "name": n.replace("_", " ")} for n in names], fh)


if __name__ == "__main__":
    main()
