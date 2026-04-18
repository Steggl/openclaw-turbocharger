# openclaw-turbocharger — Project Brief

> **Purpose of this document:** Hand this brief to Claude Code (or Cursor) as the first input when opening an empty project folder. It contains everything needed to scaffold, build, and position the project correctly without requiring external context.

---

## 1. What we are building

`openclaw-turbocharger` is a standalone, provider-agnostic sidecar for OpenClaw (and any OpenAI-compatible client) that implements **reactive model escalation**.

**The core idea in one sentence:** Start with a cheap/default model, detect when its answer is inadequate, and escalate to a stronger model (or a multi-model chorus) without losing conversational context — while showing the user *what* was escalated and *why*.

**What it is not:**
- Not another predictive router (we do not guess complexity upfront).
- Not a replacement for existing OpenClaw routers (ClawRouter, iblai-router, openmark-router, openrouter/auto). We complement them.
- Not a benchmarking platform, not a payment gateway, not a memory layer.

**Positioning statement (for README and marketing):**
> openclaw-turbocharger fills the gap between "one cheap model for everything" and "one expensive model for everything." It runs whichever model you configured first, checks if the answer actually held up, and escalates only when signals say it didn't. You see the escalation when it happens and why.

---

## 2. Why this project exists (context for anyone reading)

The OpenClaw router ecosystem in early 2026 is dominated by **predictive** routers: they look at a user query, score its complexity with keyword heuristics or embeddings, and pick a model. Examples: ClawRouter (BlockRunAI, ~1.8k stars), iblai-openclaw-router, openmark-router, openrouter/auto.

The problem with predictive routing: if the router guesses wrong, the user gets a bad answer and no one notices.

ClawRouter's roadmap includes a planned "Cascade routing — try cheap model first, escalate on low quality" feature. We are building **independently and complementarily**:

- **Provider-agnostic:** Works in front of any router or direct provider. No vendor lock-in.
- **No crypto/wallet requirement:** Usable in EU, enterprise, and regulated contexts (MiCA, DSGVO) where crypto-based payment flows are not acceptable.
- **Escalation-to-Chorus:** Our roadmap bridges to `openclaw-chorus` (future separate project) for multi-model consensus with preserved minority reports — a fundamentally different target than single-model cascade.
- **Transparency-first:** Escalations are visible to the user by default.

**Tone toward the ClawRouter project:** Respectful. In the README's "Related work" section, we acknowledge ClawRouter, link to their roadmap, and explain our differentiation. We do not compete on cost optimization; we complement on transparency and reach.

---

## 3. Core architecture

```
         ┌─────────────────────────────────────────────────┐
         │   User request (from OpenClaw or any            │
         │   OpenAI-compatible client)                     │
         └────────────────────┬────────────────────────────┘
                              │
                              ▼
         ┌─────────────────────────────────────────────────┐
         │   Turbocharger Sidecar                          │
         │   (localhost, OpenAI-compatible server)         │
         │                                                  │
         │   1. Forward to configured default target       │
         │      (any router or direct provider)            │
         │   2. Capture response                            │
         │   3. Run Critic (hybrid cascade — see §4)       │
         │   4a. PASS → stream response to client          │
         │   4b. FAIL → escalate (see §5), re-run, stream  │
         │   5. Annotate response with transparency info   │
         │      (see §6)                                    │
         └────────────────────┬────────────────────────────┘
                              │
                              ▼
         Downstream targets (any combination):
           - ClawRouter (blockrun/auto)
           - iblai-router (iblai-router/auto)
           - openmark-router (openmark/auto)
           - openrouter/auto
           - Direct: anthropic/claude-*, openai/gpt-*, ollama/*, etc.
```

The sidecar is itself an OpenAI-compatible HTTP server. OpenClaw (or any client) points at `http://localhost:<port>/v1` as if it were a model provider. The sidecar handles the routing, critic, and escalation internally.

---

## 4. Design decision: Critic strategy

**Choice:** Hybrid cascade critic.

**Order of evaluation:**

