// G9 exit criteria (docs/OBJECTIVES.md § G9): drop a point and draw a line, each with a
// rating and comment, persisted in public.map_features behind save-feature and rendered
// on the same map. The full round trip for both kinds — place/draw, rate, comment, save,
// reload, edit the rating, reload, delete, reload and gone — plus the precedence rule
// that keeps a point inside a rated area tappable.
//
// Runs at 390x844 (playwright.config.ts pins the only project there).
//
// Taps use page.touchscreen, as touch-draw.spec.ts and draw-precision.spec.ts do,
// because that is how the app is actually used.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

type PointGeometry = { type: 'Point'; coordinates: number[] }
type LineGeometry = { type: 'LineString'; coordinates: number[][] }
type FeatureGeometry = PointGeometry | LineGeometry

type StoredFeature = {
  id: string
  kind: 'point' | 'line'
  rating: number
  comment: string | null
  geometry: FeatureGeometry
}

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

// One user for the file, cleared between tests. Serial for the same reason
// draw-precision.spec.ts is: the per-test cleanup below would otherwise run while a
// sibling test is mid-flight.
test.describe.configure({ mode: 'serial' })

let admin: SupabaseClient
let apiUrl: string
let serviceKey: string
let userId: string
const email = `points-lines-${randomUUID()}@example.com`
const password = 'correct-horse-battery-staple'

