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

  ## ADR-0004: Three fixed tiers instead of a configurable ladder

- **Date:** 2026-04-19
- **Status:** accepted, supersedes `PROJECT_BRIEF.md` §5 ladder shape
- **Decision:** Replace the open-ended ladder chain from the brief with
  three fixed tiers — `simple`, `regular`, `complex`. Each request enters
  at `simple` and may escalate at most to `complex`. Tier occupants are
  model slugs chosen per provider (heuristic defaults for Anthropic and
  OpenAI, manual for OpenRouter; see ADR-0005).
- **Rationale:** The brief's ladder is expressive but pays for that with
  cognitive load on the user. In practice, deployments use one provider
  at a time and the meaningful distinctions collapse to "cheap / default
  / top". Three tiers keep the mental model small enough to hold without
  a reference chart, map cleanly onto how providers actually structure
  their offerings, and make the lifecycle-management feature (ADR-0006)
  tractable — three slots are trackable, an arbitrary chain is not. The
  `max` and `chorus` escalation _modes_ from brief §5 remain; they now
  describe the escalation _target_ (one jump to `complex` vs. chorus
  dispatch) rather than alternative ladder shapes.
- **Alternatives considered:**
  - _Keep the configurable ladder from the brief._ Rejected: flexibility
    that users rarely customize beyond the defaults, at the cost of a
    harder config story and harder lifecycle tracking.
  - _Two tiers (fast / strong)._ Rejected: collapses the middle ground
    where the bulk of real traffic lives. Three is the minimum for a
    meaningful escalation decision.
  - _Runtime-discovered tiers based on live benchmarks._ Rejected as
    over-engineering for v0.1. The lifecycle check (ADR-0006) gives us
    the update mechanism without making tiers dynamic per-request.
- **Related:** issue #6 (`escalation:ladder`) now implements the three-tier
  dispatch; issue #7 (`escalation:max`) collapses to a single-jump from
  `simple` directly to `complex`; issue #8 (`escalation:chorus-stub`)
  unchanged. The `max_escalation_depth` config key from brief §5 is kept,
  default stays at 2 — meaning `simple → regular → complex` is the
  maximum path, which is naturally bounded by the tier count.

## ADR-0005: Benchmark-driven tier initialization and lifecycle management

- **Date:** 2026-04-19
- **Status:** accepted, extends `PROJECT_BRIEF.md` §11 "model churn" from
  acknowledged risk to active feature
- **Decision:** Turbocharger treats tier occupants (ADR-0004) as
  benchmark-driven state that is periodically refreshed. On initial setup,
  the sidecar proposes tier assignments from public benchmark data. On a
  configurable schedule (default: weekly), it re-evaluates whether current
  occupants are still optimal and either auto-updates or notifies the user
  depending on policy. Before any automatic model swap, a local regression
  check (20-query bootstrap suite, pairwise judge from a third-party
  provider, 70% pass threshold) verifies behavioural equivalence.
  The benchmark source is abstracted behind a `BenchmarkProvider`
  interface; the initial implementation uses Artificial Analysis
  (free public API, covers all three target providers).
