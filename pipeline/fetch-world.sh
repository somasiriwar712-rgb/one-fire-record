#!/usr/bin/env bash
# The whole world: NASA FIRMS yearly "all countries" files (MODIS 2000-2025, VIIRS Suomi NPP 2012-2025, NOAA-20 2018-2025), about 10 GB zipped.
# Resumes where it stopped (power cuts). Raw files stay on this PC in resources/data/firms-world/ (ignored by git).
set -u
cd "$(dirname "$0")/../../resources/data/firms-world"
base=https://firms.modaps.eosdis.nasa.gov/data/country/zips
for s in modis:2000 viirs-snpp:2012 viirs-jpss1:2018; do
  sensor=${s%%:*}; first=${s##*:}
  for y in $(seq "$first" 2025); do
    f=${sensor}_${y}_all_countries.zip
    [ -f "$f" ] && { echo "have $f"; continue; }
    if curl -sSfL --retry 5 --retry-delay 5 -C - -o "$f.part" "$base/$f"; then mv "$f.part" "$f"; echo "got $f $(du -h "$f" | cut -f1)"; else echo "FAILED $f"; fi
  done
done
echo "done: $(du -sh . | cut -f1)"
