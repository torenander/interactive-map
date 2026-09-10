# Docs/tooling fix log

Findings from the doc/tooling review, fixed on `main`.

1. README.md rewritten: honest MVP-complete status, real Kom igång steps, linked to `docs/` instead of duplicating it.
2. Added `vitest.config.ts` (`include: ['tests/unit/**/*.test.ts']`) — bare `npm run test` was exiting 1 because the default glob picked up Playwright specs and `.claude/worktrees/`.
3. SPEC.md's architecture table and data-model summary corrected to the edge-function reality, marked `**Superseded (2026-09-10).**`, mirroring `docs/ARCHITECTURE.md` line 60's convention.
4. `tests/e2e/mvp-loop.spec.ts` strengthened: asserts `comment-input` holds the saved comment after the first reload and again after the edit+reload cycle. The modal does repopulate the comment — no product bug.
5. `.env.example` — one comment noting current values come from `npx supabase status -o env` and may differ from the committed anon key.
6. CLAUDE.md — re-ran the `docs/CLAUDE-MD-INSTRUCTIONS.md` verification checklist; already compliant (41 lines, no duplication, every listed command runs, including `npm run test` now that (2) landed). No edit needed.

Gates: `npm run build` exit 0; bare `npm run test` exit 0 (3 files, 14 tests); `npm run test -- tests/unit/queue.test.ts` exit 0; `npm run test:e2e -- tests/e2e/mvp-loop.spec.ts` exit 0.
