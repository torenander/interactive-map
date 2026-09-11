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
      // No testMatch, deliberately: the mobile project runs EVERY spec, including
      // tests/e2e/desktop.spec.ts. That started as an oversight — mobile's count
      // went from 27 to 33 when the desktop suite landed — and is kept on purpose,
      // because the WebKit run of desktop.spec is what caught the sheet's
      // Tab-containment bug. Accidental coverage that catches real bugs gets
      // promoted to intentional rather than scoped away.
      //
      // Desktop-only assertions stay true here rather than vacuous: the 640px sheet
      // cap is satisfied at 390px, and the input helpers (tests/e2e/input.ts)
      // dispatch on hasTouch, so each project exercises its own input model.
    },
    // G11. Desktop is additive, never a replacement: mobile stays the primary
    // target and runs everything. This project runs the suites that are
    // viewport-agnostic once input is abstracted (tests/e2e/input.ts), plus
    // desktop.spec.ts for the behaviours that only exist with a mouse and
    // keyboard.
    //
    // touch-draw.spec.ts is excluded on purpose rather than omitted by accident:
    // it reproduces a WebKit ghost-click race between touch and the synthesised
    // mouse event, so there is nothing for it to assert without touch.
    //
    // `hasTouch: false` is what tests/e2e/input.ts dispatches on, so it is
    // load-bearing config, not documentation.
    {
      name: 'desktop',
      testMatch: [
        'desktop.spec.ts',
        'map-shell.spec.ts',
        'mvp-loop.spec.ts',
        'offline.spec.ts',
        'offline-map.spec.ts',
        'perf-load.spec.ts',
        'points-lines.spec.ts',
        'draw-precision.spec.ts',
        'brush.spec.ts',
        'overlays.spec.ts',
      ],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        hasTouch: false,
        isMobile: false,
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
