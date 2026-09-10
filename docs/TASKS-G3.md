# G3 — MVP loop — task breakdown

Owned by teammate working G3. Goal: draw a polygon, rate it, comment on it, save it,
see it on reload, edit it, delete it. Exit criteria: `docs/OBJECTIVES.md` § G3.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after watching
the commands run).

> Tasks 2-7 stay `[~]` needs review: this file's legend (and G1's own note) reserves
> `[x]` for work a human has looked at. Each task's own checks were run and passed.

---

## [x] Task 1 — Environment and dependencies

- [x] Create `.env` from `.env.example` (gitignored, matches local stack's fixed anon key — verified against `supabase status -o env`)
- [x] `npm install terra-draw terra-draw-maplibre-gl-adapter` (peer deps: `maplibre-gl >=4`, satisfied by installed v6)
- [x] Verify local Supabase stack up and migrated (`npx supabase status`)

## [~] Task 2 — Auth gate

**Files:** `src/auth/useSession.ts`, `src/auth/SignIn.tsx`, `src/App.tsx`

- [x] `useSession()` hook wrapping `supabase.auth.getSession()` + `onAuthStateChange`
- [x] `SignIn` component: email/password form calling `signInWithEmail` from `src/db/client.ts`
- [x] **Deviation from the original plan:** `App.tsx` does not gate the whole app behind
      sign-in. `MapShell` always mounts — `tests/e2e/map-shell.spec.ts` (out of scope to
      touch) exercises canvas/attribution/geolocate with no session at all, so a
      full-screen blocking gate would break it. Sign-in is a small top-right pill
      (`data-testid="open-sign-in"`) that opens `SignIn` as an overlay on top of the map;
      `MapShell` reacts to session changes itself (loads areas when signed in, clears them
      on sign-out, and `handleSave` short-circuits with an inline message if you try to
      save while signed out instead of firing a doomed request)

## [~] Task 3 — Reading areas back as GeoJSON without a WKB parser

**Files:** `src/db/client.ts`

- [x] Verified empirically (`geomcheck.mjs`, discarded) that PostgREST returns `geography`
      columns as WKB hex by default, but a request with `Accept: application/geo+json`
      against the `areas` table returns a proper `FeatureCollection` with real GeoJSON
      geometry — no client-side WKB parsing dependency needed.
- [x] `fetchAreas()`: raw `fetch` against `${SUPABASE_URL}/rest/v1/areas` with that header,
      authenticated with the current session's access token, `order=created_at.asc` (newest
      last, so it paints last per SPEC's "most recent on top")
- [x] `deleteArea(id)`: direct `supabase.from('areas').delete().eq('id', id)` — the one
      direct write per CLAUDE.md invariant (FK cascade removes cells)

## [~] Task 4 — Rating color and modal UI

**Files:** `src/areas/color.ts`, `src/areas/RatingModal.tsx`, `tests/unit/areas.test.ts`

- [x] `colorForRating(rating)` pure function + `ratingFillColorExpression()` MapLibre
      `step` expression built on the same thresholds
- [x] Unit test for `colorForRating` (TESTING.md: anything touching `src/areas` needs a test)
- [x] `RatingModal`: bottom sheet, thumb-reachable, rating buttons (-1/0/+1), comment
      textarea, Save, dismiss via backdrop tap or explicit close button (does not delete
      any pending geometry), Delete button in edit mode

## [~] Task 5 — Drawing + save/load/edit/delete wired into MapShell

**Files:** `src/map/MapShell.tsx`

- [x] Terra Draw instance with `TerraDrawMapLibreGLAdapter`, `TerraDrawPolygonMode`,
      `undoRedo.modeLevel` enabled (needed for vertex undo — off by default)
- [x] "Draw" button (bottom, thumb reach) starts polygon mode; "Undo point" button visible
      while drawing, calls `draw.undo()`
- [x] `finish` event -> pending feature -> rating modal (create mode). Dismissing without
      saving keeps the drawn geometry (Terra Draw store untouched, only modal visibility
      toggles) and shows a small persistent "Rate & save" pill to reopen it
- [x] Saved areas rendered as a GeoJSON source + fill/line layers, `fill-opacity` 0.35,
      color by rating, ordered so newest paints last
- [x] Tap a saved polygon -> same modal, edit mode, prefilled
- [x] Save (create or edit) calls `saveArea()` from `src/db/client.ts` and only updates
      local state / closes the modal after the server call resolves — never before
- [x] Delete calls `deleteArea()`, removes locally and from the source
- [x] "Undo last save" control deletes the most recently saved area in this session

## [~] Task 6 — e2e: mvp-loop.spec.ts

**Files:** `tests/e2e/mvp-loop.spec.ts`

- [x] Creates a fresh confirmed user via the admin API (uuid email), signs in through the
      app's UI, tears down the user and any areas it created in `afterAll`
- [x] Draws a polygon via taps on the canvas, finishes with the Enter key (Terra Draw's
      default `finish` key binding), asserts the rating modal appears
- [x] Submits a rating + comment, asserts the polygon renders with fill
- [x] Reloads, asserts the polygon is still there
- [x] Opens it, changes the rating, reloads, asserts the new rating persisted (color changed)
- [x] Deletes it, reloads, asserts it is gone

## [~] Task 7 — Close out

- [x] `npm run build`
- [x] `npm run test -- tests/unit/`
- [x] `npm run test:e2e -- tests/e2e/mvp-loop.spec.ts`
- [x] `npm run test:e2e -- tests/e2e/map-shell.spec.ts` (regression)
- [x] Report exit codes and deviations to the lead. Do not mark the goal done in
      `docs/OBJECTIVES.md` / `docs/TASKS.md`.
