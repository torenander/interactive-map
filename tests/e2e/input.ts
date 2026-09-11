import { test, type Locator, type Page } from '@playwright/test'

// One suite, two input models. The specs were written touch-first against the
// 390x844 mobile project, and `.tap()` throws outright without `hasTouch`, so a
// desktop project cannot run any of them unmodified — that, rather than the
// viewport, is what kept the suite mobile-only (docs/TESTING.md).
//
// These helpers dispatch on the project's declared capability rather than on its
// name, so a future project gets the right input model by configuring
// `hasTouch`, not by being added to a list here.
//
// Deliberately: on a touch project these call exactly what the specs called
// before, so converting a spec is a pure refactor and the mobile gate stays
// byte-identical in behaviour. Drags are not wrapped — `page.mouse` already
// works under both models, which is why brush and draw-precision use it for
// strokes today.

function touchEnabled(): boolean {
  return test.info().project.use.hasTouch === true
}

/** Tap or click an element, whichever this project supports. */
export async function tap(target: Locator): Promise<void> {
  if (touchEnabled()) {
    await target.tap()
    return
  }
  await target.click()
}

/** Tap or click a viewport coordinate — map canvas interactions. */
export async function tapAt(page: Page, x: number, y: number): Promise<void> {
  if (touchEnabled()) {
    await page.touchscreen.tap(x, y)
    return
  }
  await page.mouse.click(x, y)
}
