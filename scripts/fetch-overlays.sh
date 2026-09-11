#!/usr/bin/env bash
# Rebuild the open-data overlay extracts in public/overlays/.
#
# Usage: scripts/fetch-overlays.sh [tfl|greenspace|noise]...
#        scripts/fetch-overlays.sh            # all three
#
# Hand-run, like scripts/fetch-tiles.sh — these sources change on the order of years,
# and nothing in the build or the test suite fetches them. The app never talks to any of
# these hosts at runtime: it reads the files this script writes, from its own origin.
#
# Licences, all three open, all three attribution-required. The strings in
# src/map/overlays.ts are what renders on the map; keep them in step with these:
#   - TfL Unified API          Powered by TfL Open Data
#   - OS Open Greenspace       Contains OS data (c) Crown copyright and database right
#   - DEFRA road noise (Lden)  Contains public sector information licensed under the OGL
#
# Dependencies are installed into a throwaway directory rather than the project:
# proj4 (British National Grid -> WGS84 for the OS data) and shapefile (the OS download
# is only offered as Shapefile or GML). Neither belongs in package.json — they are not
# part of the app, and the app would ship them to nobody.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="public/overlays"
mkdir -p "$OUT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TOOLS="$WORK/tools"
install_tools() {
  mkdir -p "$TOOLS"
  ( cd "$TOOLS" && npm init -y >/dev/null 2>&1 && npm install --silent --no-fund --no-audit proj4@2 shapefile@0.6 )
  export NODE_PATH="$TOOLS/node_modules"
}

# TfL rail-network stations. Bus stops are deliberately excluded — see the converter.
fetch_tfl() {
  echo "--- TfL stops"
  local modes="tube,dlr,overground,elizabeth-line,tram"
  curl -sSf --max-time 180 "https://api.tfl.gov.uk/StopPoint/Mode/${modes}" -o "$WORK/tfl.json"
  node scripts/overlays/tfl-stops.cjs "$WORK/tfl.json" > "$OUT/tfl-stops.geojson"
}

# OS Open Greenspace, TQ national grid square — the 100 km square Greater London sits in.
fetch_greenspace() {
  echo "--- OS Open Greenspace (TQ)"
  install_tools
  curl -sSfL --max-time 600 \
    "https://api.os.uk/downloads/v1/products/OpenGreenspace/downloads?area=TQ&format=ESRI%C2%AE+Shapefile&redirect" \
    -o "$WORK/greenspace-tq.zip"
  unzip -o -q "$WORK/greenspace-tq.zip" -d "$WORK/greenspace"
  local shp
  shp="$(find "$WORK/greenspace" -name '*GreenspaceSite.shp' | head -1)"
  [ -n "$shp" ] || { echo "no GreenspaceSite.shp in the OS download" >&2; exit 1; }
  node scripts/overlays/greenspace.cjs "$shp" > "$OUT/greenspace.geojson"
}

# DEFRA road-noise contours, Lden, England Round 3 — loudest two bands, London bbox.
fetch_noise() {
  echo "--- DEFRA road noise (Lden, >=70 dB)"
  node scripts/overlays/road-noise.cjs > "$OUT/road-noise.geojson"
}

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then targets=(tfl greenspace noise); fi

for target in "${targets[@]}"; do
  case "$target" in
    tfl) fetch_tfl ;;
    greenspace) fetch_greenspace ;;
    noise) fetch_noise ;;
    *) echo "unknown target: $target (want tfl, greenspace or noise)" >&2; exit 2 ;;
  esac
done

echo "--- written"
ls -lh "$OUT"
echo
echo "Now run: node scripts/assert-overlays.mjs"
