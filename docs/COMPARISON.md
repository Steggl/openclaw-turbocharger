# Comparison to related projects

This document positions `openclaw-turbocharger` against the OpenClaw
router ecosystem in early 2026. The intent is factual orientation,
not competitive marketing — the projects below are well-engineered
and solve different problems than this one. We complement them more
often than we replace them.

## Reactive vs predictive routing

The OpenClaw router space is dominated by **predictive** routers:
they look at a user query, score its complexity (keyword heuristics,
embeddings, benchmark results), and pick a model up front. The user
gets one answer from the model the router judged appropriate.

`openclaw-turbocharger` is **reactive**: it forwards the request to
the model the user (or an upstream router) chose, evaluates the
*response*, and only then decides whether a stronger model should be
tried. The two approaches answer different questions:

- _Predictive:_ "given this query, which model should run it?"
- _Reactive:_ "given this answer, did the model that ran it actually
  produce something usable?"

A predictive router can be wrong about a query's complexity and
nobody notices — the user receives the inadequate answer. A reactive
sidecar can mis-classify an adequate answer as inadequate and
trigger a needless escalation, costing time and money. Each failure
mode has a cost; the right tool depends on which cost matters more
in the deployment.

The two paradigms compose: a predictive router can be the
turbocharger's downstream target, and the turbocharger will react
to whatever model the router chose.

## Quick comparison

The columns below cover the differentiating axes for the OpenClaw
router space in early 2026. "Yes/No" judgements are based on each
project's published documentation; corrections welcome via PR.

| Project                          | Approach           | Multi-model consensus | EU-compatible | Crypto / wallet dependency | License |
| -------------------------------- | ------------------ | --------------------- | ------------- | -------------------------- | ------- |
| `openclaw-turbocharger`          | Reactive escalation + chorus answer mode | Yes (chorus mode) | Yes           | No                         | MIT     |
| ClawRouter (BlockRunAI)          | Predictive (cascade on roadmap) | No        | Limited       | Yes                        | MIT     |
| iblai-openclaw-router (ibl.ai)   | Predictive (14-dimension)       | No        | Yes           | No                         | MIT     |
| openmark-router (OpenMark AI)    | Predictive (benchmark-driven)   | No        | Yes           | No                         | MIT     |
| openrouter/auto                  | Predictive (proprietary)        | No        | Yes           | No                         | Closed  |

"EU-compatible" here means the project does not require integration
with crypto-payment flows or token-based payment rails that conflict
with MiCA, DSGVO, or typical enterprise procurement. This is a
deployment concern, not a code-quality judgement.

## Per-project notes

### ClawRouter (BlockRunAI)

The most-starred predictive router in the OpenClaw ecosystem. Its
public roadmap mentions cascade routing — "try cheap model first,
escalate on low quality" — as a planned feature. We're building
independently rather than waiting on or coordinating with that
roadmap, with three concrete differences:

- **Provider-agnostic.** ClawRouter is opinionated about its
  preferred providers. The turbocharger sits in front of any
  OpenAI-compatible endpoint, including ClawRouter itself.
- **No crypto payment dependency.** ClawRouter's billing model
  involves on-chain settlement. The turbocharger has no such
  requirement, which makes it deployable in EU enterprise contexts
  where on-chain payment flows are not acceptable.
- **Chorus answer mode.** Per ADR-0021 the turbocharger exposes
  multi-model consensus (chorus) as a parallel paradigm to single
  escalation. ClawRouter's roadmap does not.

### iblai-openclaw-router (ibl.ai)

A clean, zero-runtime-dependency 14-dimension predictive router.
Excellent for deployments that want a small, auditable router with
no external integrations. The turbocharger can run in front of or
behind it — as a downstream target if the router pre-selects, or
as a sidecar that reacts to whatever the router picked.

### openmark-router (OpenMark AI)

Benchmark-driven: routes based on each model's measured performance
on a curated test set. Strong fit when the benchmark methodology
matches the deployment's actual workload, less strong when the
workload diverges from the benchmark distribution. Complementary to
the turbocharger: openmark picks an adequate-looking model, the
turbocharger reacts if the actual response disagrees.

### openrouter/auto

OpenRouter's built-in auto model selector. Hosted, proprietary, and
the lowest-friction predictive router in the space. Not directly
comparable to a self-hosted sidecar like the turbocharger, but a
common downstream target — a turbocharger deployment can point at
`openrouter/auto` and let the routing happen there, while still
catching adequacy failures with the orchestrator on top.

## Inspirations and adjacent work

- **`karpathy/llm-council`** — the inspiration for the chorus
  paradigm. Not integrated with this project, but the conceptual
  ancestor of the chorus answer mode and the future
  `openclaw-chorus` project.
- **Council Mode (arXiv)** — academic validation of multi-model
  council architectures. Cited in the future `openclaw-chorus`
  project, not directly here.

## When to use what

Pick the tool whose failure mode matters less for your deployment:

- **Predictive router only** when query distribution is well-known
  ahead of time and the cost of one model running every query is
  acceptable (the predictor's job is just to pick the cheapest
  acceptable model).
- **Reactive sidecar (turbocharger, single mode)** when adequacy
  failures are a real cost — refusals, truncations, tool-call
  errors that a predictive router can't see because they only show
  up in the response.
- **Chorus mode (turbocharger or a chorus-capable backend)** when
  the question is contentious or important enough to deserve more
  than one model's view — bias transparency and minority reports
  are first-class outputs.
- **Predictive router + reactive sidecar** when the deployment can
  afford both: the predictive router minimises the common case,
  the sidecar catches the residual adequacy failures the
  predictor mis-classified.
