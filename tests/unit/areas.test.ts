// Rating -> color mapping used to paint saved areas on the map. docs/TESTING.md requires
// a test on anything touching src/areas.
import { describe, expect, it } from "vitest";
import { colorForRating, ratingFillColorExpression } from "../../src/areas/color";

describe("colorForRating", () => {
  it("maps -1 to red", () => {
    expect(colorForRating(-1)).toBe("#ef4444");
  });

  it("maps 0 to grey", () => {
    expect(colorForRating(0)).toBe("#9ca3af");
  });

  it("maps +1 to green", () => {
    expect(colorForRating(1)).toBe("#22c55e");
  });

  it("buckets ratings outside the MVP UI range the same way", () => {
    expect(colorForRating(-2)).toBe(colorForRating(-1));
    expect(colorForRating(2)).toBe(colorForRating(1));
  });
});

describe("ratingFillColorExpression", () => {
  it("is a step expression with thresholds at 0 and 1", () => {
    const expr = ratingFillColorExpression();
    expect(expr).toEqual([
      "step",
      ["get", "rating"],
      "#ef4444",
      0,
      "#9ca3af",
      1,
      "#22c55e",
    ]);
  });
});