test.beforeAll(async () => {
  const env = readLocalSupabaseEnv()
  apiUrl = env.API_URL ?? env.SUPABASE_URL
  serviceKey = env.SERVICE_ROLE_KEY
  admin = createClient(apiUrl, serviceKey)
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

// Scoped to this suite's own user — an unscoped read counts rows any suite running
// alongside has saved and not cleaned up (the failure mode bc30d3c fixed in
// draw-precision.spec.ts). geography comes back as WKB hex without the geo+json Accept.
async function storedFeatures(): Promise<StoredFeature[]> {
  const res = await fetch(
    `${apiUrl}/rest/v1/map_features?select=id,kind,rating,comment,geom&user_id=eq.${userId}&order=created_at.asc`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/geo+json',
      },
    },
  )
  if (!res.ok) throw new Error(`read map_features failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as {
    features: {
      properties: { id: string; kind: 'point' | 'line'; rating: number; comment: string | null }
      geometry: FeatureGeometry
    }[]
  }
  return body.features.map((f) => ({ ...f.properties, geometry: f.geometry }))
}

async function waitForMap(page: Page) {
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()
  await page.waitForFunction(() => {
    const map = (window as unknown as { __map?: { isStyleLoaded(): boolean } }).__map
    return !!map && map.isStyleLoaded()
  })
}

async function signIn(page: Page) {
  await page.goto('/')
  await waitForMap(page)
  await page.getByTestId('open-sign-in').tap()
  const form = page.getByTestId('sign-in-form')
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill(password)
  await form.getByRole('button', { name: 'Sign in' }).tap()
  await expect(page.getByTestId('open-sign-in')).toBeHidden()
}

// A reload restores the map long before it restores the data: saved features arrive
// after the session resolves and fetchFeatures returns. Waiting on the style alone raced
// that and tapped bare ground. Wait on the same question the click handler asks —
// queryRenderedFeatures over the feature layers — so the tap lands on something drawn.
async function waitForRenderedFeatures(page: Page, expected: number) {
  await page.waitForFunction((count) => {
    const map = (
      window as unknown as {
        __map?: {
          isStyleLoaded(): boolean
          getLayer(id: string): unknown
          queryRenderedFeatures(opts: { layers: string[] }): unknown[]
        }
      }
    ).__map
    if (!map || !map.isStyleLoaded()) return false
    if (!map.getLayer('saved-features-circle')) return false
    return (
      map.queryRenderedFeatures({
        layers: ['saved-features-circle', 'saved-features-line'],
      }).length >= count
    )
  }, expected)
}

// Same race for saved areas.
async function waitForRenderedAreas(page: Page, expected: number) {
  await page.waitForFunction((count) => {
    const map = (
      window as unknown as {
        __map?: {
          isStyleLoaded(): boolean
          getLayer(id: string): unknown
          queryRenderedFeatures(opts: { layers: string[] }): unknown[]
        }
      }
    ).__map
    if (!map || !map.isStyleLoaded()) return false
    if (!map.getLayer('saved-areas-fill')) return false
    return map.queryRenderedFeatures({ layers: ['saved-areas-fill'] }).length >= count
  }, expected)
}

// The ids of rendered features currently flagged as queued. Read off the same source the
// map paints from, so this is what is actually on screen — not what React state says.
// `queued` drives the amber in fillColorExpression, so a true here is a feature the user
// can see has not reached the server.
async function queuedFeatureIds(page: Page): Promise<string[]> {
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
    const rendered =
      map?.queryRenderedFeatures({
        layers: ['saved-features-circle', 'saved-features-line'],
      }) ?? []
    const ids = rendered
      .filter((f) => f.properties?.queued === true)
      .map((f) => f.properties?.id)
      .filter((id): id is string => typeof id === 'string')
    return [...new Set(ids)]
  })
}

async function canvasOrigin(page: Page) {
  const box = (await page.locator('.maplibregl-canvas').boundingBox())!
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

async function pageXYOf(page: Page, coordinate: number[]) {
  const origin = await canvasOrigin(page)
  const projected = await page.evaluate((coord) => {
    const map = (window as unknown as { __map: { project(c: number[]): { x: number; y: number } } })
      .__map
    const point = map.project(coord)
    return { x: point.x, y: point.y }
  }, coordinate)
  return { x: origin.x + projected.x, y: origin.y + projected.y }
}

// Placing, rating and saving is the same three steps for every kind — only the control
// that starts it and the taps in between differ.
async function rateAndSave(page: Page, rating: -1 | 0 | 1, comment: string) {
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await page.getByTestId(`rating-${rating}`).tap()
  await page.getByTestId('comment-input').fill(comment)
  await page.getByTestId('save-area').tap()
  await expect(page.getByTestId('rating-modal')).toBeHidden()
}

// The sheet ignores clicks within 50ms of mount (the WebKit ghost-click guard,
// docs/TASKS-FIX-TOUCH.md), and toBeVisible can resolve inside that window.
async function settleSheet(page: Page) {
  await page.waitForTimeout(200)
}

test('a point round-trips: place, rate, reload, edit, reload, delete, gone', async ({ page }) => {
  await signIn(page)

  const origin = await canvasOrigin(page)
  const spot = { x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 - 60 }

  await page.getByTestId('start-point').tap()
  await expect(page.getByTestId('point-hint')).toBeVisible()
  await page.touchscreen.tap(spot.x, spot.y)
  await rateAndSave(page, 1, 'good corner shop')

  let saved = await storedFeatures()
  expect(saved).toHaveLength(1)
  expect(saved[0].kind).toBe('point')
  expect(saved[0].rating).toBe(1)
  expect(saved[0].comment).toBe('good corner shop')
  expect(saved[0].geometry.type).toBe('Point')
  const placed = saved[0].geometry.coordinates as number[]

  // Survives a reload, and comes back where it was put.
  await page.reload()
  await waitForMap(page)
  await waitForRenderedFeatures(page, 1)
  const back = await pageXYOf(page, placed)
  expect(Math.abs(back.x - spot.x)).toBeLessThan(2)
  expect(Math.abs(back.y - spot.y)).toBeLessThan(2)

  // Tap it to edit the rating.
  await page.touchscreen.tap(back.x, back.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await expect(page.getByTestId('comment-input')).toHaveValue('good corner shop')
  await settleSheet(page)
  await rateAndSave(page, -1, 'shut down')

  await page.reload()
  await waitForMap(page)
  await waitForRenderedFeatures(page, 1)
  saved = await storedFeatures()
  expect(saved).toHaveLength(1)
  expect(saved[0].rating).toBe(-1)
  expect(saved[0].comment).toBe('shut down')

  // Delete it.
  const stillThere = await pageXYOf(page, placed)
  await page.touchscreen.tap(stillThere.x, stillThere.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await settleSheet(page)
  await page.getByTestId('delete-area').tap()
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  await page.reload()
  await waitForMap(page)
  expect(await storedFeatures()).toHaveLength(0)
})

test('a line round-trips: draw, rate, reload, edit, reload, delete, gone', async ({ page }) => {
  await signIn(page)

  const origin = await canvasOrigin(page)
  const cx = origin.x + origin.width / 2
  const cy = origin.y + origin.height / 2
  const vertices = [
    { x: cx - 80, y: cy - 60 },
    { x: cx, y: cy - 20 },
    { x: cx + 80, y: cy - 60 },
  ]

  await page.getByTestId('start-line').tap()
  for (const vertex of vertices) {
    await page.touchscreen.tap(vertex.x, vertex.y)
  }
  // Closed by the explicit control, not by a tap on the last vertex.
  await page.getByTestId('finish-line').tap()
  await rateAndSave(page, -1, 'noisy stretch')

  let saved = await storedFeatures()
  expect(saved).toHaveLength(1)
  expect(saved[0].kind).toBe('line')
  expect(saved[0].geometry.type).toBe('LineString')
  const drawn = saved[0].geometry.coordinates as number[][]
  expect(drawn.length).toBe(vertices.length)

  await page.reload()
  await waitForMap(page)
  await waitForRenderedFeatures(page, 1)

  // Every vertex came back where it was tapped.
  for (let i = 0; i < vertices.length; i++) {
    const back = await pageXYOf(page, drawn[i])
    expect(Math.abs(back.x - vertices[i].x)).toBeLessThan(2)
    expect(Math.abs(back.y - vertices[i].y)).toBeLessThan(2)
  }

  // Tapping the stroke opens it — the middle vertex is the easiest place to be sure the
  // tap is on the line and not near an end.
  const onLine = await pageXYOf(page, drawn[1])
  await page.touchscreen.tap(onLine.x, onLine.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await expect(page.getByTestId('comment-input')).toHaveValue('noisy stretch')
  await settleSheet(page)
  await rateAndSave(page, 1, 'quietened down')

  await page.reload()
  await waitForMap(page)
  await waitForRenderedFeatures(page, 1)
  saved = await storedFeatures()
  expect(saved).toHaveLength(1)
  expect(saved[0].rating).toBe(1)
  expect(saved[0].comment).toBe('quietened down')

  const again = await pageXYOf(page, drawn[1])
  await page.touchscreen.tap(again.x, again.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await settleSheet(page)
  await page.getByTestId('delete-area').tap()
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  await page.reload()
  await waitForMap(page)
  expect(await storedFeatures()).toHaveLength(0)
})

test('a point inside a rated area stays tappable, and the area stays tappable around it', async ({
  page,
}) => {
  await signIn(page)

  const origin = await canvasOrigin(page)
  const cx = origin.x + origin.width / 2
  const cy = origin.y + origin.height / 2

  // A rated area first, large enough to contain a point with room to spare.
  await page.getByTestId('start-drawing').tap()
  for (const vertex of [
    { x: cx - 110, y: cy - 110 },
    { x: cx + 110, y: cy - 110 },
    { x: cx + 110, y: cy + 30 },
    { x: cx - 110, y: cy + 30 },
  ]) {
    await page.touchscreen.tap(vertex.x, vertex.y)
  }
  await page.getByTestId('finish-area').tap()
  await rateAndSave(page, 1, 'area note')

  // Then a point well inside it.
  const inside = { x: cx, y: cy - 40 }
  await page.getByTestId('start-point').tap()
  await page.touchscreen.tap(inside.x, inside.y)
  await rateAndSave(page, -1, 'point note')

  await page.reload()
  await waitForMap(page)
  await waitForRenderedAreas(page, 1)
  await waitForRenderedFeatures(page, 1)

  const [savedPoint] = await storedFeatures()
  const pointXY = await pageXYOf(page, savedPoint.geometry.coordinates as number[])

  // Tapping the point opens the POINT, not the area underneath it. Which one the sheet
  // is showing is read off the comment: the two were deliberately given different ones.
  await page.touchscreen.tap(pointXY.x, pointXY.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await expect(page.getByTestId('comment-input')).toHaveValue('point note')

  // Back out without saving, so the area tap below starts from a clean slate.
  await settleSheet(page)
  await page.touchscreen.tap(cx, origin.y + 40) // backdrop
  await expect(page.getByTestId('rating-modal')).toBeHidden()
  await page.getByTestId('cancel-edit').tap()

  // And the area is still tappable everywhere the point is not — precedence takes the
  // tap from the area only where a feature actually is.
  const awayFromPoint = { x: cx - 80, y: cy + 10 }
  await page.touchscreen.tap(awayFromPoint.x, awayFromPoint.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await expect(page.getByTestId('comment-input')).toHaveValue('area note')
})


// The offline half of the same contract, mirroring what offline.spec.ts proves for areas.
// Offline-first is the app's core invariant (SPEC.md § Field UX — a save made underground
// must survive), and until this existed the feature queue was implemented but unproven
// end to end: G9's own done_when has no offline assertion.
test('a point saved with the network blocked queues, renders as queued, then flushes on reconnect', async ({
  page,
  context,
}) => {
  await signIn(page)

  // `context.setOffline(true)` is the whole block, and deliberately the only one.
  //
  // offline.spec.ts pairs setOffline with a `page.route(...).abort()` on its function
  // URL and calls that route "the load-bearing block". Measured here, the equivalent
  // route on save-feature is inert: with the route registered and the network left ON,
  // the save goes straight through and never queues (probed directly — the queued
  // assertion below failed with 0). The app registers a service worker, and a request it
  // mediates is not seen by page-level route interception, so setOffline is what
  // actually severs this path. Carrying the route anyway would have meant a line
  // claiming to do the work while doing nothing.
  await context.setOffline(true)

  const origin = await canvasOrigin(page)
  const spot = { x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 - 50 }
  await page.getByTestId('start-point').tap()
  await page.touchscreen.tap(spot.x, spot.y)
  await rateAndSave(page, 1, 'placed underground')

  // Queued, not saved. CLAUDE.md: never render a save as complete before the server has
  // it — the point is on the map, but carrying `queued`, which paints it amber rather
  // than its rating colour.
  await expect.poll(() => queuedFeatureIds(page)).toHaveLength(1)

  // And nothing reached the database.
  const { data: beforeFlush } = await admin
    .from('map_features')
    .select('id')
    .eq('user_id', userId)
  expect(beforeFlush).toEqual([])

  // Restore the network. `setOffline(false)` fires the browser's `online` event, which
  // MapShell listens for and flushes both queues from. Unlike offline.spec.ts there is no
  // manual fallback to click here: the "Sync now" button lives in the queued banner, and
  // that banner counts queued areas only — see the note in docs/TASKS-G9.md.
  await context.setOffline(false)

  // Load-bearing, proven by a red run: left offline, this poll fails with the point still
  // queued after the full 20s rather than passing vacuously.
  await expect.poll(() => queuedFeatureIds(page), { timeout: 20_000 }).toHaveLength(0)

  // Exactly one row, and it went through save-feature — a direct insert is revoked at the
  // database (migration 0009), so a row existing at all means the write path ran.
  const afterFlush = await storedFeatures()
  expect(afterFlush).toHaveLength(1)
  expect(afterFlush[0].kind).toBe('point')
  expect(afterFlush[0].rating).toBe(1)
  expect(afterFlush[0].comment).toBe('placed underground')

  // Survives a reload as a normal saved feature, no longer queued.
  await page.reload()
  await waitForMap(page)
  await waitForRenderedFeatures(page, 1)
  expect(await queuedFeatureIds(page)).toHaveLength(0)
  expect(await storedFeatures()).toHaveLength(1)
})