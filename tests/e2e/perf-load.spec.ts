import { test, expect } from '@playwright/test'

// G7 done_when probe: the two load-path guarantees, measured rather than
// eyeballed. Both assertions are structural — a count and an ordering — not
// wall-clock budgets, so they mean the same thing on a loaded CI box as on a
// laptop. See docs/OBJECTIVES.md § G7 and docs/TASKS-G7.md for the measured
// baselines that justify them.

type ResourceSnapshot = {
  workerFetches: number
  workerStart: number | null
  entryEnd: number | null
}

test('no whole-archive download, and the worker is not serialized behind the app shell', async ({
  page,
}) => {
  // Best-effort network view. WebKit — this project's only Playwright
  // project, see playwright.config.ts — does not surface service-worker
  // originated requests to page.on('request'), so this list stays empty here
  // even when the worker is pulling the whole archive down. It is kept
  // because it is exact under Chromium (scripts/assert-pwa.mjs's engine) and
  // costs nothing; the assertion that actually holds the line is the cached
  // byte count below, which is observable in every engine.
  const rangelessTileRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('.pmtiles') && !request.headers()['range']) {
      rangelessTileRequests.push(request.url())
    }
  })

  // First load registers the service worker; a service worker never
  // intercepts the load that registers it, so the reload below is the first
  // request src/sw.ts's pmtiles route actually sees.
  await page.goto('/')
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 30_000,
  })

  rangelessTileRequests.length = 0
  await page.reload({ waitUntil: 'commit' })
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
      return Boolean(map?.isStyleLoaded())
    },
    undefined,
    { timeout: 30_000 },
  )
  // A background prefetch would start during the load, not after it; give it
  // room to show up rather than racing the assertion past it.
  await page.waitForTimeout(3_000)

  expect(rangelessTileRequests).toEqual([])

  // The real gate: how many bytes src/sw.ts put in Cache Storage to paint one
  // viewport. pmtiles only ever asks for byte ranges, so a cache holding
  // anything near the archive's 55.9 MB can only mean the worker downloaded
  // the whole file — the 55.9 MB that competes with the ranges the map is
  // waiting on, and that is thrown away entirely if the visit ends before it
  // finishes. Caching per range costs ~1 MB for the same paint. The bound is
  // deliberately far from both numbers so it discriminates architecture, not
  // viewport luck.
  const cachedTileBytes = await page.evaluate(async () => {
    const cache = await caches.open('pmtiles-v1')
    let total = 0
    for (const request of await cache.keys()) {
      const response = await cache.match(request)
      if (response) total += (await response.blob()).size
    }
    return total
  })
  expect(cachedTileBytes, 'no tile bytes cached at all — offline would break').toBeGreaterThan(0)
  expect(cachedTileBytes, 'whole archive cached instead of individual ranges').toBeLessThan(
    10_000_000,
  )

  const { workerFetches, workerStart, entryEnd }: ResourceSnapshot = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource')
    const workers = entries.filter((entry) => entry.name.includes('maplibre-gl-worker'))
    const entry = entries.find((resource) => /assets\/index-.*\.js$/.test(resource.name))
    return {
      workerFetches: workers.length,
      workerStart: workers.length > 0 ? Math.round(workers[0].startTime) : null,
      entryEnd: entry ? Math.round(entry.responseEnd) : null,
    }
  })

  expect(workerStart, 'maplibre-gl-worker was never fetched').not.toBeNull()
  expect(entryEnd, 'entry chunk was never fetched').not.toBeNull()
  // Exactly one fetch, not just an early one. A document preload that the
  // application's own `fetch()` does not reuse would satisfy the ordering
  // assertion below while quietly downloading the worker twice — measured at
  // two entries starting 50ms and 84ms when the preload's credentials mode
  // does not match. Announcing the worker and consuming that announcement are
  // one change; this holds them together.
  expect(workerFetches, 'maplibre-gl-worker fetched more than once').toBe(1)
  // The worker must be discoverable from the document rather than only from
  // the evaluated module graph. src/map/MapShell.tsx blocks the whole app on
  // resolving it (a load-bearing Vite 8 workaround — the map must never be
  // created against an unresolved worker URL), so if the document does not
  // announce it the fetch cannot start until the entry chunk has finished.
  expect(workerStart as number).toBeLessThanOrEqual(entryEnd as number)
})
