/// <reference lib="webworker" />
// G5 — installable PWA with an offline basemap. See docs/TASKS-G5.md for the
// mechanism write-up. This file is the injectManifest source for
// vite-plugin-pwa: it is bundled as-is into the built service worker, with
// `self.__WB_MANIFEST` replaced by the precache list at build time.

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import { createPartialResponse } from 'workbox-range-requests'

declare let self: ServiceWorkerGlobalScope

self.skipWaiting()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Take control of already-open clients immediately on activate, so a reload
// right after install is served by this worker rather than the network —
// this is what scripts/assert-pwa.mjs's controller check requires.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// ---------------------------------------------------------------------------
// London basemap tiles: per-range caching.
//
// pmtiles' FetchSource (node_modules/pmtiles/dist/esm/index.js) issues plain
// `fetch(url, { headers: { range: 'bytes=<start>-<end>' } })` calls — a 16KB
// header read, then directory reads, then per-tile reads. It never asks for
// the whole file.
//
// Strategy (G7; supersedes the background full-file fill described in
// docs/TASKS-FIX-SW.md). Each range response is cached under its own key, so
// the cache grows to exactly what has been looked at — about 1MB for one
// viewport against the archive's 55.9MB. The previous design fetched the
// entire archive in the background on every service-worker-controlled load
// with a cold cache, which cost more than it ever returned: measured over a
// 10Mbps link it did not complete within 90s, `cache.put` only runs once the
// whole body has arrived, so a visit that ended first cached nothing and the
// next one started again from zero — all while competing for bandwidth with
// the ranges the map was actually waiting on. See docs/TASKS-G7.md.
//
// The offline guarantee is unchanged in substance: whatever has been viewed
// online stays viewable offline, which is what tests/e2e/offline-map.spec.ts
// exercises. Pre-loading the whole archive is still available, but only when
// something explicitly asks for it — see the `prefetch-tiles` message below.
const PMTILES_CACHE = 'pmtiles-v1'

// Cross-origin production tiles: VITE_TILES_URL, when set at build time,
// points at the pmtiles archive served from the deploy's own origin (or a
// storage bucket). vite-plugin-pwa's injectManifest strategy builds this file
// with Vite, so import.meta.env is resolved to a literal at build time same as
// any other module. Matching on the exact configured URL (rather than widening
// the path pattern) keeps the route from picking up unrelated *.pmtiles
// requests.
const CONFIGURED_TILES_URL = (import.meta.env.VITE_TILES_URL as string | undefined)?.trim()

function isPmtilesRequest(url: URL): boolean {
  if (CONFIGURED_TILES_URL && url.href === CONFIGURED_TILES_URL) return true
  // Fallback: same-origin /tiles/*.pmtiles — local dev and every existing
  // test use this unchanged default (VITE_TILES_URL unset).
  return url.pathname.endsWith('.pmtiles')
}

async function notifyClients(message: { type: string; url: string }) {
  const clients = await self.clients.matchAll({ type: 'window' })
  for (const client of clients) client.postMessage(message)
}

