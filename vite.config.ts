import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Optional. Unset (default) keeps every path root-relative ('/'), matching
// local dev, the preview server and every existing test unchanged. Set at
// build time for a subpath static-host deploy (e.g. GitHub Pages project
// site at /<repo>/) — see docs/DEPLOY.md § GitHub Pages. Must end with '/'.
const BASE = process.env.VITE_BASE || '/'

// G7: announce the MapLibre worker in the document head so its fetch overlaps
// module evaluation instead of queueing behind it.
//
// src/map/MapShell.tsx blocks the whole module graph on resolving the worker
// (a load-bearing Vite 8 workaround — see the comment there; the map must
// never be created against an unresolved worker URL). That made the worker's
// ~500KB fetch strictly sequential after the entry chunk: measured on the
// deployed build, the entry finished at 963ms, the worker ran 1082-1329ms, and
// the first tile range request only went out at 1820ms.
//
// The filename is content-hashed, so the link cannot be written by hand in
// index.html — it is read out of the emitted bundle instead. `as="fetch"`
// rather than `as="script"` because MapShell fetches the file with `fetch()`
// and hands MapLibre a blob URL; the preload has to match that request's type
// or the browser downloads it twice.
function preloadMapLibreWorker(): Plugin {
  return {
    name: 'areamap:preload-maplibre-worker',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const fileName = Object.keys(ctx.bundle ?? {}).find((name) =>
          /maplibre-gl-worker.*\.js$/.test(name),
        )
        if (!fileName) return html
        return {
          html,
          tags: [
            {
              tag: 'link',
              attrs: {
                rel: 'preload',
                as: 'fetch',
                crossorigin: 'anonymous',
                href: `${BASE}${fileName}`,
              },
              injectTo: 'head-prepend',
            },
          ],
        }
      },
    },
  }
}

export default defineConfig({
  base: BASE,
  plugins: [
    preloadMapLibreWorker(),
    react(),
    tailwindcss(),
    VitePWA({
      // injectManifest (not generateSW): the pmtiles range-caching route in
      // src/sw.ts needs a real handler function (fetch-once, dedupe concurrent
      // fetches, slice via workbox-range-requests) that config-driven
      // runtimeCaching entries can't express.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: 'auto',
      registerType: 'autoUpdate',
      injectManifest: {
        // london.pmtiles lives under public/tiles and is *never* matched by this
        // glob (wrong extension, on purpose) — see docs/TASKS-G5.md. Precaching a
        // 125MB file blows storage quotas and fails silently.
        globPatterns: ['**/*.{js,css,html,ico,svg,png}'],
        // MapLibre's bundle alone exceeds Workbox's 2MB default per-file cap.
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
      manifest: {
        name: 'areamap',
        short_name: 'areamap',
        description: 'Personal map annotation tool for rating London neighbourhoods',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        theme_color: '#111827',
        background_color: '#f8f6f2',
        icons: [
          { src: `${BASE}pwa-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${BASE}pwa-512.png`, sizes: '512x512', type: 'image/png' },
        ],
      },
      devOptions: {
        // Service worker only matters for the built app (assert-pwa.mjs and
        // offline-map.spec.ts both run against `vite preview`), not `vite dev`.
        enabled: false,
      },
    }),
  ],
})
