// G11 exit criteria (docs/OBJECTIVES.md § G11): the app is usable with a mouse and
// keyboard at 1440x900 — no unrecoverable state, no surface stretched across the
// window, and hover tells you what is clickable.
//
// Written red-first, before any of the behaviour exists, so that a green run is
// evidence rather than decoration. Today every test here fails: there is no
// Escape handling, no cancel-drawing control, rotation is still enabled, the
// rating sheet spans the full window (measured 1440px at 1440x900 and 2560px at
// 2560x1440 during recon), and the map canvas keeps its grab cursor over saved
// features.
//
// Desktop-project only — playwright.config.ts does not list it for mobile, and
// several assertions here are meaningless without a mouse.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { tap, tapAt } from './input'
import { SAVED_AREAS_FILL, waitForRenderedFeatures } from './rendered'

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

// Serial for the same reason draw-precision.spec.ts is: the per-test cleanup below
// would otherwise delete a sibling test's rows mid-flight.
test.describe.configure({ mode: 'serial' })

let admin: SupabaseClient
let userId: string
const email = `desktop-${randomUUID()}@example.com`
const password = 'correct-horse-battery-staple'

test.beforeAll(async () => {
  const env = readLocalSupabaseEnv()
  admin = createClient(env.API_URL ?? env.SUPABASE_URL, env.SERVICE_ROLE_KEY)
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
    await admin.from('map_features').delete().eq('user_id', userId)
    await admin.from('areas').delete().eq('user_id', userId)
    await admin.auth.admin.deleteUser(userId)
  }
})

test.beforeEach(async () => {
  await admin.from('map_features').delete().eq('user_id', userId)
  await admin.from('areas').delete().eq('user_id', userId)
})

async function waitForMap(page: Page) {
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
      return Boolean(map?.isStyleLoaded())
    },
    undefined,
    { timeout: 30_000 },
  )
}

async function signIn(page: Page) {
  await page.goto('/')
  await waitForMap(page)
  await tap(page.getByTestId('open-sign-in'))
  const form = page.getByTestId('sign-in-form')
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill(password)
  await tap(form.getByRole('button', { name: 'Sign in' }))
  await expect(page.getByTestId('open-sign-in')).toBeHidden()
}

async function canvasOrigin(page: Page) {
  const box = await page.locator('.maplibregl-canvas').boundingBox()
  if (!box) throw new Error('no canvas')
  return box
}

// Three vertices placed, ring left open — a drawing session in progress.
async function startDrawing(page: Page) {
  await tap(page.getByTestId('start-drawing'))
  const origin = await canvasOrigin(page)
  const cx = origin.x + origin.width / 2
  const cy = origin.y + origin.height / 2
  for (const [dx, dy] of [
    [-80, -60],
    [60, -60],
    [60, 50],
  ]) {
    await tapAt(page, cx + dx, cy + dy)
  }
  await expect(page.getByTestId('finish-area')).toBeVisible()
}

// Both escapes from a drawing session must leave the same clean state: no drawing
// controls, nothing half-saved, and the map ready to start over. A session you
// cannot abandon is the unrecoverable state the goal names — on a phone the draw
// button is always in reach, but a mouse user who starts a polygon by accident has
// no way back.
for (const exit of [
  { name: 'Escape', run: async (page: Page) => page.keyboard.press('Escape') },
  { name: 'cancel-drawing', run: async (page: Page) => tap(page.getByTestId('cancel-drawing')) },
]) {
  test(`${exit.name} abandons a drawing session and a fresh draw still works`, async ({ page }) => {
    await signIn(page)
    await startDrawing(page)

    await exit.run(page)

    await expect(page.getByTestId('finish-area')).toBeHidden()
    await expect(page.getByTestId('undo-vertex')).toBeHidden()
    await expect(page.getByTestId('cancel-drawing')).toBeHidden()
    await expect(page.getByTestId('rating-modal')).toBeHidden()
    await expect(page.getByTestId('start-drawing')).toBeVisible()

    // Not merely dismissed — the next session must behave like the first.
    await startDrawing(page)
    await expect(page.getByTestId('finish-area')).toBeVisible()
  })
}

