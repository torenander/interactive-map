// Brush painting of H3 cells (docs/OBJECTIVES.md § G8).
//
// Painting accumulates res-10 H3 cells while a finger is down, and on release the cell
// set is converted to a single polygon that goes to `save-area` exactly like a drawn one.
// The polygon stays the source of truth: the server rederives `area_cells` from it, so
// the cells this module computes are for display and conversion only and are never
// written to the database — see docs/ARCHITECTURE.md § "Geometry model" and the client
// write-path rule in CLAUDE.md.
//
// This is the pure core, kept out of the component so it can be tested without a map,
// the same split src/map/snapping.ts uses for G6. It holds no MapLibre, Terra Draw or
// React types; the caller feeds it pointer positions in lat/lng and renders whatever
// `selectionCells` returns.
//
// Two refusals are deliberate and live here rather than at save time:
//
// 1. A selection whose cells form more than one outer ring is rejected. Repairing it
//    would mean union or clipping, which docs/ARCHITECTURE.md § "No geometry union"
//    refuses. A hole inside a single outer ring is kept as a hole, not filled in — same
//    reason.
// 2. A session stops accepting cells at 5,000, the ceiling `save-area` enforces
//    (docs/DATA-MODEL.md § Migration 0002). Refusing while painting tells the user
//    immediately, instead of failing a save they already believe succeeded.

import { cellsToMultiPolygon, gridDisk, latLngToCell } from "h3-js"

/** Resolution `save-area` derives cells at. Painting at any other resolution would
 *  index differently from the server, so it is fixed, not configurable. */
export const BRUSH_RESOLUTION = 10

/** Ceiling `save-area` rejects a polygon above (~75 km² of res-10 cells). */
export const MAX_SELECTION_CELLS = 5000

export type BrushMode = "paint" | "erase"

/** Brush width in grid rings: 1 cell, a k=1 disk (7), or a k=2 disk (19). */
export type BrushSize = 1 | 2 | 3

/**
 * One pointer stroke — down, moves, up. `added` and `removed` record what the stroke
 * actually changed, which is what makes undo exact rather than approximate: undoing a
 * paint stroke that re-touched existing cells must not remove those cells.
 */
export type BrushStroke = {
  readonly mode: BrushMode
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export type BrushSelection = {
  readonly cells: ReadonlySet<string>
  /** Closed strokes, oldest first. Undo pops the last one. */
  readonly strokes: readonly BrushStroke[]
  /** The stroke in progress, or `null` between strokes. */
  readonly current: BrushStroke | null
  /** True when the last extend was refused by `MAX_SELECTION_CELLS`. Cleared when the
   *  next stroke opens, so the UI can show a message for the stroke that hit the cap. */
  readonly refusedAtCap: boolean
}

export type PolygonResult =
  | { ok: true; polygon: { type: "Polygon"; coordinates: number[][][] } }
  | { ok: false; reason: "empty" | "disconnected" }

export function emptySelection(): BrushSelection {
  return { cells: new Set(), strokes: [], current: null, refusedAtCap: false }
}

/** The cells a stamp of `size` covers at `lat`/`lng`. */
export function stampCells(lat: number, lng: number, size: BrushSize): string[] {
  return gridDisk(latLngToCell(lat, lng, BRUSH_RESOLUTION), size - 1)
}

/** Insertion order is not meaningful — conversion and rendering both treat the cells as
 *  a set — but a stable array is easier to assert on and to diff for a map source. */
export function selectionCells(selection: BrushSelection): string[] {
  return [...selection.cells]
}

export function isAtCapacity(selection: BrushSelection): boolean {
  return selection.cells.size >= MAX_SELECTION_CELLS
}

/** Pointer-down: open a stroke in `mode`. */
export function beginStroke(selection: BrushSelection, mode: BrushMode): BrushSelection {
  return {
    ...selection,
    current: { mode, added: [], removed: [] },
    refusedAtCap: false,
  }
}

/**
 * Pointer-move (and the pointer-down position itself): stamp at `lat`/`lng`.
 *
 * Called for every move event rather than once per frame — throttling here would drop
 * cells a finger genuinely crossed, which is the one thing a brush must not do.
 *
 * A paint stamp that would take the selection past `MAX_SELECTION_CELLS` is refused
 * whole. Filling part of a stamp would leave a ragged edge that depends on which pixel
 * the pointer happened to report, so the cap bites at stamp granularity.
 */
export function extendStroke(
  selection: BrushSelection,
  lat: number,
  lng: number,
  size: BrushSize,
): BrushSelection {
  const current = selection.current
  if (!current) {
    throw new Error("extendStroke: no open stroke — call beginStroke on pointer-down")
  }

  const stamp = stampCells(lat, lng, size)

  if (current.mode === "erase") {
    const removed = stamp.filter((cell) => selection.cells.has(cell))
    if (removed.length === 0) return selection

    const cells = new Set(selection.cells)
    for (const cell of removed) cells.delete(cell)
    return {
      ...selection,
      cells,
      current: { ...current, removed: [...current.removed, ...removed] },
    }
  }

  const added = stamp.filter((cell) => !selection.cells.has(cell))
  if (added.length === 0) return selection

  if (selection.cells.size + added.length > MAX_SELECTION_CELLS) {
    return { ...selection, refusedAtCap: true }
  }

  const cells = new Set(selection.cells)
  for (const cell of added) cells.add(cell)
  return {
    ...selection,
    cells,
    current: { ...current, added: [...current.added, ...added] },
  }
}

/**
 * Pointer-up: close the open stroke.
 *
 * A stroke that changed nothing is dropped instead of pushed, so a stray tap on empty
 * map does not consume the user's next undo.
 */
export function endStroke(selection: BrushSelection): BrushSelection {
  const current = selection.current
  if (!current) return selection

  const changedNothing = current.added.length === 0 && current.removed.length === 0
  return {
    ...selection,
    strokes: changedNothing ? selection.strokes : [...selection.strokes, current],
    current: null,
  }
}

/** Undo the last closed stroke, restoring the cell set exactly as it was before it. */
export function undoStroke(selection: BrushSelection): BrushSelection {
  const last = selection.strokes[selection.strokes.length - 1]
  if (!last) return selection

  const cells = new Set(selection.cells)
  for (const cell of last.added) cells.delete(cell)
  for (const cell of last.removed) cells.add(cell)

  return {
    ...selection,
    cells,
    strokes: selection.strokes.slice(0, -1),
    // The cap was reached with more cells than remain now, so any refusal it caused no
    // longer describes the selection.
    refusedAtCap: false,
  }
}

/**
 * The polygon a selection saves as, or why it cannot save.
 *
 * `cellsToMultiPolygon` returns one entry per connected group, each entry an outer ring
 * followed by its holes. More than one entry means the paint is disconnected, which no
 * single `geography(Polygon, 4326)` row can hold: the user is asked to paint a connected
 * shape rather than having the gap silently bridged.
 */
export function selectionToPolygon(selection: BrushSelection): PolygonResult {
  const cells = selectionCells(selection)
  if (cells.length === 0) return { ok: false, reason: "empty" }

  const groups = cellsToMultiPolygon(cells, true)
  if (groups.length !== 1) return { ok: false, reason: "disconnected" }

  return { ok: true, polygon: { type: "Polygon", coordinates: groups[0] } }
}