- **Rationale:** The model landscape changes monthly. The brief §11
  listed this as a constraint to acknowledge ("sensible defaults and
  clear cost-ceiling controls are essential") but did not specify how.
  Leaving it manual means users carry the maintenance burden; none of
  the competing routers (ClawRouter, iblai-router, openmark-router) do
  this today. Making it a first-class feature with benchmark-backed
  heuristics and a regression-check gate is a genuine differentiation
  and cheap to implement given abstracted benchmark access. The
  regression check is the critical safety net — providers sometimes
  release equivalent-scoring models that behave differently (stricter
  refusals, subtly different tool-call semantics), and naive auto-update
  would silently regress user workflows.
- **Alternatives considered:**
  - _Manual-only tier config, no lifecycle feature._ Rejected: users
    drift into stale configs, and the feature is cheap to ship.
  - _Build our own benchmark harness._ Rejected: explicitly out of scope
    per brief §1 ("not a benchmarking platform"), and solo-maintainer
    infeasible.
  - _Multiple benchmark sources aggregated._ Deferred to post-MVP.
    One reliable source plus an abstraction for fallback is enough for
    v0.1. The `BenchmarkProvider` interface keeps the door open.
  - _Auto-update without regression check._ Rejected: the empirical
    track record of "drop-in" model replacements being silent downgrades
    is too strong to ignore. The ~$1 regression check is negligible
    insurance.
- **Related:** new issue group — `benchmarks:provider-interface`,
  `benchmarks:artificial-analysis`, `benchmarks:cache`,
  `lifecycle:tier-initialization`, `lifecycle:weekly-check`,
  `lifecycle:regression-suite`, `lifecycle:regression-runner`, plus a
  `cli:init` command for first-time tier setup. OpenRouter is handled as
  expert mode (manual tier assignment, no auto-lifecycle) since its
  ~100+ model pool defeats the heuristic approach.

## ADR-0006: Probabilistic critic aggregation via noisy-OR

- **Date:** 2026-04-19
- **Status:** accepted, revises `PROJECT_BRIEF.md` §4 aggregation shape
- **Decision:** Each hard-signal rule returns a `Signal` with continuous
  confidence in `[0, 1]` rather than a boolean fire/no-fire. Signals
  aggregate via noisy-OR:
  `P(inadequate) = 1 - prod(1 - weight_i × confidence_i)`.
  Escalation triggers when the aggregate crosses a configurable
  threshold (default 0.6). Weights are per-category and configurable
  (default 1.0 for all categories); rules can be individually disabled
  via config.
- **Rationale:** The brief §4 describes hard-signal detection in boolean
  terms ("if any rule flags the response as inadequate → escalate").
  In practice, this has two failure modes: single false-positive rules
  cause unnecessary escalation (eroding the cost savings), and
  collectively-suspicious weak signals fire nothing (three mild hedges
  that would each score 0.3 are invisible). Noisy-OR is the
  mathematically principled way to combine independent probabilistic
  evidence, and it collapses the tuning surface from "per-rule
  thresholds" to a single aggregate threshold. The independence
  assumption is only approximately true (a refusing model often also
  produces short responses, correlating those signals), but the
  approximation is acceptable for the bounded precision we need.
- **Alternatives considered:**
  - _Keep boolean aggregation from the brief._ Rejected: collectively-
    weak evidence is invisible, and single-rule false positives
    dominate cost regression.
  - _Simple max over rule confidences._ Rejected: throws away the
    cumulative evidence of multiple weak signals — exactly the case
    where probabilistic combination adds value.
  - _Weighted mean._ Rejected: sensitive to the number of rules that
    happen to apply, so adding a new rule dilutes existing strong
    signals.
  - _Trained classifier on top of rule outputs._ Rejected as
    over-engineering for v0.1. Can be added later once empirical data
    from real traffic exists.
- **Related:** issue #3 (`critic:hard-signals`), issue #5
  (`critic:orchestrator`). Default threshold of 0.6 is a starting value
  calibrated by intuition; post-MVP calibration against the synthetic
  bootstrap suite (ADR-0005 regression suite, repurposed) will tune it
  with evidence.

## ADR-0007: Four-layer transparency model

- **Date:** 2026-04-19
- **Status:** accepted, extends `PROJECT_BRIEF.md` §7 transparency modes
- **Decision:** Transparency is delivered through four complementary
  layers serving different audiences:
  1. **In-stream content** (silent / banner / card, as in brief §7) — for
     human readers.
  2. **SSE events** (`turbocharger.decision`, `turbocharger.escalation`,
     `turbocharger.notice`) — for integrating clients that parse the
     stream structurally.
  3. **HTTP response headers** (`X-Turbocharger-Decision`,
     `X-Turbocharger-Models`, `X-Turbocharger-Confidence`,
     `X-Turbocharger-Signals`, `X-Turbocharger-Cost-USD`) — for
     monitoring tools that don't parse the body.
  4. **Audit log** (JSONL, privacy-by-default: hashed prompts and
     decision metadata only, verbose mode opt-in with separate
     retention) — for forensics and compliance.
     Clients that don't recognize a layer ignore it gracefully.
- **Rationale:** Brief §7 addresses the end-user with three modes but
  leaves integrators, monitoring tools, and auditors without suitable
  data channels. Each audience has different needs: humans want
  minimal annotation in the response, integrators want structured
  events, monitoring wants headers without body parsing, auditors want
  retained records for later analysis. A single mechanism cannot serve
  all four. The four layers are orthogonal and cheap to implement
  individually; the audit log specifically addresses GDPR/DSGVO
  exposure (brief §2: EU-compatibility) by defaulting to no raw
  content logging.
- **Alternatives considered:**
  - _Brief's three modes only._ Rejected: integrators and monitoring
    are left without structured data, forcing them to scrape banner
    content — fragile and slow.
  - _SSE events only, no banner._ Rejected: requires client
    cooperation that most clients in 2026 don't have. Banner is the
    universal fallback for transparency.
  - _Always log full content for debuggability._ Rejected on GDPR
    grounds and user-trust grounds. Verbose mode is the explicit
    opt-in for when debugging needs trump default privacy.
  - _Leave audit to external tooling (log shippers)._ Rejected: the
    audit layer is trivial to implement locally, and external
    dependencies for privacy-relevant data are worse than a local
    file.
- **Related:** issue #9 (`transparency:banner`) and #10
  (`transparency:card`) — the in-stream layer; new issues
  `transparency:sse-events`, `transparency:headers`,
  `transparency:audit-log`. Audit retention enforcement
  (automatic cleanup after N days) is deferred to post-MVP; v0.1 ships
  with manual cleanup guidance in the docs.
