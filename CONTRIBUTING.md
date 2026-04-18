# Contributing

This project is in early scaffold stage. A full contribution guide will land
alongside the `v0.1.0-alpha` release (see `PROJECT_BRIEF.md` §10, issue #15).

Until then, the short version:

- **Open an issue before starting non-trivial work.** One issue per logical
  change. Don't combine #2 with #3 in a single PR.
- **Conventional Commits.** Examples: `feat(critic): implement hard-signal
detector`, `fix(proxy): preserve request-id header on forward`,
  `docs(readme): clarify escalation modes`.
- **TypeScript strict mode.** No `any` without a comment explaining why.
- **Runtime dependencies are deliberately kept minimal.** Target: fewer than
  five. Adding one requires justification in the PR description. Dev
  dependencies are less tightly constrained but should still be justified.
- **Tests are required for new logic.** `vitest` for unit tests;
  `test/e2e/**` for tests that need a live endpoint (those are opt-in and not
  part of the default CI run).
- **Tone of written artifacts** (README, docs, commit messages, issue
  descriptions) is honest, technical, slightly dry, respectful toward related
  projects, non-hype. See `PROJECT_BRIEF.md` §14.
- **No overclaiming.** Phrases like "eliminates bias," "always picks the best
  model," or "guaranteed savings" are out. Measured language only:
  "reduces the chance of silent failures," "shows the user when escalation
  happened," "may reduce cost depending on workload."

## Decision log

Non-trivial architectural decisions are recorded in [`docs/DECISIONS.md`](./docs/DECISIONS.md).
If your change makes or revises such a decision, add or update the entry in
the same PR.
