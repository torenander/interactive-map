// Bottom sheet for rating + commenting on an area. SPEC.md § Field UX: dismissible with
// one thumb, and dismissing must not lose the drawn geometry — this component only ever
// reports "dismiss" up to MapShell, which decides what that means for the pending draw.
import { useEffect, useRef, useState } from "react";

export type RatingModalMode = "create" | "edit";

type RatingModalProps = {
  mode: RatingModalMode;
  initialRating: number;
  initialComment: string;
  saving: boolean;
  error: string | null;
  onDismiss: () => void;
  onSave: (rating: number, comment: string) => void;
  onDelete?: () => void;
};

const RATING_OPTIONS: { value: -1 | 0 | 1; label: string }[] = [
  { value: -1, label: "Poor" },
  { value: 0, label: "Neutral" },
  { value: 1, label: "Good" },
];

export default function RatingModal({
  mode,
  initialRating,
  initialComment,
  saving,
  error,
  onDismiss,
  onSave,
  onDelete,
}: RatingModalProps) {
  const [rating, setRating] = useState(initialRating);
  const [comment, setComment] = useState(initialComment);

  // WebKit ghost-click guard (verified touch bug, field-blocking): finishing a polygon
  // by tapping its closing vertex fires touchstart/touchend, and this modal mounts
  // synchronously in Terra Draw's `finish` handler while that same tap is still
  // in flight. WebKit then synthesizes a trailing mouse/click event from that tap
  // a few ms later, and if it lands on the just-mounted backdrop it dismisses the
  // modal instantly — the user only sees a flash. Click events carry the
  // originating gesture's timestamp in `event.timeStamp` (not the dispatch time of
  // the synthesized click), so any click whose timeStamp predates this component's
  // mount must be a leftover from the gesture that opened the modal, not a real tap
  // on the backdrop after it settled — ignore it. A small epsilon absorbs mount
  // being captured a tick after the originating touch's timestamp. Genuine
  // backdrop taps (this ref is set once, on mount, and never moves) are always far
  // enough after mount that this never affects normal dismiss-preserves-geometry
  // behaviour.
  const mountTimeRef = useRef(performance.now());
  const GHOST_CLICK_EPSILON_MS = 50;

  // Desktop keyboard. Measured before this: Escape did nothing, focus stayed on the map
  // canvas when the sheet opened, and Tab reached the geolocate control and the
  // attribution link — both *behind* the sheet — before it reached anything inside it.
  // None of that mattered on touch, where there is no Tab and no Escape.
  const sheetRef = useRef<HTMLDivElement>(null);

  // Focus the sheet itself rather than its first control: landing on "Poor" makes it look
  // preselected, and a stray Space or Enter would then set a rating the user never chose.
  useEffect(() => {
    // `preventScroll` is load-bearing, not a nicety. Without it, focusing the sheet
    // scrolls it into view, which shifts the map canvas under the pointer — measured as
    // a regression in draw-precision.spec.ts on the desktop project, where a click aimed
    // at a saved area landed on empty map and the sheet never reopened.
    sheetRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (event.key !== "Tab") return;

      // Keep Tab inside the sheet. Without this, tabbing off the end lands on controls
      // the sheet is covering — reachable by keyboard, invisible to the eye, and able to
      // start a second drawing session underneath an open rating sheet.
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusable = Array.from(
        sheet.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;

      // Drive the whole cycle rather than only guarding its ends. Guarding the ends and
      // letting the browser handle the middle looks equivalent and is not: WebKit's
      // native Tab skips buttons entirely unless full keyboard access is enabled, so
      // focus escaped the sheet from the middle of the list, where no end-guard was
      // watching. Computing the next index and always preventing the default makes
      // containment independent of each engine's tabbing policy.
      event.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      const index = active ? focusable.indexOf(active) : -1;
      if (index === -1) {
        (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
        return;
      }
      const step = event.shiftKey ? -1 : 1;
      focusable[(index + step + focusable.length) % focusable.length].focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  function handleBackdropDismiss(event: { timeStamp: number }) {
    if (event.timeStamp < mountTimeRef.current + GHOST_CLICK_EPSILON_MS) return;
    onDismiss();
  }

  return (
    <div className="fixed inset-0 z-40" data-testid="rating-modal">
      {/* Backdrop — tapping it dismisses without discarding the drawn geometry. */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={handleBackdropDismiss}
        className="absolute inset-0 h-full w-full bg-black/30"
      />

      {/* Capped and centred rather than spanning the window: measured 1440 px wide at
          1440x900, which put a 1400 px Save button under a three-word label. max-w-sm is
          the overlay sheet's cap, so the two read as the same surface. */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "create" ? "Rate this area" : "Edit this area"}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-sm rounded-t-2xl bg-white p-4 shadow-lg outline-none"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-300" />

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            {mode === "create" ? "Rate this area" : "Edit this area"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onDismiss}
            className="rounded-full px-3 py-1 text-lg leading-none text-gray-500"
          >
            &times;
          </button>
        </div>

        <div className="mb-3 flex gap-2" role="group" aria-label="Rating">
          {RATING_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              data-testid={`rating-${opt.value}`}
              onClick={() => setRating(opt.value)}
              aria-pressed={rating === opt.value}
              className={
                "flex-1 rounded-xl border py-3 text-sm font-medium " +
                (rating === opt.value
                  ? "border-gray-900 bg-gray-900 text-white"
                  : "border-gray-300 bg-white text-gray-700")
              }
            >
              {opt.label}
            </button>
          ))}
        </div>

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Comment (optional)"
          rows={3}
          data-testid="comment-input"
          className="mb-3 w-full rounded-lg border border-gray-300 p-2 text-base"
        />

        {error && (
          <p role="alert" className="mb-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="button"
          data-testid="save-area"
          disabled={saving}
          onClick={() => onSave(rating, comment)}
          className="mb-2 w-full rounded-lg bg-gray-900 py-3 text-base font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>

        {mode === "edit" && onDelete && (
          <button
            type="button"
            data-testid="delete-area"
            disabled={saving}
            onClick={onDelete}
            // min-h-11 (44px): field-UX tap-target minimum (verified touch bug) —
            // was 36px tall. flex/items-center keeps the label centred at the new height.
            className="flex min-h-11 w-full items-center justify-center rounded-lg text-sm font-medium text-red-600 disabled:opacity-50"
          >
            Delete area
          </button>
        )}
      </div>
    </div>
  );
}
