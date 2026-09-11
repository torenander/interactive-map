// Open-data reference overlays (docs/OBJECTIVES.md § G10).
//
// Read-only context under the user's own annotations: where the stations are, where the
// green space is, which streets are loud. Nothing here is editable and nothing here is
// rated — it exists to inform the ratings, not to be one.
//
// Every overlay is a static file on this app's own origin, written by
// scripts/fetch-overlays.sh at build time. The app makes no request to TfL, Ordnance
// Survey or DEFRA at runtime: no third-party host in the request path, nothing keyed,
// nothing metered, and no billing that can run away — the same posture
// docs/ARCHITECTURE.md takes for the basemap, and the reason the goal's done_when greps
// src/ for those hostnames.
//
// This module is the whole registry: ids, labels, file paths, layer definitions and
// attribution. MapShell reads it and knows nothing else about any particular overlay,
// so adding a fourth is an entry here plus a fetch step.

import type { LayerSpecification } from 'maplibre-gl'
import { OVERLAY_INSERT_BEFORE } from './layers'

export type OverlayId = 'tfl-stops' | 'greenspace' | 'road-noise'

export type Overlay = {
  readonly id: OverlayId
  /** What the toggle says. Carries the extent or threshold when the data is filtered,
   *  so the sheet never implies more coverage than the file has. */
  readonly label: string
  /** Path on this origin, under public/. Never an absolute URL. */
  readonly source: string
  /** Attribution required by the source's licence. Rendered on the map while the
   *  overlay is on, beside the OpenStreetMap attribution, which is always there. */
  readonly attribution: string
  /** Layers to add, in order, all below the annotation layers. `source` is filled in by
   *  MapShell; the id of each layer is `${overlay.id}-${suffix}`. */
  readonly layers: readonly OverlayLayer[]
}

export type OverlayLayer = {
  readonly suffix: string
  readonly spec: Omit<LayerSpecification, 'id' | 'source'>
}

/**
 * Every overlay, off by default.
 *
 * Default-off is deliberate rather than a placeholder: three overlays on at once is an
 * unreadable map, and a first run should show the user's own areas over a plain basemap.
 */
export const OVERLAYS: readonly Overlay[] = [
  {
    id: 'tfl-stops',
    label: 'Stations and stops',
    source: '/overlays/tfl-stops.geojson',
    attribution: 'Powered by TfL Open Data',
    layers: [
      {
        suffix: 'circle',
        spec: {
          type: 'circle',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5, 17, 8],
            'circle-color': '#1d4ed8',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1,
            'circle-opacity': 0.9,
          },
        },
      },
    ],
  },
  {
    id: 'greenspace',
    label: 'Green space',
    source: '/overlays/greenspace.geojson',
    attribution: 'Contains OS data © Crown copyright and database right 2026',
    layers: [
      {
        suffix: 'fill',
        spec: {
          type: 'fill',
          paint: { 'fill-color': '#16a34a', 'fill-opacity': 0.25 },
        },
      },
      {
        suffix: 'line',
        spec: {
          type: 'line',
          paint: { 'line-color': '#15803d', 'line-width': 0.6, 'line-opacity': 0.7 },
        },
      },
    ],
  },
  {
    id: 'road-noise',
    // The label carries the threshold because the file does: only the two loudest Lden
    // bands are extracted. Saying "road noise" flat would imply the quiet bands are in
    // it and that an unshaded street has been measured as quiet.
    label: 'Road noise, 70 dB+',
    source: '/overlays/road-noise.geojson',
    attribution:
      'Contains public sector information licensed under the Open Government Licence v3.0 (Defra)',
    layers: [
      {
        suffix: 'fill',
        spec: {
          type: 'fill',
          paint: {
            // Two bands, two shades: the loudest reads as the more urgent of the two.
            'fill-color': ['match', ['get', 'band'], '>=75.0', '#b91c1c', '#f97316'],
            'fill-opacity': 0.35,
          },
        },
      },
    ],
  },
]

export function overlayById(id: OverlayId): Overlay | undefined {
  return OVERLAYS.find((overlay) => overlay.id === id)
}

/** One GeoJSON source per overlay, named after it. */
export function overlaySourceId(overlay: Overlay): string {
  return `overlay-${overlay.id}`
}

export type OverlayLayerPlan = {
  readonly layerId: string
  readonly sourceId: string
  /** The layer to insert before — always the first annotation layer, so reference data
   *  lands above the basemap and below everything the user drew. */
  readonly beforeId: string
  readonly spec: Omit<LayerSpecification, 'id' | 'source'>
}

/**
 * What MapShell has to add for one overlay, in order. Kept here rather than in the
 * component so the ordering rule is one exported fact that a test can check, instead of
 * an argument buried in an addLayer call.
 */
export function overlayAddPlan(overlay: Overlay): OverlayLayerPlan[] {
  return overlay.layers.map((layer) => ({
    layerId: overlayLayerId(overlay, layer),
    sourceId: overlaySourceId(overlay),
    beforeId: OVERLAY_INSERT_BEFORE,
    spec: layer.spec,
  }))
}

export function overlayLayerId(overlay: Overlay, layer: OverlayLayer): string {
  return `${overlay.id}-${layer.suffix}`
}

/** Every layer id an overlay contributes, in the order it adds them. */
export function overlayLayerIds(overlay: Overlay): string[] {
  return overlay.layers.map((layer) => overlayLayerId(overlay, layer))
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'areamap:overlays'

/**
 * Which overlays were on last time. localStorage rather than IndexedDB: this is a couple
 * of ids, not geometry, and it has to be readable synchronously on first render so the
 * map is not built with the wrong layers and corrected a tick later.
 *
 * Anything unrecognised in storage is dropped rather than trusted — an id that no longer
 * exists in the registry would otherwise try to add a layer against a missing source.
 */
export function loadEnabledOverlays(storage: Pick<Storage, 'getItem'> | undefined): OverlayId[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return OVERLAYS.filter((overlay) => parsed.includes(overlay.id)).map((overlay) => overlay.id)
  } catch {
    // Corrupt or unavailable storage means "no overlays", never a crash on first paint.
    return []
  }
}

export function saveEnabledOverlays(
  storage: Pick<Storage, 'setItem'> | undefined,
  enabled: readonly OverlayId[],
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...enabled]))
  } catch {
    // A full or blocked storage must not break toggling; the choice just will not stick.
  }
}
