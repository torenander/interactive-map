# Tasks

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement task-by-task.

Task state is one of three markers. Nothing else is valid.

| Marker | State | Meaning |
|---|---|---|
| `[ ]` | not complete | Not started, or started and not finished. |
| `[~]` | needs review | Code written and its own tests pass, but a human has not looked at it, or something in it is a judgement call worth challenging. |
| `[x]` | done | Tests pass **and** reviewed. Only set this after watching the commands run. |

A goal is marked done only when every one of its `done_when` commands in `docs/OBJECTIVES.md` exits 0. See `docs/CLAUDE-MD-INSTRUCTIONS.md` and the rules at the top of `docs/OBJECTIVES.md`.

---

# G1 — Map shell — exit criteria met 2026-09-10

> Both `done_when` commands exit 0 (`npm run build`, `npm run test:e2e -- tests/e2e/map-shell.spec.ts`, 7 tests).
> Tasks stay `[~]` needs review: this file's legend reserves `[x]` for work a human has looked at.

**Goal:** Render a MapLibre map of London from a self-hosted Protomaps `.pmtiles` file, with a working "centre on me" control.

**Architecture:** A Vite/React/TS single page mounting one `<MapShell>` component. MapLibre reads vector tiles directly from a local `.pmtiles` archive over HTTP range requests via the `pmtiles` protocol handler — no tile server. Map state lives in the URL hash, which doubles as the E2E assertion surface for viewport position.

**Tech stack:** Vite, React, TypeScript, Tailwind, MapLibre GL JS, pmtiles, `@protomaps/basemaps`, Playwright.

**Spec:** `SPEC.md`, `docs/ARCHITECTURE.md`. Exit criteria: `docs/OBJECTIVES.md` § G1.

## Global constraints

- Mobile viewport **390x844** (iPhone 14) is the primary target. Verify there before desktop.
- OpenStreetMap attribution renders on the map and is non-negotiable.
- Out of scope for G1, do not build: drawing, Supabase, auth, offline caching.
- `npm run build` must exit 0 at the end of every task, not just at the end of the goal.
- Interactive controls belong in the **bottom third** of the screen, thumb-reachable.

## File structure

| File | Responsibility |
|---|---|
| `scripts/fetch-tiles.sh` | Reproducibly rebuild the London `.pmtiles` extract. |
| `src/map/style.ts` | Build the MapLibre style object. Sole owner of the source URL and attribution string. |
| `src/map/MapShell.tsx` | Create and own the map instance and its controls. The only file that touches `maplibregl`. |
| `src/App.tsx` | Mount `MapShell` full-viewport. |
| `tests/e2e/map-shell.spec.ts` | The four G1 exit assertions. |
| `playwright.config.ts` | Mobile viewport, geolocation permission, preview server. |

---

## [~] Task 1 — London basemap extract

Produces `public/tiles/london.pmtiles`, which G1's `blocked_by` requires. Data task, no application code.

**Files:**
- Create: `scripts/fetch-tiles.sh`
- Create: `public/tiles/london.pmtiles` (untracked — build artifact)
- Modify: `.gitignore`

**Interfaces:**
- Produces: a pmtiles archive at `public/tiles/london.pmtiles`, served by Vite at the URL path `/tiles/london.pmtiles`. Task 3 consumes it as `pmtiles:///tiles/london.pmtiles`.

- [x] **Step 1: Install the pmtiles CLI**

```bash
brew install pmtiles
pmtiles version
```

`pmtiles` is in homebrew-core; there is no `protomaps/tap`. On a machine without
Homebrew, download the `darwin_arm64` binary from
`https://github.com/protomaps/go-pmtiles/releases` and put it on `PATH` instead.

- [x] **Step 2: Write the extract script**

Protomaps daily planet builds are retained roughly a week, so the date cannot be
hardcoded. `pmtiles extract` uses HTTP range requests and downloads only the tiles
inside the bbox — this is tens of MB, not a planet.

```bash
cat > scripts/fetch-tiles.sh <<'EOF'
#!/usr/bin/env bash
# Rebuild the London basemap extract.
# Usage: scripts/fetch-tiles.sh [YYYYMMDD]
# Defaults to the most recent available Protomaps daily build.
set -euo pipefail

BBOX="-0.510375,51.28676,0.334015,51.691874"   # Greater London
OUT="public/tiles/london.pmtiles"
MAXZOOM=15

pick_build() {
  if [ $# -gt 0 ]; then echo "$1"; return; fi
  for i in $(seq 1 10); do
    d=$(date -u -v-"${i}"d +%Y%m%d 2>/dev/null || date -u -d "${i} days ago" +%Y%m%d)
    if curl -sfI --max-time 10 "https://build.protomaps.com/${d}.pmtiles" >/dev/null; then
      echo "$d"; return
    fi
  done
  echo "no reachable Protomaps daily build in the last 10 days" >&2
  exit 1
}

BUILD=$(pick_build "$@")
echo "Extracting Greater London from build ${BUILD}"

mkdir -p "$(dirname "$OUT")"
pmtiles extract "https://build.protomaps.com/${BUILD}.pmtiles" "$OUT" \
  --bbox="$BBOX" \
  --maxzoom="$MAXZOOM"

pmtiles show "$OUT"
EOF
chmod +x scripts/fetch-tiles.sh
```

