// Regression test for the verified touch bug (field-blocking, docs/TASKS-FIX-TOUCH.md):
// on WebKit/iOS, tapping a polygon's first vertex to finish it mounts the rating modal
// synchronously while that same tap is still in flight. WebKit later synthesizes a
// trailing click from that tap, and — before the fix — that synthesized click landed on
// the just-mounted backdrop and dismissed the modal ~2ms after it appeared. The user saw
// a flash; the drawn geometry survived only via the "Rate & save" recovery pill.
//
// All map/canvas interaction below uses page.touchscreen.tap (or locator.tap()) — never
// .click() — so this actually exercises WebKit's touch -> synthesized-click path rather
// than a plain synthetic click event, which would never reproduce the race.
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
const email = `touch-draw-${randomUUID()}@example.com`
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
  // Filling text fields is not "map interaction" — keyboard/programmatic fill is fine here.
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill(password)
  await form.getByRole('button', { name: 'Sign in' }).tap()
  await expect(page.getByTestId('open-sign-in')).toBeHidden()
}

test('finishing a polygon by tapping its first vertex does not get dismissed by the ghost click', async ({
  page,
}) => {
  await signIn(page)

  await page.getByTestId('start-drawing').tap()

  const canvas = page.locator('.maplibregl-canvas')
  const box = (await canvas.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // A quadrilateral well clear of the bottom control band and top bar, same footprint
  // as tests/e2e/mvp-loop.spec.ts's drawPolygon but tapped, not clicked.
  const v1 = { x: cx - 60, y: cy - 60 }
  const v2 = { x: cx + 60, y: cy - 60 }
  const v3 = { x: cx + 60, y: cy + 40 }
  const v4 = { x: cx - 60, y: cy + 40 }

  await page.touchscreen.tap(v1.x, v1.y)
  await page.touchscreen.tap(v2.x, v2.y)
  await page.touchscreen.tap(v3.x, v3.y)
  await page.touchscreen.tap(v4.x, v4.y)
  // Finish by tapping the first vertex again — the touch-specific way to close a
  // polygon (the mouse-driven mvp-loop test instead presses Enter, which has no touch
  // equivalent). This is the exact tap WebKit's ghost click is synthesized from.
  await page.touchscreen.tap(v1.x, v1.y)

  const modal = page.getByTestId('rating-modal')
  await expect(modal).toBeVisible()
  // The ghost click (if unfixed) dismisses within ~2ms of mount. Staying visible for a
  // full second is well beyond any plausible synthesized-click delay and proves the
  // modal survived it, not that we got lucky checking before it fired.
  await page.waitForTimeout(1_000)
  await expect(modal).toBeVisible()

  // Normal dismissal must still work: a genuine tap on the backdrop, well after mount,
  // dismisses the modal and leaves the recovery pill in its place (SPEC.md § Field UX —
  // dismissing must not lose the drawn geometry).
  await page.touchscreen.tap(cx, box.y + 40)
  await expect(modal).toBeHidden()
  await expect(page.getByTestId('reopen-pending')).toBeVisible()
})
