import { test, expect } from '@playwright/test'

test('app mounts at the mobile target viewport', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#root')).toBeAttached()
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 })
})
