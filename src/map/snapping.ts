// Vertex snapping against already-saved areas (docs/OBJECTIVES.md § G6).
//
// Terra Draw's built-in `snapping.toCoordinate` / `toLine` only see features in Terra
// Draw's own store, and saved areas do not live there — they are rendered from the
// `saved-areas` MapLibre GeoJSON source. `snapping.toCustom` exists for exactly this
// case: it hands the mode a function and uses whatever coordinate that function returns.
// This module is that function's pure core, kept out of the component so it can be
// tested without a map.
//
// Snapping is an *input* concern: it changes where a vertex is placed, and nothing else.
// No union, clipping or self-intersection repair happens here or anywhere downstream —
// see docs/ARCHITECTURE.md § "No geometry union". Two areas that share a border end up
// with coordinates that are equal, not merged.

export type ProjectToPixels = (lng: number, lat: number) => { x: number; y: number }

export type SnapTarget = { coordinates: number[][][] }

/**
 * The coordinate of the nearest vertex among `targets` to a cursor at `cursor`
 * (container pixels), or `undefined` if none is within `pixelDistance`.
 *
 * Returns a fresh array: Terra Draw takes ownership of the coordinate it is handed, and
 * handing it a reference into `targets` would let a later edit mutate the source area.
 */
export function nearestVertexWithin(
  cursor: { x: number; y: number },
  targets: SnapTarget[],
  project: ProjectToPixels,
  pixelDistance: number,
): [number, number] | undefined {
  let best: [number, number] | undefined
  let bestDistanceSquared = pixelDistance * pixelDistance

  for (const target of targets) {
    for (const ring of target.coordinates) {
      // A closed ring repeats its first coordinate as its last. Snapping to either is
      // the same point, so walking the duplicate would only waste a projection.
      const closed =
        ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
      const end = closed ? ring.length - 1 : ring.length

      for (let i = 0; i < end; i++) {
        const [lng, lat] = ring[i]
        const { x, y } = project(lng, lat)
        const dx = x - cursor.x
        const dy = y - cursor.y
        const distanceSquared = dx * dx + dy * dy
        // Strictly-less keeps the first of several equidistant vertices, so the result
        // is stable for a given input order rather than depending on iteration luck.
        if (distanceSquared < bestDistanceSquared) {
          bestDistanceSquared = distanceSquared
          best = [lng, lat]
        }
      }
    }
  }

  return best
}
