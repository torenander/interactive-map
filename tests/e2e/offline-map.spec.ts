import { test, expect, type Page } from '@playwright/test'

// G5: the London basemap must be usable with no connectivity, after one warm
// (online) load. See docs/TASKS-G5.md for the caching mechanism — src/sw.ts
// caches the entire pmtiles file the first time any byte range from it is
// requested (pmtiles itself only ever asks for ranges, never the whole file —
// see the file for the trace through node_modules/pmtiles), then serves every
// subsequent range from that cached copy via workbox-range-requests.

async function paintedFeatureCount(page: Page) {
  const handle = await page.waitForFunction(
    () => {
      const map = (
        window as unknown as {
          __map?: { isStyleLoaded(): boolean; queryRenderedFeatures(): unknown[] }
        }
      ).__map
      if (!map || !map.isStyleLoaded()) return 0
      const n = map.queryRenderedFeatures().length
      return n > 0 ? n : 0
    },
    undefined,
    { timeout: 30_000 },
  )
  return handle.jsonValue()
}

test('map renders tiles with the network blocked after one warm load', async ({ page, context }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  // Warm load: registers the service worker, and — because pmtiles has to
  // fetch at least one byte range to paint anything at all — forces
  // src/sw.ts to cache the *entire* london.pmtiles file before the first
  // tile can even be decoded (see the mechanism note above).
  await page.goto('/')
  await page.waitForFunction(() => window.location.hash.length > 1)
  const warmCount = await paintedFeatureCount(page)
  expect(warmCount).toBeGreaterThan(0)

  // One more online reload, waiting for tiles to paint *again*, so this page
  // is actually SW-controlled (mirrors the check in scripts/assert-pwa.mjs)
  // and — critically — so the pmtiles route in src/sw.ts has actually
  // finished caching the full file before the network is cut. The first
  // warm load above can't be SW-controlled at all (a service worker never
  // intercepts the load that first registers it), so nothing gets cached
  // until this second, controlled pass.
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => window.location.hash.length > 1)
  await paintedFeatureCount(page)

  // Neither of Playwright's two usual "go offline" mechanisms works cleanly
  // here in WebKit (this project's mobile project — see playwright.config.ts):
  // context.setOffline(true) makes WebKit itself throw an internal error on
  // the next navigation, and aborting the navigation request via
  // context.route crashes WebKit's inspector ("Blocked by Web Inspector").
  // Let the top-level navigation request through — the service worker
  // intercepts it before it reaches the real network regardless of Playwright
  // routing — and hard-block every other request. `blob:` URLs (MapLibre's
  // worker script, see src/map/MapShell.tsx) never touch the network at all
  // and must stay unblocked too, or WebKit throws that same inspector error
  // trying to abort a request that was never a network request to begin
  // with. Any tile, glyph or sprite fetch the service worker cannot answer
  // from Cache Storage genuinely fails.
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (route.request().isNavigationRequest() || url.startsWith('blob:')) {
      void route.continue()
      return
    }
    void route.abort()
  })

  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => window.location.hash.length > 1)

  const offlineCount = await paintedFeatureCount(page)
  expect(offlineCount).toBeGreaterThan(0)
  expect(pageErrors).toEqual([])
})
