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
// London basemap tiles: range-request caching.
//
// pmtiles' FetchSource (node_modules/pmtiles/dist/esm/index.js) issues plain
// `fetch(url, { headers: { range: 'bytes=<start>-<end>' } })` calls — a 16KB
// header read, then directory reads, then per-tile reads. There is no single
// "give me the whole file" request from the library itself.
//
// Strategy: on the first range request for a given .pmtiles URL, ignore the
// incoming Range header and fetch the whole file once as a plain 200,
// caching it under the plain URL. Every request (including the one that
// triggered the fetch) is then answered by slicing that cached full response
// per its own Range header via workbox-range-requests. Concurrent range
// requests that arrive before the first fetch resolves share one in-flight
// promise instead of each starting their own 125MB download.
//
// A `Response` body can only be read once. A tile-heavy warm load fires
// dozens of concurrent range requests for the same URL, all racing on the
// same in-flight fetch — an earlier version of this handler handed every
// one of them the *same* fetched Response object, and the second reader
// always failed (surfacing as a 416 from workbox-range-requests, whose
// `createPartialResponse` swallows the read error into that status). The
// fix: the in-flight promise only signals "the cache entry exists now";
// every caller — including the one that triggered the fetch — gets its own
// fresh `Response` via a separate `cache.match()` afterwards.
const PMTILES_CACHE = 'pmtiles-v1'
const pmtilesInflight = new Map<string, Promise<boolean>>()

async function getOrFetchFullPmtiles(url: string, cache: Cache): Promise<Response | null> {
  const cached = await cache.match(url)
  if (cached) return cached

  let pending = pmtilesInflight.get(url)
  if (!pending) {
    pending = (async () => {
      // A fresh Request with no Range header — we want the whole file.
      const response = await fetch(new Request(url))
      if (!response.ok) return false
      await cache.put(url, response)
      return true
    })()
    pmtilesInflight.set(url, pending)
    void pending.finally(() => pmtilesInflight.delete(url))
  }

  const cachedOk = await pending.catch(() => false)
  if (!cachedOk) return null
  return (await cache.match(url)) ?? null
}

registerRoute(
  ({ url, request }) => request.method === 'GET' && url.pathname.endsWith('.pmtiles'),
  async ({ request, url }) => {
    const cache = await caches.open(PMTILES_CACHE)
    const full = await getOrFetchFullPmtiles(url.href, cache)
    if (!full) {
      // Network unreachable and nothing cached yet — let the request fail
      // normally rather than fabricate a response.
      return fetch(request)
    }
    return createPartialResponse(request, full)
  },
)

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
