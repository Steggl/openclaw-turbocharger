# Architecture

System-level architecture of `openclaw-turbocharger` after the
ADR-0021 refactor (Issue #8 + AnswerMode separation).

## Request lifecycle

The sidecar is itself an OpenAI-compatible HTTP server. Clients —
OpenClaw, any other OpenAI-API-shaped client, or just `curl` —
point at `http://localhost:<port>/v1/chat/completions` as if it
were a model provider, and the sidecar handles routing, critic, and
optional escalation behind that interface.

```
                    Client (OpenClaw, curl, …)
                              │
                              ▼
    ┌──────────────────────────────────────────────────────────┐
    │ Hono server (src/server.ts)                              │
    │                                                          │
    │   defaultAnswerMode === 'chorus' ? ──→ chorus path       │
    │   else                          ──→ single path          │
    └─────────────────────┬────────────────────────────────────┘
                          │
                ┌─────────┴────────────┐
                │                      │
                ▼                      ▼
    ┌───────────────────────┐   ┌────────────────────────────┐
    │ Single path           │   │ Chorus path                │
    │ (src/pipeline.ts:     │   │ (src/pipeline.ts:          │
    │  runSinglePipeline)   │   │  runChorusPipeline)        │
    │                       │   │                            │
    │ 1. Forward via proxy  │   │ 1. Forward request body    │
    │ 2. Run orchestrator   │   │    + X-Turbocharger-*      │
    │ 3. If escalate:       │   │    headers to              │
    │    re-query next      │   │    ChorusConfig.endpoint   │
    │    ladder/max step    │   │ 2. Forward response        │
    │ 4. Loop until pass /  │   │    verbatim                │
    │    maxDepth /         │   │                            │
    │    ladder exhausted   │   │ Orchestrator does NOT run  │
    │ 5. Inject banner if   │   │ on chorus responses (ADR-  │
    │    transparencyConfig │   │ 0021): chorus is itself    │
    │ 6. Return             │   │ the meta-adequacy layer.   │
    └─────────┬─────────────┘   └────────────┬───────────────┘
              │                              │
              ▼                              ▼
    Configured downstream                  Chorus endpoint
    (Ollama, OpenAI, anthropic,            (openclaw-chorus or
     openrouter, ClawRouter, …)             any compatible service)
```

The two paths are deliberately separate. Single-mode requests pay
for an orchestrator evaluation on every response and may pay for
re-queries; chorus-mode requests pay for one chorus dispatch and
nothing else. They are different paradigms, not stages of the
same process. See ADR-0021 for the rationale.

## Module map

```
src/
├── server.ts          — HTTP entry. Hono app, AppDeps wiring,
│                        decision-log emission. Branches on
│                        defaultAnswerMode.
├── pipeline.ts        — runPipeline + runSinglePipeline + runChorusPipeline.
│                        Owns the escalation loop, chorus dispatch
│                        invocation, banner injection, and response
│                        annotation.
├── proxy.ts           — forwardChatCompletion. Header-strip,
│                        downstream call, body pass-through.
├── types.ts           — single source of truth for the type
│                        surface. AppConfig, AnswerMode,
│                        OrchestratorConfig, EscalationConfig,
│                        ChorusConfig, TransparencyConfig,
│                        OrchestratorDecision, EscalationTrace,
│                        ChorusTrace, etc.
├── critic/
│   ├── orchestrator.ts — runOrchestrator: combines hard-signals
│   │                     (noisy-OR) with the optional LLM-critic
│   │                     (grey-band invocation). Returns an
│   │                     OrchestratorDecision discriminated union.
│   ├── hard-signals.ts — six deterministic detectors, each
│   │                     emitting a continuous confidence in [0, 1].
│   ├── llm-critic.ts   — small-model adapter, OpenAI-compatible.
│   │                     Returns a discriminated LlmCriticResult.
│   └── index.ts        — barrel.
├── escalation/
│   ├── ladder.ts       — nextLadderStep, remainingLadderSteps.
│   │                     Pure helpers, no I/O.
│   ├── max.ts          — maxStep. Pure helper.
│   └── index.ts        — barrel. No longer exports chorus dispatch
│                          per ADR-0021.
├── chorus/
│   ├── dispatch.ts     — dispatchChorus. One HTTP call to a
│   │                     ChorusConfig.endpoint, classified errors,
│   │                     no silent fallback.
│   └── index.ts        — barrel.
├── transparency/
│   ├── banner.ts       — formatBanner, formatBannerPrefix,
│   │                     resolveBannerLocale. Pure functions, no I/O.
│   ├── card.ts         — placeholder for issue #10.
│   └── logger.ts       — placeholder for structured log helpers.
└── config/
    └── env.ts          — loadEnvConfig. Reads TURBOCHARGER_* env
                          vars into AppConfig. The full file-based
                          loader arrives with issue #11.
```

## Type surface

`src/types.ts` is the single shared type surface. Every module
imports its types from there; modules do not export types that
other modules consume directly. This keeps the dependency graph
flat — `critic/`, `escalation/`, `chorus/`, and `transparency/`
all depend on `types.ts` and never on each other for types.

The discriminated unions (`OrchestratorDecision`,
`LlmCriticResult`, `ChorusDispatchResult`) follow the project's
"no silent fallbacks" principle from the brief: failure modes are
always representable in the type, never converted into an
implicit success.

## Decisions

The numbered ADRs in [`DECISIONS.md`](./DECISIONS.md) record the
non-trivial architectural decisions and the alternatives that
were rejected. Particularly relevant for understanding the
current shape:

- **ADR-0006** — noisy-OR aggregation of hard signals.
- **ADR-0010 / ADR-0011** — grey-band invocation of the LLM-critic
  and the rule that LLM verdicts do not feed into the noisy-OR.
- **ADR-0013** — streaming responses skip the orchestrator
  entirely.
- **ADR-0016** — escalation strategies share the single configured
  downstream.
- **ADR-0018 / ADR-0019** — `maxDepth` semantics and the rule that
  max-mode without `maxModel` is a configuration error, not a
  silent fallback.
- **ADR-0020** — chorus dispatch is hard-fail.
- **ADR-0021** — chorus is an `AnswerMode`, not an escalation
  strategy. The most consequential refactor in the project so far.
- **ADR-0022** — transparency banner is opt-in, body-mutating, and
  locale-aware.

The full project-level brief lives in `PROJECT_BRIEF.md` at the
repository root and remains the design-intent reference.
