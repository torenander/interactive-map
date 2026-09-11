// Vertex snapping against saved areas — docs/OBJECTIVES.md § G6 ("a vertex dropped near
// an existing area's border stores a coordinate exactly equal to that border's
// coordinate"). The pixel maths is the part worth testing without a map; the wiring into
// Terra Draw's `snapping.toCustom` is covered by tests/e2e/draw-precision.spec.ts.
import { describe, expect, it } from "vitest";
import { nearestVertexWithin, type SnapTarget } from "../../src/map/snapping";

// A deliberately trivial projection: 100 container pixels per degree, y growing
// southward as screen pixels do. Exact, so expected distances are readable by hand.
const project = (lng: number, lat: number) => ({ x: lng * 100, y: -lat * 100 });

function square(west: number, south: number, size: number): SnapTarget {
  return {
    coordinates: [
      [
        [west, south],
        [west + size, south],
        [west + size, south + size],
        [west, south + size],
        [west, south], // closing coordinate, repeated
      ],
    ],
  };
}

describe("nearestVertexWithin", () => {
  it("returns the exact coordinate of a vertex inside the radius", () => {
    const target = square(0, 0, 1);
    // Cursor 5px away from the vertex at [1, 1] -> projected (100, -100).
    const snapped = nearestVertexWithin({ x: 103, y: -96 }, [target], project, 20);
    expect(snapped).toEqual([1, 1]);
  });

  it("returns undefined when every vertex is outside the radius", () => {
    const target = square(0, 0, 1);
    // Centre of the square: 50px from each of the four corners.
    expect(nearestVertexWithin({ x: 50, y: -50 }, [target], project, 20)).toBeUndefined();
  });

  it("picks the nearest vertex across several areas", () => {
    const near = square(2, 2, 1); // corner at [2, 2] -> (200, -200)
    const far = square(0, 0, 1);
    const snapped = nearestVertexWithin({ x: 202, y: -202 }, [far, near], project, 20);
    expect(snapped).toEqual([2, 2]);
  });

  it("keeps the first of two equidistant vertices, so results are stable", () => {
    const first = square(0, 0, 1);
    const second = square(0, 0, 1);
    // Exactly on the shared [1, 1] corner of both.
    expect(nearestVertexWithin({ x: 100, y: -100 }, [first, second], project, 20)).toEqual([1, 1]);
  });

  it("does not hand back a reference into the source geometry", () => {
    const target = square(0, 0, 1);
    const snapped = nearestVertexWithin({ x: 100, y: -100 }, [target], project, 20)!;
    snapped[0] = 999;
    // The ring still holds its own [1, 1]; Terra Draw mutating what it was given
    // must not reach back into the saved area it snapped to.
    expect(target.coordinates[0][2]).toEqual([1, 1]);
  });

  it("ignores empty targets rather than throwing", () => {
    expect(nearestVertexWithin({ x: 0, y: 0 }, [{ coordinates: [] }], project, 20)).toBeUndefined();
  });
});
