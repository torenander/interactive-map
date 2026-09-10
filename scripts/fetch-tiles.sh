#!/usr/bin/env bash
# Rebuild the London basemap extract.
# Usage: scripts/fetch-tiles.sh [YYYYMMDD]
# Defaults to the most recent available Protomaps daily build.
set -euo pipefail

BBOX="-0.510375,51.28676,0.334015,51.691874"   # Greater London
OUT="public/tiles/london.pmtiles"
MAXZOOM=15

pick_build() {
  if [ $# -gt 0 ]; then echo "$1"; return; fi
  for i in $(seq 1 10); do
    d=$(date -u -v-"${i}"d +%Y%m%d 2>/dev/null || date -u -d "${i} days ago" +%Y%m%d)
    if curl -sfI --max-time 10 "https://build.protomaps.com/${d}.pmtiles" >/dev/null; then
      echo "$d"; return
    fi
  done
  echo "no reachable Protomaps daily build in the last 10 days" >&2
  exit 1
}

BUILD=$(pick_build "$@")
echo "Extracting Greater London from build ${BUILD}"

mkdir -p "$(dirname "$OUT")"
pmtiles extract "https://build.protomaps.com/${BUILD}.pmtiles" "$OUT" \
  --bbox="$BBOX" \
  --maxzoom="$MAXZOOM"

pmtiles show "$OUT"
