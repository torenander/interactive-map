// OS Open Greenspace (TQ national grid square) -> GeoJSON polygons.
//
// Usage: node greenspace.cjs <TQ_GreenspaceSite.shp> [minAreaM2] > out.geojson
//
// Two conversions happen here. The shapefile's coordinates are British National Grid
// (EPSG:27700, Airy 1830 / OSGB36 — see the .prj that ships with the download), so every
// ring is reprojected to WGS84 before MapLibre ever sees it. And the TQ square is bigger
// than Greater London, so sites with no coordinate inside the basemap's bbox are dropped.
//
// `minAreaM2` filters out the small stuff, measured on the projected coordinates where
// area is already in square metres. Default 5,000 m2 (about half a football pitch): the
// dataset is full of grass verges and estate lawns that add file size and tell a reader
// nothing about whether a neighbourhood is green.

const {
  bngToWgs84Transformer,
  featureCollection,
  planarArea,
  ringsIntersectBbox,
  roundRings,
} = require('./lib.cjs')

const [shpPath, minAreaArg] = process.argv.slice(2)
if (!shpPath) {
  console.error('usage: greenspace.cjs <TQ_GreenspaceSite.shp> [minAreaM2]')
  process.exit(2)
}
const minArea = minAreaArg === undefined ? 5000 : Number(minAreaArg)

const { open } = require('shapefile')
const toWgs84 = bngToWgs84Transformer()

function reproject(rings) {
  return rings.map((ring) => ring.map(([easting, northing]) => toWgs84(easting, northing)))
}

async function main() {
  const source = await open(shpPath, shpPath.replace(/\.shp$/, '.dbf'))
  const features = []
  let read = 0
  let tooSmall = 0
  let outside = 0

  for (let result = await source.read(); !result.done; result = await source.read()) {
    const feature = result.value
    const geometry = feature.geometry
    if (!geometry) continue
    read++

    // The dataset is polygons and multipolygons; treat both as a list of polygons so the
    // area filter applies per site, not per part.
    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates
          : []
    if (polygons.length === 0) continue

    // Outer rings only for the area test — a site is as big as its footprint.
    const area = polygons.reduce((sum, rings) => sum + planarArea(rings[0]), 0)
    if (area < minArea) {
      tooSmall++
      continue
    }

    const projected = polygons.map((rings) => roundRings(reproject(rings)))
    if (!projected.some((rings) => ringsIntersectBbox(rings))) {
      outside++
      continue
    }

    const properties = {
      // `function` is OS's own field name for what the site is: "Public Park Or Garden",
      // "Playing Field", "Allotments Or Community Growing Spaces", and so on.
      kind: feature.properties.function ?? null,
      name: feature.properties.distName1 ?? null,
    }

    features.push({
      type: 'Feature',
      geometry:
        projected.length === 1
          ? { type: 'Polygon', coordinates: projected[0] }
          : { type: 'MultiPolygon', coordinates: projected },
      properties,
    })
  }

  process.stderr.write(
    `greenspace: ${features.length} sites kept (${read} read, ${tooSmall} under ${minArea} m2, ${outside} outside London)\n`,
  )
  process.stdout.write(JSON.stringify(featureCollection(features)))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