- [x] **Step 3: Run it**

```bash
scripts/fetch-tiles.sh
```

Expected: `pmtiles show` reports a non-zero tile count, `min zoom 0`, `max zoom 15`,
and bounds enclosing the Greater London bbox.

- [x] **Step 4: Verify the artifact independently of the script**

```bash
pmtiles show public/tiles/london.pmtiles | grep -E 'tile count|bounds|max zoom'
test -s public/tiles/london.pmtiles && echo "non-empty: OK"
```

Expected: all three fields present, file non-empty. If tile count is 0 the bbox
was wrong — do not proceed to Task 3 with an empty archive.

- [x] **Step 5: Keep the archive out of git**

```bash
printf '\n# Basemap build artifact — rebuild with scripts/fetch-tiles.sh\npublic/tiles/*.pmtiles\n' >> .gitignore
git status --short   # london.pmtiles must NOT appear
```

- [x] **Step 6: Commit**

```bash
git add scripts/fetch-tiles.sh .gitignore
git commit -m "feat: reproducible Greater London pmtiles extract"
```

---

## [~] Task 2 — App scaffold and mobile test harness

Vite + React + TS + Tailwind, plus a Playwright runner pinned to 390x844. The
harness ships here because G1's second `done_when` command is a Playwright
invocation — without it the goal cannot be evaluated.

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `playwright.config.ts`, `tests/e2e/map-shell.spec.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `preview`, `test`, `test:e2e`. Tasks 3–5 rely on these exact names; `docs/OBJECTIVES.md` calls `npm run build` and `npm run test:e2e` verbatim.
- Produces: `tests/e2e/map-shell.spec.ts`, extended by Tasks 3 and 4.

- [x] **Step 1: Scaffold Vite into the non-empty repo**

`npm create vite` refuses a non-empty directory non-interactively, so scaffold
into a temp directory and move the files across.

```bash
TMP=$(mktemp -d)
npm create vite@latest "$TMP/app" -- --template react-ts
# The scaffolder resolves the path relative to cwd, so the app may land in
# ./var/folders/... inside the repo. Locate it before copying.
APP=$(find "$TMP" var -maxdepth 8 -name package.json -not -path '*/node_modules/*' 2>/dev/null | head -1 | xargs dirname)
# The template ships its own .gitignore and README.md — ours must survive.
rm -f "$APP/.gitignore" "$APP/README.md"
cp -R "$APP/." .
rm -rf "$TMP" var
rm -f public/vite.svg src/App.css
rm -rf src/assets
npm install
```

- [x] **Step 2: Add Tailwind, MapLibre, pmtiles, Playwright and vitest**

Tailwind v4 is a Vite plugin, not a PostCSS config.

```bash
npm install maplibre-gl pmtiles @protomaps/basemaps
npm install -D tailwindcss @tailwindcss/vite @playwright/test vitest
npx playwright install webkit   # devices['iPhone 14'] is a WebKit descriptor
```

- [x] **Step 3: Wire Tailwind into Vite**

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
```

```css
/* src/index.css */
@import "tailwindcss";
@import "maplibre-gl/dist/maplibre-gl.css";

html, body, #root { height: 100%; margin: 0; }
```

- [x] **Step 4: Set the npm scripts**

Edit the `scripts` block of `package.json` to exactly:

```json
{
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview --port 4173 --strictPort",
  "test": "vitest run",
  "test:e2e": "playwright test"
}
```

Port 4173 is fixed because `docs/OBJECTIVES.md` § G5 runs Lighthouse against
`http://localhost:4173`.

- [x] **Step 5: Write the Playwright config**

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    permissions: ['geolocation'],
    geolocation: { latitude: 51.5072, longitude: -0.1276 }, // Charing Cross
  },
  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 14'],
        // The descriptor's viewport is 390x664 — iPhone 14 screen minus Safari
        // chrome. Installed as a PWA the app runs standalone and gets the full
        // 390x844, which is the target docs/TESTING.md pins. Test that.
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
```

- [x] **Step 6: Write the failing harness test**

One real assertion — that the app mounts and the viewport is the mobile target.
`docs/TESTING.md` forbids assertion-free placeholder tests.

```ts
// tests/e2e/map-shell.spec.ts
import { test, expect } from '@playwright/test'

test('app mounts at the mobile target viewport', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#root')).toBeAttached()
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 })
})
```

- [x] **Step 7: Run it to verify it fails**

```bash
npm run test:e2e -- tests/e2e/map-shell.spec.ts
```

Expected: FAIL. Before Step 8, `src/App.tsx` still renders the Vite demo
counter; the run fails at build or on the `#root` assertion.

- [x] **Step 8: Replace the Vite demo with an empty full-viewport shell**

