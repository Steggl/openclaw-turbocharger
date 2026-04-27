# Contributing to openclaw-turbocharger

Thanks for considering a contribution. This guide describes the
working agreements that keep the project understandable as it grows.
Most of these conventions exist because of a specific problem the
project ran into; the rationale is in the linked ADR where one exists.

## Workflow

- **Open an issue before non-trivial work.** A short description of
  what you intend to change and why is enough. Issues are also where
  design feedback happens before code is written.
- **One issue per PR.** Don't combine #5 with #6 in a single
  branch. The CI is fast enough that splitting is cheap, and
  reviewers will thank you.
- **Branch naming follows the issue type:**
  - `feat/N-short-description` for new features (e.g.
    `feat/9-transparency-banner`).
  - `fix/short-description` for bug fixes.
  - `docs/short-description` for documentation-only changes.
  - `refactor/short-description` for code restructuring without
    behaviour change (e.g. `refactor/chorus-as-answer-mode`).
  - `chore/short-description` for tooling, dependencies, or
    formatting commits that ship outside a feature branch.
- **Commits use Conventional Commits.** Examples:
  - `feat(critic): implement hard-signal detector`
  - `fix(proxy): preserve request-id header on forward`
  - `docs(readme): clarify escalation modes`
  - `refactor(types): separate AnswerMode from EscalationMode`
  - `chore: apply prettier to refactor files`
  - `test(escalation): cover ladder exhaustion path`
- **Rebase-and-merge, no squash.** The project's commit history is a
  documented design narrative — every commit on `main` should still
  be a meaningful unit you'd want to read in isolation. Squash-merging
  loses that, fast-forward merging keeps unrelated commits adjacent,
  rebase-and-merge is the compromise.

## Code

- **TypeScript strict mode.** `tsconfig.json` enables
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and
  `noUncheckedIndexedAccess`. Most non-trivial type errors trace to
  one of these — read the message carefully before reaching for
  `any`. If `any` is genuinely the right answer, add a comment
  explaining why; otherwise prefer `unknown` plus a narrowing check.
- **Runtime dependencies stay minimal.** The project's contract is
  fewer than five runtime dependencies (currently two: `hono` and
  `@hono/node-server`). Adding one requires justification in the PR
  description. Dev dependencies are less constrained but should
  still be defended.
- **No silent fallbacks that hide failures.** When a critic, proxy,
  or escalation step can't do its job, surface the specific failure
  through the discriminated result types — don't convert `error` or
  `skipped` into an implicit `pass`. The pattern is in
  [ADR-0012](./docs/DECISIONS.md) and applied consistently across
  modules.
- **No overclaiming.** "Eliminates bias", "always picks the best
  model", "guaranteed savings" are out. Measured language only:
  "reduces the chance of silent failures", "shows the user when
  escalation happened", "may reduce cost depending on workload".
  The project's brief (§14) calls this out specifically because
  it's easy to slip into marketing tone in technical docs.

## Tests

- **`vitest` for unit tests.** Co-located under `test/`, named after
  the module they exercise (e.g. `test/banner.test.ts` for
  `src/transparency/banner.ts`).
- **Integration tests live next to their unit tests** with a
  `pipeline-` prefix when they exercise the full HTTP path
  (e.g. `test/pipeline-banner.test.ts`).
- **End-to-end tests** that need a live LLM endpoint live under
  `test/e2e/` and are opt-in — they don't run in the default CI.
- **New code paths get tests.** Especially for branches that handle
  failure modes — the hardest bugs hide in the "should never
  happen" branches.

## Local verification

Before pushing, run the full local pipeline:

```bash
pnpm check
```

This runs, in order: `prettier --write`, `eslint --fix`, `eslint`,
`prettier --check`, `tsc --noEmit`, `vitest run`, `tsup`. Any step
failing fails the whole command. CI runs the same steps but each
in its own job, so a CI failure points to a specific stage.

The `prettier --write` step normalises formatting silently. CI runs
`prettier --check`, which doesn't, so format-drift can pass local
verification but fail CI. The defence is to commit any formatting
changes the local check makes — see the recurring `chore: apply
prettier to ...` commits in the project history for the established
pattern.

## Architecture decisions

Non-trivial architectural decisions are recorded in
[`docs/DECISIONS.md`](./docs/DECISIONS.md) as numbered ADRs. The
heuristic for "non-trivial" is: would a future contributor
reading only the code be able to reconstruct why the decision was
made the way it was? If not, write an ADR.

Each ADR follows a short consistent shape:

- **Date** (`YYYY-MM-DD`) and **status**
  (`accepted` / `superseded by ADR-NNNN` / `deprecated`).
- **Decision**: one paragraph stating what was decided, in the
  imperative. No setup, no preamble.
- **Rationale**: why this and not the obvious alternative.
- **Alternatives considered**: explicit list with reasons for
  rejection. The most useful section for future readers because it
  documents the negative space.
- **Consequences** or **Mechanical scope**: where applicable, what
  this means for downstream code or other ADRs.
- **Related**: cross-links to other ADRs, issues, or sections of
  the brief.

ADRs that supersede earlier ones don't delete them — the earlier
record stays in place with a `Status: superseded` note so the
project's evolution remains readable.

## Tone of written artifacts

The brief (§14, item 6) puts it best: "honest, technical, slightly
dry, respectful toward related projects, non-hype". This applies to
README, docs, commit messages, issue descriptions, ADRs, and
changelog entries equally. Mistakes happen — own them in the next
commit and move on. The project's history isn't supposed to look
heroic; it's supposed to be useful to the next person who comes
through.
