"""Tests for the data scripts and the files they write.

Run from build/:  python3 -m unittest discover tests
Standard library only. The checks on real data files skip themselves when those files are missing.
"""
import glob
import importlib.util
import json
import os
import unittest
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "site", "data")


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "..", "pipeline", file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hz = load("harmonize", "harmonize.py")
fr = load("fetch_recent", "fetch-recent.py")


class Rounding(unittest.TestCase):
    def test_half_up_matches_javascript_round(self):
        self.assertEqual([hz.half_up(v) for v in (0.5, 1.5, 2.5, 2.4999)], [1, 2, 3, 2])


class Months(unittest.TestCase):
    def test_month_range_crosses_years(self):
        self.assertEqual(list(hz.month_range("2011-11", "2012-02")), ["2011-11", "2011-12", "2012-01", "2012-02"])

    def test_month_range_single(self):
        self.assertEqual(list(hz.month_range("2020-05", "2020-05")), ["2020-05"])


class Keep(unittest.TestCase):
    def test_modis_confidence_and_type(self):
        self.assertTrue(hz.keep({"type": "0", "confidence": "30"}, "modis"))
        self.assertFalse(hz.keep({"type": "0", "confidence": "29"}, "modis"))
        self.assertFalse(hz.keep({"type": "2", "confidence": "90"}, "modis"))

    def test_viirs_confidence(self):
        self.assertTrue(hz.keep({"type": "0", "confidence": "n"}, "snpp"))
        self.assertTrue(hz.keep({"type": "0", "confidence": "h"}, "n20"))
        self.assertFalse(hz.keep({"type": "0", "confidence": "l"}, "n20"))

    def test_near_real_time_rows_have_no_type(self):
        self.assertTrue(hz.keep({"confidence": "n"}, "n20"))
        self.assertTrue(hz.keep({"type": "", "confidence": "n"}, "n20"))


class Fit(unittest.TestCase):
    def test_constant_ratio_is_found(self):
        pairs = [(f"{y}-{m:02d}", 10 + m, 3 * (10 + m)) for y in range(2012, 2022) for m in range(1, 13)]
        base, by_month = hz.fit(pairs)
        self.assertAlmostEqual(base, 3.0)
        self.assertTrue(all(abs(f - 3.0) < 1e-9 for f in by_month.values()))

    def test_thin_month_is_pulled_to_the_all_year_factor(self):
        pairs = [(f"2015-{m:02d}", 100, 300) for m in range(1, 13)] + [("2016-06", 1, 30)]
        base, by_month = hz.fit(pairs)
        self.assertLess(abs(by_month[6] - base), abs(30 - base))   # one odd month cannot set June alone

    def test_no_modis_gives_nothing(self):
        self.assertEqual(hz.fit([("2015-01", 0, 5)]), (None, None))


class TestOfTheJoin(unittest.TestCase):
    def test_perfect_ratio_has_no_error(self):
        modis = {m: 20 for m in hz.month_range("2012-01", "2021-12")}
        viirs = {m: 60 for m in modis}
        t = hz.test_join(modis, viirs)
        self.assertEqual(t["monthly"]["month_err"], 0.0)
        self.assertEqual(t["fixed"]["year_err_mean"], 0.0)
        self.assertEqual(len(t["years"]), 10)


class Chunks(unittest.TestCase):
    def test_every_day_once_and_the_switch_to_near_real_time(self):
        sp_until, nrt_from = date(fr.YEAR, 3, 3), date(fr.YEAR - 1, 1, 1)
        spans = list(fr.chunks(sp_until, nrt_from))
        days = [d + timedelta(i) for _, d, n in spans for i in range(n)]
        last = date.today().replace(day=1) - timedelta(1)
        self.assertEqual(days, [date(fr.YEAR, 1, 1) + timedelta(i) for i in range((last - date(fr.YEAR, 1, 1)).days + 1)])
        self.assertTrue(all(n <= 5 for _, _, n in spans))
        for source, d, n in spans:   # no span mixes the two kinds of data
            self.assertEqual(source.endswith("SP"), d + timedelta(n - 1) <= sp_until)


@unittest.skipUnless(os.path.exists(fr.BORDERS), "Natural Earth borders not downloaded")
class Borders(unittest.TestCase):
    def test_capitals_and_neighbours(self):
        lanka, portugal = fr.border("Sri_Lanka"), fr.border("Portugal")
        self.assertTrue(lanka(79.86, 6.93))        # Colombo
        self.assertFalse(lanka(80.27, 13.08))      # Chennai, India
        self.assertTrue(portugal(-9.14, 38.72))    # Lisbon
        self.assertFalse(portugal(-3.70, 40.42))   # Madrid, Spain


PLACES = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(SITE, "*.json")) if not p.endswith(("index.json", ".fires.json")))


@unittest.skipUnless(PLACES, "no data files written yet")
class DataFiles(unittest.TestCase):
    def test_index_lists_every_place(self):
        with open(os.path.join(SITE, "index.json")) as fh:
            self.assertEqual(sorted(p["id"] for p in json.load(fh)), PLACES)

    def test_each_record_holds_together(self):
        for place in PLACES:
            with self.subTest(place=place), open(os.path.join(SITE, f"{place}.json")) as fh:
                d = json.load(fh)
                n = len(d["joined"])
                self.assertEqual({len(d[k]) for k in ("modis", "snpp", "n20", "joined", "lo", "hi", "src")}, {n})
                self.assertEqual(n, len(list(hz.month_range(d["first"], "2099-12"))[:n]))
                self.assertTrue(all(lo <= v <= hi for lo, v, hi in zip(d["lo"], d["joined"], d["hi"])))
                self.assertTrue(all(v >= 0 for v in d["joined"]))
                self.assertTrue(set(d["src"]) <= set("tmsn"))
                self.assertEqual(len(d["factor"]["by_month"]), 12)
                self.assertLess(d["test"]["monthly"]["month_err"], d["test"]["fixed"]["month_err"])   # the claim on the page

    def test_fire_dots_are_inside_the_record_and_the_year(self):
        for place in PLACES:
            path = os.path.join(SITE, f"{place}.fires.json")
            if not os.path.exists(path):
                continue
            with self.subTest(place=place), open(path) as fh:
                f = json.load(fh)
                pts, sc = f["pts"], f["scale"]
                self.assertEqual(len(pts) % 4, 0)
                self.assertTrue(all(1 <= pts[k] <= 366 for k in range(2, len(pts), 4)))
                self.assertTrue(all(pts[k] >= 1 for k in range(3, len(pts), 4)))
                with open(os.path.join(SITE, f"{place}.json")) as gh:
                    d = json.load(gh)
                cell = d["coarse_deg"]
                xs, ys = [g[0] for g in d["grid"]], [g[1] for g in d["grid"]]
                for k in range(0, len(pts), 4):   # every dot lies within the country's own fire grid
                    lat, lon = pts[k] / sc, pts[k + 1] / sc
                    self.assertTrue(min(ys) * cell - 0.01 <= lat <= (max(ys) + 1) * cell + 0.01, (lat, lon))
                    self.assertTrue(min(xs) * cell - 0.01 <= lon <= (max(xs) + 1) * cell + 0.01, (lat, lon))


if __name__ == "__main__":
    unittest.main()
