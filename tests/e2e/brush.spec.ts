// Brush painting end to end — docs/OBJECTIVES.md § G8. The cell arithmetic is covered
// without a map in tests/unit/brush.test.ts; what only a browser can show is here: that
// a drag paints something visible, that release opens the same rating sheet a drawn
// polygon gets, that the saved row carries derived cells, and that an unsaved selection
// is never rendered as a saved area.
//
// On input: drags use page.mouse.move/down/up, the same choice and for the same reason
// as tests/e2e/draw-precision.spec.ts — the app listens for pointerdown/pointermove/
// pointerup, which is what WebKit synthesises from touch, and Playwright's touchscreen
// API can tap but cannot drag. Taps that do not need a path use page.touchscreen.tap, so
// the genuine touch path is exercised too.
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
const email = `brush-${randomUUID()}@example.com`
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

  await page.getByTestId('open-sign-in').tap()
  const form = page.getByTestId('sign-in-form')
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill(password)
  await form.getByRole('button', { name: 'Sign in' }).tap()
  await expect(page.getByTestId('open-sign-in')).toBeHidden()
}

/** The cell ids currently painted, as MapShell exposes them for tests. */
function paintedCells(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __brushCells?: string[] }).__brushCells ?? [],
  )
}

/** How many features of `layer` are actually on screen. */
function renderedCount(page: Page, layer: string) {
  return page.evaluate((name) => {
    const map = (
      window as unknown as {
        __map?: { queryRenderedFeatures(opts: { layers: string[] }): unknown[] }
      }
    ).__map
    return map?.queryRenderedFeatures({ layers: [name] }).length ?? 0
  }, layer)
}

async function canvasCentre(page: Page) {
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}

/**
 * Enter brush mode and wait until it is really open.
 *
 * The tap starts a fetch: the brush core and h3-js are a dynamic import, kept off the
 * critical path for G7's bundle budget, so brush mode opens when the module lands rather
 * than on the tap itself. Waiting for a control that only exists in brush mode is what
 * makes the rest of a test deterministic instead of racing that fetch.
 */
async function startBrush(page: Page) {
  await page.getByTestId('start-brush').tap()
  await expect(page.getByTestId('exit-brush')).toBeVisible()
}

