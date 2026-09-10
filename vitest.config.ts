import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Root-anchored: vitest's default include glob also picks up
    // tests/e2e/*.spec.ts (Playwright files, wrong runner) and anything
    // under .claude/worktrees/. Scope to the unit suite only.
    include: ['tests/unit/**/*.test.ts'],
  },
})
