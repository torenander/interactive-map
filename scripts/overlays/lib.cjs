// Shared helpers for the overlay converters (scripts/fetch-overlays.sh).
//
// Build-time only: nothing here ships to the browser. These run under a throwaway
// node_modules the fetch script installs, so they are CommonJS and reach their
// dependencies through NODE_PATH.

// Greater London, the same bbox scripts/fetch-tiles.sh extracts the basemap for. An
// overlay covering more ground than the basemap would be bytes nobody can look at.
const LONDON_BBOX = { west: -0.510375, south: 51.28676, east: 0.334015, north: 51.691874 }

/** Five decimal places is ~1 m at London's latitude — finer than any of these sources
 *  claims, and it roughly halves the file compared with raw output. */
const COORD_DECIMALS = 5

function roundCoord([lng, lat]) {
  return [+lng.toFixed(COORD_DECIMALS), +lat.toFixed(COORD_DECIMALS)]
}

function roundRings(rings) {
  return rings.map((ring) => ring.map(roundCoord))
}

/** True when any coordinate of `rings` falls inside the bbox. Cheaper than clipping,
 *  and clipping is the wrong tool: a park half outside the bbox should stay whole
 *  rather than gain a straight edge the real park does not have. */
function ringsIntersectBbox(rings, bbox = LONDON_BBOX) {
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng >= bbox.west && lng <= bbox.east && lat >= bbox.south && lat <= bbox.north) {
        return true
      }
    }
  }
  return false
}

function pointInBbox([lng, lat], bbox = LONDON_BBOX) {
  return lng >= bbox.west && lng <= bbox.east && lat >= bbox.south && lat <= bbox.north
}

/** Planar ring area in square metres. Only valid on projected coordinates — call it on
 *  British National Grid eastings/northings, before any reprojection. */
function planarArea(ring) {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return Math.abs(sum) / 2
}

/** EPSG:27700 (British National Grid) -> EPSG:4326. The Airy 1830 ellipsoid and the
 *  standard OSGB36 Helmert parameters, as published; proj4 does the arithmetic rather
 *  than this repo hand-rolling a datum shift. */
function bngToWgs84Transformer() {
  const proj4 = require('proj4')
  proj4.defs(
    'EPSG:27700',
    '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 ' +
      '+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 ' +
      '+units=m +no_defs',
  )
  return (easting, northing) => proj4('EPSG:27700', 'EPSG:4326', [easting, northing])
}

/**
 * Ramer-Douglas-Peucker on a ring, with the tolerance given in degrees of longitude at
 * London's latitude so a single number means roughly the same distance in x and y.
 *
 * The sources here are grids and contours built at ~10 m; carrying every vertex of a
 * dissolved contour is bytes without information. The DEFRA road-noise extract went from
 * 28 MB to a few MB on this alone, because a handful of enormous polygons (the largest
 * had 158,216 coordinates) accounted for most of the file.
 */
function simplifyRing(ring, toleranceDeg) {
  if (ring.length <= 4) return ring

  // Rings are closed; simplify the open path and close it again, so the ring cannot be
  // left unclosed by a dropped last point.
  const open = ring.slice(0, -1)
  const keep = new Uint8Array(open.length)
  keep[0] = 1
  keep[open.length - 1] = 1

  // Latitude compression: a degree of latitude is ~1.6x a degree of longitude here, so
  // scale y to keep the tolerance isotropic on the ground.
  const LAT_SCALE = 1.6
  const stack = [[0, open.length - 1]]

  while (stack.length > 0) {
    const [first, last] = stack.pop()
    let index = -1
    let maxDistance = toleranceDeg

    const [x1, y1] = open[first]
    const [x2, y2] = open[last]
    const dx = x2 - x1
    const dy = (y2 - y1) * LAT_SCALE
    const lengthSquared = dx * dx + dy * dy

    for (let i = first + 1; i < last; i++) {
      const [x0, y0] = open[i]
      const px = x0 - x1
      const py = (y0 - y1) * LAT_SCALE
      // Perpendicular distance to the segment, or to its start if it has no length.
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared))
      const distance = Math.hypot(px - t * dx, py - t * dy)
      if (distance > maxDistance) {
        index = i
        maxDistance = distance
      }
    }

    if (index !== -1) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }

  const simplified = []
  for (let i = 0; i < open.length; i++) if (keep[i]) simplified.push(open[i])
  simplified.push(simplified[0])

  // A ring needs three distinct corners to enclose anything; below that, keep the
  // original rather than emit a degenerate polygon.
  return simplified.length >= 4 ? simplified : ring
}

function simplifyRings(rings, toleranceDeg) {
  return rings
    .map((ring) => simplifyRing(ring, toleranceDeg))
    .filter((ring) => ring.length >= 4)
}

// Metres per degree at London's latitude. Good enough to size and filter features; not
// used for anything a reader measures.
const M_PER_DEG_LNG = 69300
const M_PER_DEG_LAT = 111320

/** Approximate outer-ring area in square metres, from WGS84 degrees. */
function approxAreaM2(rings) {
  const ring = rings[0]
  if (!ring || ring.length < 4) return 0
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return (Math.abs(sum) / 2) * M_PER_DEG_LNG * M_PER_DEG_LAT
}

function featureCollection(features) {
  return { type: 'FeatureCollection', features }
}

module.exports = {
  COORD_DECIMALS,
  approxAreaM2,
  simplifyRing,
  simplifyRings,
  LONDON_BBOX,
  bngToWgs84Transformer,
  featureCollection,
  planarArea,
  pointInBbox,
  ringsIntersectBbox,
  roundCoord,
  roundRings,
}
