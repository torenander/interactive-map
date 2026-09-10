# Fix — non-blocking pmtiles service worker cache

Flagged in `docs/TASKS.md` § G5 as "Known trade-off, flagged": the original
`src/sw.ts` pmtiles route blocked the *first* range request for a cold cache
until the entire ~125MB `london.pmtiles` archive downloaded — invisible on
localhost, minutes of blank map on cellular in the field (the primary use
case). This fix removes the block without weakening the offline guarantee.

## Mechanism

`src/sw.ts`'s pmtiles route, revised:

- Warm cache (full file already stored under the plain URL): unchanged —
  every range request is answered instantly by slicing the cached full
  response via `workbox-range-requests`' `createPartialResponse`.
- Cold cache: the range request is now passed straight through to the
  network via `fetch(request)` — the exact pre-service-worker behaviour, so
  first paint is not delayed by caching at all. A separate,
  never-awaited `warmPmtilesCache()` call kicks off (or, via a
  `Map<url, Promise<void>>`, joins) one background `fetch()` of the whole
  file and `cache.put`s it. Concurrent cold range requests for the same URL
  trigger only one background download, not one each.
- On completion, the background fill broadcasts `{ type: 'tiles-cached',
  url }` to all window clients via `postMessage` — an observable completion
  signal instead of requiring pollers to guess.

This does not reintroduce the shared-`Response`-body bug documented in
`docs/TASKS-G5.md` (concurrent readers of one fetched body corrupting each
other, surfacing as spurious 416s): the background fill's fetched Response is
only ever read once, by `cache.put`, and is never handed to a request
handler; every range request that misses the cache gets its own independent
`fetch(request)` call with its own Response.

## Test: `tests/e2e/offline-map.spec.ts`

The existing "one warm load, then go offline" structure is unchanged in
shape, but the second (SW-controlled) reload's warm-up is now async relative
to painting, so the spec has to wait for it explicitly rather than relying on
the old blocking behaviour to have finished the download implicitly:

- Added `waitForTilesCached()`: races an already-populated `pmtiles-v1`
  cache against the `tiles-cached` postMessage, registering the message
  listener before checking the cache so there is no window where a
  fast-finishing background fetch's message could be missed. No sleep, no
  polling loop.
- The spec now records `Date.now()` right after the second reload's first
  paint and again right after `waitForTilesCached()` resolves, and asserts
  the cache genuinely finished *after* paint — direct evidence the fill runs
  in the background rather than gating the response. Verified running
  (`PREVIEW_PORT=4973 npx playwright test tests/e2e/offline-map.spec.ts
  --reporter=json`): the run's annotations array was empty, meaning the hard
  `expect(cachedAt).toBeGreaterThan(paintedAt)` path fired, not the
  informational fallback — on this repo's real ~125MB fixture file the gap
  was measurable, not flaky. The fallback (an `annotations.push(...)` note,
  no failing assertion) stays in place for slower/faster environments where
  the fill could finish at or before the paint instant.
- The offline assertion itself (`offlineCount` > 0 after the network is hard
  blocked) is untouched — only strengthened by the added wait, never
  weakened.

## Gates

- `npm run build` — exit 0.
- `PREVIEW_PORT=4973 npm run test:e2e -- tests/e2e/offline-map.spec.ts` — 1/1
  passed, ~7s wall clock (previously gated on a full 125MB download before
  the offline reload could even be attempted).
- `node scripts/assert-pwa.mjs 4973` — 10/10 passed, unedited (none of its
  checks touch the pmtiles route).
- `PREVIEW_PORT=4973 npm run test:e2e -- tests/e2e/map-shell.spec.ts` — 7/7
  passed (first-paint regression suite, unaffected).

## Scope

Files touched: `src/sw.ts`, `tests/e2e/offline-map.spec.ts`, this file, and
the "Known trade-off" paragraph in `docs/TASKS.md` § G5. No changes to
`src/map/MapShell.tsx` or any file outside this ownership boundary were
needed — the readiness signal is entirely a service-worker-to-page
`postMessage`, not a hook into map component state.
