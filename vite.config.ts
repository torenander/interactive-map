import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
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
        start_url: '/',
        display: 'standalone',
        theme_color: '#111827',
        background_color: '#f8f6f2',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
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
