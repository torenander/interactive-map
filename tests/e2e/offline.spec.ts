// G4 exit criteria (docs/OBJECTIVES.md): with the network blocked, drawing and saving
// shows queued state, not success; restoring the network flushes it and the area appears
// in the database exactly once.
//
// Driver note: this project's mobile profile is WebKit (devices['iPhone 14']).
// `context.setOffline()` is the load-bearing block here — it is what stands between
// "saved" and "queued" — and it is the only one.
//
// This comment used to claim the opposite: that `setOffline` was unreliable against
// localhost and that a `page.route(...).abort()` on the save-area call was doing the
// real work. Measured on 2026-09-11, both halves of that were wrong, and the route
// call was inert. `save-area` is invoked through `supabase.functions.invoke`, which
// the service worker mediates, and page-level route interception never sees a request
// the service worker handles. Isolating the two mechanisms:
//
//   setOffline only, route removed  -> passes (4.3s)
//   route only, setOffline removed  -> FAILS: the save reaches the server, no queued
//                                      banner appears
//
// So the route call is gone rather than left in as decoration. If you are writing
// another offline suite: reach for `context.setOffline()`, and do not assume
// `page.route` can block anything the service worker touches.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function readLocalSupabaseEnv(): Record<string, string> {
  const raw = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!match) continue
    env[match[1]] = match[2].replace(/^"(.*)"$/, '$1')
  }
  return env
}

let admin: SupabaseClient
let userId: string
const email = `offline-${randomUUID()}@example.com`
const password = 'correct-horse-battery-staple'

test.beforeAll(async () => {
  const env = readLocalSupabaseEnv()
  const apiUrl = env.API_URL ?? env.SUPABASE_URL
  admin = createClient(apiUrl, env.SERVICE_ROLE_KEY)
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user) throw error ?? new Error('test user not created')
  userId = data.user.id
})

test.afterAll(async () => {
  if (userId) {
    await admin.from('areas').delete().eq('user_id', userId)
    await admin.auth.admin.deleteUser(userId)
  }
})

async function signIn(page: Page) {
  await page.goto('/')
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()
  await page.waitForFunction(() => {
    const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
    return !!map && map.isStyleLoaded()
  })

  await page.getByTestId('open-sign-in').click()
  const form = page.getByTestId('sign-in-form')
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill(password)
  await form.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('open-sign-in')).toBeHidden()
}

async function drawPolygon(page: Page) {
  await page.getByTestId('start-drawing').click()
  const canvas = page.locator('.maplibregl-canvas')
  const box = (await canvas.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.click(cx - 60, cy - 60)
  await page.mouse.click(cx + 60, cy - 60)
  await page.mouse.click(cx + 60, cy + 40)
  await page.mouse.click(cx - 60, cy + 40)
  await page.keyboard.press('Enter')
}

// MapLibre's queryRenderedFeatures does not dedupe its own results: a feature that
// spans more than one of the source's internal tiles is reported once per tile it was
// found in, all carrying the same `id` (the GeoJSON source is configured with
// `promoteId: 'id'` precisely so there is a stable id to dedupe by — see MapShell.tsx).
// Deduping is the caller's job, so do it here rather than asserting on a raw count.
function queuedFeatureIds(page: Page) {
  return page.evaluate(() => {
    const map = (
      window as unknown as {
        __map?: {
          queryRenderedFeatures(opts: { layers: string[] }): {
            properties?: { id?: string; queued?: boolean }
          }[]
        }
      }
    ).__map
    const features = map?.queryRenderedFeatures({ layers: ['saved-areas-fill'] }) ?? []
    const ids = features
      .filter((f) => f.properties?.queued === true)
      .map((f) => f.properties?.id)
      .filter((id): id is string => typeof id === 'string')
    return [...new Set(ids)]
  })
}

test('save with the network blocked queues instead of succeeding, then flushes on reconnect', async ({
  page,
  context,
}) => {
  await signIn(page)

  // The block. See the driver note at the top for why this is the only mechanism
  // that works here, and what was measured to establish that.
  await context.setOffline(true)

  await drawPolygon(page)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await page.getByTestId('rating-1').click()
  await page.getByTestId('comment-input').fill('drawn while offline')
  await page.getByTestId('save-area').click()

  // Queued state, not success: the modal still closes (consistent save UX), but the
  // banner and the feature's own `queued` property say this hasn't reached the server.
  await expect(page.getByTestId('rating-modal')).toBeHidden()
  await expect(page.getByTestId('queued-banner')).toBeVisible()
  await expect(page.getByTestId('queued-banner')).toContainText('1 area queued')
  await expect.poll(() => queuedFeatureIds(page)).toHaveLength(1)

  // Nothing reached the database yet.
  const { data: beforeFlush } = await admin.from('areas').select('id').eq('user_id', userId)
  expect(beforeFlush).toEqual([])

  // Restore the network and flush. `setOffline(false)` also fires the browser's
  // `online` event, which MapShell listens for and may already be flushing by the
  // time we get to the manual button below — so the click is best-effort: if the
  // auto-flush already emptied the queue (button/banner gone), that's success too.
  await context.setOffline(false)
  try {
    await page.getByTestId('flush-queue').click({ timeout: 2_000 })
  } catch {
    // Already flushed via the `online` event's auto-flush.
  }
  await expect(page.getByTestId('queued-banner')).toBeHidden({ timeout: 15_000 })

  // Exactly one row — verified against the database via the admin client, not the UI.
  const { data: afterFlush, error } = await admin.from('areas').select('id').eq('user_id', userId)
  expect(error).toBeNull()
  expect(afterFlush).toHaveLength(1)
})
