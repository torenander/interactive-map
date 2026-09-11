// Brush selection core — docs/OBJECTIVES.md § G8. Every assertion the goal's
// `brush.test.ts` contract names lives here, against the pure module with no map:
// stroke accumulation, dedupe, erase, stroke undo, single-outer-ring conversion and
// the 5,000-cell refusal. The MapShell wiring and the painted rendering are covered by
// tests/e2e/brush.spec.ts instead.
import { describe, expect, it } from "vitest";
import { cellsToMultiPolygon, gridDisk, latLngToCell } from "h3-js";
import {
  BRUSH_RESOLUTION,
  MAX_SELECTION_CELLS,
  beginStroke,
  emptySelection,
  endStroke,
  extendStroke,
  selectionCells,
  selectionToPolygon,
  stampCells,
  undoStroke,
} from "../../src/map/brush";

// Charing Cross, the geolocation fixture playwright.config.ts already uses.
const LAT = 51.5072;
const LNG = -0.1276;
// ~330 m apart in latitude: comfortably more than one res-10 cell (~130 m across), so
// each position lands in its own cell without relying on where the hex grid falls.
const STEP = 0.003;

const cellAt = (lat: number, lng: number) => latLngToCell(lat, lng, BRUSH_RESOLUTION);

/** Paint one stroke of size-1 stamps at each position, then close it. */
function paint(positions: Array<[number, number]>, size: 1 | 2 | 3 = 1) {
  let selection = beginStroke(emptySelection(), "paint");
  for (const [lat, lng] of positions) selection = extendStroke(selection, lat, lng, size);
  return endStroke(selection);
}

describe("stampCells", () => {
  it("size 1 is the single cell under the pointer", () => {
    expect(stampCells(LAT, LNG, 1)).toEqual([cellAt(LAT, LNG)]);
  });

  it("sizes 2 and 3 are the k=1 and k=2 grid disks around it", () => {
    const centre = cellAt(LAT, LNG);
    expect(stampCells(LAT, LNG, 2).sort()).toEqual(gridDisk(centre, 1).sort());
    expect(stampCells(LAT, LNG, 3).sort()).toEqual(gridDisk(centre, 2).sort());
    expect(stampCells(LAT, LNG, 2)).toHaveLength(7);
    expect(stampCells(LAT, LNG, 3)).toHaveLength(19);
  });

  it("resolves at resolution 10, the resolution save-area derives at", () => {
    expect(BRUSH_RESOLUTION).toBe(10);
  });
});

describe("stroke accumulation", () => {
  it("a three-position stroke yields all three cells", () => {
    const positions: Array<[number, number]> = [
      [LAT, LNG],
      [LAT + STEP, LNG],
      [LAT + 2 * STEP, LNG],
    ];
    const expected = positions.map(([lat, lng]) => cellAt(lat, lng));
    expect(new Set(expected).size).toBe(3); // the fixture really is three distinct cells

    const cells = selectionCells(paint(positions));
    expect(cells).toHaveLength(3);
    expect(new Set(cells)).toEqual(new Set(expected));
  });

  it("a cell added twice appears once", () => {
    const cells = selectionCells(
      paint([
        [LAT, LNG],
        [LAT, LNG],
        [LAT + 0.00001, LNG], // same cell, a pointer that barely moved
      ]),
    );
    expect(cells).toEqual([cellAt(LAT, LNG)]);
  });

  it("overlapping stamps from different sizes still dedupe", () => {
    let selection = beginStroke(emptySelection(), "paint");
    selection = extendStroke(selection, LAT, LNG, 3); // 19 cells
    selection = extendStroke(selection, LAT, LNG, 2); // 7 of the same 19
    expect(selectionCells(endStroke(selection))).toHaveLength(19);
  });

  it("accumulates across separate strokes", () => {
    let selection = paint([[LAT, LNG]]);
    selection = beginStroke(selection, "paint");
    selection = extendStroke(selection, LAT + STEP, LNG, 1);
    expect(selectionCells(endStroke(selection))).toHaveLength(2);
  });

  it("refuses to extend when no stroke is open", () => {
    expect(() => extendStroke(emptySelection(), LAT, LNG, 1)).toThrow(/no open stroke/i);
  });
});

