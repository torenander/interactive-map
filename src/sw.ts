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
// London basemap tiles: range-request caching, non-blocking.
//
// pmtiles' FetchSource (node_modules/pmtiles/dist/esm/index.js) issues plain
// `fetch(url, { headers: { range: 'bytes=<start>-<end>' } })` calls — a 16KB
// header read, then directory reads, then per-tile reads. There is no single
// "give me the whole file" request from the library itself.
//
// Strategy (revised — see docs/TASKS-FIX-SW.md): a warm cache answers every
// range request instantly by slicing the cached full file via
// workbox-range-requests, exactly as before. But a *cold* cache no longer
// makes the request wait for a ~125MB download first — it passes the range
// request straight through to the network, unchanged from pre-SW behaviour,
// and separately kicks off (or joins) a single background full-file fetch
// that fills the cache for every request after it. First paint on a cold
// cache — first visit, or any visit after eviction — is therefore as fast as
// it would be with no service worker at all; the offline guarantee still
// holds once that background fill completes.
//
// A `Response` body can only be read once. An earlier version of this
// handler awaited one shared in-flight fetch and handed every concurrent
// range request the *same* fetched Response object; the second reader always
// failed (surfacing as a 416 from workbox-range-requests, whose
// `createPartialResponse` swallows the read error into that status). This
// version never shares a Response across requests: each range request that
// misses the cache gets its own independent `fetch(request)`, and the
// background fill is a separate fetch entirely, consumed only by
// `cache.put`. The in-flight map here dedupes concurrent background-fill
// *triggers* (so a burst of cold range requests starts one download, not
// dozens), not response bodies.
const PMTILES_CACHE = 'pmtiles-v1'
const pmtilesInflight = new Map<string, Promise<void>>()

// Cross-origin production tiles: VITE_TILES_URL, when set at build time,
// points at the Supabase Storage public bucket object serving
// london.pmtiles — a different origin than the app shell. vite-plugin-pwa's
// injectManifest strategy builds this file with Vite, so import.meta.env is
// resolved to a literal at build time same as any other module. Matching on
// the exact configured URL (rather than widening the path pattern) keeps the
// route from picking up unrelated cross-origin *.pmtiles requests.
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

// Fire-and-forget: fills the cache in the background, deduping concurrent
// triggers for the same URL onto one download. Never awaited by the request
// handler below — that would reintroduce the blocking behaviour this fix
// removes. Broadcasts a `tiles-cached` message once the file is fully cached
// so tests (and, eventually, UI) can observe completion without polling.
function warmPmtilesCache(url: string, cache: Cache): void {
  if (pmtilesInflight.has(url)) return
  const pending = (async () => {
    // A fresh Request with no Range header — we want the whole file. Explicit
    // 'cors' mode: for the cross-origin production case (Supabase Storage
    // public bucket) this must be a readable response, not opaque — an
    // opaque response's body can't be sliced by workbox-range-requests, so
    // caching one would leave every subsequent range request permanently
    // broken. Same-origin requests are unaffected by the explicit mode.
    const response = await fetch(new Request(url), { mode: 'cors' })
    if (!response.ok) throw new Error(`pmtiles background fetch failed: ${response.status}`)
    if (response.type === 'opaque') {
      throw new Error(`pmtiles background fetch returned an opaque response for ${url}`)
    }
    await cache.put(url, response)
    await notifyClients({ type: 'tiles-cached', url })
  })()
  pmtilesInflight.set(url, pending)
  void pending.catch(() => {
    // Network unreachable or fetch failed — leave the cache as-is. The next
    // range request that misses the cache will retry this on its own.
  }).finally(() => pmtilesInflight.delete(url))
}

registerRoute(
  ({ url, request }) => request.method === 'GET' && isPmtilesRequest(url),
  async ({ request, url }) => {
    const cache = await caches.open(PMTILES_CACHE)
    const full = await cache.match(url.href)
    if (full) {
      // Warm cache: every range is answered instantly from the full file.
      return createPartialResponse(request, full)
    }
    // Cold cache: answer this request exactly like the network would, and
    // let a background fetch fill the cache for next time.
    warmPmtilesCache(url.href, cache)
    return fetch(request)
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