```tsx
// src/App.tsx
export default function App() {
  return <div className="h-full w-full" />
}
```

```tsx
// src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

Delete `src/App.css`.

- [x] **Step 9: Run the test and the build**

```bash
npm run test:e2e -- tests/e2e/map-shell.spec.ts
npm run build
```

Expected: PASS, and build exits 0.

- [x] **Step 10: Ignore build and test output**

```bash
printf '\n# Playwright\n/test-results/\n/playwright-report/\n' >> .gitignore
git status --short   # no node_modules/, dist/, test-results/
```

- [x] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: Vite React TS scaffold with Tailwind and mobile Playwright harness"
```

---

## [~] Task 3 — Map renders London from local pmtiles

**Files:**
- Create: `src/map/style.ts`, `src/map/MapShell.tsx`
- Modify: `src/App.tsx`
- Test: `tests/e2e/map-shell.spec.ts`

**Interfaces:**
- Consumes: `public/tiles/london.pmtiles` from Task 1; the npm scripts from Task 2.
- Produces: `buildStyle(): StyleSpecification` from `src/map/style.ts`, and the default-exported `MapShell` React component. Task 4 adds a control inside `MapShell`.
- Produces: `LONDON_CENTER: [number, number]` and `LONDON_ZOOM: number`, exported from `src/map/style.ts` and reused by Task 4.

- [x] **Step 1: Write the failing tests**

Append to `tests/e2e/map-shell.spec.ts`. Viewport position is read from the URL
hash, which MapLibre maintains when `hash: true` — this is a real feature
(shareable map links) rather than a test-only hook.

```ts
const GREATER_LONDON = { west: -0.510375, south: 51.28676, east: 0.334015, north: 51.691874 }

test('map canvas renders with non-zero size', async ({ page }) => {
  await page.goto('/')
  const canvas = page.locator('.maplibregl-canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box!.width).toBeGreaterThan(0)
  expect(box!.height).toBeGreaterThan(0)
})

test('initial viewport is within Greater London', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.location.hash.length > 1)
  const [, lat, lng] = page.url().split('#')[1].split('/').map(Number)
  expect(lat).toBeGreaterThan(GREATER_LONDON.south)
  expect(lat).toBeLessThan(GREATER_LONDON.north)
  expect(lng).toBeGreaterThan(GREATER_LONDON.west)
  expect(lng).toBeLessThan(GREATER_LONDON.east)
})

test('OpenStreetMap attribution is in the DOM', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('OpenStreetMap')
})
```

- [x] **Step 2: Run to verify they fail**

```bash
npm run test:e2e -- tests/e2e/map-shell.spec.ts
```

Expected: three FAILs — no `.maplibregl-canvas`, no hash, no attribution
element. The Task 2 mount test still passes.

- [x] **Step 3: Write the style module**

```ts
// src/map/style.ts
import { layers, namedFlavor } from '@protomaps/basemaps'
import type { StyleSpecification } from 'maplibre-gl'

export const LONDON_CENTER: [number, number] = [-0.1276, 51.5072] // Charing Cross
export const LONDON_ZOOM = 11

const TILES_URL = 'pmtiles:///tiles/london.pmtiles'
const ATTRIBUTION =
  '<a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'

export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
    sources: {
      protomaps: {
        type: 'vector',
        url: TILES_URL,
        attribution: ATTRIBUTION,
      },
    },
    layers: layers('protomaps', namedFlavor('light'), { lang: 'en' }),
  }
}
```

Glyphs and sprites are remote here. That is fine for G1 and becomes a G5 problem
when the map must work offline — do not self-host them now, offline caching is
listed under G1's `out_of_scope`.

- [x] **Step 4: Write the map component**

```tsx
// src/map/MapShell.tsx
import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { buildStyle, LONDON_CENTER, LONDON_ZOOM } from './style'

export default function MapShell() {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)

  useEffect(() => {
    if (!container.current || map.current) return

    const protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)

    map.current = new maplibregl.Map({
      container: container.current,
      style: buildStyle(),
      center: LONDON_CENTER,
      zoom: LONDON_ZOOM,
      hash: true,
      attributionControl: { compact: false },
    })

    return () => {
      map.current?.remove()
      map.current = null
      maplibregl.removeProtocol('pmtiles')
    }
  }, [])

  return <div ref={container} className="h-full w-full" />
}
```

The `map.current` guard matters: React StrictMode runs effects twice in dev and
would otherwise create two map instances on one container.

- [x] **Step 5: Mount it**

```tsx
// src/App.tsx
import MapShell from './map/MapShell'

export default function App() {
  return <MapShell />
}
```

- [x] **Step 6: Run the tests and the build**

```bash
npm run test:e2e -- tests/e2e/map-shell.spec.ts
npm run build
```

Expected: four PASS, build exits 0.

- [x] **Step 7: Look at it**

```bash
npm run dev
```

Open at 390x844 in device emulation. Streets, water and parks should be drawn,
not a blank canvas with attribution. A blank canvas with passing tests means the
archive has no tiles at this zoom — go back to Task 1 Step 4.

