# openclaw-turbocharger

> A sidecar that decides between running one model carefully and asking
> several at once. For OpenClaw and any OpenAI-compatible client.

**Status:** in-progress implementation. 9 of 15 MVP issues merged. The
proxy, adequacy detectors, LLM-critic, orchestrator, pipeline, ladder
escalation, max escalation, chorus dispatch stub, and the transparency
banner are all in place. Card transparency, config schema, per-request
overrides, the doc finalization round, and the first published release
are still pending. No published release yet.

openclaw-turbocharger fills the gap between "one cheap model for everything"
and "one expensive model for everything." It runs whichever model you
configured first, checks if the answer actually held up, and escalates
only when signals say it didn't. When that's not the question — when you
want bias transparency and minority reports up front — it can also
dispatch directly to a chorus endpoint instead. You see what happened
when it happened.

It is **not** a predictive router and **not** a replacement for existing
OpenClaw routers (ClawRouter, iblai-openclaw-router, openmark-router,
openrouter/auto). It complements them. See
[`docs/COMPARISON.md`](./docs/COMPARISON.md) for the longer version.

## Two answer modes

Per [ADR-0021](./docs/DECISIONS.md), the sidecar exposes two top-level
paradigms for shaping a request:

- **`single`** (the default): forward to the configured downstream
  target, evaluate the response with the orchestrator, and — when an
  escalation strategy is configured — re-query with a stronger model
  until the answer passes or a stop condition is reached. This is the
  reactive-escalation core the project was originally about.
- **`chorus`** (opt-in): dispatch the request directly to a configured
  chorus endpoint that synthesises a multi-model consensus answer with
  bias transparency and minority reports. The orchestrator does not run
  in this mode — chorus is itself the meta-adequacy mechanism, not
  something that fires when adequacy fails.

Single-mode users get reactive escalation. Chorus-mode users get
deliberate consensus. They are orthogonal — not stages of the same
process.

## What has landed

The MVP is tracked as issues #2–#15 (see `PROJECT_BRIEF.md` §10). Merged
so far, in order:

1. **#2 `core`** — OpenAI-compatible HTTP server with pass-through
   proxy. Forwards `POST /v1/chat/completions` byte-for-byte, streams
   responses without buffering, preserves end-to-end headers per RFC 7230.
2. **#3 `critic:hard-signals`** — deterministic adequacy detectors for
   refusal, truncation, repetition, empty/short, tool-error, and JSON
   syntax. Each detector emits a continuous confidence in `[0, 1]` so
   the orchestrator can aggregate without losing weak-but-present
   evidence.
3. **#4 `critic:llm`** — small-model LLM critic adapter. OpenAI-compatible,
   locale-keyed prompts (EN + DE), opt-in per-request budget check,
   tolerant JSON extraction. Returns a discriminated result so failure
   modes are never silently converted into a pass.
4. **#5 `critic:orchestrator` + pipeline** — combines hard signals
   (noisy-OR aggregation with per-category weights) with the LLM-critic
   (invoked only in a configurable grey band) into a single decision.
   Surfaces it as `X-Turbocharger-*` response headers and structured
   log fields.
5. **#6 `escalation:ladder`** — on `escalate` decisions, re-queries with
   the next step on a configured model ladder until the answer passes,
   the ladder is exhausted, or `maxDepth` is reached.
6. **#7 `escalation:max`** — alternative single-jump strategy: on
   `escalate`, re-queries directly with a configured maxModel rather
   than walking up a ladder.
7. **#8 `escalation:chorus-stub`** (originally) — dispatch stub to an
   external chorus endpoint, with classified errors
   (`endpoint_not_set`, `unreachable`, `timeout`, `non_ok_status`) and
   no silent fallback to other strategies.
8. **ADR-0021** — refactor: chorus is re-classified from an escalation
   mode to a parallel `AnswerMode`. See the linked ADR for the
   rationale; the short version is that chorus is a user-selected
   paradigm for multi-model consensus, not a reactive fallback for
   adequacy failures.
