// TfL rail-network stops -> GeoJSON points.
//
// Usage: node tfl-stops.cjs <stoppoints.json>... > public/overlays/tfl-stops.geojson
//
// Input is the TfL Unified API's /StopPoint/Mode/{modes} response, which returns a flat
// list mixing stations with their entrances, platforms and access areas. Only the
// station-level rows carry the position a reader wants on a map — one dot per station,
// not five per station — so anything that is not a *Station is dropped.
//
// Bus stops are deliberately not fetched: ~19,000 of them would bury the network shape
// this overlay exists to show, and the file would be an order of magnitude larger.

const fs = require('node:fs')
const { featureCollection, pointInBbox, roundCoord } = require('./lib.cjs')

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: tfl-stops.cjs <stoppoints.json>...')
  process.exit(2)
}

const byId = new Map()

for (const file of files) {
  const body = JSON.parse(fs.readFileSync(file, 'utf8'))
  const stopPoints = body.stopPoints ?? body
  for (const stop of stopPoints) {
    if (typeof stop.lat !== 'number' || typeof stop.lon !== 'number') continue
    if (!/Station$/.test(stop.stopType ?? '')) continue

    const coordinates = roundCoord([stop.lon, stop.lat])
    if (!pointInBbox(coordinates)) continue

    // A station served by several modes appears once per mode request; merge the modes
    // rather than letting the last file win, so an interchange reads as one.
    const existing = byId.get(stop.naptanId)
    const modes = new Set([...(existing?.properties.modes ?? []), ...(stop.modes ?? [])])

    byId.set(stop.naptanId, {
      type: 'Feature',
      geometry: { type: 'Point', coordinates },
      properties: {
        name: stop.commonName,
        modes: [...modes].sort(),
      },
    })
  }
}

const features = [...byId.values()].sort((a, b) =>
  a.properties.name.localeCompare(b.properties.name),
)
process.stderr.write(`tfl-stops: ${features.length} stations\n`)
process.stdout.write(JSON.stringify(featureCollection(features)))