> **Deviation.** maplibre-gl v6 has no default export — imports are named
> (`MapLibreMap`, `addProtocol`, `removeProtocol`). And Vite 8/rolldown does not
> emit MapLibre's internal worker chunk, so the worker request fell through to
> `index.html` and died parsing HTML: four green DOM tests, blank map. Fixed with
> `?worker&url` + `setWorkerUrl`. Added a `vector tiles decode and paint` test
> that fails without the fix, and set `reuseExistingServer: false` because a
> stale preview server turned that failing test green.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: render London basemap from local pmtiles archive"
```

---

## [~] Task 4 — Centre on me

**Files:**
- Modify: `src/map/MapShell.tsx`
- Test: `tests/e2e/map-shell.spec.ts`

**Interfaces:**
- Consumes: the `MapShell` component from Task 3, and the `geolocation` permission and pinned position from `playwright.config.ts` in Task 2.
- Produces: a `areamap:geolocate` DOM `CustomEvent` on `window`, carrying `{ latitude, longitude }`, dispatched when MapLibre's `GeolocateControl` emits `geolocate`.

- [x] **Step 1: Write the failing test**

Playwright's context already grants geolocation and pins the position to
Charing Cross via `playwright.config.ts` from Task 2.

```ts
test('geolocate control fires a geolocate event with the mocked position', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.maplibregl-ctrl-geolocate')).toBeVisible()

  const fired = page.evaluate(
    () =>
      new Promise<{ latitude: number; longitude: number }>((resolve) => {
        window.addEventListener(
          'areamap:geolocate',
          (e) => resolve((e as CustomEvent).detail),
          { once: true },
        )
      }),
  )

  await page.locator('.maplibregl-ctrl-geolocate').click()

  const detail = await fired
  expect(detail.latitude).toBeCloseTo(51.5072, 3)
  expect(detail.longitude).toBeCloseTo(-0.1276, 3)
})

test('geolocate control sits in the bottom third of the viewport', async ({ page }) => {
  await page.goto('/')
  const box = await page.locator('.maplibregl-ctrl-geolocate').boundingBox()
  expect(box!.y).toBeGreaterThan(844 * (2 / 3))
})
```

- [x] **Step 2: Run to verify it fails**

```bash
npm run test:e2e -- tests/e2e/map-shell.spec.ts
```

Expected: two FAILs — no `.maplibregl-ctrl-geolocate` in the DOM.

- [x] **Step 3: Add the control**

Insert into the `useEffect` in `src/map/MapShell.tsx`, after the `new maplibregl.Map(...)`
assignment and before the cleanup `return`:

```ts
    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserLocation: true,
    })

    geolocate.on('geolocate', (e) => {
      const { latitude, longitude } = (e as GeolocationPosition).coords
      window.dispatchEvent(
        new CustomEvent('areamap:geolocate', { detail: { latitude, longitude } }),
      )
    })

    map.current.addControl(geolocate, 'bottom-right')
```

`bottom-right` satisfies the thumb-reach constraint in `SPEC.md` § Field UX.

- [x] **Step 4: Lift the controls clear of the home indicator**

Append to `src/index.css`:

```css
.maplibregl-ctrl-bottom-right {
  padding-bottom: calc(env(safe-area-inset-bottom) + 1rem);
  padding-right: 0.75rem;
}
```

- [x] **Step 5: Run the tests and the build**

```bash
npm run test:e2e -- tests/e2e/map-shell.spec.ts
npm run build
```

Expected: six PASS, build exits 0.

> **Deviation.** maplibre-gl v6 types the payload as `GeolocatePositionEvent`
> with `coords: GeolocationCoordinates` already on it, so the planned
> `(e as GeolocationPosition).coords` cast does not compile and is not needed.
> Use `e.coords` directly.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: centre-on-me control in thumb reach"
```

---

## [~] Task 5 — Close out G1

No new behaviour. Runs the goal's exit criteria exactly as written and records
the result.

**Files:**
- Modify: `docs/TASKS.md`

- [x] **Step 1: Run every `done_when` command from `docs/OBJECTIVES.md` § G1, unmodified**

```bash
npm run build
echo "build exit: $?"
npm run test:e2e -- tests/e2e/map-shell.spec.ts
echo "e2e exit: $?"
```

Both must print `exit: 0`. If either fails, add tasks above and continue. Do not
edit an assertion to make it pass — `docs/TESTING.md` forbids it and so does
`docs/OBJECTIVES.md`.

- [x] **Step 2: Confirm nothing out of scope was built**

```bash
ls src/ && grep -ril "supabase\|terra-draw\|serviceWorker" src/ tests/ || echo "no out-of-scope code: OK"
```

Expected: no matches. Drawing, Supabase, auth and offline caching are G1
`out_of_scope`.

- [x] **Step 3: Mark the goal**

Change this section's heading to `# G1 — Map shell — done YYYY-MM-DD`, using the
real date, and set every Task 1–5 marker to `[x]`. Only then.