1. **Hard-signal detector (deterministic, zero-cost)** runs first on every response:
   - Refusal patterns (`/I can(?:not|'t) help/i`, `/As an AI/i`, `/I'm unable to/i`, plus locale variants)
   - Tool-call errors surfaced by the provider
   - Syntax errors in code outputs (only if the request was code-related — detect via presence of code fences or code-specific keywords in the user message)
   - Context-limit truncations (finish_reason: "length" without the model producing a natural conclusion)
   - Repetition loops (same n-gram repeated > threshold)
   - Empty or suspiciously short outputs (< 20 chars for non-trivial queries)
2. **LLM-critic (small model, opt-in per request)** runs only when:
   - Hard-signal detector returns "no clear failure" **AND**
   - A confidence threshold says the answer is borderline **AND**
   - User's config allows LLM-critic (default: on, but with cost ceiling)
3. **Decision:** If either detector flags the response as inadequate → escalate. Otherwise → pass through.

**Critic model recommendation (configurable):**
- Local default: `ollama/qwen2.5:7b` (free, fast, runs on M4 unified memory)
- Cloud default: `anthropic/claude-haiku-*` or `openai/gpt-*-mini`

**Critic prompt (internal, not exposed to user):**
The critic receives the user's query and the model's response, and returns a JSON object `{ verdict: "pass" | "fail", reason: string, confidence: 0..1 }`. The critic is explicitly instructed **not to rewrite the answer** — only to judge adequacy.

**Cost safeguard:** Every request can optionally configure a `critic_budget_usd` ceiling. When exceeded, the critic falls back to hard-signal-only.

---

## 5. Design decision: Escalation target

**Choice:** User-configurable, three modes. Set globally, overridable per chat/context.

| Mode | Behavior | MVP status |
|------|----------|------------|
| `ladder` | Escalate one step up on a user-defined ladder, e.g. `haiku → sonnet → opus`. Can escalate multiple steps if repeated failure. | **MVP** |
| `max` | Jump directly to user-defined "max performance" model. No intermediate steps. | **MVP** |
| `chorus` | Dispatch to `openclaw-chorus` (separate future project) for multi-model consensus with minority-report synthesis. | **interface only in MVP**, implementation later |

**Configuration shape (illustrative YAML):**

```yaml
turbocharger:
  default_escalation: ladder      # ladder | max | chorus
  ladder:
    - ollama/qwen2.5:7b
    - anthropic/claude-haiku-4-5
    - anthropic/claude-sonnet-4-6
    - anthropic/claude-opus-4-7
  max_model: anthropic/claude-opus-4-7
  chorus_endpoint: null           # set when openclaw-chorus is available
  critic:
    strategy: hybrid              # hard_only | hybrid | llm_only
    llm_model: ollama/qwen2.5:7b
    critic_budget_usd: 0.01
  transparency:
    default: banner               # banner | silent | card
```

**Per-chat override:** The sidecar respects a special header `X-Turbocharger-Mode: chorus` (or similar) that clients can set per-request. OpenClaw agents can set this dynamically for specific chat contexts.

**Max escalation depth:** Configurable (default 2). Prevents runaway costs if critic keeps firing.

---

## 6. Design decision: Context handoff

**Choice:** User-query + adequacy hint, without the weak answer itself.

When escalating, the stronger model receives:
- The original user messages (unchanged)
- A system-level hint appended or prepended: `"A previous attempt to answer was flagged as inadequate (reason: <critic-reason>). Please answer fresh."`
- **Not the weak answer itself** — this avoids anchoring/priming the stronger model on the weaker model's framing.

**Backlog (not MVP):** Configurable hand-off strategies. When implemented, it will offer options like full-transcript forwarding, summarized handoff, or zero-context fresh start, adaptive based on escalation reason. Tracked as issue in the backlog.

---

## 7. Design decision: Transparency layer

**Choice:** Banner by default, full card available via flag/config.

**Banner (default):** A short line prepended or appended to the response, e.g.:

```
[turbocharger] Escalated haiku → sonnet. Reason: refusal pattern detected.
```

**Card mode (`transparency: card` or `--verbose`):** A structured block that shows:
- Initial model and its (discarded) response
- Critic verdict and confidence
- Final model
- Estimated cost delta vs. starting fresh with the final model
- Time delta

**Silent mode (`transparency: silent`):** No user-visible annotation. Still logged server-side for analytics.