// Cache Storage keys on URL alone — it ignores request headers — so the byte
// range has to be folded into the key itself, or every range would overwrite
// the last. The suffix is a synthetic query parameter: it never reaches the
// network, only `cache.match`/`cache.put`.
function rangeCacheKey(url: string, range: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}__range=${encodeURIComponent(range)}`
}

// `cache.put` rejects a 206 outright ("Partial response (status code 206) is
// unsupported"), so the range's bytes are stored under a 200 carrying the
// original headers. That is not a workaround that costs correctness: pmtiles
// accepts a 200 as long as Content-Length does not exceed what it asked for
// (FetchSource.getBytes), and preserving the headers keeps the ETag it uses to
// detect an archive changing underneath it.
function toCacheableResponse(response: Response, body: ArrayBuffer): Response {
  const headers = new Headers(response.headers)
  headers.set('content-length', String(body.byteLength))
  return new Response(body, { status: 200, statusText: 'OK', headers })
}

registerRoute(
  ({ url, request }) => request.method === 'GET' && isPmtilesRequest(url),
  async ({ request, url }) => {
    const cache = await caches.open(PMTILES_CACHE)
    const range = request.headers.get('range')

    // No Range header at all: either something explicitly prefetched the whole
    // archive earlier, or this is a bare request for it. Serve the full file
    // when it is there; otherwise pass straight through.
    if (!range) {
      const whole = await cache.match(url.href)
      return whole ?? fetch(request)
    }

    // A whole-archive entry, if one exists from an explicit prefetch, answers
    // every range by slicing — cheaper than holding both representations.
    const whole = await cache.match(url.href)
    if (whole) return createPartialResponse(request, whole)

    const key = rangeCacheKey(url.href, range)
    const hit = await cache.match(key)
    if (hit) return hit

    const response = await fetch(request)
    if (!response.ok) return response

    // Cache before returning rather than in the background. The write is a few
    // hundred KB and it removes a race that matters: offline-map.spec.ts reads
    // the cache the moment tiles paint, and a paint that outran its own cache
    // write would leave the next offline load short of the bytes it needs.
    const body = await response.clone().arrayBuffer()
    await cache.put(key, toCacheableResponse(response, body))
    return response
  },
)

// ---------------------------------------------------------------------------
// Open-data overlays (G10): same posture as the basemap — cache-first, served
// from this origin, usable with no connectivity once they have been fetched
// once. They are deliberately *not* precached: the three files together are
// several megabytes, all three are off by default, and precaching them would
// make every install pay for data most sessions never turn on.
//
// CacheFirst rather than the hand-rolled handler the tiles need: these are
// whole-file GETs with no Range header, so Workbox's strategy is exactly right.
// The expiration plugin caps the cache rather than the age — an overlay a user
// keeps switched on should not stop working offline because a month passed,
// but a registry that grows should not grow the cache without limit either.
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' &&
    url.origin === self.location.origin &&
    url.pathname.startsWith('/overlays/'),
  new CacheFirst({
    cacheName: 'overlays-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 12 }),
    ],
  }),
)

// Opt-in whole-archive prefetch. Nothing calls this automatically — that is
// the point of G7 — but a client can post
// `{ type: 'prefetch-tiles', url }` to pull the entire archive down for a
// deliberate "make this available offline" action, and gets a `tiles-cached`
// message back when it lands. The in-flight map dedupes concurrent triggers
// onto one download; it never shares a Response body, since a body can only be
// read once and an earlier version of this file surfaced that as a 416.
const pmtilesInflight = new Map<string, Promise<void>>()

function prefetchWholeArchive(url: string): void {
  if (pmtilesInflight.has(url)) return
  const pending = (async () => {
    const cache = await caches.open(PMTILES_CACHE)
    if (await cache.match(url)) return
    // Explicit 'cors' mode: for a cross-origin archive this must be a readable
    // response, not opaque — an opaque body cannot be sliced by
    // workbox-range-requests, so caching one would leave every subsequent
    // range request permanently broken.
    const response = await fetch(new Request(url), { mode: 'cors' })
    if (!response.ok) throw new Error(`pmtiles prefetch failed: ${response.status}`)
    if (response.type === 'opaque') {
      throw new Error(`pmtiles prefetch returned an opaque response for ${url}`)
    }
    await cache.put(url, response)
    await notifyClients({ type: 'tiles-cached', url })
  })()
  pmtilesInflight.set(url, pending)
  void pending
    .catch(() => {
      // Network unreachable or fetch failed — leave the cache as-is. Ranges
      // still resolve individually; only the offline-everything promise is
      // unmet, and the client can ask again.
    })
    .finally(() => pmtilesInflight.delete(url))
}

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; url?: string } | null
  if (data?.type !== 'prefetch-tiles') return
  const url = data.url ?? CONFIGURED_TILES_URL
  if (url) prefetchWholeArchive(new URL(url, self.location.href).href)
})

// ---------------------------------------------------------------------------
// Glyphs and sprites: needed for label rendering offline, fetched from
// protomaps.github.io. Plain whole-file GETs, no Range handling required.
registerRoute(
  ({ url }) => url.origin === 'https://protomaps.github.io',
  new CacheFirst({
    cacheName: 'basemap-assets',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
)