- [x] **Step 4: Commit**

```bash
git add docs/TASKS.md
git commit -m "docs: G1 map shell complete"
```

---

# G2 — Schema and client — done 2026-09-10

Task breakdown and verification log: `docs/TASKS-G2.md` (owned by teammate schema-g2).

All three `done_when` commands exit 0, run twice — once by the implementing teammate,
once independently by the lead: `npx supabase db reset`; `npx supabase gen types
typescript --local | diff - src/db/types.ts` (byte-identical); `npm run test --
tests/unit/schema.test.ts` (5/5 against live local Postgres, no mocks).

**Architecture deviation, decided mid-goal:** h3-pg does not exist in any Supabase
Postgres image, local or hosted, so the cell-derivation trigger was impossible on this
stack. Derivation moved to the `save-area` edge function (h3-js, caller's JWT) — the
alternative ARCHITECTURE.md § "Cell derivation runs server side" always allowed; see
its superseded note and DATA-MODEL.md § Migration 0002 for the full contract.
`area_cells.h3_index` became `text`.

---

# G3 — MVP loop — done 2026-09-10

Task breakdown: `docs/TASKS-G3.md` (teammate mvp-g3).

All three `done_when` commands exit 0 on a clean `db reset`, run independently by the
lead after the teammate's run: `npm run build`; `npm run test -- tests/unit/` (10/10);
`npm run test:e2e -- tests/e2e/mvp-loop.spec.ts` (full round trip at 390x844).
`map-shell.spec.ts` still 7/7 — no regression. Visual verification: three areas at
ratings -1/0/+1 render semi-transparent red/grey/green on the live app.

**Field-UX audit (2026-09-10, read-only teammate at this snapshot):** all 8 SPEC
§ Field UX / CLAUDE.md user-visible requirements PASS, verified by driving the real UI
at 390x844 — thumb reach (all draw-flow controls y >= 563 of 844), undo-vertex (5->4,
drawing continues), undo-last-save (DB row 1->0), modal dismissal preserves geometry
(reopen pill), overlap semi-transparent newest-on-top (fill-opacity 0.35, source
order), ratings limited to -1/0/+1 with no dimension UI, blocked save shows an alert
and writes nothing, attribution visible mid-draw.

**Interpretation call, accepted:** no hard auth gate. The map mounts without a session
(read-only; `map-shell.spec.ts` requires this), sign-in is a top-right pill, saving
without a session fails fast inline. Deletes are the one direct table write, per the
CLAUDE.md rule.

---

# G4 — Offline writes — done 2026-09-10

Task breakdown: `docs/TASKS-G4.md` (teammate mvp-g3).

Both `done_when` commands exit 0 on clean state, verified independently by the lead;
`offline.spec.ts` additionally repeated 3x clean after the teammate's dedupe fix
(MapLibre `queryRenderedFeatures` reports a feature once per internal tile — fixed
with `promoteId` + Set-dedupe; had flaked ~50% before). Regressions: map-shell 7/7,
mvp-loop 1/1.

Design notes: raw IndexedDB queue, injectable flush, queued areas render amber and
live in a separate list so a server fetch cannot wipe an unflushed save; queueing
only triggers on real network failure (FunctionsFetchError) — validation/auth errors
still surface. Offline deletes are not queued (out of scope, surfaces normal error).

---

# G5 — Installable PWA with offline basemap — done 2026-09-10

Task breakdown: `docs/TASKS-G5.md` (teammate pwa-g5, built in an isolated worktree,
merged as 86d92c9). `done_when` per the amended G5 block (Lighthouse's PWA category no
longer exists — see the dated note in docs/OBJECTIVES.md): `npm run build` exit 0;
`node scripts/assert-pwa.mjs` exit 0 (10/10: manifest, icons 192/512, standalone, SW
controls page, offline shell); `offline-map.spec.ts` exit 0 (tiles repaint with the
network hard-blocked after one warm load). Full regression after merge: map-shell 7/7,
mvp-loop 1/1, offline 1/1, unit 14/14, schema 3x clean.

Mechanism: SW caches the full pmtiles archive on first range request and serves all
subsequent range requests from cache (workbox-range-requests); glyphs/sprites runtime-
cached. Two real bugs fixed during verification: shared Response body corruption on
concurrent warm-load fetches, and WebKit's SW not intercepting dedicated-worker script
loads (MapLibre's worker now fetched via fetch() and handed over as a Blob URL).

**Known trade-off, fixed:** the first load (and any load after cache eviction) used
to download the full ~125 MB archive before tiles painted — fine on localhost,
minutes of blank map on cellular. `src/sw.ts` now passes cold-cache range requests
straight through to the network (unchanged pre-SW first paint) while a single
background fetch fills the cache and broadcasts a `tiles-cached` postMessage on
completion; a warm cache still answers every range instantly. See
`docs/TASKS-FIX-SW.md` for the mechanism and how `offline-map.spec.ts` now waits
for that signal, deterministically, before cutting the network.

---

# Verification sweep and fixes — 2026-09-10

Six independent verifier agents after G1-G5 completion: gate re-run, fresh-clone
reproducibility, adversarial security/concurrency probe, test-honesty audit,
touch-only field simulation, docs-vs-reality sweep. All five goal gates held. The
sweep surfaced 16 findings; every one is fixed (fix logs: TASKS-FIX*.md):

- save-area rebuilt around a single-transaction RPC (migration 0005): no more partial
  writes on WORKER_LIMIT, no concurrency 400s, no silent cell-set corruption. Cell-count
  cap validated before any write.
- Sole write path is now a DATABASE guarantee (migration 0007): save_area_tx is
  SECURITY DEFINER with explicit auth/ownership checks; INSERT/UPDATE revoked on areas,
  all writes revoked on area_cells, for client roles. Comment capped at 2000 chars.
- Server-owned timestamps and pinned dimension (migration 0006).
- Ghost-click race dismissing the rating modal on touch draw-finish: fixed via
  event-timestamp guard; touch-draw.spec.ts added (verified red pre-fix). Tap targets
  raised to 44px; draw controls safe-area aware.
- Service worker: pmtiles warm no longer blocks first paint (passthrough + background
  fill, tiles-cached signal; non-blocking proven by assertion).
- Bare `npm run test` fixed via vitest.config.ts include (was exiting 1 on e2e specs).
- mvp-loop now asserts comment persistence. README rewritten (was pre-code skeleton
  text). SPEC.md stale h3/trigger claims marked superseded. .env.example annotated.

Final consolidated gates on the combined result, run by the lead: db reset 0001-0007,
types diff, build, bare unit run (22/22), all five e2e suites (map-shell 7, mvp-loop,
offline, offline-map, touch-draw), assert-pwa 10/10 — every command exit 0.

Residual accepted risk, documented: with client-generated ids, a caller who already
knows another user's area uuid can infer it is taken (their own save fails generically);
guessing a v4 uuid is not a practical path, and server-generated ids would break offline
idempotency.

---

# G6 — Drawing precision — done 2026-09-11

Task breakdown: `docs/TASKS-G6.md` (teammate draw-accuracy).

All ten `done_when` entries exit 0, re-run independently by the lead after the
teammate's own run: the five grep probes, `npm run build`, the unit suite (28 tests),
and the three e2e suites — `draw-precision` 3/3, plus the `touch-draw` and `mvp-loop`
regression gates 1/1 each. No check was rewritten or weakened to get there.

Design notes: `TerraDrawPolygonMode` gains `showCoordinatePoints`, `editable` and
`pointerDistance` 20 — closing the ring no longer depends on hitting a 40px target,
because an explicit "Finish area" control closes it outright (Terra Draw has no public
`finish()`; the button dispatches the mode's finish key at the map canvas). A
`TerraDrawSelectMode` holds any finished polygon — a fresh draw or a reopened saved
area — with draggable vertex and midpoint handles; polygon mode cannot, since a tap on
empty map would start a second polygon. The `finish` handler's old
`action !== 'draw'` early return is gone, so a dragged vertex now reaches `save-area`
and `area_cells` is rebuilt from the new outline (asserted against `h3-js`).

Snapping to existing borders is `snapping.toCustom` (`src/map/snapping.ts`), not the
built-in `toCoordinate`/`toLine`: those only see Terra Draw's own store, and saved areas
render from the `saved-areas` GeoJSON source, so the built-ins would have snapped to
nothing. Vertex snapping only — G9-style segment snapping would produce an interpolated
coordinate equal to nothing, and the point of snapping here is a shared border
coordinate. It remains an input-side concern: nothing unions, clips or repairs geometry
(docs/ARCHITECTURE.md § "No geometry union").

One UX consequence worth knowing: dismissing the rating sheet now *keeps* an edit
session open (with a new "Cancel edit" control) rather than discarding it. The sheet's
backdrop covers the whole map, so clearing the session on dismiss would have made
dragging a saved area's vertex impossible.

---

# G7 — Load performance — done 2026-09-11

Task breakdown: `docs/TASKS-G7.md` (teammate perf-probe, built in two stages so that G6
and G7 were never editing `src/map/MapShell.tsx` at once).

All five `done_when` commands exit 0, re-run independently by the lead after the
teammate's own run: `npm run build`, `node scripts/assert-bundle-budget.mjs` (PASS at
364,240 B gzip against a 380,000 B budget), and the `perf-load`, `offline-map` and
`offline` suites. G6's three suites were re-run as regression gates, since deferring
Terra Draw moves when drawing initialises: `draw-precision` 3/3, `touch-draw` 1/1,
`mvp-loop` 1/1.

What moved: critical-path JS 449,088 -> 364,240 B gzip; tile bytes cached to paint one
viewport 55,891,073 -> 544,046 B across 5 entries; the MapLibre worker fetched once,
starting ahead of the entry chunk rather than after it.

Mechanism: `src/sw.ts` caches each pmtiles byte range under its own key instead of
downloading the whole archive in the background. The old design cost more than it
returned — over 10 Mbps the full fetch did not finish within 90 s, and since `cache.put`
only runs once the whole body has arrived, a visit that ended first cached nothing and
the next one restarted from zero, all while competing for the ranges the map was actually
waiting on. Whole-archive prefetch survives as an opt-in `prefetch-tiles` message. The
G5 offline guarantee is unchanged in substance: whatever has been viewed online stays
viewable offline, which is what `offline-map.spec.ts` exercises.

Terra Draw and `@supabase/supabase-js` now load after the map exists. The Supabase move
needed one design change rather than a moved import: `saveArea` translates
`FunctionsFetchError` into a local `OfflineWriteError`, so MapShell's queue-vs-fail
decision no longer drags the vendor module back onto the critical path.

The MapLibre worker is fetched by an inline script in the document head, with the promise
awaited by `src/map/MapShell.tsx`. A `<link rel="preload">` cannot do this job: MapShell
does not load the worker as a resource, it fetches the source and hands MapLibre a blob
URL so the service worker can serve it offline (WebKit does not intercept worker script
loads), and no `as`/`crossorigin` combination got WebKit to reuse the preloaded entry —
it downloaded the worker twice. The load-bearing guarantee is intact: the map is still
never created against an unresolved worker URL.

**Two gate corrections made during the work**, both strengthening a check, neither moving
a threshold. `perf-load`'s first version counted `.pmtiles` requests lacking a `Range`
header and passed against the unfixed code — WebKit does not surface service-worker
originated requests to `page.on('request')`. It was replaced by a cached-byte count,
which failed honestly at 55,891,073 B. The bundle budget's `TerraDraw` marker tested for
a name any caller can write, and destructuring the dynamic import left those names in the
entry chunk; it now tests a library-internal error string, verified by forcing terra-draw
back onto the critical path (exit 1, 407,759 B).

---

# G8 — Brush painting of H3 cells — done 2026-09-11

Task breakdown: `docs/TASKS-G8.md` (teammate goals-author, core first, MapShell wiring
once G7 stage 2 released the file).

All four `done_when` entries exit 0, re-run independently by the lead after the
teammate's own run: the `area_cells` grep probe, `npm run build`, 35 unit tests, and
`brush.spec.ts` 3/3 — the e2e run against the committed z15 tile default with no
`VITE_TILES_URL` override, so the suite holds under fresh-clone conditions.

Design notes are in `docs/TASKS-G8.md`; the two worth surfacing here are that the brush
samples every `pointermove` rather than throttling to frames (the browser coalesces
moves, and a 180 px stroke otherwise painted only ~130 px, with gaps filled by a
zoom-derived step), and that the client still never writes `area_cells` — the grep probe
holds that invariant, and the brush derives cells for display only.

---

# G9 — Point and line features — done 2026-09-11

Task breakdown: `docs/TASKS-G9.md` (teammate draw-accuracy, backend and UI stages).

All five `done_when` commands exit 0, re-run independently by the lead after the
teammate's own run: `db reset` (nine migrations, 0001–0009), the types diff clean,
`npm run build`, 16 unit tests across `save-feature.test.ts` and `schema.test.ts`, and
`points-lines.spec.ts` — on committed defaults, with `public/tiles/london.pmtiles`
present rather than the z14 override. Regression sweep on top, since MapShell is shared:
the full unit suite and the whole e2e directory, 22 e2e tests across nine suites.

Design notes: `public.map_features` is its own table (migrations 0008, 0009) — `areas` is
untouched, and the shapes genuinely differ, since an area derives H3 cells and a feature
derives none. One table covers both kinds with `kind` kept honest against
`geometrytype(geom::geometry)`. 0009 adopts the `save_area_tx` posture up front rather
than over two migrations as `areas` needed: SECURITY DEFINER with INSERT/UPDATE revoked
from the client roles, `user_id` from `auth.uid()`, ownership as a predicate on the
conflict path, one generic 404.

Tap precedence, now three pointer consumers: brush owns the pointer while active (G8's
rule), any open session blocks, and otherwise a point or line beats the area beneath it.
That last rule needed an explicit hit test rather than layer order — drawing features
last decides what is visible on top but does not stop the area fill's layer-scoped click
handler from firing.

Hardening beyond the goal's own gates: the feature offline queue shipped implemented but
unproven, since G9's `done_when` has no offline assertion. `points-lines.spec.ts` now
carries an offline round trip mirroring `offline.spec.ts` — queued and rendered as
queued with nothing in the database, then flushed on reconnect and surviving a reload.

---

# G10 — Open data overlays — done 2026-09-11

Task breakdown: `docs/TASKS-G10.md` (teammate goals-author).

All five `done_when` commands exit 0, re-run independently by the lead after the
teammate's own run: `npm run build`, `node scripts/assert-overlays.mjs` (three overlays
present and attributed, 0.08 / 3.23 / 3.98 MB), 14 unit tests, `overlays.spec.ts` 4/4 at
390x844, and the grep probe for the three source hosts. Regression sweep on top, since
`MapShell.tsx` and `src/sw.ts` are shared: whole unit suite 88 passed across 8 files,
whole e2e suite 26 passed, `tsc` clean on the app and service-worker projects. E2E on
committed defaults, no `VITE_TILES_URL` override.

Overlays take the basemap's posture, and that is the decision behind everything else
here: TfL stations, OS Open Greenspace and DEFRA road-noise contours are extracted once
by `scripts/fetch-overlays.sh` and served as tracked files on this app's own origin, so
no keyed, metered or uncapped service sits in the request path and an overlay a user
switched on still works with no signal. Full rationale and the filter table in
`docs/ARCHITECTURE.md` § Open-data overlays.

Three things worth surfacing here:

- **The DEFRA endpoint ignores `offset` silently** — `offset=0` and `offset=5` return the
  identical five features — and pages on `startIndex` via each response's `next` link. A
  first implementation looped on `offset` and re-read page one forever, pulling 582,000
  "features" from a 14,242-feature band before it was killed. The fetch now follows the
  `next` link, refuses to revisit a URL, and reconciles rows read against the server's own
  `numberMatched` per band, so a paging regression fails loudly instead of producing a
  plausible-looking partial file.
- **Every filter is recorded, and the filtered overlay says so in the UI.** The noise
  extract is 28.1 MB raw over 35,055 polygons (one carries 158,216 coordinates); ~17 m
  simplification and a 200 m² fragment floor bring it to 4.0 MB with both loud bands kept,
  and the toggle reads "Road noise, 70 dB+" rather than implying an unshaded street was
  measured as quiet.
- **Known limit, documented not hidden:** with the network hard-blocked, MapLibre logs
  "Importing a module script failed" starting a worker from the blob URL G5 hands it. A
  GeoJSON overlay source is the first thing here to want more than one worker, which is
  why `offline-map.spec.ts` is clean and this is not. The overlay still paints from cache
  with its attribution, so `overlays.spec.ts` tolerates exactly those two messages and
  fails on any other page error. Serving the worker from a real same-origin URL is the
  real fix — G5/G7-shaped follow-up, not part of this goal.

---

# G11 — Desktop — done 2026-09-11

Task breakdown: `docs/TASKS-G11.md` (teammates draw-accuracy on `src`, perf-probe on tests
and config, goals-author keeping the ledger).

All nine `done_when` commands exit 0, re-run independently by the lead at 3631262 after the
implementers' own runs: the five grep probes, `npm run build`, the unit suite 88/88, the
`mobile` project 33/33 at `retries=0` twice consecutively, and the `desktop` project 32/32
at `--workers=1 retries=0`, inside the predicted 191 s band. The mobile line passing with
none of its assertions edited is the "mobile 390x844 first, not mobile only" invariant on
the record rather than asserted.

What shipped: the rating sheet and queued banner capped and centred instead of spanning the
window (measured 1440 px wide at 1440x900 before); Escape resetting session state rather
than only Terra Draw's store, with a `cancel-drawing` control so a polygon draw has an exit;
`dragRotate` and `touchPitch` disabled, since one stray right-drag took bearing to -146.7
and pitch to 60 with no way back; keyboard operation of the rating sheet; `pointer` over
saved geometry; and a `desktop` Playwright project over the suites made input-agnostic by a
shared tap helper.

Three things worth surfacing here:

- **The `done_when` desktop line carries `--workers=1`**, amended 2026-09-11 with a dated
  note in `docs/OBJECTIVES.md` § G11 on perf-probe's measurements: 5 workers gave 32/32 then
  3 failures, 2 workers 32/32 then 2 then 2, 1 worker five deterministic runs once the
  `perf-load` assertion defect (fixed in b46323d) is excluded. Not a weakened check — no
  assertion, threshold or timeout moved, and a gate that stops failing on machine contention
  fails only on merit.
- **A causal claim was retracted mid-goal.** The `preventScroll` line shipped with a comment
  and a commit message attributing a `draw-precision` failure to it. draw-accuracy raised
  against their own evidence that every comparison varied configuration and the suspect line
  together, so nothing was isolated; perf-probe's later run of the missing cell was green.
  The fix stands on mechanism, the attribution is retracted, and causation is unresolved and
  immaterial — the configuration it appeared in is no longer any gate's configuration. The
  comment was rewritten to the mechanism alone (3631262); the retracted wording survives only
  in cb80aaf's immutable message, and `docs/TASKS-G11.md` is the correction of record.
- **One anomalous count is recorded, not dropped.** The lead's first mobile run reported 32
  passed where 33 tests exist, with output truncated to one line so it cannot be
  reconstructed. Two clean `retries=0` mobile runs at 33/33 followed. Evidence of nothing,
  kept because an unexplained number that nobody can reconstruct is what quietly disappears.

`docs/TASKS-G11.md` also carries a reading note earned the hard way: the boxes are a ledger,
not a status board, an unticked box means "not yet recorded" rather than "not yet done", and
status comes from asking the owner rather than from the file, a free lock, or the branch.
