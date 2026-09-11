// DEFRA road-noise contours (Lden, England Round 3) -> GeoJSON polygons.
//
// Usage: node road-noise.cjs > out.geojson
//
// Fetched through DEFRA's OGC API - Features endpoint with a bbox, not from the
// whole-England download: the bulk file is a national grid of ~10 m polygons, and the
// bbox query returns the same data already in WGS84, for London only, in pages.
//
// Only the loudest bands are kept. Lden runs from 55 dB up; the quiet end covers most of
// the city and would make a map that is entirely shaded, which tells a reader nothing.
// 70 dB and above is where road noise starts ruling a street out, which is the question
// this overlay exists to answer.

const {
  LONDON_BBOX,
  approxAreaM2,
  featureCollection,
  roundRings,
  simplifyRings,
} = require('./lib.cjs')

const COLLECTION =
  'https://environment.data.gov.uk/spatialdata/road-noise-lden-england-round-3/ogc/features/v1' +
  '/collections/Road_Noise_Lden_England_Round_3/items'

// Lden runs from 55 dB up. These two bands are the ones a street gets ruled out over;
// the quiet end covers most of the city and would shade the whole map.
//
// Counts over the Greater London bbox, measured against the live endpoint on
// 2026-09-11: >=75.0 is 14,242 polygons, 70.0-74.9 is 20,813, and 65.0-69.9 alone is
// 61,203 — which is why the cut is at 70 and not lower.
const LOUD_BANDS = ['>=75.0', '70.0-74.9']
const PAGE_SIZE = 1000

// Simplification tolerance (~17 m at this latitude) and the floor under which a polygon
// is dropped. Both are measured choices, not guesses — on the 2026-09-11 extract of the
// two loud bands:
//
//   raw                                        28.1 MB   35,055 polygons
//   ~11 m tolerance                            17.5 MB   35,055
//   ~17 m tolerance                             8.6 MB   35,055
//   ~17 m tolerance, fragments under 200 m2      4.9 MB   15,957
//
// Past ~17 m the return collapses (~35 m only reaches 8.2 MB), and 200 m2 is about two
// pixels at the zoom this app opens at, so what is dropped is a fragment nobody can see
// on a phone. The contours themselves — the long dissolved bands along main roads, one
// of which carried 158,216 coordinates raw — are all kept.
const SIMPLIFY_TOLERANCE_DEG = 0.00025
const MIN_AREA_M2 = 200

// The band filter runs server side (OGC API - Features part 3, CQL2). Filtering here
// instead would mean pulling all 265,248 London polygons to keep 35,055 of them.
//
// Paging follows the response's own `next` link rather than a parameter of our choosing.
// This endpoint ignores `offset` silently — asking for offset=0 and offset=5 returns the
// identical five features — and pages on `startIndex` instead, which its `next` link
// supplies. An offset-based loop therefore re-read page one forever: it had pulled
// 582,000 "features" from a 14,242-feature band before it was killed. Following the link
// is both correct per the spec and immune to the next server that names it differently.
function firstUrl(band) {
  const filter = encodeURIComponent(`noiseclass='${band}'`)
  return (
    `${COLLECTION}?f=application%2Fgeo%2Bjson` +
    `&bbox=${LONDON_BBOX.west},${LONDON_BBOX.south},${LONDON_BBOX.east},${LONDON_BBOX.north}` +
    `&filter-lang=cql2-text&filter=${filter}` +
    `&limit=${PAGE_SIZE}`
  )
}

async function fetchPage(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`DEFRA features ${res.status}: ${await res.text()}`)
  return res.json()
}

function nextLink(page) {
  return page.links?.find((link) => link.rel === 'next')?.href
}

async function main() {
  const features = []

  for (const band of LOUD_BANDS) {
    let url = firstUrl(band)
    let expected = null
    // `fetched` is what the server handed over and is what the completeness check below
    // compares; `kept` is what survived the area filter and is only for the log line.
    let fetched = 0
    let kept = 0
    const seen = new Set()

    while (url) {
      if (seen.has(url)) {
        throw new Error(`DEFRA features: next link repeated (${url}) — paging is not advancing`)
      }
      seen.add(url)

      const page = await fetchPage(url)
      const batch = page.features ?? []
      if (expected === null && typeof page.numberMatched === 'number') {
        expected = page.numberMatched
      }
      if (batch.length === 0) break
      fetched += batch.length

      for (const feature of batch) {
        const geometry = feature.geometry
        if (!geometry) continue
        const shrink = (rings) =>
          roundRings(simplifyRings(rings, SIMPLIFY_TOLERANCE_DEG))
        const coordinates =
          geometry.type === 'Polygon'
            ? shrink(geometry.coordinates)
            : geometry.coordinates.map(shrink).filter((rings) => rings.length > 0)
        if (coordinates.length === 0) continue
        const polygons = geometry.type === 'Polygon' ? [coordinates] : coordinates
        if (polygons.reduce((sum, rings) => sum + approxAreaM2(rings), 0) < MIN_AREA_M2) continue

        features.push({
          type: 'Feature',
          geometry:
            geometry.type === 'Polygon'
              ? { type: 'Polygon', coordinates }
              : { type: 'MultiPolygon', coordinates },
          properties: { band },
        })
        kept++
      }

      process.stderr.write(
        `road-noise: ${band} ${fetched}/${expected ?? '?'} fetched, ${kept} kept\n`,
      )
      if (expected !== null && fetched >= expected) break
      url = nextLink(page)
    }

    // Paging completeness, not filter output: every row the server said it had must have
    // been read, even though only some of them are kept.
    if (expected !== null && fetched !== expected) {
      throw new Error(
        `road-noise: ${band} read ${fetched} of the ${expected} rows the server reported`,
      )
    }
  }

  process.stderr.write(`road-noise: ${features.length} polygons at 70 dB or louder\n`)
  process.stdout.write(JSON.stringify(featureCollection(features)))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
