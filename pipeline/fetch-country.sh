#!/usr/bin/env bash
# Download NASA FIRMS yearly fire files for one country (standard-processing data, no login).
# Usage: ./fetch-country.sh Sri_Lanka        (name as in the FIRMS file names, underscores for spaces)
# Files land in ../../resources/data/firms/<sensor>/ (kept out of git). Safe to re-run: finished files are skipped.
set -u
country="${1:?country name, e.g. Sri_Lanka}"
mkdir -p "$(dirname "$0")/../../resources/data"   # a fresh machine (the weekly GitHub run) has no data folder yet
out="$(cd "$(dirname "$0")/../../resources/data" && pwd)/firms"
base="https://firms.modaps.eosdis.nasa.gov/data/country"
last_year=$(( $(date +%Y) - 1 ))   # last year's file; this year comes from fetch-recent.py. A year NASA has not published yet is a 404 and is tried again next run
fail=0
fetch() { # sensor first_year
  mkdir -p "$out/$1"
  for y in $(seq "$2" "$last_year"); do
    f="$out/$1/${1}_${y}_${country}.csv"
    [ -s "$f" ] && continue
    # a country with no fires that year has no file (404): that is not an error
    code=$(curl -sS --retry 5 --retry-delay 3 -m 600 -o "$f.part" -w '%{http_code}' "$base/$1/$y/${1}_${y}_${country}.csv") || code=000
    if [ "$code" = 200 ]; then mv "$f.part" "$f"; else rm -f "$f.part"; [ "$code" = 404 ] || { echo "FAILED $1 $y (http $code)"; fail=1; }; fi
  done
}
fetch modis 2000
fetch viirs-snpp 2012
fetch viirs-jpss1 2018
echo "$country: $(ls "$out"/*/*_[0-9][0-9][0-9][0-9]_"$country".csv 2>/dev/null | wc -l) files, $(cat "$out"/*/*_[0-9][0-9][0-9][0-9]_"$country".csv 2>/dev/null | wc -c) bytes"
exit $fail
