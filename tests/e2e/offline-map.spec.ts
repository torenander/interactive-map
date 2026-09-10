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

  // One more online reload so this page is actually SW-controlled (mirrors
  // the check in scripts/assert-pwa.mjs) before the network is cut.
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => window.location.hash.length > 1)

  // context.setOffline(true) does not reliably cut off requests to localhost
  // in WebKit — this project's mobile Playwright project runs WebKit (see
  // playwright.config.ts) — which would make this assertion pass for the
  // wrong reason (network never actually blocked). Hard-block every request
  // instead: a response the service worker can answer purely from Cache
  // Storage never touches the network layer at all, so cached responses
  // still get through while anything genuinely uncached is blocked, same as
  // a phone with no signal.
  await context.route('**/*', (route) => route.abort())

  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => window.location.hash.length > 1)

  const offlineCount = await paintedFeatureCount(page)
  expect(offlineCount).toBeGreaterThan(0)
  expect(pageErrors).toEqual([])
})
