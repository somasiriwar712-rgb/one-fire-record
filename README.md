# One Fire Record

A fire globe and a 25-year fire record for a country, on one page that works on a phone.

NASA has counted fires from space since 2000, first with MODIS and since 2012 with VIIRS. VIIRS sees smaller fires, so it counts 3 to 8 times more for the same burning. Put the two records side by side and the old years look calm. I joined them into one monthly record per country, tested the join, and put this year's fires on a satellite map.

**Open it:** https://somasiriwar712-rgb.github.io/one-fire-record/

**Slides:** https://somasiriwar712-rgb.github.io/one-fire-record/slides/ ([PDF](https://somasiriwar712-rgb.github.io/one-fire-record/slides/one-fire-record-slides.pdf))

Made for the NASA Space Apps Challenge 2026 (challenge "Harmonization of MODIS and VIIRS Hot Spots", Kandy local event).

## What it does

- **Is this month normal?** One sentence for the newest month, against the same month in every earlier year. Also in Sinhala and Tamil.
- **This season so far:** every fire year as a running total, counted from the place's quietest month, with what the next three months usually bring.
- **The record:** fire detections per month from November 2000 to October 2026, all counted the way VIIRS counts. Old months are estimates and show their likely range.
- **Burning calendar:** years down, months across. Switch between the joined record, MODIS as counted and VIIRS as counted.
- **Which months burn, which years were worst.**
- **Fire globe:** every place where NASA's NOAA-20 satellite saw fire this year, on a 3D globe with a sharp satellite picture. A glow from space, every satellite pixel up close; tap a fire for its date, tap a gold country to open it.
- **When it burns** and **unusual now:** map squares coloured by their peak month, or by how the newest month compares with earlier years.
- **The seam:** one real fire seen by MODIS and VIIRS on the same afternoon, every pixel at its true size.
- **Your own area:** zoom the map to a district and every chart redraws for it. The link keeps the place, area and view, so it can be sent on.
- **Downloads and a feed:** the monthly record (CSV), this year's fires (CSV, opens in QGIS or Excel), the map as a picture (PNG), and an RSS feed per place.
- **Updates itself:** a weekly GitHub Action fetches the newest months and republishes.

Places so far: Sri Lanka, Nepal, Thailand, Kenya, Greece, Portugal, Chile and Argentina. The scripts work for any country.

## How the two records are joined

1. Keep vegetation fires only (type 0) and drop low-confidence detections, the same way for both sensors.
2. On 2012 to 2021, when both flew and before the Terra and Aqua orbits drifted, count how many VIIRS detections there are for each MODIS one, separately for each calendar month. The gap moves with the fire season.
3. Multiply the MODIS-only months by those factors (Terra-only factors before July 2002, when Aqua joined). From February 2012 the record is Suomi NPP VIIRS itself. From January 2026 it is NOAA-20, scaled on the years both VIIRS satellites flew (Suomi NPP had gaps in mid-2026 and stopped on 2 November 2026).
4. Test it: hide one shared year at a time, rebuild it from MODIS alone, and compare with what VIIRS really saw. On a hidden month the average miss is 8 to 19% with monthly factors and 9 to 27% with one fixed factor, across the 8 countries. Each country's numbers are on its page.

## The weekly update

`.github/workflows/update.yml` runs every Monday: it downloads the yearly files (kept between runs), fetches this year's months through the FIRMS API, rebuilds, runs the tests and republishes. It needs one repository secret, `FIRMS_MAP_KEY`.

## Run it yourself

Python 3 (standard library only) and any static web server.

```bash
cd pipeline
./fetch-country.sh Sri_Lanka            # NASA FIRMS yearly country files, no login
python3 fetch-recent.py Sri_Lanka       # this year's months; needs a free FIRMS MAP_KEY and the Natural Earth borders (see the file)
python3 harmonize.py Sri_Lanka          # writes site/data/ and site/feed/, and prints the test of the join
python3 seam.py Sri_Lanka               # the seam picture: one fire both sensors saw
python3 outlines.py                     # country outlines for the globe
cd ../site && python3 -m http.server 4180
```

Country names are written as in the FIRMS file names, with underscores for spaces.

## Tests

```bash
python3 -m unittest discover tests      # the join, the borders, the date ranges and every data file
node tests/browser-check.mjs            # every place at phone and PC size, every switch, no errors (needs Chromium and the page on port 4180)
node tools/speed.mjs http://localhost:4180/   # load speed as a phone on slow 4G sees it
```

## Data and credit

We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS).

- Fire detections: NASA FIRMS, MODIS Collection 6.1 and VIIRS 375 m (Suomi NPP, NOAA-20). The newest three months are near-real-time data and are marked provisional.
- Maps: Sentinel-2 cloudless 2020 by EOX (https://s2maps.eu, contains modified Copernicus Sentinel data), place names © OpenStreetMap contributors.
- Country borders and outlines: Natural Earth (public domain).
- Map library: MapLibre GL JS 5.24.1.

This is not a NASA product and NASA does not endorse it.

## AI use

I built this with help from an AI assistant (Claude, by Anthropic) for the code and the text. I chose the challenge and the goal, made the decisions, and tested the page. The data files in `site/data/` and `site/feed/` come from that code and NASA data. No AI-made images, video or audio are used.
