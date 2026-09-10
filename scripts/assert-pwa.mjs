#!/usr/bin/env node
// G5 done_when probe. Replaces the Lighthouse `--only-categories=pwa` run that
// docs/OBJECTIVES.md's 2026-09-10 amendment notes cannot execute at all on
// Lighthouse v12+ (the PWA category was removed). This is a direct check
// against the built app instead of a piped audit tool.
//
// Usage:
//   node scripts/assert-pwa.mjs                 # builds against http://localhost:4173 (default)
//   node scripts/assert-pwa.mjs 4273             # a bare number is treated as a port on localhost
//   node scripts/assert-pwa.mjs http://localhost:4273
//   PREVIEW_PORT=4273 node scripts/assert-pwa.mjs
//
// Exits 0 only if every check below passes; each check's result is printed
// individually first.

import { spawn } from 'node:child_process'
import { chromium } from '@playwright/test'

const arg = process.argv[2]
const DEFAULT_PORT = 4173
const port = arg && /^\d+$/.test(arg) ? arg : process.env.PREVIEW_PORT || DEFAULT_PORT
const baseURL = arg && !/^\d+$/.test(arg) ? arg : `http://localhost:${port}`

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function isReachable(url) {
  try {
    const res = await fetch(url, { method: 'GET' })
    return res.ok || res.status === 304
  } catch {
    return false
  }
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isReachable(url)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function main() {
  let previewProcess = null
  const alreadyUp = await isReachable(baseURL)

  if (!alreadyUp) {
    console.log(`No server at ${baseURL} — starting \`vite preview --port ${port} --strictPort\``)
    previewProcess = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    const up = await waitForServer(baseURL)
    if (!up) {
      console.error(`Server at ${baseURL} never became reachable`)
      previewProcess.kill()
      process.exit(1)
    }
  } else {
    console.log(`Reusing already-running server at ${baseURL}`)
  }

  const browser = await chromium.launch()
  let exitCode = 0
  try {
    const context = await browser.newContext()
    const page = await context.newPage()

    // --- Manifest -----------------------------------------------------
    await page.goto(baseURL, { waitUntil: 'load' })

    const manifestHref = await page
      .locator('link[rel="manifest"]')
      .getAttribute('href')
      .catch(() => null)

    if (!manifestHref) {
      record('manifest link present in document head', false)
    } else {
      record('manifest link present in document head', true, manifestHref)
      const manifestUrl = new URL(manifestHref, baseURL).href
      const manifestRes = await page.request.get(manifestUrl)
      if (!manifestRes.ok()) {
        record('manifest link resolves (HTTP 200)', false, `status ${manifestRes.status()}`)
      } else {
        record('manifest link resolves (HTTP 200)', true)
        let manifest
        try {
          manifest = await manifestRes.json()
        } catch (err) {
          record('manifest is valid JSON', false, String(err))
          manifest = null
        }
        if (manifest) {
          record('manifest is valid JSON', true)
          record('manifest has non-empty name', typeof manifest.name === 'string' && manifest.name.length > 0, manifest.name)
          record('manifest start_url is set', typeof manifest.start_url === 'string' && manifest.start_url.length > 0, manifest.start_url)
          record(
            'manifest display is standalone or fullscreen',
            manifest.display === 'standalone' || manifest.display === 'fullscreen',
            manifest.display,
          )
          const icons = Array.isArray(manifest.icons) ? manifest.icons : []
          const sizeOf = (icon) => {
            const match = /^(\d+)x(\d+)$/i.exec(icon.sizes || '')
            if (!match) return 0
            return Math.min(Number(match[1]), Number(match[2]))
          }
          const has192 = icons.some((icon) => sizeOf(icon) >= 192)
          const has512 = icons.some((icon) => sizeOf(icon) >= 512)
          record('manifest has an icon >= 192x192', has192, icons.map((i) => i.sizes).join(', '))
          record('manifest has an icon >= 512x512', has512, icons.map((i) => i.sizes).join(', '))
        }
      }
    }

    // --- Service worker takes control ----------------------------------
    await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) throw new Error('serviceWorker unsupported')
      await navigator.serviceWorker.ready
      if (navigator.serviceWorker.controller) return
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(undefined), {
          once: true,
        })
      })
    })

    await page.reload({ waitUntil: 'load' })
    const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller))
    record('service worker controls the page after reload', controlled)

    // --- Offline shell ---------------------------------------------------
    await context.setOffline(true)
    let offlineOk = false
    let offlineDetail = ''
    try {
      const response = await page.reload({ waitUntil: 'load', timeout: 15_000 })
      offlineOk = Boolean(response && response.ok())
      offlineDetail = response ? `status ${response.status()}` : 'no response'
      if (offlineOk) {
        const rootAttached = await page.locator('#root').count()
        offlineOk = rootAttached > 0
        offlineDetail += rootAttached > 0 ? ', #root attached' : ', #root missing'
      }
    } catch (err) {
      offlineDetail = String(err)
    }
    record('reload with network blocked still serves the app shell', offlineOk, offlineDetail)
    await context.setOffline(false)

    exitCode = results.every((r) => r.pass) ? 0 : 1
  } finally {
    await browser.close()
    if (previewProcess) previewProcess.kill()
  }

  console.log('')
  console.log(
    exitCode === 0
      ? `All ${results.length} checks passed.`
      : `${results.filter((r) => !r.pass).length} of ${results.length} checks failed.`,
  )
  process.exit(exitCode)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