describe("erase", () => {
  it("removes only the cells under the erase stroke", () => {
    const painted = paint([
      [LAT, LNG],
      [LAT + STEP, LNG],
      [LAT + 2 * STEP, LNG],
    ]);

    let selection = beginStroke(painted, "erase");
    selection = extendStroke(selection, LAT + STEP, LNG, 1);
    const cells = selectionCells(endStroke(selection));

    expect(new Set(cells)).toEqual(
      new Set([cellAt(LAT, LNG), cellAt(LAT + 2 * STEP, LNG)]),
    );
  });

  it("erasing where nothing is painted changes nothing", () => {
    const painted = paint([[LAT, LNG]]);
    let selection = beginStroke(painted, "erase");
    selection = extendStroke(selection, LAT + 10 * STEP, LNG, 1);
    expect(selectionCells(endStroke(selection))).toEqual([cellAt(LAT, LNG)]);
  });
});

describe("undo", () => {
  it("restores the selection to its exact pre-stroke set", () => {
    const first = paint([
      [LAT, LNG],
      [LAT + STEP, LNG],
    ]);
    const before = new Set(selectionCells(first));

    let selection = beginStroke(first, "paint");
    selection = extendStroke(selection, LAT + 2 * STEP, LNG, 3);
    selection = endStroke(selection);
    expect(selectionCells(selection).length).toBeGreaterThan(before.size);

    expect(new Set(selectionCells(undoStroke(selection)))).toEqual(before);
  });

  it("undoes one stroke, not the whole session", () => {
    let selection = paint([[LAT, LNG]]);
    selection = beginStroke(selection, "paint");
    selection = extendStroke(selection, LAT + STEP, LNG, 1);
    selection = endStroke(selection);

    expect(selectionCells(undoStroke(selection))).toEqual([cellAt(LAT, LNG)]);
  });

  it("puts back cells an erase stroke removed", () => {
    const painted = paint([
      [LAT, LNG],
      [LAT + STEP, LNG],
    ]);
    let selection = beginStroke(painted, "erase");
    selection = extendStroke(selection, LAT, LNG, 1);
    selection = endStroke(selection);
    expect(selectionCells(selection)).toHaveLength(1);

    expect(new Set(selectionCells(undoStroke(selection)))).toEqual(
      new Set(selectionCells(painted)),
    );
  });

  it("is a no-op with no strokes to undo", () => {
    const empty = emptySelection();
    expect(selectionCells(undoStroke(empty))).toEqual([]);
    const painted = paint([[LAT, LNG]]);
    expect(selectionCells(undoStroke(undoStroke(painted)))).toEqual([]);
  });

  it("does not spend an undo on a stroke that changed nothing", () => {
    const painted = paint([[LAT, LNG]]);
    // An erase stroke over empty map: closes without touching the cell set.
    let selection = beginStroke(painted, "erase");
    selection = extendStroke(selection, LAT + 10 * STEP, LNG, 1);
    selection = endStroke(selection);

    expect(selectionCells(undoStroke(selection))).toEqual([]);
  });
});

