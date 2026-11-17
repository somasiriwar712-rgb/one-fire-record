#!/usr/bin/env python3
"""Country outlines for the globe: every Natural Earth 10m country, simplified so the file stays small for a phone.

Usage:  python3 outlines.py
Reads:  ../../resources/data/borders/ne_10m_admin_0_countries.geojson (public domain), ../site/data/index.json
Writes: ../site/data/countries.json, a light GeoJSON for the globe and for tapping: id (the FIRMS file name, e.g. Sri_Lanka),
        name, and has = 1 when the page holds a fire record for it (only those can be opened);
        ../site/data/<id>.outline.json, a detailed outline of each country with a record, drawn when it is open.
"""
import json
import os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
BORDERS = os.path.join(HERE, "..", "..", "resources", "data", "borders", "ne_10m_admin_0_countries.geojson")
SITE = os.path.join(HERE, "..", "site", "data")
TOLERANCE = 0.08    # degrees, about 9 km: fine on the globe, and the file drops from 13 MB to about 140 KB compressed
MIN_RING = 0.05     # square degrees: drops tiny islets, which a finger can't hit anyway
FINE = (0.01, 0.002)   # the open country's own outline: about 1 km, keeping islets down to about 5 km across


def simplify(points, tol):
    """Douglas-Peucker, iterative so long coastlines don't hit the recursion limit."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        far, at = 0.0, -1
        for i in range(a + 1, b):
            x, y = points[i]
            d = abs(dy * (x - x1) - dx * (y - y1)) / norm if (dx or dy) else ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
            if d > far:
                far, at = d, i
        if far > tol:
            keep[at] = True
            stack += [(a, at), (at, b)]
    return [p for p, k in zip(points, keep) if k]


def area(ring):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))) / 2


with open(os.path.join(HERE, "border-names.json")) as _fh:
    NAMES = json.load(_fh)   # FIRMS file name -> Natural Earth ADMIN name, or [ADMIN name, [west, south, east, north]] for an overseas part


def borders(features):
    """FIRMS id -> (display name, polygons) for every Natural Earth country, with overseas parts split off by their box."""
    parts, to_id, out = defaultdict(list), {v: k for k, v in NAMES.items() if isinstance(v, str)}, {}
    for cid, v in NAMES.items():
        if isinstance(v, list):
            parts[v[0]].append((cid, v[1]))
    for f in features:
        name, geo = f["properties"]["ADMIN"], f["geometry"]
        polys = geo["coordinates"] if geo["type"] == "MultiPolygon" else [geo["coordinates"]]
        for cid, (w, s, e, n) in parts[name]:
            mine = [p for p in polys if w <= p[0][0][0] <= e and s <= p[0][0][1] <= n]
            polys = [p for p in polys if not (w <= p[0][0][0] <= e and s <= p[0][0][1] <= n)]
            if mine:
                out[cid] = (cid.replace("_", " "), mine)
        out[to_id.get(name, name.replace(" ", "_"))] = (name, polys)
    return out


def shape(polygons, tol, min_ring, places):
    polys = []
    for poly in polygons:
        outer = simplify(poly[0], tol)
        if len(outer) < 4 or area(outer) < min_ring:
            continue
        holes = [h for h in (simplify(r, tol) for r in poly[1:]) if len(h) >= 4 and area(h) >= min_ring]
        polys.append([[[round(x, places), round(y, places)] for x, y in ring] for ring in [outer, *holes]])
    return polys


def main():
    with open(os.path.join(SITE, "index.json")) as fh:
        shown = {p["id"]: p["name"] for p in json.load(fh)}   # the globe uses the same names as the place list
    have = set(shown)
    with open(BORDERS) as fh:
        world = json.load(fh)
    out = []
    for cid, (name, geo) in borders(world["features"]).items():
        polys = shape(geo, TOLERANCE, MIN_RING, 2)
        if not polys and cid in have:   # small islands with a fire record must stay tappable
            polys = shape(geo, FINE[0], 0, 3)
        if not polys:
            continue
        if cid in have:
            with open(os.path.join(SITE, f"{cid}.outline.json"), "w") as fh:
                json.dump({"type": "Feature", "properties": {"id": cid}, "geometry": {"type": "MultiPolygon", "coordinates": shape(geo, *FINE, 3)}}, fh, separators=(",", ":"))
        out.append({"type": "Feature", "properties": {"id": cid, "name": shown.get(cid, name), "has": int(cid in have)},
                    "geometry": {"type": "MultiPolygon", "coordinates": polys}})
    with open(os.path.join(SITE, "countries.json"), "w") as fh:
        json.dump({"type": "FeatureCollection", "features": out}, fh, separators=(",", ":"), ensure_ascii=False)
    missing = have - {f["properties"]["id"] for f in out}
    assert not missing, f"no outline for {missing}"
    print(f"{len(out)} countries, {sum(f['properties']['has'] for f in out)} with a record, {os.path.getsize(os.path.join(SITE, 'countries.json')) // 1024} KB")


if __name__ == "__main__":
    main()
