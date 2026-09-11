// Gate for G10 (docs/OBJECTIVES.md): every overlay in the registry must resolve to a
// file that is actually here, carry an attribution, and name no host outside this app's
// origin.
//
// Usage: node scripts/assert-overlays.mjs
//
// The registry is TypeScript, so it is read as text and checked structurally rather than
// imported — this script has to run with no build step and no loader flags, the way the
// done_when calls it. The unit suite (tests/unit/overlays.test.ts) type-checks and
// exercises the same registry as code; this is the part that looks at the filesystem and
// at what the strings actually say.

import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const registryPath = join(root, 'src/map/overlays.ts')
const publicDir = join(root, 'public')

const failures = []
const fail = (message) => failures.push(message)

let registry
try {
  registry = readFileSync(registryPath, 'utf8')
} catch {
  console.error(`assert-overlays: cannot read ${registryPath}`)
  process.exit(1)
}

// One entry per `id:` in the OVERLAYS array. Splitting on the id keeps each entry's
// fields together, so a missing attribution is attributed to the right overlay.
const entryBlocks = registry
  .split(/\n\s*\{\s*\n(?=\s*id:)/)
  .slice(1)
  .map((block) => block.split(/\n\s*\},\s*\n(?=\s*\{|\s*\])/)[0])

const entries = entryBlocks.map((block) => ({
  id: /id:\s*'([^']+)'/.exec(block)?.[1],
  label: /label:\s*'([^']*)'/.exec(block)?.[1],
  source: /source:\s*'([^']*)'/.exec(block)?.[1],
  attribution: /attribution:\s*\n?\s*'([^']*)'/.exec(block)?.[1],
  block,
}))

if (entries.length === 0) {
  fail('no overlay entries found in src/map/overlays.ts — has the registry shape changed?')
}

// Hosts the goal forbids in the runtime path, and the generic case: any absolute URL.
// Overlay data is fetched by scripts/fetch-overlays.sh at build time and served from
// this origin, so nothing in the registry should point off-origin.
const EXTERNAL_HOST = /https?:\/\/[^\s'"]+/i

for (const entry of entries) {
  const name = entry.id ?? '(unnamed entry)'

  if (!entry.id) fail(`${name}: no id`)
  if (!entry.label?.trim()) fail(`${name}: no label`)

  if (!entry.attribution?.trim()) {
    fail(`${name}: no attribution — every source here is attribution-required`)
  }

  if (!entry.source) {
    fail(`${name}: no source path`)
  } else if (EXTERNAL_HOST.test(entry.source) || !entry.source.startsWith('/overlays/')) {
    fail(`${name}: source ${entry.source} is not a path under /overlays/ on this origin`)
  } else {
    const file = join(publicDir, entry.source)
    let size = -1
    try {
      size = statSync(file).size
    } catch {
      fail(`${name}: ${entry.source} is missing — run scripts/fetch-overlays.sh`)
    }
    if (size === 0) {
      fail(`${name}: ${entry.source} is empty — the fetch did not complete`)
    } else if (size > 0) {
      // An overlay nobody can download on a phone is not a working overlay. The basemap
      // is 53 MB and precached deliberately; these are fetched on demand, so the ceiling
      // is far lower.
      const MAX_BYTES = 12_000_000
      if (size > MAX_BYTES) {
        fail(
          `${name}: ${entry.source} is ${(size / 1e6).toFixed(1)} MB, over the ${
            MAX_BYTES / 1e6
          } MB budget for an on-demand overlay`,
        )
      }
      console.log(`ok   ${name}: ${entry.source} (${(size / 1e6).toFixed(2)} MB)`)
    }
  }

  const offOrigin = entry.block.match(EXTERNAL_HOST)
  if (offOrigin) {
    fail(`${name}: registry entry names an external host: ${offOrigin[0]}`)
  }
}

if (failures.length > 0) {
  console.error(`\nassert-overlays: ${failures.length} problem(s)`)
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}

console.log(`\nassert-overlays: ${entries.length} overlays, all present and attributed`)
