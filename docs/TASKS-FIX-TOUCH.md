# Touch-interaction fixes — session log

Scope: `src/areas/RatingModal.tsx`, `src/map/MapShell.tsx`, `tests/e2e/touch-draw.spec.ts`.
Ran in the main checkout (not a worktree) alongside two other concurrent fix agents on
disjoint files; used `PREVIEW_PORT=4873` for all e2e/preview runs per the lead's brief.

## Bug 1 (critical): rating modal dismissed by WebKit ghost click on draw-finish

**Mechanism chosen: `event.timeStamp` comparison against mount time, with a small
epsilon, in preference to a fixed post-mount time window.**

`RatingModal` now records `performance.now()` in a ref on mount. The backdrop's
`onClick` handler ignores any event whose `event.timeStamp` is earlier than
`mountTime + 50ms`. Click events (including WebKit's synthesized compatibility click
following a touch) carry the originating gesture's timestamp, not the dispatch time —
so a click carrying the timestamp of the tap that *finished the polygon* (and therefore
predates the modal's mount) is recognized as a leftover of that gesture, not a genuine
tap on the settled backdrop, and is dropped. The 50ms epsilon absorbs the gap between
the originating touch's timestamp and the ref being set a tick later in the same task;
it does not add a perceptible dismiss delay for real user taps (which land well after
mount). The reasoning and the WebKit race are documented inline in
`src/areas/RatingModal.tsx`.

The `timeStamp` approach was validated empirically (see red-run proof below) rather
than assumed — the fixed-window fallback the brief allowed for was not needed.

Normal dismiss (backdrop tap after the modal has settled) is unaffected: verified by
the second half of the new test (tap dismisses, recovery pill appears).

### Proof the new test fails pre-fix

`git stash push -- src/areas/RatingModal.tsx src/map/MapShell.tsx` to put back the
pre-fix component code, keeping the new test in place, then:

```
PREVIEW_PORT=4873 npm run test:e2e -- tests/e2e/touch-draw.spec.ts
```

Red, as expected — the modal is gone before the first assertion even gets to run
(dismissed within the WebKit ghost-click race, not by anything the test itself does):

```
1) [mobile] › touch-draw.spec.ts:72:1 › finishing a polygon by tapping its first vertex ...
   Error: expect(locator).toBeVisible() failed
   Locator: getByTestId('rating-modal')
   Expected: visible
   Timeout: 5000ms
   Error: element(s) not found
   1 failed
```

`git stash pop` restored the fix; the same command then passed (1 passed).

## Bug 2 (moderate): tap targets under 44px

- `reopen-pending` pill: was `px-4 py-2` (~36px tall). Now `min-h-11` (44px) with
  `flex items-center justify-center`, unchanged horizontal padding/position.
- `delete-area` button (`RatingModal.tsx`): was `py-2` (~36px tall). Same treatment.

Neither moved out of the bottom-third band — only their own height grew.

## Bug 3 (low): draw-controls wrapper not safe-area-aware

The wrapper (`start-drawing` / `undo-vertex` / `reopen-pending`) used Tailwind's fixed
`bottom-24` (6rem, no notch awareness). Replaced with an inline
`style={{ bottom: "calc(env(safe-area-inset-bottom) + 6rem)" }}`, matching the pattern
`RatingModal`'s bottom sheet already uses for its own safe-area padding. On
non-notched devices `env(safe-area-inset-bottom)` is `0`, so this resolves to the same
`6rem` `bottom-24` gave — no visual change there.

## Gates (all green, no retries needed — `npx supabase status` checked healthy before
each e2e run)

| Gate | Exit |
|---|---|
| `npm run build` | 0 |
| `PREVIEW_PORT=4873 npm run test:e2e -- tests/e2e/touch-draw.spec.ts` | 0 (1 passed) |
| `PREVIEW_PORT=4873 npm run test:e2e -- tests/e2e/map-shell.spec.ts` | 0 (7 passed) |
| `PREVIEW_PORT=4873 npm run test:e2e -- tests/e2e/offline.spec.ts` | 0 (1 passed) |

## Deviations

- Skipped the auto-worktree personal default: the brief explicitly assigned this
  session to the main checkout, coordinated with two concurrent agents editing
  disjoint files there — a worktree would have isolated this work from that design.
- `package.json`, `package-lock.json`, `src/db/types.ts`, `supabase/functions/save-area/index.ts`,
  `supabase/migrations/000{5,6}_*.sql`, `smoke.tmp.mjs`, `tests/unit/save-area.test.ts`
  appeared modified/untracked during this session from a concurrent agent's work —
  left untouched and not committed here, per the file-scope boundary in the brief.
