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

## [~] Task 4 — `scripts/assert-pwa.mjs`

- [x] Accepts a port/URL via `process.argv`/`PREVIEW_PORT` env, **defaults to
      4173** (the lead's post-merge run is argument-less). Starts (or reuses) a
      preview server itself if nothing answers on the target port, drives it with
      Playwright chromium.
- [x] Checks, each printed with pass/fail: manifest `<link>` resolves and parses;
      `name`, `start_url`, `display` in `{standalone, fullscreen}`, icons ≥192 and
      ≥512 present; SW registers and, after a reload, `navigator.serviceWorker.controller`
      is non-null; a reload with `page.route('**/*', route => route.abort())`
      still yields a `200`/document response for `/`.
- [x] Exit 0 only if every check passes.

## [~] Task 5 — `tests/e2e/offline-map.spec.ts`

- [x] 390x844 (project default). Warm load, wait for
      `window.__map.queryRenderedFeatures().length > 0` (same pattern as
      `map-shell.spec.ts`'s "vector tiles decode and paint" test), then block the
      network and reload, then assert features paint again post-reload — not just
      that the shell loads.
- [x] Network blocking: `page.route('**/*', ...)` hard-block for the reload,
      not `context.setOffline(true)` — noted in-file why (WebKit's `setOffline`
      does not reliably cut off `localhost` requests, so it would pass for the
      wrong reason).

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
