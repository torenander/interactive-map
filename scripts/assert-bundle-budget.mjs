#!/usr/bin/env node
// G7 done_when probe: the critical-path JavaScript budget.
//
// "Critical path" means the entry module plus every chunk the browser is told
// to fetch before it can run anything — i.e. `<script src>` and
// `<link rel="modulepreload">` in the built index.html. Chunks reached only
// through a dynamic `import()` are deliberately excluded: moving Terra Draw
// and the Supabase client behind one is the entire point of the goal, and a
// budget that counted them anyway would be unmovable.
//
// `rel="preload"` links are also excluded, and that is not an oversight.
// vite.config.ts injects one for the MapLibre worker so its fetch overlaps
// module evaluation (docs/OBJECTIVES.md § G7). That file is fetched by the
// worker, never evaluated on the main thread, so charging it to the
// main-thread budget would penalise the very fix the goal asks for.
//
// Usage:
//   node scripts/assert-bundle-budget.mjs        # checks ./dist
//   DIST_DIR=dist-other node scripts/assert-bundle-budget.mjs
//
// Exits 0 only if the total is within budget and no forbidden marker appears.

import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const DIST = process.env.DIST_DIR || 'dist'

// Measured, not guessed. Today's single chunk is 440,217 B gzip. A real split
// with Terra Draw and Supabase dynamically imported measures
// maplibre 275,740 + react 67,517 + app 19,673 = 362,930 B, so this leaves
// ~17 KB of headroom. Static `manualChunks` alone still totals 441,503 B and
// fails here — the budget is what forces genuine deferral over cosmetic
// chunking. See docs/TASKS-G7.md § Measured baselines.
const GZIP_BUDGET = 380_000

// Strings that only each library's own code can produce, so a hit means the
// dependency itself was bundled here rather than merely named.
//
// 'TerraDraw' was the obvious marker and was wrong: destructuring the dynamic
// import (`const { TerraDraw, ... } = await import('terra-draw')`) leaves the
// export names in the importing chunk, so the check failed while terra-draw
// sat correctly in its own chunk. An internal error message cannot be produced
// that way. Whatever replaces these must keep that property — a marker that a
// caller can write by accident tests nothing.
const FORBIDDEN = [
  ['Terra Draw is not enabled', 'terra-draw must load after the map exists'],
  ['GoTrueClient', '@supabase/supabase-js must load off the pre-map path'],
]

const html = readFileSync(join(DIST, 'index.html'), 'utf8')

// index.html paths are absolute and carry the deploy base (VITE_BASE, '/' by
// default, '/interactive-map/' on GitHub Pages). Strip whatever prefix the
// entry script shows so lookups resolve inside DIST regardless of base.
const base = (html.match(/src="([^"]*\/)assets\//) || [, '/'])[1]
const toDistPath = (url) => url.replace(base, '').replace(/^\//, '')

const critical = [
  ...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g),
]
  .map((m) => toDistPath(m[1]))
  // registerSW.js is vite-plugin-pwa's registration shim, a few hundred bytes
  // that must stay in the document for the service worker to install at all.
  .filter((p) => !p.includes('registerSW'))

if (critical.length === 0) {
  console.error(`FAIL: no critical-path scripts found in ${DIST}/index.html — did the build run?`)
  process.exit(1)
}

const failures = []
let total = 0

for (const path of critical) {
  const buf = readFileSync(join(DIST, path))
  const gzipped = gzipSync(buf).length
  total += gzipped
  const source = buf.toString('utf8')
  for (const [marker, why] of FORBIDDEN) {
    if (source.includes(marker)) failures.push(`${path} contains "${marker}" — ${why}`)
  }
  console.log(`  ${String(gzipped).padStart(7)} B gzip  ${path}`)
}

console.log(`critical-path JS: ${total} B gzip (budget ${GZIP_BUDGET})`)
if (total > GZIP_BUDGET) {
  failures.push(`critical-path JS ${total} B gzip exceeds the ${GZIP_BUDGET} B budget`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`)
  process.exit(1)
}
console.log('PASS')
