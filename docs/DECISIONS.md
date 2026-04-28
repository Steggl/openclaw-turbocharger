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

## ADR-0008: Syntax-error detection scope limited to JSON for v0.1

- **Date:** 2026-04-20
- **Status:** accepted
- **Decision:** The `syntax_error` hard-signal detector (one of the
  six categories introduced for ADR-0006) checks only JSON code fences
  in v0.1. Blocks explicitly tagged `json` that fail `JSON.parse` emit
  a signal at confidence `0.85`; blocks that parse cleanly, and fences
  tagged with any other language (or with no tag at all), emit
  nothing. Multi-language syntax validation (JavaScript/TypeScript,
  Python, shell, SQL, etc.) is deferred to a post-MVP follow-up issue,
  `critic:code-syntax`.
- **Rationale:** `PROJECT_BRIEF.md` §4 calls out "syntax errors in
  code outputs" as a hard-signal category, but does not scope _which_
  languages. A useful multi-language check requires either a real
  compiler/interpreter per language (pulls in heavy runtime
  dependencies, often with native bindings, which violates the
  runtime-dep budget in brief §8) or a tolerant parser that is likely
  to over-fire on valid code it happens not to recognize. Neither fits
  the "minimal magic, minimal deps" stance in the brief, and
  over-firing specifically undermines ADR-0006 — the noisy-OR
  aggregator depends on each detector having a low false-positive rate
  at its declared confidence, because false fires from one detector
  can pull the aggregate across the threshold on their own. JSON sits
  at the opposite end of that trade: `JSON.parse` is in the runtime
  already, is deterministic, and has a near-zero false-positive rate
  when the fence is explicitly tagged `json`. In real-world LLM
  traffic, structured JSON outputs (tool calls, form responses, config
  blocks) are frequent, and a parse failure there is a clean
  inadequacy signal.
- **Alternatives considered:**
  - _Full JavaScript/TypeScript validation via the `typescript`
    package._ Rejected for v0.1. The TypeScript compiler is tolerant
    by design — it parses many constructs that fail at runtime and
    mis-reports many that succeed. Distinguishing true syntax errors
    from resolution errors (e.g. `TS2307 "cannot find module"`) adds
    significant maintenance surface. Worth doing as its own
    `critic:code-syntax` issue with a dedicated config key; not worth
    squeezing into #3.
  - _Drop the `syntax_error` category from v0.1 entirely._ Rejected:
    JSON parse-checks deliver genuine value for structured LLM output
    at roughly fifteen lines of code and zero extra dependencies.
    Losing that would be strictly worse for the same cost.
  - _Multi-language via abstract-syntax-tree libraries (e.g.
    `tree-sitter`)._ Rejected for v0.1. `tree-sitter` pulls in native
    grammar bindings per language, which violates both the runtime-dep
    budget and the implicit zero-native-dep preference in the brief.
- **Related:** issue #3 (`critic:hard-signals`), in which the detector
  lands. Post-MVP follow-up `critic:code-syntax` tracks full
  multi-language coverage. The detector's `category` is kept as the
  broader `syntax_error` (not `json_syntax_error`) so that the
  transparency layer (ADR-0007) and the audit log need no changes
  when the multi-language version lands; new languages extend the
  detector, not the type surface.

## ADR-0009: Local check pipeline with granular CI

- **Date:** 2026-04-20
- **Status:** accepted
- **Decision:** Local verification and CI verification use the same
  underlying scripts (`lint`, `format:check`, `typecheck`, `test`,
  `build`) but compose them differently. Locally, `pnpm check` runs
  Prettier-write and ESLint-autofix first, then the read-only gates in
  the same order CI runs them. A separate `pnpm check:ci` script runs
  only the read-only gates — it exists so contributors can reproduce
  CI behaviour locally, but the CI workflow itself does **not** call
  it; the workflow keeps its five granular steps (`Lint`,
  `Format check`, `Typecheck`, `Test`, `Build`).
- **Rationale:** Issues #2 and #3 each produced a prettier-drift
  fixup commit after the feature work, because the patches were
  prepared in an environment where Prettier was not available to
  normalize output. Making `pnpm check` the default pre-commit
  command — auto-fix first, then strict verification — eliminates
  that pattern: running it once before committing guarantees format
  and lint hygiene without a follow-up commit. At the same time, the
  CI workflow benefits from keeping each verification stage as its
  own named step: GitHub Actions highlights the failing step in the
  run summary, so a contributor opening a red CI run sees at a glance
  whether the problem is type errors, test failures, or build errors.
  Collapsing to a single `pnpm check:ci` step would save roughly ten
  lines of YAML but force everyone reviewing a red run to scroll
  through logs to identify which gate failed. The trade is small on
  one side and real on the other, so the lines of YAML stay.
- **Alternatives considered:**
  - _Collapse CI to a single `pnpm check:ci` step._ Rejected as
    described above: modest YAML reduction, measurable diagnostic
    cost.
  - _Drop `pnpm check:ci` entirely, keep only `pnpm check`._
    Rejected: without `check:ci`, reproducing the exact CI pipeline
    locally requires typing out five commands joined by `&&`.
    Contributors investigating a CI failure want a one-liner. The
    two-script split (fix-then-verify locally, verify-only for
    reproduction) is cheap and covers both cases.
  - _Run `pnpm check` in CI._ Rejected: CI should never rewrite
    files. Prettier-write and ESLint-autofix in CI would either
    silently mask contributor format drift (if the rewritten files
    are discarded) or create a mutation loop (if they are committed
    back). The `check:ci` script guarantees the read-only stance by
    construction.
  - _Git pre-commit hook that runs `pnpm check`._ Deferred, not
    rejected. Hooks are per-contributor opt-in and require
    installation setup; `pnpm check` as a documented one-liner is a
    lower-friction first step. A post-MVP issue can add a husky /
    simple-git-hooks wiring if contributor volume ever justifies it.
- **Related:** Introduced on branch `feat/3-critic-hard-signals` in
  commit `79c9a61` (rebased to `e7a1f39` on main) as part of PR #3.
  This ADR retroactively records the decision; no further code
  change is needed.

## ADR-0010: LLM-critic triggers only inside the grey band of the hard-signal aggregate