describe("capacity", () => {
  it("refuses painting past 5,000 cells and leaves the selection intact", () => {
    expect(MAX_SELECTION_CELLS).toBe(5000);

    let selection = beginStroke(emptySelection(), "paint");
    let refusedAt = -1;
    for (let i = 0; i < 80 && refusedAt < 0; i++) {
      for (let j = 0; j < 80; j++) {
        const next = extendStroke(selection, 51.4 + i * STEP, -0.2 + j * STEP, 1);
        if (next.refusedAtCap) {
          refusedAt = selectionCells(next).length;
          selection = next;
          break;
        }
        selection = next;
      }
    }

    // Size-1 stamps add one cell at a time, so the cap is hit exactly, not overshot.
    expect(refusedAt).toBe(MAX_SELECTION_CELLS);
    expect(selectionCells(selection)).toHaveLength(MAX_SELECTION_CELLS);
  });

  it("keeps refusing while at the cap, without losing cells", () => {
    let selection = beginStroke(emptySelection(), "paint");
    for (let i = 0; i < 80 && selectionCells(selection).length < MAX_SELECTION_CELLS; i++) {
      for (let j = 0; j < 80 && selectionCells(selection).length < MAX_SELECTION_CELLS; j++) {
        selection = extendStroke(selection, 51.4 + i * STEP, -0.2 + j * STEP, 1);
      }
    }
    expect(selectionCells(selection)).toHaveLength(MAX_SELECTION_CELLS);

    const after = extendStroke(selection, 51.7, -0.4, 3);
    expect(after.refusedAtCap).toBe(true);
    expect(selectionCells(after)).toHaveLength(MAX_SELECTION_CELLS);
  });

  it("refuses a whole stamp rather than filling part of it", () => {
    // A size-3 stamp is 19 cells; a selection with 18 slots left takes none of them.
    let selection = beginStroke(emptySelection(), "paint");
    const cells: string[] = [];
    for (let i = 0; i < 80 && cells.length < MAX_SELECTION_CELLS - 18; i++) {
      for (let j = 0; j < 80 && cells.length < MAX_SELECTION_CELLS - 18; j++) {
        selection = extendStroke(selection, 51.4 + i * STEP, -0.2 + j * STEP, 1);
        cells.push("");
      }
    }
    const filled = selectionCells(selection).length;
    expect(filled).toBe(MAX_SELECTION_CELLS - 18);

    const after = extendStroke(selection, 51.7, -0.4, 3);
    expect(after.refusedAtCap).toBe(true);
    expect(selectionCells(after)).toHaveLength(filled);
  });

  it("clears the refusal flag when the next stroke opens", () => {
    let selection = beginStroke(emptySelection(), "paint");
    for (let i = 0; i < 80 && selectionCells(selection).length < MAX_SELECTION_CELLS; i++) {
      for (let j = 0; j < 80 && selectionCells(selection).length < MAX_SELECTION_CELLS; j++) {
        selection = extendStroke(selection, 51.4 + i * STEP, -0.2 + j * STEP, 1);
      }
    }
    selection = extendStroke(selection, 51.7, -0.4, 1);
    expect(selection.refusedAtCap).toBe(true);

    expect(beginStroke(endStroke(selection), "erase").refusedAtCap).toBe(false);
  });
});

describe("selectionToPolygon", () => {
  it("converts a one-cell selection to a single-ring polygon", () => {
    const result = selectionToPolygon(paint([[LAT, LNG]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.polygon.type).toBe("Polygon");
    expect(result.polygon.coordinates).toHaveLength(1);
    const ring = result.polygon.coordinates[0];
    expect(ring).toEqual(cellsToMultiPolygon([cellAt(LAT, LNG)], true)[0][0]);
    // A closed hexagon: six corners plus the repeated first coordinate.
    expect(ring).toHaveLength(7);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // GeoJSON order, which is what save-area's polygonToCells expects.
    const [lng, lat] = ring[0];
    expect(lng).toBeCloseTo(LNG, 2);
    expect(lat).toBeCloseTo(LAT, 2);
  });

  it("converts a connected blob to one ring", () => {
    const result = selectionToPolygon(paint([[LAT, LNG]], 2));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.polygon.coordinates).toHaveLength(1);
    expect(result.polygon.coordinates[0]).toHaveLength(19);
  });

  it("rejects two disconnected clusters rather than yielding two rings", () => {
    const result = selectionToPolygon(
      paint([
        [LAT, LNG],
        [51.55, -0.05], // ~6 km away
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("disconnected");
  });

  it("rejects an empty selection", () => {
    const result = selectionToPolygon(emptySelection());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty");
  });

  it("keeps a hole rather than repairing it", () => {
    // A ring of six cells around an unpainted centre is one polygon with two rings.
    // docs/ARCHITECTURE.md § "No geometry union" forbids repairing that into a disc.
    let selection = beginStroke(emptySelection(), "paint");
    selection = extendStroke(selection, LAT, LNG, 2);
    selection = endStroke(selection);
    selection = beginStroke(selection, "erase");
    selection = extendStroke(selection, LAT, LNG, 1);
    selection = endStroke(selection);
    expect(selectionCells(selection)).toHaveLength(6);

    const result = selectionToPolygon(selection);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.polygon.coordinates).toHaveLength(2);
  });
});
