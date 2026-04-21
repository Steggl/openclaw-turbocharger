# openclaw-turbocharger

> Reactive model escalation sidecar for OpenClaw and any OpenAI-compatible client.

**Status:** in-progress implementation. 5 of 15 MVP issues merged. The proxy,
the adequacy detectors, the LLM-critic, the orchestrator, and the pipeline
are in place; escalation, transparency, config-schema, and release wiring are
still pending. No published release yet.

openclaw-turbocharger fills the gap between "one cheap model for everything" and
"one expensive model for everything." It runs whichever model you configured
first, checks if the answer actually held up, and escalates only when signals
say it didn't. You see the escalation when it happens and why.

It is **not** a predictive router and **not** a replacement for existing
OpenClaw routers (ClawRouter, iblai-openclaw-router, openmark-router,
openrouter/auto). It complements them.

## What has landed

The MVP is tracked as issues #2–#15 (see `PROJECT_BRIEF.md` §10). Merged so
far, in order:

1. **#2 `core`** — OpenAI-compatible HTTP server with pass-through proxy.
   Forwards `POST /v1/chat/completions` to a configured downstream target
   byte-for-byte, streams responses without buffering, preserves end-to-end
   headers per RFC 7230.
2. **#3 `critic:hard-signals`** — deterministic adequacy detectors for
   refusal, truncation, repetition, empty/short, tool-error, and JSON
   syntax. Each detector emits a continuous confidence in `[0, 1]` so the
   orchestrator can aggregate without losing weak-but-present evidence.
3. **#4 `critic:llm`** — small-model LLM critic adapter. OpenAI-compatible,
   locale-keyed prompts (EN + DE), opt-in per-request budget check,
   tolerant JSON extraction from the critic's response. Returns a
   discriminated result so failure modes are never silently converted
   into a pass.
4. **#5 `critic:orchestrator` + pipeline** — combines hard signals (noisy-OR
   aggregation with per-category weights) with the LLM-critic (invoked
   only when the aggregate lands in a configurable grey band) into a
   single decision. The pipeline wraps the proxy and surfaces the decision
   as `X-Turbocharger-*` response headers and structured log fields.

The full critic stack is now functional end-to-end — a request flows
through the proxy, gets evaluated by the orchestrator, and its decision
is visible to monitoring tools via response headers. What is still
missing for a usable v0.1 is the escalation step that acts on the
decision (re-querying with a stronger model) and the transparency layer
that surfaces the decision to end users in the response body.

## What lands next

1. **#6 `escalation:ladder`** — on `escalate` decisions, re-query with the
   next step on a configurable model ladder (e.g. haiku → sonnet → opus).
2. **#7 `escalation:max`** — alternative mode: single jump to a configured
   maximum-performance model instead of stepping up the ladder.
3. **#9 `transparency:banner`** — short user-visible banner prepended or
   appended to the response content when escalation happened.

After that: the chorus stub (#8), the card transparency mode (#10), the
Zod-validated config schema (#11), per-request header overrides (#12),
README and comparison document finalization (#13 + #14), and the first
published release (#15).

## Development

Requires Node ≥ 22 (pin: `.nvmrc`, see `docs/DECISIONS.md` ADR-0001).
pnpm preferred.

```bash
pnpm install
pnpm check
```

`pnpm check` runs the full local pipeline: format, lint, typecheck, test,
build (see `docs/DECISIONS.md` ADR-0009). CI on every pull request runs
each step separately for per-step failure reporting.

## Kurzfassung (DE)

`openclaw-turbocharger` ist ein provider-agnostischer Sidecar zwischen Client
und Modell-Provider. Er führt die konfigurierte Default-Anfrage aus, prüft die
Antwort anhand von Adäquanz-Signalen und eskaliert bei Bedarf auf ein stärkeres
Modell. Eskalationen werden dem Nutzer standardmäßig transparent gemacht.

Stand: laufende Implementierung, 5 von 15 MVP-Issues gemerged. Proxy,
Adäquanz-Detektoren, LLM-Kritiker, Orchestrator und Pipeline sind fertig;
Eskalation, Transparenz-Layer, Config-Schema und Release-Verdrahtung
stehen noch aus. Es gibt noch kein veröffentlichtes Release.

## License

MIT — see [LICENSE](./LICENSE). Copyright © 2026 Stefan Meggl.
