import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    permissions: ['geolocation'],
    geolocation: { latitude: 51.5072, longitude: -0.1276 }, // Charing Cross
  },
  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 14'],
        // The descriptor's viewport is 390x664 — iPhone 14 screen minus Safari
        // chrome. Installed as a PWA the app runs standalone and gets the full
        // 390x844, which is the target docs/TESTING.md pins. Test that.
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
