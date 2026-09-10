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

# G1 — Map shell

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

## [ ] Task 4 — Centre on me

**Files:**
- Modify: `src/map/MapShell.tsx`
- Test: `tests/e2e/map-shell.spec.ts`

**Interfaces:**
- Consumes: the `MapShell` component from Task 3, and the `geolocation` permission and pinned position from `playwright.config.ts` in Task 2.
- Produces: a `areamap:geolocate` DOM `CustomEvent` on `window`, carrying `{ latitude, longitude }`, dispatched when MapLibre's `GeolocateControl` emits `geolocate`.

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test:e2e -- tests/e2e/map-shell.spec.ts
```

Expected: two FAILs — no `.maplibregl-ctrl-geolocate` in the DOM.

- [ ] **Step 3: Add the control**

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

- [ ] **Step 4: Lift the controls clear of the home indicator**

Append to `src/index.css`:

```css
.maplibregl-ctrl-bottom-right {
  padding-bottom: calc(env(safe-area-inset-bottom) + 1rem);
  padding-right: 0.75rem;
}
```

- [ ] **Step 5: Run the tests and the build**

```bash
npm run test:e2e -- tests/e2e/map-shell.spec.ts
npm run build
```

Expected: six PASS, build exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: centre-on-me control in thumb reach"
```

---

## [ ] Task 5 — Close out G1

No new behaviour. Runs the goal's exit criteria exactly as written and records
the result.

**Files:**
- Modify: `docs/TASKS.md`

- [ ] **Step 1: Run every `done_when` command from `docs/OBJECTIVES.md` § G1, unmodified**

```bash
npm run build
echo "build exit: $?"
npm run test:e2e -- tests/e2e/map-shell.spec.ts
echo "e2e exit: $?"
```

Both must print `exit: 0`. If either fails, add tasks above and continue. Do not
edit an assertion to make it pass — `docs/TESTING.md` forbids it and so does
`docs/OBJECTIVES.md`.

- [ ] **Step 2: Confirm nothing out of scope was built**

```bash
ls src/ && grep -ril "supabase\|terra-draw\|serviceWorker" src/ tests/ || echo "no out-of-scope code: OK"
```

Expected: no matches. Drawing, Supabase, auth and offline caching are G1
`out_of_scope`.

- [ ] **Step 3: Mark the goal**

Change this section's heading to `# G1 — Map shell — done YYYY-MM-DD`, using the
real date, and set every Task 1–5 marker to `[x]`. Only then.

- [ ] **Step 4: Commit**

```bash
git add docs/TASKS.md
git commit -m "docs: G1 map shell complete"
```
