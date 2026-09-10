# How to write CLAUDE.md

Instructions for the agent that generates or maintains `CLAUDE.md` at the repo root. Delete this file once you are happy with the result, or keep it as the spec for future rewrites.

## What CLAUDE.md is for

It is a router, not documentation. It gets read into context on every session in this repo, so every line costs tokens on every turn forever. Its job is to state the invariants that are expensive to get wrong, and to point at where the detail lives.

## Hard constraints

- **Under 50 lines.** If you are at 50, something belongs in `docs/` instead.
- **No prose paragraphs.** Bullets and short lines.
- **No content that is already in `docs/`.** Link to the file; do not summarise it. A summary that drifts from its source is worse than no summary.
- **No content the agent can discover by reading the code.** Do not list directories, dependencies, or file names. Those go stale within a week and the agent can see them anyway.
- **No aspirational content.** Nothing about future features, roadmap, or "eventually we will". If it is not true of the code today, it does not go in.
- **No praise, no tone-setting, no "be helpful".** State rules, not attitudes.

## Required sections, in this order

1. **One-line description of the project**, then a pointer to `SPEC.md`.
2. **Stack** — one line, comma-separated. Names only, no versions (versions live in `package.json`).
3. **Rules** — the invariants. This is the only section that earns its length. Each rule must be a statement the agent could otherwise violate by making a reasonable-looking choice. See below.
4. **Commands** — the four or five commands actually used. Copy-pasteable, no explanation.
5. **Docs** — one line per file in `docs/`, with what question each one answers.

## What counts as a rule

A rule belongs in `CLAUDE.md` if breaking it is (a) plausible for a competent agent acting in good faith, and (b) expensive to undo. Both conditions, not one.

Qualifies:
- `areas.geom` is the source of truth; `area_cells` is derived. Never write cells without writing geometry.
- `dimension` stays `'overall'`. Do not add rating dimensions in the UI.
- No geometry union, clipping or self-intersection handling. Overlaps are a rendering concern.
- Mobile viewport (390x844) is the primary target. Verify there before desktop.
- Schema changes go through `supabase/migrations/`. Never edit in the Supabase dashboard.
- Work from `docs/OBJECTIVES.md`. Never mark a goal done without running its `done_when` commands.

Does not qualify — do not include:
- "Write clean code", "add tests", "follow best practices". Unfalsifiable.
- "Use TypeScript". Visible from the repo.
- "Ask before making large changes". Belongs in the harness, not the file.
- Anything that restates a `docs/` file.

## Maintenance

- When a rule stops being true, delete it. A stale rule is followed as confidently as a live one.
- When a rule is repeatedly violated, the rule is unclear, not the agent. Rewrite it as a concrete prohibition rather than a preference.
- Do not grow this file with each session's lessons. If it exceeds 50 lines, the newest additions are usually the least important; cut those first.

## Verification

Before committing a `CLAUDE.md`, check:

- [ ] Under 50 lines
- [ ] Every rule names something specific in this codebase
- [ ] No rule could be replaced by "read the code"
- [ ] No section duplicates a `docs/` file
- [ ] Every command listed actually runs
