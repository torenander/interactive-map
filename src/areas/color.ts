// Color-by-rating for saved area polygons. The MVP UI only emits -1, 0, 1 (CLAUDE.md),
// but the DB check constraint allows -2..2, so both helpers treat "negative", "zero",
// "positive" as the three buckets rather than switching on exact values.
import type { ExpressionSpecification } from "maplibre-gl";

const NEGATIVE = "#ef4444"; // red
const NEUTRAL = "#9ca3af"; // grey
const POSITIVE = "#22c55e"; // green
const QUEUED = "#f59e0b"; // amber — queued locally, not yet confirmed by the server

export function colorForRating(rating: number): string {
  if (rating < 0) return NEGATIVE;
  if (rating > 0) return POSITIVE;
  return NEUTRAL;
}

// MapLibre `step` expression form of the same thresholds, for the saved-areas fill layer.
export function ratingFillColorExpression(): ExpressionSpecification {
  return ["step", ["get", "rating"], NEGATIVE, 0, NEUTRAL, 1, POSITIVE] as ExpressionSpecification;
}

// Layers "queued" (docs/DATA-MODEL.md § Client-side write queue: the UI must show
// queued state explicitly, never render a save as complete before the server has it)
// over the rating color, regardless of what rating was picked.
export function fillColorExpression(): ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "queued"], true],
    QUEUED,
    ratingFillColorExpression(),
  ] as ExpressionSpecification;
}
