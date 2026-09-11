import { test, expect } from '@playwright/test'

// G7 done_when probe: the two load-path guarantees, measured rather than
// eyeballed. Both assertions are structural — a count and an ordering — not
// wall-clock budgets, so they mean the same thing on a loaded CI box as on a
// laptop. See docs/OBJECTIVES.md § G7 and docs/TASKS-G7.md for the measured
// baselines that justify them.

type ResourceSnapshot = {
  workerFetches: number
  documentInitiated: boolean
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

  const { workerFetches, documentInitiated }: ResourceSnapshot = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource')
    const workers = entries.filter((entry) => entry.name.includes('maplibre-gl-worker'))
    return {
      workerFetches: workers.length,
      // vite.config.ts injects an inline head script that starts the worker fetch and
      // parks the promise here; src/map/MapShell.tsx awaits it instead of issuing its
      // own. Its presence is the document having initiated the fetch.
      documentInitiated:
        typeof (window as unknown as { __mapWorkerSource?: unknown }).__mapWorkerSource !==
        'undefined',
    }
  })

  // The claim is that the worker fetch is started by the document rather than
  // serialized behind the module graph — MapShell blocks the whole graph on resolving
  // it, so without the document announcing it, the fetch cannot begin until the entry
  // chunk has downloaded and evaluated. On the deployed build that gap was measured at
  // hundreds of milliseconds: entry finished at 963ms, the worker ran 1082-1329ms, and
  // the first tile range request only went out at 1820ms.
  //
  // This used to be asserted as `workerStart <= entryEnd`, which was the right idea
  // measured the wrong way. On localhost both resources come from the service worker
  // precache and land within a few milliseconds of each other, so the comparison was
  // reading scheduling noise: it failed once at 11ms against 10ms. A one-millisecond
  // inversion between two cache hits says nothing about whether the fetch was
  // serialized. Assert the mechanism instead of a proxy for it.
  expect(documentInitiated, 'the document did not start the worker fetch').toBe(true)
  // Exactly one fetch, not just an early one: a document-initiated fetch that MapShell
  // does not reuse would satisfy the check above while downloading the worker twice,
  // which is what a <link rel=preload> did before this mechanism replaced it.
  expect(workerFetches, 'maplibre-gl-worker fetched more than once').toBe(1)
})