- **Date:** 2026-04-20
- **Status:** accepted
- **Decision:** The orchestrator (issue #5) invokes the LLM-critic only
  when the noisy-OR aggregate of the hard-signal detectors (ADR-0006)
  lands in the configurable grey band, default `[0.30, 0.60)`. Aggregates
  below `0.30` skip the LLM-critic because the response is clearly
  adequate; aggregates at or above `0.60` skip it because the
  escalation threshold has already been crossed and a second opinion
  would only add cost.
- **Rationale:** The brief §4 describes the LLM-critic as running "only
  when hard-signals return 'no clear failure' AND a confidence
  threshold says the answer is borderline". That rule is stated in
  boolean terms; ADR-0006 moved the hard-signal pipeline to
  continuous confidence and a noisy-OR aggregate. Translating "no
  clear failure" and "borderline" onto that continuous scale produces
  a band: the lower edge marks "confidently adequate, no point
  checking further", and the upper edge is simply the escalation
  threshold itself (whatever a future configuration sets it to).
  Running the critic outside the band is always wasteful: below the
  lower edge the escalation would not fire regardless; at or above the
  upper edge it fires on the hard-signal evidence alone. Inside the
  band, the LLM-critic earns its keep — it catches the subtle
  inadequacy cases that the hard-signal heuristics miss, without
  running on every request.
- **Alternatives considered:**
  - _Run the LLM-critic on every request below the escalation
    threshold._ Rejected: pays for a small-model inference call on
    every confidently-adequate response. At any realistic volume the
    cumulative cost overwhelms the savings from cheaper-model-first.
  - _Run the LLM-critic on every request, regardless of hard-signal
    aggregate._ Rejected more strongly: same objection, worse.
    Belongs in a user-selectable "always second-opinion" mode,
    post-MVP.
  - _Run only when the aggregate is exactly at the threshold within
    a small epsilon._ Rejected: the grey band is the epsilon, just
    with an explicit floor and ceiling. An epsilon framing without
    named bounds would be harder to reason about and harder to
    calibrate later.
- **Related:** issue #4 (this commit introduces the critic; the
  orchestrator that applies the band gating lands in issue #5); the
  default `[0.30, 0.60)` can be revised when post-MVP calibration data
  exists.

## ADR-0011: LLM-critic verdict is a separate threshold check, not mixed into the noisy-OR pool

- **Date:** 2026-04-20
- **Status:** accepted
- **Decision:** The {@link LlmVerdict} returned by the critic is
  evaluated against the escalation threshold independently of the
  hard-signal noisy-OR aggregate. Escalation fires when
  `(hard_signal_aggregate >= threshold) || (verdict === 'fail' &&
verdict.confidence >= threshold)`. A pass verdict never triggers
  escalation regardless of confidence. The critic does not contribute
  a `Signal` to the hard-signal pool.
- **Rationale:** Hard-signal detectors and the LLM-critic supply
  structurally different evidence. Hard signals are independent
  heuristics over surface features (refusal phrasing, truncation,
  repetition, empty response, tool error, syntax error); noisy-OR is
  the right combinator because each detector fires on its own
  evidence channel. The LLM-critic's output is holistic — a single
  verdict on the whole response — and it is not independent of the
  hard signals: the same refusal phrasing that fires the refusal
  detector is also visible to the critic. Mixing them into one pool
  double-counts that evidence and gives the critic outsized weight
  (at confidence 0.80, a single LLM-critic vote would alone cross
  the default threshold regardless of what any hard-signal detector
  found). Keeping them in separate tracks makes the escalation
  condition explicit and easier to reason about, and it lets each
  track be tuned independently (the grey-band cut-offs in ADR-0010
  do not need to stay in sync with hard-signal weights in issue #11).
- **Alternatives considered:**
  - _Add an `llm_critic` category to the hard-signal pool._
    Rejected: double-counts evidence the hard signals already saw,
    and gives a single high-confidence vote disproportionate weight
    under noisy-OR.
  - _Keep the pool but weight the critic signal down._ Rejected:
    trades one calibration problem for another. The principled
    answer is separate tracks, not a magic weight.
  - _Replace the hard-signal pool with the critic whenever the
    critic fires._ Rejected: throws away real evidence from the
    deterministic detectors, and couples escalation to a
    probabilistic external call.
- **Related:** issue #4 (this commit introduces the verdict type);
  issue #5 implements the two-track threshold comparison.

## ADR-0012: LLM-critic v0.1 implementation — no cloud defaults, locale-keyed prompts (EN + DE), tolerant parsing

- **Date:** 2026-04-20
- **Status:** accepted
- **Decision:** Three coupled implementation details of the v0.1
  LLM-critic.
  1. No defaults are baked in for the critic's `baseUrl` or `model`.
     Callers must supply both explicitly. Budget enforcement is
     opt-in (requires both `budgetUsd` and `pricing`).
  2. Prompt templates are locale-keyed: English and German shipped,
     English selected for unknown locales. The system prompt in each
     template explicitly tells the critic that the user and assistant
     may converse in any language and that the verdict JSON is always
     in English with fixed field names.
  3. Verdict extraction is deliberately tolerant: first a
     ` ```json ` fence, then the first-`{`-to-last-`}`
     substring, then the whole response body parsed as JSON. Each
     strategy falls through to the next if either `JSON.parse` or
     shape validation fails.
- **Rationale:**
  1. _No cloud defaults._ A silent default for the cloud critic
     endpoint would cause a misconfigured turbocharger to fire
     inference calls against whatever provider we happened to pin as
     "the default", at unexpected cost to the user. Explicit
     configuration forces the user to acknowledge the billing
     relationship. Local-default candidates (e.g. an Ollama endpoint
     on `http://localhost:11434/v1` with `qwen2.5:7b`) are slightly
     less dangerous but still a stealth-dependency; an
     `examples/standalone-config.example.yaml` fragment in a later
     issue is the right home for them.
  2. _Locale-keyed prompts._ ADR is consistent with issue #3's
     locale-aware refusal patterns. A critic prompted in the user's
     language pays less risk of misreading colloquial or
     idiomatically-phrased content. The fallback-to-English keeps
     unknown locales functional. The English verdict-JSON
     requirement is a deliberate simplification: field names do not
     vary by locale, so the extractor stays language-agnostic.
  3. _Tolerant parsing._ Real-world LLMs frequently emit prose
     before or after the JSON (e.g. "Here is my verdict: {...}") or
     wrap it in a code fence. A strict `JSON.parse` on the whole
     content would classify these as `parse_failure` and the
     orchestrator would drop a perfectly usable verdict. Fence-first
     is the best-hit path (fences are unambiguous when present);
     brackets-second handles prose wrapping; direct parse last is
     the unwrapped happy path that comes at no extra cost.
- **Alternatives considered:**
  - _Ship a default cloud endpoint (e.g. Anthropic or OpenAI) to
    smooth first-run setup._ Rejected for silent billing reasons.
  - _Ship defaults for Ollama only, not cloud._ Considered; this
    sits in `examples/standalone-config.example.yaml` instead, so
    the default is visible as documentation rather than hard-coded.
  - _Single English-only prompt._ Rejected for consistency with
    ADR-0012's (_sic — ADR-0012 is this one; the reference intended
    is ADR-0006's noisy-OR localization stance and issue #3's
    locale detectors_) locale awareness and for the risk of
    misreading German idiom.
  - _Strict `JSON.parse` only._ Rejected: measurable rate of
    recoverable critic outputs would become spurious errors.
  - _A structured-outputs API (OpenAI's JSON mode or Anthropic's
    tool-use)._ Rejected for v0.1: couples the critic to a specific
    provider's feature. Tolerant parsing lets the critic run
    against any OpenAI-compatible endpoint, including Ollama.
- **Related:** issue #4. Post-MVP candidates: a
  structured-outputs-aware config flag that activates provider-native
  JSON mode when available (keeps tolerant parsing as fallback); a
  configurable prompt-template override for users who want custom
  critic behaviour.

## ADR-0013: Adequacy checks are skipped for streaming responses in v0.1

- **Date:** 2026-04-20
- **Status:** accepted
- **Decision:** When the client requests a streaming completion
  (`stream: true`), the pipeline forwards the response unchanged to
  the client, skips the orchestrator entirely, and records the skip
  with `{ kind: 'skipped', reason: 'streaming' }`. The
  `X-Turbocharger-Decision: skipped` header is set; no other
  transparency layer runs.
- **Rationale:** Streaming responses are `ReadableStream`s that must
  reach the client before the assistant's content is assembled end
  to end. Running the orchestrator against them requires either (a)
  buffering the entire stream before forwarding — which breaks the
  streaming contract and is guarded by the existing
  `test/proxy.test.ts` streaming assertion; (b) duplicating the
  stream with `.tee()` so one half streams to the client and the
  other accumulates for the orchestrator — which means the decision
  is only available _after_ the stream has finished, long past the
  HTTP headers, requiring trailers (poorly supported across clients)
  or body-level SSE events (which contradicts the "no body
  modification" posture we chose for v0.1, ADR-0007's in-stream
  layer is Issue #9's territory); or (c) a stream-accumulator that
  inspects a prefix and decides synchronously — which would need a
  different, partial-response critic that we have not designed.
  Option (a) is incompatible with the existing streaming contract;
  (b) and (c) are each worth their own design round. Skipping for
  v0.1 is honest: we surface the skip in headers and logs so
  monitoring can track how often it happens, which gives us data for
  a post-MVP design decision on streaming critics.
- **Alternatives considered:**
  - _Buffer the stream, run the critic, then forward._ Rejected:
    breaks the streaming contract that issue #2 explicitly tested
    and that users with latency-sensitive UIs depend on.
  - _Tee the stream, decide after stream end, emit HTTP trailers._
    Rejected for v0.1: trailer support in clients (`curl` without
    `--raw`, browsers, many SDKs) is inconsistent. A decision
    delivered via trailer is, for most consumers, no decision at
    all.
  - _Tee the stream, append a terminal SSE event with the
    decision._ Rejected for v0.1: modifies the response body, which
    this issue's design explicitly avoids (pipeline is pass-through
    for bytes; transparency is via headers and logs only). Can be
    revisited in Issue #9 alongside the banner/card modes, which do
    modify the body by design.
  - _Prefix-inspection critic that decides on the first N tokens._
    Rejected: the adequacy heuristics (refusal, truncation,
    repetition) reason about the whole response. A prefix critic
    would be a different, more speculative detector that we have
    not calibrated.
- **Related:** issue #5 pipeline implementation; future post-MVP
  work on streaming adequacy checks would revisit this ADR.

## ADR-0014: Orchestrator is a pure function, not an object

- **Date:** 2026-04-20
- **Status:** accepted
- **Decision:** `runOrchestrator(input, config): Promise<Decision>`
  is a pure function. Configuration is passed per call rather than
  captured in a constructor. No internal state is held between
  calls.
- **Rationale:** In v0.1 the orchestrator is genuinely stateless:
  every invocation runs the hard-signal detectors, aggregates via
  noisy-OR, and optionally invokes a caller-supplied LLM-critic.
  None of that benefits from being a method on an object with
  shared state. A pure function is simpler to test (no setup /
  teardown), easier to reason about (the config is visible at every
  call site), and trivially composable with the pipeline (which is
  also a function). Should a future iteration accumulate state
  across calls — a per-session cost counter, a decision-history
  cache, a calibration-tracking layer — an `Orchestrator` class
  wrapping this function is straightforward to build later. The
  reverse (pulling state out of a class into separate function
  arguments after it has already been used) is disproportionately
  harder.
- **Alternatives considered:**
  - _`new Orchestrator(config).evaluate(input)`._ Rejected: the
    kept-config ergonomic win is small when the caller is a single
    pipeline that already holds the config anyway.
  - _Closure-based factory: `createOrchestrator(config) =>
(input) => Decision`._ Rejected: hides the config dependency
    from stack traces and test-setup, for the same closure-bound
    ergonomic as the class form with none of the class's
    discoverability.
  - _Pass config as a top-level module export, set once at boot._
    Rejected strongly: makes tests non-hermetic, couples unrelated
    orchestrator invocations.
- **Related:** issue #5 implementation; future post-MVP state work
  (cost accounting, calibration) can wrap this function without
  changing its public surface.

## ADR-0015: The pipeline is a separate module, not a proxy feature

- **Date:** 2026-04-20
- **Status:** accepted
- **Decision:** The code that runs the orchestrator against proxy
  responses lives in `src/pipeline.ts`, a new top-level module.
  `src/proxy.ts` remains responsible only for HTTP forwarding and
  does not import the orchestrator or any critic. `src/server.ts`
  composes the two: when an `orchestratorConfig` is supplied via
  `AppDeps`, the request flows through `runPipeline`; otherwise
  through `forwardChatCompletion` directly.
- **Rationale:** The proxy's job is narrow and testable —
  RFC-compliant forwarding, header hygiene, streaming passthrough.
  Folding the adequacy check into the same file would force
  `proxy.ts` to know about Signals, LlmVerdicts, noisy-OR, grey
  bands, and X-Turbocharger headers. That is four layers of
  concerns entangled in one file, and it makes proxy-level changes
  (e.g. a different fetch implementation, an HTTP/2 upgrade) risky
  because they would also touch critic code. Keeping the two
  responsibilities separate costs one extra file and one import in
  `server.ts`; it wins an explicit seam that can be tested, mocked,
  and replaced independently. The pipeline module is also where
  the issue #6 escalation machinery will plug in: after the
  decision is made, it will optionally trigger a ladder/max
  re-query before returning to the client. Having that all live
  alongside the forwarding logic would continue entangling the
  proxy.
- **Alternatives considered:**
  - _Add a critic hook to `forwardChatCompletion`._ Rejected: see
    above.
  - _Put the pipeline inline in `server.ts`._ Rejected: the server
    already does HTTP routing, logging, and startup; adding the
    orchestrator composition to it would make the file a
    multi-concern hub.
  - _Expose a class-based middleware_ (e.g. Hono middleware
    function) _instead of a standalone module._ Considered; deferred
    until Issue #6 (escalation) is done, because the middleware's
    shape depends on how escalation changes the response flow.
    When we know the final shape, we can convert the module to a
    middleware if that simplification pays for itself.
- **Related:** issue #5 pipeline module; issue #6 escalation will
  extend `runPipeline` to act on `escalate` decisions.

## ADR-0016: Ladder is a flat list of model IDs against a single downstream

- **Date:** 2026-04-21
- **Status:** accepted
- **Decision:** For issue #6 (`escalation:ladder`), the ladder is a
  flat, ordered list of model IDs. Every rung is sent to the single
  configured downstream `ProxyTarget`; per-rung `baseUrl` and
  `apiKey` are deliberately out of scope for v0.1.
- **Rationale:** The brief (§3 "Downstream targets") describes the
  typical deployment as the sidecar sitting in front of _one_ route
  — a local Ollama, a hosted aggregator (OpenRouter, ClawRouter,
  iblai-router, openmark-router), or a single provider endpoint.
  Aggregators already expose many providers behind one base URL
  using model-id prefixes like `anthropic/claude-sonnet-4-6` or
  `openai/gpt-4o`, which the ladder naturally names. Making the
  ladder a flat string list keeps the config shape trivial
  (`ladder: [a, b, c]`), avoids a discriminated-union schema that
  would only pay off for the minority of users who want to route
  different rungs to different providers, and leaves a clean
  upgrade path for a future multi-downstream variant.
- **Alternatives considered:**
  - _Per-rung `{model, baseUrl, apiKey}` objects._ Rejected for
    v0.1: doubles the config schema surface, requires multi-provider
    credential management, and the aggregators already cover the
    intended deployments. Can be added later as a discriminated
    union entry (string | object) without breaking existing
    flat-list configs.
  - _Hybrid (string or object per rung)._ Rejected for v0.1: all the
    complexity of the per-rung variant, no simplification over the
    flat list. If we ever add per-rung overrides, we revisit this
    ADR and decide whether the hybrid or a separate
    `perRungOverrides` map is the cleaner shape.
- **Related:** issue #6. Post-MVP candidate: a per-rung override
  feature if and when real deployments ask for it. Issue #12
  (per-request header overrides) covers the orthogonal "force a
  specific model for this call" case.

## ADR-0017: The discarded original response is not surfaced to the client

- **Date:** 2026-04-21
- **Status:** accepted
- **Decision:** When the pipeline escalates, the original response
  bodies from rungs below the final one are not retained and not
  surfaced to the client in any form — not in headers, not in the
  response body, not as an additional field. Only the final
  attempted response's body reaches the client. Headers record the
  escalation path (which rungs were tried) and the stopping reason,
  but not the discarded content.
- **Rationale:** The escalation exists because the original answer
  was judged inadequate. Passing it through alongside the final
  answer forces the client to re-implement adequacy judgement just
  to decide which version to show, which defeats the point of the
  critic pipeline. The transparency layer (issues #9 and #10) is
  the correct place to surface escalation metadata in the body —
  the banner (#9) names the escalation as a short line, and the
  card (#10) can include a structured record of the path. Keeping
  those concerns separated keeps issue #6 focused on the re-query
  mechanics. The brief's §6 "no weak answer forwarded to stronger
  model" directive is honoured at a different layer (we do not
  prime the stronger model with the weaker model's output), but the
  same spirit — not letting the weak answer continue to influence
  the interaction — also argues for not putting it in front of the
  client.
- **Alternatives considered:**
  - _Include the original response(s) as `X-Turbocharger-Original-*`
    headers._ Rejected: header size limits make this fragile for
    anything but trivial responses, and most log aggregators will
    redact or truncate non-standard header payloads.
  - _Append the originals as extra JSON fields alongside
    `choices`._ Rejected for v0.1: modifies the response body,
    which the issue #5 pipeline established as off-limits outside
    the explicit transparency modes of issues #9/#10.
  - _Expose the originals via a separate API endpoint (`GET
/v1/traces/{id}`)._ Rejected for v0.1: would require request-id
    generation and an audit-log backing store. Tracked in the
    post-MVP backlog; see ADR-0007 on the audit-log tier.
- **Related:** issue #6 (this ADR); issues #9 and #10 for the body-
  level transparency surfaces where the discarded content may
  resurface by design.

## ADR-0018: Default max escalation depth is 2

- **Date:** 2026-04-21
- **Status:** accepted
- **Decision:** The recommended default for `EscalationConfig.maxDepth`
  is 2: the pipeline performs at most two re-queries after the
  initial attempt, so the client sees an answer from at most the
  third ladder step. `maxDepth: 0` disables escalation entirely
  (decisions are still reported but no re-query runs); `maxDepth: 1`
  allows one escalation. The type surface does not embed this
  default — callers must supply the value explicitly — but the
  brief (§5 "Max escalation depth: configurable, default 2") and
  examples use 2.
- **Rationale:** Two escalations covers the realistic useful range:
  the weakest → mid model upgrade fixes most refusal and truncation
  cases; the mid → strong upgrade catches genuinely hard prompts
  that the mid model also fails. A third or fourth upgrade rarely
  changes the outcome — if even the strong model cannot answer, the
  bottleneck is usually the prompt (unanswerable, malformed,
  out-of-policy) rather than the model. Capping at 2 bounds
  worst-case latency and cost: the client-facing latency is at most
  three downstream round-trips plus two critic passes, and the cost
  budget is the sum of three completions plus two critic calls —
  enough to reason about in a headroom calculation, unlike a
  depth-5 or unlimited variant.
- **Alternatives considered:**
  - _Default = ladder length (walk the whole ladder until pass or
    exhaustion)._ Rejected: the upper bound on worst-case cost
    becomes the ladder length, which in the brief's example is 4.
    Users who configure longer ladders for exploratory reasons
    would pay for that exploration on every escalation.
  - _Default 1 (one escalation only, then stop)._ Rejected:
    insufficient for the realistic mid → strong-upgrade case.
    Users would hit the depth ceiling on exactly the prompts they
    care most about.
  - _Default unbounded, cap via USD budget only._ Rejected:
    coupling escalation depth to cost accounting makes each
    re-query's decision path harder to reason about. A depth cap
    is orthogonal to a cost cap; having both is fine, having one
    replace the other is not.
- **Related:** issue #6 (this ADR); issue #11 will introduce the
  Zod schema that materializes the default in the validated config
  loader.

## ADR-0019: Max-mode requires an explicit maxModel, and respects maxDepth

- **Date:** 2026-04-21
- **Status:** accepted
- **Decision:** When `EscalationConfig.mode === 'max'`, the pipeline
  resolves the target model exclusively from `config.maxModel`. If
  `maxModel` is unset or an empty string, the pipeline records
  `stoppedReason: 'max_model_not_set'` and performs no re-query. Max-
  mode also respects `maxDepth`: `maxDepth === 0` disables escalation
  for any mode, keeping the "kill switch" semantics uniform between
  ladder and max.
- **Rationale:** The point of max-mode is "skip straight to the
  configured best model when the first attempt is inadequate". If the
  best model is not configured, the correct response is to surface
  the configuration gap, not to invent a fallback. A hidden fallback
  (e.g. "use the top of `ladder` when `maxModel` is unset") would
  degrade a configuration error into silently different behaviour:
  users would see max-mode responses that look like ladder responses,
  with no clear signal that they had forgotten to set `maxModel`.
  Propagating `max_model_not_set` through the trace makes the
  configuration mistake loud and auditable. The `maxDepth` decision
  is pragmatic consistency: a single mental model ("maxDepth gates
  all escalation, regardless of mode") is easier to reason about at
  the config level than "maxDepth means N for ladder but always 1
  for max", and max-mode users who want the single-jump behaviour
  can leave `maxDepth` at its default (2) or set it to 1 — the extra
  budget for max-mode is unused and harmless, since max performs
  exactly one jump by construction.
- **Alternatives considered:**
  - _Fall back to the top of `ladder` when `maxModel` is unset._
    Rejected: hides a configuration error by producing ladder-like
    output in a max-mode deployment. Users would not realize the
    config is wrong until someone audited the actual flow.
  - _Make max-mode ignore `maxDepth` and always jump once._ Rejected:
    breaks the "maxDepth is the uniform kill switch" guarantee that
    makes it easy to disable all escalation for debugging or
    rollback scenarios. The minor inconvenience of a user setting
    `maxDepth: 1` for a strict single-jump max is worth the
    conceptual consistency.
  - _Fall back to some well-known provider default (e.g. "gpt-4")._
    Rejected: any baked-in default is a business-relationship
    assumption we should not make on behalf of the user.
- **Related:** issue #7; ADR-0016 (ladder and max both address a
  single downstream); ADR-0018 (maxDepth default is 2, which
  continues to be the recommended default for max-mode too despite
  max using at most one of those two available slots).

## ADR-0020: Chorus dispatch is an OpenAI-compatible stub with hard-fail semantics

- **Date:** 2026-04-22
- **Status:** accepted
- **Decision:** When `EscalationConfig.mode === 'chorus'`, the
  pipeline performs exactly one HTTP POST to
  `config.chorusEndpoint` with the client's original
  chat/completions request body and the client's forwarded headers
  (hop-by-hop stripped per RFC 7230), plus per-request context
  headers under the `X-Turbocharger-*` namespace (decision reason,
  aggregate score, ladder contents, etc). The endpoint is expected
  to be OpenAI-compatible — that is, it accepts a standard chat-
  completions request and returns a standard chat-completions
  response. The dispatch is hard-fail: if the endpoint is unset,
  unreachable, times out, or responds with a non-2xx status, the
  pipeline surfaces a specific `stoppedReason`
  (`chorus_endpoint_not_set`, `chorus_unreachable`,
  `chorus_timeout`, `chorus_non_ok_status`) and returns the
  original inadequate downstream response to the client. The
  default timeout is 90 seconds (`DEFAULT_CHORUS_TIMEOUT_MS`),
  overridable via `chorusTimeoutMs`. Chorus respects `maxDepth`:
  `maxDepth === 0` disables it like any other mode.
- **Rationale:** The chorus strategy is the multi-model consensus
  strategy envisioned in the project brief, but the full
  implementation (parallel dispatch, adequacy synthesis, minority
  reports) is deliberately scoped to a separate project
  (`openclaw-chorus`) rather than built into this sidecar. Issue #8
  reserves the integration point without building the logic behind
  it. The OpenAI-compatible protocol is the obvious choice: it
  means a chorus server can be implemented as any OpenAI-
  compatible HTTP service and swapped in without requiring a
  non-standard request shape. Context via `X-Turbocharger-*`
  headers lets the chorus server optionally make use of the
  escalation reason and configured ladder without the client
  having to pass them explicitly, while keeping the request body
  a plain chat-completions payload. The hard-fail policy is a
  deliberate deviation from the brief (§5, which suggested
  "graceful fallback to max"): falling back silently would hide
  configuration errors and make it hard to distinguish "chorus
  was the strategy" from "chorus failed and max ran instead" in
  the trace. Users who want a fallback can compose it at the
  config layer (e.g. by retrying a failed chorus request with a
  different mode) once the Zod-validated config loader arrives
  in issue #11. The 90-second default reflects the realistic
  runtime of chorus endpoints: parallel calls to ~3-5 models plus
  a synthesis step routinely exceeds 45 seconds on sizeable
  contexts, and a default that forces users to override on every
  real deployment would be unhelpful. 90 seconds is generous
  enough to let typical chorus implementations finish under
  realistic conditions, while still bounding the worst case.
- **Alternatives considered:**
  - _Non-OpenAI-compatible dedicated chorus API._ Rejected:
    locks the chorus server design into this project's
    assumptions and forecloses reusing existing OpenAI-compatible
    infrastructure.
  - _Graceful fallback to max-mode on chorus failure._ Rejected
    in favor of hard-fail because fallback hides configuration
    errors and makes the trace misleading. Users who want
    fallback can layer it on top via config composition, and the
    decision is reversible: adding fallback later as an opt-in
    flag is trivial, whereas removing silent fallback would be
    a breaking change.
  - _Baked-in default chorus endpoint (e.g. a hosted service)._
    Rejected: assumes a business relationship we shouldn't make
    on behalf of users.
  - _Lower default timeout (30s or 60s)._ Rejected because
    realistic chorus runtimes regularly exceed 60s under normal
    conditions. A too-aggressive default would surface as
    `chorus_timeout` errors for the common case, forcing every
    deployment to override the default — which defeats the
    purpose of a default.
- **Related:** issue #8; ADR-0016 (escalation modes share the
  downstream ProxyTarget — but chorus explicitly does not, since
  it addresses a distinct endpoint); ADR-0019 (max-mode semantics
  — same hard-fail pattern for `max_model_not_set`); brief §5
  (original "graceful fallback" wording, revised here).

## ADR-0021: Chorus is an AnswerMode, not an escalation strategy

- **Date:** 2026-04-22
- **Status:** accepted, supersedes part of ADR-0020
- **Decision:** Chorus is re-classified from an escalation mode
  (Issue #8, alongside ladder and max) to a parallel
  {@link AnswerMode} that dispatches the client's request directly
  to a configured chorus endpoint, bypassing the orchestrator and
  the escalation loop entirely. `EscalationMode` shrinks to
  `'ladder' | 'max'`; a new `AnswerMode = 'single' | 'chorus'` is
  introduced at the pipeline's top level. Chorus configuration
  (`endpoint`, `timeoutMs`) moves from `EscalationConfig` to a new
  `ChorusConfig` wired independently on `AppDeps`. The hard-fail
  policy from ADR-0020 is retained: a missing, unreachable,
  timing-out, or error-responding chorus endpoint surfaces a
  specific outcome rather than falling back to any other strategy.
  The orchestrator does not run on chorus responses because chorus
  itself is a meta-adequacy mechanism.
- **Rationale:** Under ADR-0020 the pipeline ran the orchestrator
  on the downstream response first, and only reached chorus when
  the orchestrator decided `escalate`. That framing implied chorus
  was a reactive fallback for adequacy failures — the user asked
  a question, a cheap model refused, so the sidecar tried chorus
  as the "strong" recovery option. But chorus's value proposition
  is different: multi-model consensus with bias transparency and
  minority reports. Users select chorus for a specific query
  because they want that kind of answer, not because their cheap
  model failed. Routing chorus through the escalation path had
  three concrete problems. First, the banner text for chorus in
  Issue #9's original scope would read "Escalated to chorus.
  Reason: refusal pattern detected." — misleading, because the
  chorus dispatch wasn't triggered by a refusal, it was the user's
  chosen paradigm. Second, the orchestrator-then-chorus sequence
  meant every chorus request incurred a downstream model call it
  didn't need, wasting cost and latency. Third, re-running the
  adequacy critic on a chorus response doesn't make sense: chorus
  is supposed to surface minority reports and bias signals
  explicitly, and a refusal-pattern detector downstream of that
  would flag exactly the kind of "this is a hard question and
  here's what different models said" output that chorus is
  designed to produce. Separating `AnswerMode` from escalation
  resolves all three issues: chorus users pay for one chorus call
  and nothing more, the banner text can be honest about why
  chorus was chosen (user selection, not adequacy failure), and
  the orchestrator stays out of chorus's way.
- **Alternatives considered:**
  - _Keep chorus in escalation, neutralize the banner text._
    Considered and rejected: the banner could be softened, but the
    cost-per-chorus-call issue and the orchestrator-over-chorus-
    response issue remained. Neutralising the language would be
    cosmetic and would leave the architectural mismatch in place.
  - _Chorus as a third answer mode on top of single (escalation
    still runs)._ Considered: make chorus mode run the
    orchestrator on the chorus response and escalate further if
    the chorus answer is flagged. Rejected: chorus already
    performs the multi-model consensus; escalating from a chorus
    answer to another model would either contradict the chorus
    synthesis or produce an answer that's strictly less
    informative. Also, the chorus server is expected to handle
    its own failure modes; the sidecar's role is to call it and
    forward the result.
  - _Hybrid: chorus as both a fallback (current) and a direct
    mode (new)._ Considered: support both paths so existing users
    aren't broken. Rejected: the current state is not in a
    released version (the project has no v0.1.0 yet), so there
    are no existing users to preserve. Two paths for chorus would
    double the test surface and the mental model for no real
    benefit.
- **Mechanical scope of the refactor:**
  - EscalationMode: remove 'chorus'.
  - EscalationConfig: remove chorusEndpoint and chorusTimeoutMs.
  - EscalationTrace.stoppedReason: remove the four chorus\_\*
    values.
  - New types: AnswerMode, ChorusConfig, ChorusTrace.
  - src/escalation/chorus.ts moves to src/chorus/dispatch.ts (new
    module root, since chorus is no longer escalation); the
    dispatch function takes ChorusConfig instead of
    EscalationConfig.
  - src/pipeline.ts: runPipeline takes a PipelineInput bag with
    an answerMode field and dispatches to runSinglePipeline or
    runChorusPipeline. The chorus-inside-while-loop branch is
    gone.
  - src/server.ts: AppDeps gains chorusConfig and
    defaultAnswerMode. DecisionLogEntry gains chorus_outcome and
    chorus_detail.
  - Test migration: Issue #8's chorus describe block moves from
    test/pipeline-escalation.test.ts to a new
    test/pipeline-chorus.test.ts, rewritten around the AnswerMode
    paradigm.
- **Consequences for downstream issues:**
  - Issue #9 (transparency: banner) is simplified: the banner only
    applies to single-mode escalation (ladder/max). Chorus-mode
    transparency is explicitly out of scope for #9 and will live
    in a later issue if it's needed at all.
  - Issue #11 (config:schema with Zod) will need to validate the
    new ChorusConfig type independently of EscalationConfig.
  - Issue #12 (per-request header override) gains
    X-Turbocharger-Answer-Mode as a first-class header alongside
    the existing X-Turbocharger-Mode idea.
- **Related:** ADR-0020 (retained for the hard-fail policy on
  chorus dispatch errors); ADR-0016 (escalation strategies share a
  downstream — chorus is not bound by that because it's no longer
  an escalation strategy); Issue #8 (where chorus was originally
  scaffolded).

## ADR-0022: Transparency banner is opt-in, body-mutating, locale-aware

- **Date:** 2026-04-23
- **Status:** accepted, implements brief §7
- **Decision:** The transparency layer (Issue #9) ships with one
  active mode — `banner` — and one default — `silent`. The default
  is silent: a sidecar started without an explicit
  `transparencyConfig` will not modify any response body, even when
  escalation happens. Operators who want end users to see a banner
  must opt in by setting `transparencyConfig: { mode: 'banner' }`
  on AppDeps. When opted in, every escalation/skipped-with-reason
  decision in single-mode requests produces a single-line banner
  prepended to the assistant content with the marker
  `[turbocharger]` and a blank line separator. Banners are
  locale-aware (English default, German for `de*` locales) and
  deliberately vague in tone ("looked incomplete", not "was
  wrong"). Pass decisions never produce a banner. Chorus-mode
  responses are out of scope and never touched.
- **Rationale:** Three decisions are bundled into one ADR because
  they share the same underlying principle: the transparency layer
  trades response-body invasiveness for end-user visibility, and
  every aspect of that trade-off needs to default to caution.
  - _Silent default._ The brief §7 says "banner-as-default" for
    the user-facing vision, but that's the default a deployment
    should _aim for_, not the default a constructor should pick
    for a misconfigured deployment. A sidecar starting without
    explicit config landing on a Hono app and silently mutating
    every response with `[turbocharger]` text would surprise
    operators in ways the project's "no silent fallbacks" stance
    does not allow. Silent-as-technical-default lets the brief's
    user-facing default live in `examples/standalone-config.example.yaml`
    and the README, where operators see and accept it
    consciously, rather than as a hidden constructor behaviour.
    Because of this asymmetry between technical default and
    recommended default, the README, CONFIGURATION.md, and the
    JSDoc on `TransparencyConfig` all explicitly tell operators
    they MUST set `mode: 'banner'` to surface escalation events
    — silent is "do nothing visible", not "the recommended
    user experience".
  - _Body-mutating, not header-only._ Headers (`x-turbocharger-*`)
    already exist for the same information and have done since
    Issue #5. The brief's transparency goal is end-user-visible
    output, not API metadata, and end users do not see HTTP
    headers — they see assistant message content. Banner injection
    therefore mutates `choices[0].message.content`. This is
    invasive but it is the only way to actually meet the brief's
    goal. The marker `[turbocharger]` plus blank-line separator
    keeps the injection unambiguously machine-strippable for
    clients that prefer the headers-only view.
  - _Tone is vague, not technical._ "The first answer looked
    incomplete" instead of "A refusal pattern was detected". The
    project's "do not overclaim" principle (brief §14, item 7)
    rules out language that asserts the original answer was
    objectively wrong; the adequacy critic detected a flag, not
    a proven inadequacy. Vague language also avoids leaking
    implementation details about specific signal categories,
    which is good for forward-compatibility (Issue #11+ may add,
    rename, or remove categories) and good for the user
    (knowing the category is rarely what they need; knowing
    "the system noticed something off and tried again" is).
  - _Locale-aware (en + de only)._ Two locales is enough for v0.1
    given the project's EU/DACH-friendly positioning. The
    BCP-47 prefix-match (`de-AT` → `de`) keeps the resolver
    simple. Other locales fall through to English. Issue #11's
    config schema can later allow operators to add their own
    locale tables without changing the banner module's API.
- **Alternatives considered:**
  - _Banner-as-default, opt-out via silent._ Considered: align
    technical default with the brief's user-facing recommendation.
    Rejected because the failure mode of "default mutates response
    bodies" is much worse than "default is silent": a
    misconfigured client could end up with `[turbocharger]`
    prefixes in stored conversation logs, and the operator might
    not notice for days. Silent-as-default fails closed.
  - _Header-only transparency, no body mutation._ Considered:
    keep transparency entirely in `x-turbocharger-*` headers,
    skip body mutation. Rejected because the brief's goal is
    end-user visibility, and end users do not read response
    headers. Header-only transparency would meet the API
    requirements but not the user-facing requirement.
  - _Per-decision verbosity (banner vs card vs silent toggleable
    per request)._ Considered: let clients pick the mode via
    `X-Turbocharger-Transparency` header. Rejected for v0.1: it
    conflates two issues. Issue #9 is about the banner; Issue
    #10 is about the card; Issue #12 is about per-request
    overrides. Bundling them all into one PR would make each
    harder to review.
  - _Render banner at the END of the content instead of the
    beginning._ Considered: less visually invasive when reading
    streaming output, more readable in chat UIs that auto-scroll
    to bottom. Rejected because (a) streaming is out of scope
    per ADR-0013 — this layer never sees streamed responses,
    (b) appending after content makes it easy for the user to
    miss the banner if the response is long, and (c) the
    pipeline already has the response body buffered, so prefix
    placement is not harder than suffix placement.
- **Mechanical scope of Issue #9:**
  - New `TransparencyConfig` type with single field `mode:
'banner' | 'silent'`. Issue #10 will add `'card'`.
  - `src/transparency/banner.ts` becomes a real module
    (replacing the Issue #1 stub) exporting `formatBanner`,
    `formatBannerPrefix`, and `resolveBannerLocale`.
  - `PipelineInput` gains optional `transparencyConfig`.
  - Pipeline calls `formatBannerPrefix` after the escalation
    loop, before constructing the final Response. Banner
    injection mutates a parsed copy of `currentBodyText` and
    re-stringifies it; if parsing fails or the body shape is
    unexpected, the original body is preserved (defensive
    fallback so a misconfiguration cannot corrupt responses).
  - `AppDeps` gains optional `transparencyConfig` which the
    server passes through to the pipeline.
  - `DecisionLogEntry` gains optional `transparency_mode` so
    log aggregators can correlate body-mutation behaviour
    without re-parsing response bodies.
  - Two test files: `test/banner.test.ts` (24 unit tests for
    `formatBanner` + `resolveBannerLocale`) and
    `test/pipeline-banner.test.ts` (6 integration tests
    covering banner-on-escalate, no-banner-on-pass,
    silent-mode, default-silent, not_attempted, and German
    locale).
- **Consequences for downstream issues:**
  - Issue #10 (transparency: card) extends `TransparencyConfig.mode`
    to a third literal `'card'` and adds card-rendering to the
    same injection path.
  - Issue #11 (config:schema) needs to validate
    `TransparencyConfig` and to expose `mode: 'banner'` as the
    _recommended_ default in `examples/standalone-config.example.yaml`.
  - Issue #12 (per-request header override) gains
    `X-Turbocharger-Transparency: banner|silent|card` as an
    optional override on top of the configured default.
  - The README's positioning section can now show concrete
    banner output as a screenshot or code block.
- **Related:** ADR-0007 (transparency-as-design-principle),
  ADR-0013 (no transparency for streaming responses),
  ADR-0021 (chorus-mode is out of transparency layer scope),
  brief §7 and §14.

## ADR-0023: Transparency card is structured Markdown, locale-aware labels, English values

- **Date:** 2026-04-28
- **Status:** accepted, implements brief §7
- **Decision:** Issue #10 adds a third transparency mode, `card`,
  alongside the existing `banner` and `silent`. The card surfaces
  the full decision context for a single-mode request: initial
  model, decision kind plus reason, signals with their
  confidences, the aggregate score, the optional LLM verdict,
  the escalation path, and the outcome. The format is a kompakte
  Markdown list under a distinct marker `[turbocharger card]`,
  followed by a `---` separator and the original assistant
  content. Structural labels (`Initial model:`, `Decision:`,
  ...) are localized for the same `en` and `de` locales the
  banner supports; values stay English (model IDs, signal
  categories, decision kinds) to match the `x-turbocharger-*`
  headers and the ADR vocabulary. The pass + depth=0 suppression
  rule from the banner applies unchanged: a successful first try
  produces no card. Cost-delta and time-delta are deliberately
  not part of the v0.1 card.
- **Rationale:** The banner conveys "something happened" in one
  sentence; the card answers "what exactly happened" in seven or
  eight lines. Operators choose between them based on how much
  decision context they want their end users to see, not on
  whether they want transparency at all (that's the
  silent-vs-not axis). Three reasoning steps lead to the
  specific shape:
  - *Why Markdown list and not table.* A Markdown table would
    render attractively in clients that parse Markdown, but the
    sidecar cannot assume the client does. A pipe-table in a
    plain-text view is unreadable. A list works in both.
  - *Why localize labels but not values.* The labels are user-
    facing prose that benefits from translation. The values are
    keys into a small known vocabulary that operators and
    monitoring tooling already work with in English (`refusal`,
    `hard_signals`, `pass`). Translating those would diverge the
    user-visible card from the headers and the structured log,
    which would be more confusing than helpful.
  - *Why no cost or time delta in v0.1.* Cost-delta requires
    per-model pricing data the sidecar does not currently have;
    fabricating one would be the kind of overclaim the project
    explicitly avoids. Time-delta is captured in the structured
    log already and adding it to the card would imply a
    precision the per-request measurement cannot deliver. Both
    are candidates for a later issue if real demand materializes.
- **Alternatives considered:**
  - *Markdown table.* Rejected per "Why Markdown list" above —
    plain-text-renderer hostility outweighs the visual
    compactness for clients that do parse Markdown.
  - *JSON-in-content surface.* Was the original direction in the
    `card.ts` stub from Issue #1. Rejected because the card's
    purpose is end-user readability; clients that want
    machine-readable decision data already have the
    `x-turbocharger-*` response headers.
  - *Shared `[turbocharger]` marker for both banner and card.*
    Rejected because clients that want to strip transparency
    annotations need to know whether they are looking at a
    one-line banner or a multi-line card. Distinct markers
    (`[turbocharger]` and `[turbocharger card]`) make that
    decision trivial.
  - *Localizing values too (e.g. `escalate (harte Signale)`).*
    Rejected for symmetry with the headers and to keep the
    grep-ability of the card consistent across locales.
  - *Showing the LLM verdict's free-form `reason` text.*
    Considered but rejected: it is the most variable field in
    the decision surface and including it would make the card
    unpredictable in length. The structured fields (`verdict`
    and `confidence`) are more useful at the card level; the
    free-form reason remains available in the structured log.
- **Mechanical scope:**
  - `TransparencyConfig.mode` is widened from `'banner' | 'silent'`
    to `'banner' | 'silent' | 'card'`.
  - New module `src/transparency/card.ts` exports `formatCard`,
    `formatCardPrefix`, `resolveCardLocale`, and `CardLocale`.
    Pure functions, no I/O. Mirrors the structure of `banner.ts`
    so future maintenance can rely on familiar shapes.
  - `runSinglePipeline` gets a second branch in the transparency
    injection block: when `transparencyConfig.mode === 'card'`,
    `formatCardPrefix` is called and the same
    `injectBannerIntoBody` helper (renamed in spirit to "inject
    string prefix into body" but kept under its original name
    to minimize the diff) prepends it to `choices[0].message.content`.
  - `DecisionLogEntry.transparency_mode` already widens
    automatically — its type is `TransparencyConfig['mode']`.
  - Two test files: `test/card.test.ts` (~30 unit tests covering
    locale resolution, all stoppedReasons, both decision kinds
    with and without LLM verdict, signal filtering, all skipped
    reasons including streaming-returns-null, both Detail-line
    behaviours, and `formatCardPrefix`) and
    `test/pipeline-card.test.ts` (6 integration tests covering
    card-on-escalate, no-card-on-pass, silent-mode, default-silent,
    not_attempted-with-no-Path-line, and the German locale).
- **Consequences for downstream issues:**
  - Issue #11 (config:schema) needs `'card'` as a third allowed
    value in the `TransparencyConfig.mode` enum and an example
    deployment showing card-style configuration.
  - Issue #12 (per-request header override) gains
    `X-Turbocharger-Transparency: card` as a valid value
    alongside `banner` and `silent`.
  - The README's transparency section already mentioned the card
    as upcoming; that mention can now point to a real card
    output example.
- **Related:** ADR-0007 (transparency-as-design-principle),
  ADR-0013 (no transparency for streaming responses),
  ADR-0021 (chorus-mode is out of transparency layer scope),
  ADR-0022 (transparency banner — the sibling decision this
  one mirrors structurally), brief §7.
