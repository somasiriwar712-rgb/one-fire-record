#!/usr/bin/env python3
"""Find one real fire that MODIS and VIIRS both saw on the same afternoon, for the "seam" picture on the page.

Usage:  python3 seam.py Sri_Lanka [More_Countries ...]
Reads:  the yearly MODIS and Suomi NPP files (fetch-country.sh), 2012 to 2021.
Writes: ../site/data/<Country>.seam.json

Aqua (MODIS) and Suomi NPP (VIIRS) cross the equator at about 1:30 PM, minutes apart, so their daytime passes see
the same fire at nearly the same moment. The script looks for the day and 0.25-degree box where Suomi NPP counted the
most detections and Aqua counted at least a few, within 30 minutes of each other, and saves every pixel of both passes there with its real size:
NASA's scan (across the orbit, about east-west) and track (along the orbit, about north-south) in km.
Only rows the record itself counts are used: vegetation fires, no low confidence (harmonize.keep).
"""
import csv
import glob
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harmonize import DATA, FIT_YEARS, FOLDERS, SITE, keep   # noqa: E402

BOX = 0.25          # degrees, about 28 km: the size of one picture
MIN_MODIS = 5       # a fire both sensors clearly saw
MAX_GAP = 30        # minutes between the two passes, so both saw the fire at nearly the same moment


def afternoon(country, sensor, year):
    """Daytime rows of the afternoon satellite (Aqua for MODIS, Suomi NPP for VIIRS) that the record counts."""
    folder = FOLDERS[sensor]
    for path in glob.glob(os.path.join(DATA, folder, f"{folder}_{year}_{country}.csv")):
        with open(path, newline="") as fh:
            for row in csv.DictReader(fh):
                if row["daynight"] == "D" and keep(row, sensor) and (sensor != "modis" or row["satellite"] == "Aqua"):
                    yield row


def minutes(row):
    t = int(row["acq_time"])
    return t // 100 * 60 + t % 100


def gap(b):
    return abs(minutes(b["modis"][0]) - minutes(b["snpp"][0])) if b["snpp"] else 10 ** 6


def find(country):
    best = None
    for year in FIT_YEARS:
        boxes = defaultdict(lambda: {"modis": [], "snpp": []})
        for sensor in ("modis", "snpp"):
            for row in afternoon(country, sensor, year):
                lat, lon = float(row["latitude"]), float(row["longitude"])
                boxes[(row["acq_date"], int(lat // BOX), int(lon // BOX))][sensor].append(row)
        for key, b in boxes.items():
            if len(b["modis"]) >= MIN_MODIS and gap(b) <= MAX_GAP and (best is None or len(b["snpp"]) > len(best[1]["snpp"])):
                best = (key, b)
    return best


def pixels(rows):
    return [[round(float(r["latitude"]), 4), round(float(r["longitude"]), 4), float(r["scan"]), float(r["track"])] for r in rows]


def run(country):
    found = find(country)
    if not found:
        print(f"{country}: no afternoon both sensors saw with {MIN_MODIS}+ MODIS detections")
        return False
    (day, _, _), b = found
    out = {"date": day, "modis": pixels(b["modis"]), "viirs": pixels(b["snpp"]),
           "modis_time": b["modis"][0]["acq_time"], "viirs_time": b["snpp"][0]["acq_time"]}
    with open(os.path.join(SITE, f"{country}.seam.json"), "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"{country:12s} {day}: Aqua MODIS {len(out['modis'])}, Suomi NPP VIIRS {len(out['viirs'])} ({out['modis_time']} / {out['viirs_time']} UTC)")
    return True


if __name__ == "__main__":
    if not [c for c in sys.argv[1:] if run(c)]:
        sys.exit("nothing written")