**Rationale for banner-as-default:** Aligns with the "bias and mechanics visible" philosophy of the broader project family (including `openclaw-chorus`). Silent would contradict that stance. Card every time would overwhelm.

---

## 8. Tech stack and conventions

- **Language:** TypeScript, strict mode, Node.js ≥ 18
- **HTTP framework:** None heavy — raw `node:http` or a minimal router like `itty-router` / `hono`. Target: keep runtime dependencies under 5 packages.
- **Build:** `tsup` (fast, minimal config)
- **Tests:** `vitest` (fast, ESM-native, familiar API)
- **Lint/format:** `eslint` + `prettier` with a minimal shared config
- **License:** MIT
- **Node version pin:** `.nvmrc` with `20` (LTS)
- **Package manager:** `pnpm` preferred, `npm` acceptable fallback
- **Repo name:** `openclaw-turbocharger`
- **Organization:** Personal account initially. Plan to migrate to a dedicated org (e.g. `openclaw-addons/turbocharger`) once the project has traction (arbitrary signal: 100+ stars or 3+ outside contributors).
- **Distribution:**
  - npm package: `openclaw-turbocharger` (under personal scope initially, e.g. `@steggl/openclaw-turbocharger`)
  - ClawHub plugin: `openclaw.plugin.json` + `clawhub.json` manifests
  - Docker image: for non-Node deployments
- **Docs language:** English primary. German short-form summary in README for EU/DACH audience.

**Code style principles:**
- Minimal magic. Explicit configuration over convention where it affects behavior.
- Error messages include remediation hints, not just symptoms.
- No silent fallbacks that hide failures from the user (except where explicitly configured via `transparency: silent`).

---

## 9. Repository structure (target)

```
openclaw-turbocharger/
├── src/
│   ├── server.ts              # OpenAI-compatible HTTP server entry
│   ├── proxy.ts               # Forwarding to downstream target
│   ├── critic/
│   │   ├── index.ts           # Orchestrator: hybrid cascade
│   │   ├── hard-signals.ts    # Deterministic checks
│   │   └── llm-critic.ts      # Small-model critic
│   ├── escalation/
│   │   ├── index.ts           # Strategy dispatch
│   │   ├── ladder.ts
│   │   ├── max.ts
│   │   └── chorus.ts          # Interface stub in MVP
│   ├── transparency/
│   │   ├── banner.ts
│   │   ├── card.ts
│   │   └── logger.ts
│   ├── config/
│   │   ├── schema.ts          # Zod schema for config
│   │   └── load.ts
│   └── types.ts
├── test/
│   ├── hard-signals.test.ts
│   ├── llm-critic.test.ts
│   ├── escalation-ladder.test.ts
│   ├── proxy.test.ts
│   └── e2e/
│       └── ollama-local.test.ts
├── docs/
│   ├── DESIGN.md              # This document, trimmed
│   ├── ARCHITECTURE.md
│   ├── CONFIGURATION.md
│   └── COMPARISON.md          # Relation to ClawRouter, iblai, etc.
├── examples/
│   ├── openclaw-config.example.json
│   └── standalone-config.example.yaml
├── openclaw.plugin.json
├── clawhub.json
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── .nvmrc
├── README.md
├── LICENSE
├── CONTRIBUTING.md
└── .github/
    └── workflows/
        └── ci.yml             # lint + typecheck + test + build
```

---

## 10. First issues (for GitHub, after scaffold)

Tagged for clarity:

1. **`scaffold`** Initialize TypeScript project, tsup, vitest, eslint, prettier, CI workflow. Commit as v0.0.1.
2. **`core`** Implement OpenAI-compatible HTTP server skeleton with pass-through proxy to a configurable downstream. No critic yet.
3. **`critic:hard-signals`** Implement hard-signal detector with tests for each pattern type.
4. **`critic:llm`** Implement LLM-critic adapter (OpenAI-compatible, swappable model) with tests using mocked responses.
5. **`critic:orchestrator`** Implement hybrid cascade logic connecting hard-signals → LLM-critic → verdict.
6. **`escalation:ladder`** Implement ladder strategy with configurable chain.
7. **`escalation:max`** Implement max strategy.
8. **`escalation:chorus-stub`** Implement interface only — HTTP POST to configurable chorus endpoint, graceful fallback if endpoint unset.
9. **`transparency:banner`** Prepend banner to response when escalation happened.
10. **`transparency:card`** Full structured card as opt-in.
11. **`config:schema`** Zod schema for full config, validation on load.
12. **`config:per-request-override`** Support `X-Turbocharger-Mode` header.
13. **`docs:readme`** Write README with positioning, install, config, respectful ClawRouter section.
14. **`docs:comparison`** `docs/COMPARISON.md` with honest comparison to ClawRouter, iblai-router, openmark-router.
15. **`release:v0.1.0-alpha`** First published version.

