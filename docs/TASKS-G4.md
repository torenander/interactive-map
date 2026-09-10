# G4 — Offline writes — task breakdown

Goal: a save made with no connectivity is queued locally and flushed on reconnect.
Nothing lost, nothing reported saved before the server has it. Exit criteria:
`docs/OBJECTIVES.md` § G4.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after watching
the commands run — reserved for the lead per G1/G3 convention).

> Tasks 1-6 stay `[~]` needs review: each task's own checks were run and passed, but
> only the lead's independent verification earns `[x]`.

---

## [~] Task 1 — IndexedDB-backed queue module

**Files:** `src/offline/queue.ts`, `package.json` (dev dep)

- [x] `fake-indexeddb` as a devDependency — the queue is tested with `queue.test.ts`
      (vitest, Node environment, no browser). Real IndexedDB only exists in a browser;
      `fake-indexeddb/auto` polyfills the global so the same queue module code runs
      under test and in the app unchanged.
- [x] `enqueueWrite(entry)`, `listQueuedWrites()`, `removeQueuedWrite(id)` — each opens
      its own IndexedDB connection and closes it when done. No module-level connection
      cache, so "survives a reload" is actually testing durable storage, not an
      in-process variable.
- [x] Entry shape carries the client-generated uuid as `id` (same id that becomes
      `areas.id` on flush — DATA-MODEL's idempotent-upsert contract), `geom`, `rating`,
      `comment`, `queuedAt`.

## [~] Task 2 — Flush

**Files:** `src/offline/flush.ts`

- [x] `flushQueuedWrites(save)` — takes an injectable save function (so
      `queue.test.ts` can test flush behaviour without a network), tries each queued
      entry in turn, removes on success, leaves in the queue on failure. Returns which
      ids flushed and which failed.
- [x] No merge/conflict logic beyond last-write-wins on `updated_at` (server-side,
      already true of `save-area`'s upsert) — documented here, not built.

## [~] Task 3 — `tests/unit/queue.test.ts`

- [x] A queued entry survives a page reload (fresh dynamic import + `vi.resetModules()`
      as the closest unit-test proxy for a reload, backed by fake-indexeddb's
      process-lifetime store so it's real persistence, not a fixture)
- [x] Flushing the same entry twice produces one row, not two (fake save function backed
      by a `Map` standing in for the server's upsert-by-id; flush twice, assert the map
      has one entry)
- [x] A failed flush leaves the entry in the queue (fake save function that rejects)

## [~] Task 4 — Wire the queue into MapShell

**Files:** `src/map/MapShell.tsx`, `src/areas/color.ts`

- [x] `handleSave` tries `saveArea()` first; only on `FunctionsFetchError` (a genuine
      network failure, distinguished from `FunctionsHttpError`/validation errors, which
      still surface as real errors) does it fall back to `enqueueWrite` — never queues
      an error that isn't actually about connectivity
- [x] Queued (not-yet-synced) areas render distinctly: amber fill/line regardless of
      rating (`fillColorExpression()` in `color.ts`, layered over the existing
      rating-based `step` expression), separate from the synced-areas list so a later
      `fetchAreas()` doesn't wipe out not-yet-flushed items
- [x] A persistent banner (`data-testid="queued-banner"`) states the queued count and
      offers a manual `data-testid="flush-queue"` retry, in addition to auto-flush on the
      browser's `online` event — manual retry exists specifically so the e2e test has a
      deterministic trigger that doesn't depend on the browser firing `online` reliably
      under Playwright
- [x] Never render a queued save as "success" — the modal closes (consistent with the
      normal save UX) but only the amber styling + banner communicate state; no
      false-positive success indicator anywhere
- [x] Deletes are NOT queued offline (out of scope per the brief, which only asks for
      "drawing and saving" — a delete attempted offline surfaces as a normal error, same
      as any other failed direct write)

## [~] Task 5 — `tests/e2e/offline.spec.ts`

- [x] Verify which layer actually blocks the save request before trusting the test:
      `context.setOffline(true)` is known unreliable for localhost on WebKit (this
      project's mobile profile). Block via `page.route()` on the `functions/v1/save-area`
      URL (abort), and call `setOffline` too for `navigator.onLine`/the `online` event —
      comment in the test explaining which one is load-bearing.
- [x] With the network blocked: draw + save shows queued state (banner or the drawn
      polygon's `queued` property via `queryRenderedFeatures`), not a success state
- [x] Unroute + restore network, trigger flush (manual button, not reliant on the
      `online` event's timing), assert the area appears in the database **exactly once**
      via the admin client (row count, not the UI)
- [x] Fresh uuid-email test user, admin-API creation, teardown of user + areas in
      `afterAll`
- [x] **Deviation found while stabilizing the test:** the first version flaked ~50% of
      the time asserting exactly one queued feature via `queryRenderedFeatures`, even
      though the queue itself only ever held one entry. Root cause: MapLibre's
      `queryRenderedFeatures` does not dedupe its own results — a feature spanning more
      than one of the GeoJSON source's internal tiles is reported once per tile, and
      `promoteId` (added to the source in `MapShell.tsx`) only gives a stable id to
      dedupe *by*, it doesn't dedupe automatically. Fixed by deduping via a `Set` of ids
      in the test helper. Six clean repeats after the fix; zero failures.

## [~] Task 6 — Close out

- [x] `npm run test -- tests/unit/queue.test.ts`
- [x] `npm run test:e2e -- tests/e2e/offline.spec.ts`
- [x] `npm run test:e2e -- tests/e2e/map-shell.spec.ts` (regression)
- [x] `npm run test:e2e -- tests/e2e/mvp-loop.spec.ts` (regression)
- [x] Report exit codes and deviations. Do not mark the goal done in
      `docs/OBJECTIVES.md` / `docs/TASKS.md`.
