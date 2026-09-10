# G5 — Installable PWA with offline basemap — task breakdown

Goal: installable on iOS and Android, London basemap tiles served from cache, map
usable with no connectivity. Exit criteria: `docs/OBJECTIVES.md` § G5 (amended
2026-09-10 — Lighthouse's PWA category was removed in v12; `assert-pwa.mjs` is a
direct Playwright probe instead of a piped Lighthouse run).

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run). This file's own tasks stay `[~]`: reserved for a human
review pass, per G1/G3's convention in this repo.

Built in an isolated worktree (`worktree-agent-a5bc6b91a1d9bb1c1`), never on port
4173 — that belongs to the G4 teammate's concurrent work in the main checkout.
All dev/verification here runs on port 4273.

---

## Mechanism decision: vite-plugin-pwa, `injectManifest` strategy

`vite-plugin-pwa` (already named in `CLAUDE.md`'s stack list) over hand-rolled
Workbox wiring — it handles manifest injection, precache manifest generation, and
build-time asset hashing for free, and `injectManifest` mode still lets us hand
Workbox packages import into a real `src/sw.ts` for the pmtiles range logic below,
which `generateSW` mode cannot express cleanly (no `runtimeCaching` entry from
config gives a custom async handler with a "fetch full file, dedupe concurrent
fetches" shape).

## Mechanism decision: pmtiles range caching

Inspected `node_modules/pmtiles/dist/esm/index.js`: the `FetchSource` class issues
plain `fetch(url, { headers: { range: 'bytes=<start>-<end>' } })` calls — first a
16KB header read, then directory reads, then per-tile reads, each a distinct byte
range, with no single "give me the whole file" request from the library itself.

Chosen approach — **cache the full file on first range fetch, then serve every
subsequent range from that cached copy** (`src/sw.ts`):

- A route matches `*.pmtiles` requests.
- On a cache miss, the handler strips any incoming `Range` header and does a plain
  `fetch()` for the whole 125MB file once, storing the full 200 response under the
  URL (not the ranged request) as the cache key. Concurrent range requests that
  land before that fetch resolves share one in-flight promise (a module-level
  `Map`) instead of each starting their own 125MB download.
- Every request — including the one that triggered the fetch — is then answered by
  `workbox-range-requests`'s `createPartialResponse(request, fullCachedResponse)`,
  which slices the cached full response according to the incoming `Range` header
  and returns a proper `206`.

This means the *first* map load after install is slow (one 125MB download instead
of the ~tens-of-MB a bboxed session would normally touch), but it is the only
approach that makes "map usable with no connectivity" true rather than "the few
tiles you happened to pan across are usable" — and it is what "warm load once, then
go offline" in the `offline-map.spec.ts` exit criterion describes. Documented as
the explicit trade-off; not a silent behaviour change.

`london.pmtiles` itself is **not** in the precache manifest — see the amendment's
own reasoning restated in `docs/OBJECTIVES.md` § G5: precaching a 125MB file blows
typical browser storage quotas and fails silently. The runtime route above is the
only path that ever touches it.

### Bug found while verifying this against the real WebKit E2E project

A `Response` body can only be read once. The first version of
`getOrFetchFullPmtiles` deduped concurrent range requests onto one in-flight
`fetch()` promise and then handed **the same fetched `Response` object** to every
caller waiting on it. A tile-heavy warm load fires dozens of concurrent range
requests for the same URL; the first reader of that shared object succeeded and
every other concurrent reader failed trying to read an already-consumed body —
surfacing as a `416 Range Not Satisfiable`, because `workbox-range-requests`'
`createPartialResponse` swallows the read error into that status rather than
throwing. Fixed by having the in-flight promise resolve to a plain `boolean`
("the cache entry exists now") and having *every* caller — including the one that
triggered the fetch — get its own fresh `Response` via a separate `cache.match()`
call afterwards. Confirmed via a throwaway diagnostic Playwright script (not
committed) that logged every URL `src/sw.ts`'s pmtiles route handler actually saw,
in both Chromium and WebKit, before and after the fix.

### WebKit gap: Service Worker does not intercept dedicated-Worker script loads

Separately, and specific to this project's mobile E2E project (WebKit, per
`playwright.config.ts`): a network-blocked reload rendered nothing, even after the
bug above was fixed and `pmtiles-v1` was confirmed populated. The cause is
upstream of tile caching entirely — `assets/maplibre-gl-worker-*.js` (G1's
`setWorkerUrl` fix in `src/map/MapShell.tsx`) is correctly precached, but WebKit's
service worker does not intercept the network request a `new Worker(url)` call
makes to fetch its own script; interception there only covers document and
main-thread `fetch()` calls. Offline, the worker script load fails outright, no
worker exists, and — per G1's own comment in `MapShell.tsx` — "without a worker
nothing decodes vector tiles."

Fixed in `src/map/MapShell.tsx` without touching the surrounding effect or
breaking G1's fix: instead of pointing `setWorkerUrl` straight at the worker
chunk's network URL, a `resolveWorkerUrl` helper fetches that URL through a plain
main-thread `fetch()` first (which the service worker *does* intercept and can
serve from precache) and hands MapLibre a `Blob` URL built from the response
instead. A `blob:` URL never touches the network at all, so the browser has
nothing to fail to load offline. This needs the worker source in hand before any
`Map` is constructed, so the `setWorkerUrl` call is now behind a top-level
`await` — module evaluation (and therefore the whole app, since `main.tsx`
transitively imports `MapShell.tsx`) blocks on it, which was preferred over a
fire-and-forget swap racing the component's `useEffect` non-deterministically.
Falls back to the original network URL on fetch failure (e.g. plain `npm run dev`
with no service worker registered — `devOptions.enabled: false` in
`vite.config.ts` — still resolves it via a real network fetch, unchanged
behaviour from before this task).

`tests/e2e/offline-map.spec.ts`'s network-block also has to let `blob:` URLs
through unmolested (see the in-file comment) — aborting a `blob:` "request" via
Playwright's `context.route` crashes WebKit's inspector the same way aborting the
top-level navigation request does, because neither one is a real network request
Playwright can legitimately intercept.

Glyphs and sprites (`protomaps.github.io/basemaps-assets/...`) are runtime-cached
with a plain Workbox `CacheFirst` route — normal whole-file GETs, no range
handling needed, but required offline or label rendering breaks even with tiles
present.

---

## [~] Task 1 — Dependencies and icons

- [x] `npm install -D vite-plugin-pwa workbox-precaching workbox-routing workbox-strategies workbox-range-requests workbox-expiration workbox-cacheable-response`
- [x] Generate `public/pwa-192.png` and `public/pwa-512.png`: a hand-rolled PNG
      encoder (`node:zlib` deflate, manual chunk/CRC32), no image library, no
      network fetch. Rounded square, gray-900 background, cream map-pin glyph —
      matches the app's existing button chrome and the protomaps "light" flavour.

## [~] Task 2 — Web app manifest + service worker registration

**Files:** `vite.config.ts`, `src/sw.ts`

- [x] `VitePWA` plugin, `strategies: 'injectManifest'`, `srcDir: 'src'`,
      `filename: 'sw.ts'`, `injectRegister: 'auto'` (index.html gets the register
      script injected at build time — no change to `src/main.tsx` or
      `src/map/MapShell.tsx` needed; the G1 worker-chunk fix there is untouched).
- [x] Manifest: `name`/`short_name` "areamap", `start_url` "/", `display`
      "standalone", `theme_color` "#111827", `background_color` "#f8f6f2", icons
      192 and 512.
- [x] `src/sw.ts`: `precacheAndRoute(self.__WB_MANIFEST)` for the app shell,
      `self.skipWaiting()` + `clientsClaim()` so a reload after first install is
      actually controlled (required by `assert-pwa.mjs`'s controller check).

## [~] Task 3 — Runtime caching routes

**Files:** `src/sw.ts`

- [x] pmtiles range-caching route, per the mechanism decision above.
- [x] `CacheFirst` route for `https://protomaps.github.io/basemaps-assets/*`
      (glyphs + sprites), with `workbox-expiration` capping entries so it can't
      grow unbounded.
- [x] Fixed a shared-`Response`-body concurrency bug in the pmtiles handler
      found while verifying against the real E2E project — see "Bug found while
      verifying..." above.

## [~] Task 4 — `scripts/assert-pwa.mjs`

- [x] Accepts a port/URL via `process.argv`/`PREVIEW_PORT` env, **defaults to
      4173** (the lead's post-merge run is argument-less). Starts (or reuses) a
      preview server itself if nothing answers on the target port, drives it with
      Playwright chromium.
- [x] Checks, each printed with pass/fail: manifest `<link>` resolves and parses;
      `name`, `start_url`, `display` in `{standalone, fullscreen}`, icons ≥192 and
      ≥512 present; SW registers and, after a reload, `navigator.serviceWorker.controller`
      is non-null; a reload with `context.setOffline(true)` still yields a
      `200`/document response with `#root` attached for `/`. Runs against
      Chromium (`@playwright/test`'s bundled `chromium`), where `setOffline`
      behaves correctly — see Task 5's note on why the WebKit-run E2E spec
      can't use the same mechanism.
- [x] Exit 0 only if every check passes.

## [~] Task 5 — `tests/e2e/offline-map.spec.ts`

- [x] 390x844 (project default, WebKit). Warm load, wait for
      `window.__map.queryRenderedFeatures().length > 0` (same pattern as
      `map-shell.spec.ts`'s "vector tiles decode and paint" test), one more
      *online* reload waiting for the same paint condition again (so the pmtiles
      route has actually finished caching the full file before going offline —
      the very first load is never SW-controlled, nothing caches during it), then
      block the network and reload, then assert features paint again — not just
      that the shell loads.
- [x] Network blocking: `context.route('**/*', ...)` hard-block, letting
      navigation requests and `blob:` URLs through — not `context.setOffline(true)`.
      Documented in-file and in the "WebKit gap" section above: `setOffline(true)`
      makes WebKit throw an internal error on the next navigation in this
      Playwright build, and aborting the navigation request (or a `blob:`
      pseudo-request) via `context.route` crashes WebKit's inspector
      ("Blocked by Web Inspector") rather than simulating offline.
- [x] **Deviation, `src/map/MapShell.tsx`:** required a change beyond
      "sw registration belongs in main.tsx" to actually pass — see "WebKit gap"
      above. G1's `setWorkerUrl` fix (why a worker bundle is resolved manually at
      all) is untouched; only *what URL* gets handed to it changed, from the
      network URL directly to a `Blob` URL built from fetching that same URL
      first, so the browser never issues an uninterceptable network request for
      the worker script when offline. `npm run test:e2e -- tests/e2e/map-shell.spec.ts`
      (out of scope to touch, must keep passing) reverified after this change —
      see Task 7.

## [~] Task 6 — Port discipline plumbing

**Files:** `playwright.config.ts`

- [x] `PREVIEW_PORT` env var, defaulting to `4173` — committed default is
      unchanged. `webServer.command` and `use.baseURL`/`webServer.url` read it.
      G5's own verification runs `PREVIEW_PORT=4273`.

## [~] Task 7 — Verification

- [x] `npm run build`
- [x] `node scripts/assert-pwa.mjs` against port 4273
- [x] `PREVIEW_PORT=4273 npm run test:e2e -- tests/e2e/offline-map.spec.ts`
- [x] `PREVIEW_PORT=4273 npm run test:e2e -- tests/e2e/map-shell.spec.ts` (regression —
      must still pass; G1's `setWorkerUrl` fix in `src/map/MapShell.tsx` was not
      touched)