Each issue should have acceptance criteria. Claude Code should ask before combining multiple issues into one commit.

---

## 11. Honest constraints and unknowns

- **"Adequacy" is not a solved problem.** Both the hard-signal detector and the LLM-critic are imperfect. The project's credibility depends on being upfront about false-positive and false-negative rates. A benchmark harness should be added early (post-MVP) to measure critic accuracy on a fixed dataset.
- **Escalation adds latency.** Each critic call and each re-run with a stronger model costs time. We need to measure and report this in the transparency layer.
- **Escalation adds cost.** While cheaper than "always use the strongest model," the naive case (critic fires often) can be *more* expensive than a direct call to the strongest model. Sensible defaults and clear cost-ceiling controls are essential.
- **Chorus integration is deliberately a stub in MVP.** Until `openclaw-chorus` is a real project, we only reserve the interface. Don't implement the chorus logic in this repo.

---

## 12. Related projects (for README's "Related work" section)

- **ClawRouter** (BlockRunAI) — the most-starred OpenClaw router. Cascade routing on their roadmap. We differ in: provider-agnostic design, no crypto/wallet dependency, EU-compatible, chorus bridge.
- **iblai-openclaw-router** (ibl.ai) — clean zero-dependency 14-dimension predictive router. We sit in front of or next to it.
- **openmark-router** (OpenMark AI) — benchmark-driven predictive router. Complementary: they pick the best model upfront using their benchmarks; we verify the answer after the fact.
- **openrouter/auto** — OpenRouter's built-in auto model selector. We can run in front of it.
- **karpathy/llm-council** — inspiration for the future `openclaw-chorus`. Not integrated in this project.
- **Council Mode (arXiv)** — academic validation of the chorus approach. Cite in `openclaw-chorus` README, not here.

---

## 13. Metadata and credits

- **Author:** Stefan Meggl
- **GitHub:** [Steggl](https://github.com/Steggl)
- **Email:** steggl@gmail.com
- **Copyright:** `Copyright (c) 2026 Stefan Meggl`
- **License file:** MIT, full text in `LICENSE`
- **Repository URL (once created):** `https://github.com/Steggl/openclaw-turbocharger`

---

## 14. Instructions for Claude Code / Cursor on first open

When this brief is the first input in an empty project folder:

1. **Do not start coding immediately.** First summarize back to the user what you understood (one paragraph), and confirm you have read sections 3–10 in detail.
2. **Author metadata is already set** in §13 (Stefan Meggl, GitHub `Steggl`, email `steggl@gmail.com`). Use these values consistently in `package.json`, `LICENSE`, and any generated URLs. Do not ask the user to re-confirm them unless you find a contradiction elsewhere.
3. **Start with issue #1 (scaffold) only.** Do not jump ahead to critic or escalation logic before the scaffold is verified.
4. **Commit after each issue.** Conventional Commits format. Example: `feat(critic): implement hard-signal detector`.
5. **Ask before adding any dependency beyond the stack defined in §8.**
6. **The tone of all written artifacts** (README, docs, commit messages, issue descriptions) should match the tone of this brief: honest, technical, slightly dry, respectful toward related projects, non-hype.
7. **Do not overclaim.** Statements like "eliminates bias," "always picks the best model," or "guaranteed savings" are forbidden. Use measured language: "reduces the chance of silent failures," "shows the user when escalation happened," "may reduce cost depending on workload."

---

*End of brief. Total length ~1,400 words. Designed to be ingested in a single Claude Code or Cursor context.*