/** A drag the brush reads as one stroke: press, move in steps, release. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 })
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

test('painting an area: drag paints, release rates, save derives cells', async ({ page }) => {
  await signIn(page)
  await startBrush(page)

  const { x: cx, y: cy } = await canvasCentre(page)
  const from = { x: cx - 50, y: cy - 40 }
  const to = { x: cx + 50, y: cy - 40 }

  // Mid-stroke: paint is on screen, and it is not in the saved-areas layer. This is the
  // "in-progress selection is not rendered as a saved area" assertion, taken at the one
  // moment it could go wrong unnoticed.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await expect.poll(() => renderedCount(page, 'brush-selection-fill')).toBeGreaterThan(0)
  expect(await renderedCount(page, 'saved-areas-fill')).toBe(0)

  // A drag paints a trail, not one stamp: the cells under the whole path are in.
  expect((await paintedCells(page)).length).toBeGreaterThan(1)

  // Release opens the rating sheet — the same sheet a drawn polygon gets.
  await page.mouse.up()
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  // Still not a saved area: nothing has been submitted yet.
  expect(await renderedCount(page, 'saved-areas-fill')).toBe(0)

  await page.getByTestId('rating-1').tap()
  await page.getByTestId('comment-input').fill('Painted this block')
  await page.getByTestId('save-area').tap()
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  // One row, and area_cells derived from the polygon the brush synthesised. The cells
  // come from save-area re-deriving them server side, not from anything the client sent.
  await expect
    .poll(
      async () => {
        const { data } = await admin.from('areas').select('id').eq('user_id', userId)
        return data?.length ?? 0
      },
      { timeout: 15_000 },
    )
    .toBe(1)

  const { data: rows } = await admin.from('areas').select('id').eq('user_id', userId)
  const { count } = await admin
    .from('area_cells')
    .select('*', { count: 'exact', head: true })
    .eq('area_id', rows![0].id)
  expect(count ?? 0).toBeGreaterThan(0)

  // The saved area renders as a polygon fill, and the selection it came from is gone —
  // brush mode is ready for the next area rather than still showing the last one.
  await expect
    .poll(() => renderedCount(page, 'saved-areas-fill'), { timeout: 15_000 })
    .toBeGreaterThan(0)
  expect(await renderedCount(page, 'brush-selection-fill')).toBe(0)

  // Reload: still there, still a polygon fill.
  await page.reload()
  await page.waitForFunction(() => {
    const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
    return !!map && map.isStyleLoaded()
  })
  await expect
    .poll(() => renderedCount(page, 'saved-areas-fill'), { timeout: 15_000 })
    .toBeGreaterThan(0)
  expect(await renderedCount(page, 'brush-selection-fill')).toBe(0)

  // Delete the row as soon as it has served its purpose rather than leaving it to
  // afterAll. tests/e2e/draw-precision.spec.ts reads every row in `areas` with the
  // service-role key, unscoped by user, so any area this suite leaves alive while the
  // two run in parallel shows up in its count. Keeping the row's life to the few
  // seconds these assertions need is what this suite can do about that from its side;
  // the read itself wants a user filter (reported to the lead).
  await admin.from('areas').delete().eq('user_id', userId)
})

test('erase clears what it covers, and undo brings the stroke back', async ({ page }) => {
  await signIn(page)
  await startBrush(page)

  const { x: cx, y: cy } = await canvasCentre(page)
  const spot = { x: cx, y: cy - 40 }

  // Paint one stamp, then get the sheet out of the way — dismissing keeps the paint
  // (SPEC.md § Field UX) and is the only way back to the map.
  await page.touchscreen.tap(spot.x, spot.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  // Dismiss with the sheet's own close control rather than the backdrop: the backdrop
  // ignores clicks within 50ms of mount (RatingModal's WebKit ghost-click guard), which
  // makes a backdrop tap here a race against the assertion above rather than a test of
  // anything this suite is about. tests/e2e/touch-draw.spec.ts covers the backdrop path.
  await page.getByRole('button', { name: 'Close' }).tap()
  await expect(page.getByTestId('rating-modal')).toBeHidden()
  await expect.poll(() => renderedCount(page, 'brush-selection-fill')).toBeGreaterThan(0)
  const painted = await paintedCells(page)
  expect(painted.length).toBeGreaterThan(0)

  // Erase over the same spot with the widest brush: the selection empties, so there is
  // nothing left to rate and the sheet stays shut.
  await page.getByTestId('brush-erase-toggle').tap()
  await expect(page.getByTestId('brush-erase-toggle')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('brush-size-3').tap()
  await page.touchscreen.tap(spot.x, spot.y)
  await expect.poll(() => renderedCount(page, 'brush-selection-fill')).toBe(0)
  expect(await paintedCells(page)).toEqual([])
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  // Undo the erase stroke: exactly the cells it removed come back — not approximately,
  // and not the whole session — and the selection is saveable again.
  await page.getByTestId('undo-stroke').tap()
  await expect.poll(() => renderedCount(page, 'brush-selection-fill')).toBeGreaterThan(0)
  expect([...(await paintedCells(page))].sort()).toEqual([...painted].sort())
  await expect(page.getByTestId('reopen-pending')).toBeVisible()
})

test('paint in separate pieces is refused until the gap is closed', async ({ page }) => {
  await signIn(page)
  await startBrush(page)

  const { x: cx, y: cy } = await canvasCentre(page)
  const left = { x: cx - 90, y: cy - 40 }
  const right = { x: cx + 90, y: cy - 40 }

  await page.touchscreen.tap(left.x, left.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).tap() // see the note in the erase test
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  // A second stamp with a gap between it and the first cannot be one polygon. The paint
  // stays on screen and the message says so; the sheet does not open on a shape that
  // cannot be saved.
  await page.touchscreen.tap(right.x, right.y)
  await expect(page.getByTestId('brush-message')).toBeVisible()
  await expect(page.getByTestId('brush-message')).toContainText('separate pieces')
  await expect(page.getByTestId('rating-modal')).toBeHidden()
  expect(await renderedCount(page, 'brush-selection-fill')).toBeGreaterThan(0)

  // Painting across the gap joins them — and proves a fast drag does not leave holes of
  // its own, since every step of this path is stamped.
  await drag(page, left, right)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await expect(page.getByTestId('brush-message')).toBeHidden()
})
