// G13 move-session precedence (docs/OBJECTIVES.md § G13), plus the tap-precedence rule
// G9/G11 already established for areas vs. features. The adversarial field pass never
// exercised what a move session does to everything ELSE trying to happen at once — this
// suite is that gap, one focused desktop pass:
//
//   1. starting a brush/paint session while a move is open
//   2. tapping a second saved feature while a move is open
//   3. a double-tap ghost-click firing the "Move point" / "Reshape line" control twice
//
// Setup, helpers and conventions are copied from tests/e2e/points-lines.spec.ts
// deliberately — that is the file this gap was found in, and the two suites should read
// as siblings. This file does not modify points-lines.spec.ts.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { tap, tapAt } from './input'
import { waitForRenderedFeatures as waitForRenderedLayer } from './rendered'

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
// points-lines.spec.ts is: per-test cleanup would otherwise run while a sibling test is
// mid-flight.
test.describe.configure({ mode: 'serial' })

let admin: SupabaseClient
let apiUrl: string
let serviceKey: string
let userId: string
const email = `move-precedence-${randomUUID()}@example.com`
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
  await tap(page.getByTestId('open-sign-in'))
  const form = page.getByTestId('sign-in-form')
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill(password)
  await tap(form.getByRole('button', { name: 'Sign in' }))
  await expect(page.getByTestId('open-sign-in')).toBeHidden()
}

const SAVED_FEATURES_CIRCLE = 'saved-features-circle'