test('a right-drag does not rotate or pitch the map', async ({ page }) => {
  await page.goto('/')
  await waitForMap(page)

  const origin = await canvasOrigin(page)
  const cx = origin.x + origin.width / 2
  const cy = origin.y + origin.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(cx + 220, cy + 120, { steps: 12 })
  await page.mouse.up({ button: 'right' })

  // Rotation is removed rather than made recoverable (G11 out_of_scope rules out a
  // compass), so a right-drag that tilts the basemap leaves a mouse user with no
  // way back to north.
  const view = await page.evaluate(() => {
    const map = (window as unknown as { __map: { getBearing(): number; getPitch(): number } }).__map
    return { bearing: map.getBearing(), pitch: map.getPitch() }
  })
  expect(view.bearing).toBe(0)
  expect(view.pitch).toBe(0)
})

test('the rating sheet and queued banner stay readable rather than spanning the window', async ({
  page,
}) => {
  await signIn(page)
  await startDrawing(page)
  await tap(page.getByTestId('finish-area'))
  await expect(page.getByTestId('rating-modal')).toBeVisible()

  const viewport = page.viewportSize()!
  const sheet = await page.getByTestId('rating-modal').locator('form, .rounded-t-2xl').first().boundingBox()
  expect(sheet, 'rating sheet has no box').not.toBeNull()
  // Measured at 1440px wide at this viewport during recon, with a 1400px Save
  // button. 640px is a readable measure, not a breakpoint fork: the overlay sheet
  // already caps itself at max-w-sm and is the pattern being matched.
  expect(sheet!.width).toBeLessThanOrEqual(640)
  expect(sheet!.width).toBeLessThan(viewport.width)

  // Same shape of defect on the queued banner, which is inset-x-3 today: 1416px at
  // this viewport for one short sentence. Cut the network so it renders.
  await page.context().setOffline(true)
  await tap(page.getByTestId('rating-1'))
  await tap(page.getByTestId('save-area'))
  await expect(page.getByTestId('queued-banner')).toBeVisible()
  const banner = await page.getByTestId('queued-banner').boundingBox()
  expect(banner!.width).toBeLessThanOrEqual(640)
  await page.context().setOffline(false)
})

test('the rating sheet is keyboard-operable and keeps focus', async ({ page }) => {
  await signIn(page)
  await startDrawing(page)
  await tap(page.getByTestId('finish-area'))
  const sheet = page.getByTestId('rating-modal')
  await expect(sheet).toBeVisible()

  // Opening a modal without moving focus into it leaves a keyboard user tabbing
  // through the map behind the sheet — which recon found reaches controls behind it
  // before reaching save.
  await expect
    .poll(async () => sheet.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true)

  // Tab must cycle within the sheet rather than escaping to the page behind it.
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
  expect(await sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true)

  // Escape is the expected way out of a modal with a mouse and keyboard, and the
  // drawn geometry must survive it exactly as dismissing by backdrop does.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(page.getByTestId('reopen-pending')).toBeVisible()
})

test('the cursor says what is clickable', async ({ page }) => {
  await signIn(page)
  await startDrawing(page)
  await tap(page.getByTestId('finish-area'))
  await tap(page.getByTestId('rating-1'))
  await tap(page.getByTestId('save-area'))
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  // Same race as draw-precision's reopen tap: the hover has to land on a rendered
  // feature for MapLibre's hit test to report one, and the source re-tiles after the
  // save. This suite had no such wait and had simply not been unlucky yet.
  await waitForRenderedFeatures(page, SAVED_AREAS_FILL)

  const origin = await canvasOrigin(page)
  const inside = { x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 - 20 }
  await page.mouse.move(inside.x, inside.y)

  // The map keeps MapLibre's grab cursor everywhere by default, so a saved area
  // looks exactly as clickable as empty basemap — which is to say, not at all.
  await expect
    .poll(async () =>
      page.evaluate(() => getComputedStyle(document.querySelector('.maplibregl-canvas')!).cursor),
    )
    .toBe('pointer')

  // And it must go back, or the whole map reads as clickable instead.
  await page.mouse.move(origin.x + 30, origin.y + 30)
  await expect
    .poll(async () =>
      page.evaluate(() => getComputedStyle(document.querySelector('.maplibregl-canvas')!).cursor),
    )
    .not.toBe('pointer')
})
