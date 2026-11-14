# One Fire Record

NASA's MODIS (2000 on) and VIIRS (2012 on) active fire detections, joined into one tested monthly record per place and shown as a burning calendar. Built for the NASA Space Apps Challenge 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots", Kandy local event.

**Open it:** https://somasiriwar712-rgb.github.io/one-fire-record/ (works on a phone, no login)

**Slides:** https://somasiriwar712-rgb.github.io/one-fire-record/slides/ ([PDF](https://somasiriwar712-rgb.github.io/one-fire-record/slides/one-fire-record-slides.pdf))

- The page: `site/` (or open `site/index.html` through any static web server).
- The slides: `site/slides/` (HTML and PDF).
- The data pipeline: `pipeline/`.

## Run the pipeline

```bash
cd pipeline
./fetch-country.sh Sri_Lanka            # FIRMS yearly country files, no login, about 1 to 500 MB per country
python3 fetch-recent.py Sri_Lanka       # optional: this year's NOAA-20 months through the FIRMS API (needs a free MAP_KEY in resources/data/firms-key.txt)
python3 harmonize.py Sri_Lanka          # writes site/data/Sri_Lanka.json and prints the test of the join
```

Country names are spelled as in the FIRMS file names, with underscores for spaces. Python 3 standard library only.

## How the join works

1. Vegetation fires only (type 0), no low-confidence detections, for both sensors.
2. On 2012 to 2021, when both flew and before the Terra and Aqua orbits drifted, measure VIIRS detections per MODIS detection for each calendar month.
3. Scale MODIS-only months by those factors (Terra-only factors before July 2002). From February 2012 the record is Suomi NPP VIIRS, then NOAA-20 scaled on their shared years.
4. Test: hide one shared year at a time, rebuild it from MODIS, compare with VIIRS. The results are in each `site/data/<Country>.json` under `test`, and on the page.

## Data and credit

We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS).

Map background: NASA GIBS Blue Marble. Map library: Leaflet 1.9.4. This project is not a NASA product and NASA does not endorse it.

## AI use

The code, the method and the text in this repository were written with an AI assistant (Claude, by Anthropic), directed and reviewed by the team. The data files in `site/data/` are produced by that code from NASA data. No AI-generated images, video or audio are used.
