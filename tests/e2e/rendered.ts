import { expect, type Page } from '@playwright/test'

// Waiting for map features to actually be on screen before interacting with them.
//
// Clicking or hovering saved geometry goes through MapLibre's hit test: the
// layer-scoped handler in src/map/MapShell.tsx fires only when the hit test finds
// something, and a geojson source re-tiles asynchronously after setData. So the
// gap between "the server has the row" and "the shape is clickable" is real, and
// nothing in a save round trip closes it.
//
// When the click wins that race it hits nothing at all: no error, no failure
// signature, just an interaction that silently does not happen — a rating sheet
// that never opens. It is load-sensitive, so it passes every time on a quiet
// machine and appears as an unreproducible flake under a full suite.
// points-lines.spec.ts carries seven of these waits because that suite hit the
// race for real while it was being written; draw-precision.spec.ts and
// desktop.spec.ts had none until this module.

type MapHandle = {
  isStyleLoaded(): boolean
  getLayer(id: string): unknown
  queryRenderedFeatures(opts: { layers: string[] }): unknown[]
}

const win = () => (window as unknown as { __map?: MapHandle }).__map

/**
 * Blocks until `layerId` has at least `count` features rendered in the viewport.
 *
 * Deliberately queries the whole viewport with no geometry argument: restricting
 * the query to the point about to be clicked just moves the race earlier, since a
 * partially re-tiled source can answer for one pixel and not its neighbour.
 *
 * A missing layer is reported as a missing layer rather than waited out. Early in
 * a page's life queryRenderedFeatures throws rather than returning empty, and
 * swallowing that in a try/catch would turn "this layer does not exist" into an
 * indistinguishable timeout — which is how a genuine bug hides inside a flake.
 */
export async function waitForRenderedFeatures(
  page: Page,
  layerId: string,
  count = 1,
  timeout = 15_000,
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((id) => {
          const map = (window as unknown as { __map?: MapHandle }).__map
          return Boolean(map?.isStyleLoaded() && map.getLayer(id))
        }, layerId),
      { timeout: 10_000, message: `layer "${layerId}" never appeared on the map` },
    )
    .toBe(true)

  await expect
    .poll(
      async () =>
        page.evaluate(
          (id) => (window as unknown as { __map?: MapHandle }).__map!
            .queryRenderedFeatures({ layers: [id] }).length,
          layerId,
        ),
      { timeout, message: `layer "${layerId}" rendered no features` },
    )
    .toBeGreaterThanOrEqual(count)
}

/** The saved-areas fill: what a click on a saved area has to hit. */
export const SAVED_AREAS_FILL = 'saved-areas-fill'
