# Architecture Decision Records

Log of non-trivial architectural decisions made during development.

`DESIGN.md` is the final, trimmed design document — the stable stand.
This file is the **logbook** of the paths that led there: decisions,
their rationale, alternatives considered, and the link to the issue
or PR where the decision was made.

## Format

Each entry uses this shape:

```
## ADR-NNNN: <short title>

- **Date:** YYYY-MM-DD
- **Status:** accepted | superseded-by ADR-XXXX | revised
- **Decision:** one-sentence statement of what was chosen.
- **Rationale:** why — in two to five sentences, not a blog post.
- **Alternatives considered:** what else was on the table and why it was not chosen.
- **Related:** issue / PR / commit hashes.
```

Entries are numbered sequentially (`ADR-0001`, `ADR-0002`, …) and append-only.
Revisions add a new entry that supersedes the old one rather than rewriting history.

---

<!-- First entry below. -->

## ADR-0001: Node.js version

- **Date:** 2026-04-18
- **Status:** accepted
- **Decision:** Pin Node 22 LTS in `.nvmrc`, `engines.node` in `package.json`,
  `tsup` build target, and the CI matrix.
- **Rationale:** `PROJECT_BRIEF.md` §8 specified Node 20 as "LTS" at the time
  of writing. Node 20 is scheduled to leave LTS imminently, which would mean
  the scaffold starts life on a soon-to-be-EOL runtime and forces a near-term
  follow-up upgrade. Node 22 is the current Active LTS. Taking the bump now
  as a one-line change is cheaper than carrying the mismatch. The brief's
  intent — "the current Active LTS" — is preserved; only the version number
  is updated.
- **Alternatives considered:**
  - _Stay on Node 20 until its scheduled maintenance-EOL._ Rejected: the
    remaining support window is too short to justify the carry, and any new
    contributor would install Node 20 on a machine that would outlive it.
  - _Jump straight to Node 24._ Rejected: Node 24 was not the Active LTS at
    the time of this decision; defaulting to the current Active LTS is the
    more defensive baseline. Revisit when Node 24 is promoted.
  - _Matrix-test both 20 and 22._ Rejected for this scaffold step: the
    project has no runtime dependencies yet and no Node-20-specific code
    paths, so there is nothing to validate against 20 today. The matrix
    structure is in place in `ci.yml`; adding versions is a one-line edit.
- **Related:** chore commit bumping `.nvmrc`, `package.json` (`engines`,
  `@types/node`), `tsup.config.ts` (target), and `.github/workflows/ci.yml`
  (matrix). Supersedes `PROJECT_BRIEF.md` §8 guidance on the Node version
  only; all other stack decisions in §8 remain as written.

## ADR-0002: Scaffold hardening

- **Date:** 2026-04-18
- **Status:** accepted
- **Decision:** Three changes to make the scaffold strict and unambiguous
  before functional work starts.
  1. Split `tsconfig.json` into editor/typecheck (`tsconfig.json`, with
     `noEmit: true` and no emit-only fields) and build (`tsconfig.build.json`,
     `extends` root, sets `noEmit: false`, `declaration`, `declarationMap`,
     `sourceMap`, `outDir`, and includes `src/**` only). `tsup` is pointed
     at `tsconfig.build.json` for its `dts` step.
  2. Enable the additional strict flags in the root `tsconfig.json`:
     `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
     `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`.
     The build config inherits these via `extends`.
  3. Add `pnpm format:check` as a CI step between `lint` and `typecheck`.
- **Rationale:**
  1. The previous single `tsconfig.json` set both `noEmit: true` and emit-only
     fields (`outDir`, `declaration`, `sourceMap`). The emit fields were
     silently ignored — a latent contradiction that would mislead anyone
     adding a `tsc`-based build step later. Splitting makes each config's
     job explicit.
  2. These flags catch real classes of bugs (array access past bounds,
     optional-property conflation, missing returns, dead code) and are
     cheaper to turn on now, before any code exists, than to retrofit later.
  3. Prettier drift is a small paper cut that compounds in PR review.
     Catching it in CI is one line and costs almost nothing per run. It
     lands before typecheck so a formatting-only failure doesn't hide real
     type errors on the same commit.
- **Alternatives considered:**
  - _Single `tsconfig.json` with a `references`-based project setup._
    Rejected for the current size: project references add ceremony that
    pays off only when there are multiple compilation units. Revisit if
    we ever split the workspace.
  - _Rely on ESLint for unused-locals / unused-params only, not TypeScript._
    Rejected: the two checkers disagree in edge cases, and having the
    compiler itself refuse to emit on unused bindings is the stronger
    guarantee. Both layers stay on; the `_`-prefix escape hatch works
    under both.
  - _Leave formatting drift to a pre-commit hook only._ Rejected: hooks
    are optional per contributor. CI is the one place the check is
    unavoidable.
- **Related:** chore commit `chore: harden scaffold` touching
  `tsconfig.json`, new `tsconfig.build.json`, `tsup.config.ts`, and
  `.github/workflows/ci.yml`. The HTTP framework decision originally
  pencilled in as ADR-0002 becomes ADR-0003 and lands with issue #2.

## ADR-0003: HTTP framework choice

- **Date:** 2026-04-18
- **Status:** accepted
- **Decision:** Use [`hono`](https://hono.dev) with `@hono/node-server` as
  the HTTP layer for the sidecar's OpenAI-compatible server. Two new
  runtime dependencies; runtime-dep budget (brief §8: under five) stays
  comfortably under target.
- **Rationale:** Hono is built on the Web Fetch API (`Request` /
  `Response` / `ReadableStream`), which matches the shape of the
  pass-through proxy almost exactly — the upstream client's request body
  and headers map directly to a `fetch()` call against the downstream
  target, and the downstream's streaming `Response.body` can be returned
  unchanged. Hono ships with zero transitive dependencies of its own,
  and `@hono/node-server` is a thin adapter onto `node:http`. Tests can
  exercise the app via `app.fetch(request)` without binding a port,
  which keeps the proxy test suite hermetic. The router primitive will
  also absorb the additional endpoints expected from later issues
  (`/v1/models`, header-based per-request overrides from issue #12,
  health/readiness) without restructuring.
- **Alternatives considered:**
  - _Raw `node:http`._ Rejected. Workable for a single endpoint but
    forces hand-rolled header copying, body buffering vs. piping
    decisions, and streaming back-pressure handling that Hono gives for
    free via the Fetch streaming APIs. The dependency saving (zero vs.
    two) is real but small in absolute terms and the budget allows it.
  - _`itty-router`._ Rejected. Comparable size, but less idiomatic on
    Node for streaming bodies (designed primarily for edge runtimes
    where body handling differs) and no first-class Node adapter
    matching `@hono/node-server`.
  - _`fastify` / `express`._ Rejected. Both pull in significantly more
    surface area than the project's "minimal magic, minimal deps" stance
    in brief §8 warrants for what is structurally a thin proxy.
- **Related:** issue #2 (`feat/2-core-http-server`); the
  `feat(core): …` commit on that branch introduces the dependencies and
  the initial server / proxy modules.