9. **#9 `transparency:banner`** — single-line localized banner
   prepended to the assistant content when escalation/skipped-with-reason
   happened in single mode. Banner mode is opt-in; the technical
   default is silent. See [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md)
   and [ADR-0022](./docs/DECISIONS.md).

## Transparency

The transparency layer is opt-in. By default the sidecar reports
escalation decisions on response headers (`x-turbocharger-decision`,
`x-turbocharger-escalation-stopped`, `x-turbocharger-escalation-path`,
…) and as structured log fields, but does not modify the response
body. To make escalation events visible to end users, set
`transparencyConfig.mode` to `banner`. Once opted in, an
`[turbocharger]` annotation precedes the assistant content whenever
escalation or skipped-with-reason happened:

```
[turbocharger] A stronger model was used because the first answer
looked incomplete. The answer below is from the stronger model.

<original assistant content>
```

The banner is locale-aware: `en-*` (default) and `de-*`. Other
locales fall through to English. The phrasing is deliberately
vague — "looked incomplete" rather than "was wrong" — because the
adequacy critic flags signals, not proven inadequacy. See ADR-0022
for the full reasoning.

The card transparency mode (#10) will offer a more structured
multi-line view as a third option alongside `silent` and `banner`.

## What lands next

1. **#10 `transparency:card`** — opt-in structured card view as an
   alternative to the banner.
2. **#11 `config:schema`** — Zod-validated config file shape merging
   environment variables, file values, and defaults.
3. **#12 `config:per-request-override`** — header-based per-request
   overrides (`X-Turbocharger-Answer-Mode`, `X-Turbocharger-Transparency`,
   …).
4. **#13 / #14 `docs:readme` + `docs:comparison`** — final pass on the
   README and the comparison document.
5. **#15 `release:v0.1.0-alpha`** — first published version.

## Development

Requires Node ≥ 22 (pin: `.nvmrc`, see `docs/DECISIONS.md` ADR-0001).
pnpm preferred.

```bash
pnpm install
pnpm check
```

`pnpm check` runs the full local pipeline: format, lint, typecheck,
test, build (see `docs/DECISIONS.md` ADR-0009). CI on every pull
request runs each step separately for per-step failure reporting.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full contribution
workflow including ADR conventions, branch naming, and the local
verification expectations.

## Kurzfassung (DE)

`openclaw-turbocharger` ist ein provider-agnostischer Sidecar zwischen
Client und Modell-Provider, der zwei Antwort-Paradigmen unterstützt:

- **`single`** (Standard): die konfigurierte Default-Anfrage ausführen,
  die Antwort anhand von Adäquanz-Signalen prüfen und bei Bedarf auf
  ein stärkeres Modell eskalieren (Ladder oder Max).
- **`chorus`** (opt-in): die Anfrage direkt an einen Chorus-Endpoint
  weiterleiten, der eine konsens-orientierte Multi-Modell-Antwort mit
  Bias-Transparenz erzeugt. Der Orchestrator läuft in diesem Modus
  nicht — Chorus ist selbst die Meta-Adäquanz-Logik.

Eskalations-Ereignisse können über einen lokalisierten Banner
(`mode: 'banner'`) im Antwort-Body sichtbar gemacht werden — opt-in,
der technische Default ist `silent`. Banner-Texte sind in EN und DE
verfügbar (Auswahl per `Accept-Language`).

Stand: laufende Implementierung, 9 von 15 MVP-Issues gemerged. Proxy,
Adäquanz-Detektoren, LLM-Kritiker, Orchestrator, Pipeline, Ladder-
und Max-Eskalation, Chorus-Dispatch und Banner-Transparenz sind
fertig. Card-Modus, Config-Schema, Per-Request-Overrides, finale
Doku-Runde und das erste Release stehen noch aus. Es gibt noch kein
veröffentlichtes Release.

## License

MIT — see [LICENSE](./LICENSE). Copyright © 2026 Stefan Meggl.
