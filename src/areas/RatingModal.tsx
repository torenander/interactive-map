// Bottom sheet for rating + commenting on an area. SPEC.md § Field UX: dismissible with
// one thumb, and dismissing must not lose the drawn geometry — this component only ever
// reports "dismiss" up to MapShell, which decides what that means for the pending draw.
import { useState } from "react";

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

  return (
    <div className="fixed inset-0 z-40" data-testid="rating-modal">
      {/* Backdrop — tapping it dismisses without discarding the drawn geometry. */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="absolute inset-0 h-full w-full bg-black/30"
      />

      <div
        className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white p-4 shadow-lg"
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
            className="w-full rounded-lg py-2 text-sm font-medium text-red-600 disabled:opacity-50"
          >
            Delete area
          </button>
        )}
      </div>
    </div>
  );
}
