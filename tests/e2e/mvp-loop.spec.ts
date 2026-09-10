// G3 exit criteria (docs/OBJECTIVES.md): draw a polygon, rate it, comment on it, save it,
// see it on reload, edit it, delete it. One flow, run at the mobile viewport
// (playwright.config.ts pins 390x844).
//
// Test hygiene: a fresh confirmed user (uuid email) is created via the admin API for this
// run and torn down — with any areas it created — in afterAll, per the lead's brief.
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
const email = `mvp-loop-${randomUUID()}@example.com`
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

// The map itself needs no auth (see src/App.tsx) — it mounts immediately, same as it
// does for tests/e2e/map-shell.spec.ts. Sign-in is a contextual top-right affordance;
// only saving/deleting areas requires it.
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

function fillCount(page: Page) {
  return page.evaluate(() => {
    const map = (
      window as unknown as {
        __map?: { queryRenderedFeatures(opts: { layers: string[] }): unknown[] }
      }
    ).__map
    return map?.queryRenderedFeatures({ layers: ['saved-areas-fill'] }).length ?? 0
  })
}

async function drawPolygon(page: Page) {
  await page.getByTestId('start-drawing').click()
  const canvas = page.locator('.maplibregl-canvas')
  const box = (await canvas.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // A ~100px quadrilateral well clear of the bottom control band and top bar.
  await page.mouse.click(cx - 60, cy - 60)
  await page.mouse.click(cx + 60, cy - 60)
  await page.mouse.click(cx + 60, cy + 40)
  await page.mouse.click(cx - 60, cy + 40)
  await page.keyboard.press('Enter')
}

test('draw, rate, save, reload, edit, delete', async ({ page }) => {
  await signIn(page)

  // Draw a polygon; the rating modal appears.
  await drawPolygon(page)
  await expect(page.getByTestId('rating-modal')).toBeVisible()

  // Rate it and comment.
  await page.getByTestId('rating-1').click()
  await page.getByTestId('comment-input').fill('Nice little square')
  await page.getByTestId('save-area').click()
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  // The polygon renders with fill.
  await page.waitForFunction(
    ([layer]) => {
      const map = (
        window as unknown as {
          __map?: { queryRenderedFeatures(opts: { layers: string[] }): unknown[] }
        }
      ).__map
      return (map?.queryRenderedFeatures({ layers: [layer] }).length ?? 0) > 0
    },
    ['saved-areas-fill'],
    { timeout: 15_000 },
  )

  // Reload: still there.
  await page.reload()
  await page.waitForFunction(() => {
    const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
    return !!map && map.isStyleLoaded()
  })
  await expect
    .poll(() => fillCount(page), { timeout: 15_000 })
    .toBeGreaterThan(0)

  // Open it and change the rating.
  const canvas = page.locator('.maplibregl-canvas')
  const box = (await canvas.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2 - 10
  await page.mouse.click(cx, cy)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await expect(page.getByTestId('rating-1')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('rating--1').click()
  await page.getByTestId('save-area').click()
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  // Reload: the new rating persisted.
  await page.reload()
  await page.waitForFunction(() => {
    const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
    return !!map && map.isStyleLoaded()
  })
  await expect.poll(() => fillCount(page), { timeout: 15_000 }).toBeGreaterThan(0)
  await page.mouse.click(cx, cy)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await expect(page.getByTestId('rating--1')).toHaveAttribute('aria-pressed', 'true')

  // Delete it.
  await page.getByTestId('delete-area').click()
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  // Reload: it is gone.
  await page.reload()
  await page.waitForFunction(() => {
    const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
    return !!map && map.isStyleLoaded()
  })
  await expect.poll(() => fillCount(page), { timeout: 15_000 }).toBe(0)
})
