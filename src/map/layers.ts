// Source and layer ids for everything this app adds to the MapLibre style, and the one
// ordering rule between them.
//
// These live here rather than in MapShell because two modules now depend on the order:
// MapShell adds the layers, and src/map/overlays.ts has to know which layer an overlay
// must sit *below*. Two copies of a layer id in two files is a rename away from an
// overlay silently drawing on top of the user's areas.

export const SAVED_AREAS_SOURCE = 'saved-areas'
export const SAVED_AREAS_FILL_LAYER = 'saved-areas-fill'
export const SAVED_AREAS_LINE_LAYER = 'saved-areas-line'

export const BRUSH_SOURCE = 'brush-selection'
export const BRUSH_FILL_LAYER = 'brush-selection-fill'
export const BRUSH_LINE_LAYER = 'brush-selection-line'

export const SAVED_FEATURES_SOURCE = 'saved-features'
export const SAVED_FEATURES_LINE_LAYER = 'saved-features-line'
export const SAVED_FEATURES_CIRCLE_LAYER = 'saved-features-circle'

/**
 * Everything that draws the user's own work: rated areas, painted selection, points and
 * lines. Reference data goes underneath all of it (docs/OBJECTIVES.md § G10 —
 * "reference data never obscures annotations").
 */
export const ANNOTATION_LAYER_IDS = [
  SAVED_AREAS_FILL_LAYER,
  SAVED_AREAS_LINE_LAYER,
  BRUSH_FILL_LAYER,
  BRUSH_LINE_LAYER,
  SAVED_FEATURES_LINE_LAYER,
  SAVED_FEATURES_CIRCLE_LAYER,
] as const

/**
 * Overlay layers are inserted before this one, which is the first annotation layer
 * MapShell adds. MapLibre draws in list order, so "before the first annotation layer"
 * puts an overlay above the basemap and below every annotation at once.
 */
export const OVERLAY_INSERT_BEFORE = SAVED_AREAS_FILL_LAYER