async function waitForRenderedPoints(page: Page, expected = 1) {
  await waitForRenderedLayer(page, SAVED_FEATURES_CIRCLE, expected)
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

async function rateAndSave(page: Page, rating: -1 | 0 | 1, comment: string) {
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await tap(page.getByTestId(`rating-${rating}`))
  await page.getByTestId('comment-input').fill(comment)
  await tap(page.getByTestId('save-area'))
  await expect(page.getByTestId('rating-modal')).toBeHidden()
}

// The sheet ignores clicks within 50ms of mount (the WebKit ghost-click guard,
// docs/TASKS-FIX-TOUCH.md), and toBeVisible can resolve inside that window.
async function settleSheet(page: Page) {
  await page.waitForTimeout(200)
}

// Drags use page.mouse, matching points-lines.spec.ts's own G13 tests: it works under
// both input models and is what brush/draw-precision already use for strokes.
async function dragOnCanvas(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
}

// Open the sheet on a saved feature and start a move. Returns once the sheet has been
// dismissed for dragging — identical to points-lines.spec.ts's own helper.
async function startMove(page: Page, at: { x: number; y: number }) {
  await tapAt(page, at.x, at.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await settleSheet(page)
  await tap(page.getByTestId('move-feature'))
  await expect(page.getByTestId('rating-modal')).toBeHidden()
}

async function reopenAndSave(page: Page) {
  await tap(page.getByTestId('reopen-pending'))
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await settleSheet(page)
  await tap(page.getByTestId('save-area'))
  await expect(page.getByTestId('rating-modal')).toBeHidden()
}

async function placeAndSavePoint(page: Page, at: { x: number; y: number }, comment: string) {
  await tap(page.getByTestId('start-point'))
  await tapAt(page, at.x, at.y)
  await rateAndSave(page, 1, comment)
}

// ---------------------------------------------------------------------------
// Collision 1 — starting a brush/paint session while a move is open
// ---------------------------------------------------------------------------
//
// src/map/MapShell.tsx's `hasSession` (which `editingMapFeature` alone sets true) hides
// the whole entry-point row — "Paint area" among them — for as long as a session is
// open, including a move whose sheet has been dismissed. handleStartBrush carries the
// same guard independently (`if (... || editingMapFeature) return`), so even a
// caller that reached the handler directly would be refused. This test is the first to
// exercise that combination for a MOVE session specifically, rather than a pending
// draw or a rating-only edit.
test('starting a brush session is blocked while a point move is open, and the move survives the attempt', async ({
  page,
}) => {
  await signIn(page)
  const origin = await canvasOrigin(page)
  const spot = { x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 - 50 }

  await placeAndSavePoint(page, spot, 'brush precedence')
  await waitForRenderedPoints(page)

  const [before] = await storedFeatures()
  const from = await pageXYOf(page, before.geometry.coordinates as number[])

  await startMove(page, from)

  // The whole entry-point row — brush included — is unreachable while the move is open.
  // Checked concurrently (not four sequential awaits) and with a generous timeout: this
  // suite runs in CI's 2-worker mobile lane alongside the rest of the suite, and a
  // sequential stack of default-timeout polls is the part of this test most exposed to
  // that lane's own documented resource contention (see the workflow's own comment on
  // the desktop project needing --workers=1 for the same reason).
  await Promise.all([
    expect(page.getByTestId('start-brush')).toBeHidden({ timeout: 10_000 }),
    expect(page.getByTestId('start-drawing')).toBeHidden({ timeout: 10_000 }),
    expect(page.getByTestId('start-point')).toBeHidden({ timeout: 10_000 }),
    expect(page.getByTestId('start-line')).toBeHidden({ timeout: 10_000 }),
  ])

  // The move itself is unharmed by the attempt to reach past it.
  const to = { x: from.x + 90, y: from.y - 70 }
  await dragOnCanvas(page, from, to)
  await reopenAndSave(page)

  await page.reload()
  await waitForMap(page)
  await waitForRenderedPoints(page)

  const [after] = await storedFeatures()
  expect(after.id).toBe(before.id)
  const landed = await pageXYOf(page, after.geometry.coordinates as number[])
  expect(Math.abs(landed.x - to.x)).toBeLessThan(3)
  expect(Math.abs(landed.y - to.y)).toBeLessThan(3)

  // And the entry points come back once the session ends.
  await expect(page.getByTestId('start-brush')).toBeVisible({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Collision 2 — tapping a second saved feature mid-move
// ---------------------------------------------------------------------------
//
// handleFeatureClick's own guard (`if (pendingMapFeatureRef.current ||
// editingMapFeatureIdRef.current) return`) fires before the hit test even runs, so a tap
// anywhere on the map is swallowed while a move is open — but the field attack only ever
// tried an empty-map tap, never a tap that actually lands on a second real, tappable
// feature. This closes that gap.
test('tapping a second saved point mid-move does not steal or disturb the session', async ({
  page,
}) => {
  await signIn(page)
  const origin = await canvasOrigin(page)
  const spotA = { x: origin.x + origin.width / 2 - 90, y: origin.y + origin.height / 2 - 50 }
  const spotB = { x: origin.x + origin.width / 2 + 90, y: origin.y + origin.height / 2 - 50 }

  await placeAndSavePoint(page, spotA, 'first')
  await placeAndSavePoint(page, spotB, 'second')
  await waitForRenderedPoints(page, 2)

  const stored = await storedFeatures()
  const a = stored.find((f) => f.comment === 'first')!
  const b = stored.find((f) => f.comment === 'second')!
  const fromA = await pageXYOf(page, a.geometry.coordinates as number[])
  const atB = await pageXYOf(page, b.geometry.coordinates as number[])

  await startMove(page, fromA)

  // Tap squarely on the OTHER saved point while A's move is open.
  await tapAt(page, atB.x, atB.y)
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  // The reopen pill still returns to A's session, not to nothing and not to B.
  await tap(page.getByTestId('reopen-pending'))
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await expect(page.getByTestId('comment-input')).toHaveValue('first')
  await settleSheet(page)

  // Dismiss via the backdrop (as points-lines.spec.ts does) rather than saving — the
  // sheet has to close before "cancel-edit" renders at all (it is hidden while
  // `modalVisible`), and then abandon A's move without writing anything.
  await tapAt(page, origin.x + origin.width / 2, origin.y + 40)
  await expect(page.getByTestId('rating-modal')).toBeHidden()
  await tap(page.getByTestId('cancel-edit'))

  // And B was never touched by the tap that landed on it.
  const after = await storedFeatures()
  const bAfter = after.find((f) => f.id === b.id)!
  expect(bAfter.comment).toBe('second')
  expect(bAfter.geometry).toEqual(b.geometry)
  const aAfter = after.find((f) => f.id === a.id)!
  expect(aAfter.geometry).toEqual(a.geometry) // cancelled, so A is untouched too
})

// ---------------------------------------------------------------------------
// Collision 3 — double-tap ghost-click on the Move control
// ---------------------------------------------------------------------------
//
// handleStartMoveFeature is async (`await drawReady.current`) and its own-session guard
// reads `editingMapFeature` from the closure captured at the moment it started running —
// not a ref, unlike every other precedence guard in this file. Two click events fired in
// the same task both run their synchronous prefix (guard check included) before either
// handler's `await` resumes and calls setEditingMapFeature, so both can pass the guard
// and both call `terraDraw.addFeatures` with the same id. Dispatching two native click
// events back to back on the same element reproduces that race far more reliably than
// two separate Playwright clicks, which cannot land closer together than a real
// double-tap does, and is the desktop-reachable analogue of the WebKit touch/synthetic-
// mouse ghost click that touch-draw.spec.ts exercises for drawing.
test('a double-tap ghost-click on Move does not duplicate or corrupt the session', async ({
  page,
}) => {
  await signIn(page)
  const origin = await canvasOrigin(page)
  const spot = { x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 - 50 }

  await placeAndSavePoint(page, spot, 'ghost click')
  await waitForRenderedPoints(page)

  const [before] = await storedFeatures()
  const from = await pageXYOf(page, before.geometry.coordinates as number[])

  const pageErrors: Error[] = []
  page.on('pageerror', (err) => pageErrors.push(err))

  await tapAt(page, from.x, from.y)
  await expect(page.getByTestId('rating-modal')).toBeVisible()
  await settleSheet(page)

  await page.getByTestId('move-feature').evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await expect(page.getByTestId('rating-modal')).toBeHidden()

  const to = { x: from.x + 90, y: from.y - 70 }
  await dragOnCanvas(page, from, to)
  await reopenAndSave(page)

  expect(pageErrors).toEqual([])

  await page.reload()
  await waitForMap(page)
  await waitForRenderedPoints(page)

  // Exactly one row — no duplicate created by the second, redundant addFeatures call.
  const after = await storedFeatures()
  expect(after).toHaveLength(1)
  expect(after[0].id).toBe(before.id)
  const landed = await pageXYOf(page, after[0].geometry.coordinates as number[])
  expect(Math.abs(landed.x - to.x)).toBeLessThan(3)
  expect(Math.abs(landed.y - to.y)).toBeLessThan(3)
})
