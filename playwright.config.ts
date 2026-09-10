import { defineConfig, devices } from '@playwright/test'

// Port 4173 is the committed default — the same port the `preview` npm script
// and docs/OBJECTIVES.md's done_when commands use verbatim. G5 work happens in
// a worktree alongside another teammate's concurrent use of 4173 in the main
// checkout, so its own verification runs with PREVIEW_PORT=4273 instead. The
// default here is unchanged.
const PREVIEW_PORT = process.env.PREVIEW_PORT || '4173'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: `http://localhost:${PREVIEW_PORT}`,
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
    command: `npm run build && npx vite preview --port ${PREVIEW_PORT} --strictPort`,
    url: `http://localhost:${PREVIEW_PORT}`,
    // Always rebuild. Reusing a running preview server silently served a stale
    // dist and turned a genuinely failing test green.
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
