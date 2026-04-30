# openclaw-turbocharger

> A sidecar that decides between running one model carefully and asking
> several at once. For OpenClaw and any OpenAI-compatible client.

**Status:** all 15 MVP issues merged. The proxy, adequacy detectors,
LLM-critic, orchestrator, pipeline, ladder and max escalation,
chorus dispatch, transparency banner and card, the Zod-validated
config loader, and per-request header overrides are all in place.
v0.1.0-alpha is being cut — see [`CHANGELOG.md`](./CHANGELOG.md)
for the release notes and [`docs/RELEASING.md`](./docs/RELEASING.md)
for how the release is assembled.

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
10. **#10 `transparency:card`** — opt-in structured Markdown card as a
    third transparency mode alongside `silent` and `banner`. Surfaces
    the full decision context (initial model, decision kind, signals,
    aggregate, escalation path, outcome) under a distinct
    `[turbocharger card]` marker. Locale-aware structural labels
    (en/de); values stay English. See [ADR-0023](./docs/DECISIONS.md).
11. **#11 `config:schema`** — Zod-validated configuration loader
    accepting YAML or JSON files via `TURBOCHARGER_CONFIG`,
    environment-variable overrides via `TURBOCHARGER_*` (with `__`
    for nesting and `,` for arrays), and hard-coded defaults.
    Validation errors are aggregated so operators see every
    misconfiguration in one error message. See
    [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) and
    [ADR-0024](./docs/DECISIONS.md).
12. **#12 `config:per-request-override`** — header-based per-request
    overrides for answer mode and transparency mode
    (`X-Turbocharger-Answer-Mode`, `X-Turbocharger-Transparency`),
    layered on top of the static configuration. Invalid values are
    rejected and reported on a `x-turbocharger-override-rejected`
    response header rather than silently falling through. See
    [ADR-0025](./docs/DECISIONS.md).
13. **#13 + #14 `docs:readme` + `docs:comparison`** — full README,
    `docs/COMPARISON.md`, `docs/CONFIGURATION.md`,
    `docs/ARCHITECTURE.md`, and `CONTRIBUTING.md` polish to
    release-ready state, including the `Two answer modes` section
    and the configuration overview. Documentation tracks the code
    rather than trailing it.

## Transparency

The transparency layer is opt-in. By default the sidecar reports
escalation decisions on response headers (`x-turbocharger-decision`,
`x-turbocharger-escalation-stopped`, `x-turbocharger-escalation-path`,
…) and as structured log fields, but does not modify the response
body. Two body-mutating modes are available: a single-line banner
or a structured card. Both are locale-aware (en/de) and both prefix
their output with a marker so clients can strip transparency
annotations without ambiguity.

Set `transparencyConfig.mode` to `banner` for a one-sentence
annotation prepended to the assistant content whenever escalation
or skipped-with-reason happened:

```
[turbocharger] A stronger model was used because the first answer
looked incomplete. The answer below is from the stronger model.

<original assistant content>
```

Set `transparencyConfig.mode` to `card` for the full decision
context — initial model, decision kind plus reason, signals with
their confidences, aggregate score, escalation path, and outcome:

```
[turbocharger card]
- Initial model: weak-model
- Decision: escalate (hard_signals)
- Signals: refusal (0.92)
- Aggregate: 0.853
- Path: weak-model → mid-model
- Outcome: passed at depth 1

---

<original assistant content>
```

The phrasing is deliberately vague — "looked incomplete" rather
than "was wrong" — because the adequacy critic flags signals, not
proven inadequacy. Pass on the first try (`depth === 0`) produces
no banner or card. Streaming responses (per ADR-0013) and
chorus-mode responses (per ADR-0021) are exempt from the
transparency layer regardless of this setting.

See [ADR-0022](./docs/DECISIONS.md) and
[ADR-0023](./docs/DECISIONS.md) for the design rationale of the
banner and card respectively, and
[`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) for the
configuration shape.

## What's next

The MVP is complete. Post-v0.1.0-alpha work is tracked in the issue
tracker on GitHub. Notable items:

- **#22 `plugin-sdk`** — native OpenClaw plugin adapter and an entry
  on `plugins/community.md`. v0.1.0-alpha ships as a standalone
  OpenAI-compatible HTTP sidecar; OpenClaw users can already
  configure it as a custom provider URL. #22 adds first-class plugin
  integration via the OpenClaw plugin SDK so that
  `openclaw plugins install @steggl/openclaw-turbocharger` works
  end-to-end.

See [`CHANGELOG.md`](./CHANGELOG.md) for the v0.1.0-alpha.0 release
notes and [`docs/RELEASING.md`](./docs/RELEASING.md) for how releases
are assembled.

## Install

`openclaw-turbocharger` is published on npm as a scoped package and
installs a single binary, `openclaw-turbocharger`, that runs the
sidecar.

Run it directly without installing globally:

```bash
TURBOCHARGER_DOWNSTREAM_BASE_URL=http://localhost:11434/v1 \
  npx @steggl/openclaw-turbocharger
```

Or install once and use the `openclaw-turbocharger` command:

```bash
npm install -g @steggl/openclaw-turbocharger

TURBOCHARGER_DOWNSTREAM_BASE_URL=http://localhost:11434/v1 \
  openclaw-turbocharger
```

The package is also importable from a Node application for embedded
use; see the named exports of `@steggl/openclaw-turbocharger`.

For Docker deployments, the image is published on Docker Hub and
GHCR:

```bash
docker run -p 11435:11435 \
  -e TURBOCHARGER_DOWNSTREAM_BASE_URL=http://your-llm-host:11434/v1 \
  steggl/openclaw-turbocharger:0.1.0-alpha.0
```

Replace `steggl/...` with `ghcr.io/steggl/...` to pull from GHCR
instead. See [`docs/RELEASING.md`](./docs/RELEASING.md) for the
build and publish flow.

## Configuration

The sidecar reads configuration from three sources, in order of
descending precedence: environment variables, an optional
YAML/JSON file (path from `TURBOCHARGER_CONFIG`), and hard-coded
defaults. The minimum viable deployment sets one variable:

```bash
export TURBOCHARGER_DOWNSTREAM_BASE_URL=http://localhost:11434/v1
node dist/server.js
```

For a full deployment with adequacy critic, ladder escalation, and
banner transparency, write a YAML config (see
[`examples/standalone-config.example.yaml`](./examples/standalone-config.example.yaml))
and point `TURBOCHARGER_CONFIG` at it. Per-field environment
variables follow the `TURBOCHARGER_PATH__SUBPATH=value` convention
(double underscore for nesting, comma for primitive arrays):

```bash
export TURBOCHARGER_CONFIG=/etc/turbocharger.yaml
export TURBOCHARGER_ESCALATION__LADDER=ollama/qwen2.5:7b,anthropic/claude-haiku-4-5
export TURBOCHARGER_TRANSPARENCY__MODE=banner
```

Validation is aggregated — every problem is reported in one error
message, with full dotted-path context, so operators can fix all
of them in one edit. See
[`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) for the full
field-by-field reference and [ADR-0024](./docs/DECISIONS.md) for
the design.

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
(`mode: 'banner'`) oder eine ausführlichere Card
(`mode: 'card'`) im Antwort-Body sichtbar gemacht werden — opt-in,
der technische Default ist `silent`. Banner- und Card-Texte sind in
EN und DE verfügbar (Auswahl per `Accept-Language`).

Die Konfiguration kommt aus Umgebungsvariablen und/oder einer
YAML/JSON-Datei (Pfad aus `TURBOCHARGER_CONFIG`); env-Werte
überschreiben Datei-Werte. Validierungsfehler werden gesammelt und
mit vollem Pfad-Kontext gemeldet.

Stand: alle 15 MVP-Issues gemerged. Proxy, Adäquanz-Detektoren,
LLM-Kritiker, Orchestrator, Pipeline, Ladder- und Max-Eskalation,
Chorus-Dispatch, Banner- und Card-Transparenz, der Zod-validierte
Config-Loader und Per-Request-Header-Overrides sind alle fertig.
v0.1.0-alpha wird vorbereitet — siehe [`CHANGELOG.md`](./CHANGELOG.md)
für die Release-Notes und [`docs/RELEASING.md`](./docs/RELEASING.md)
für den Release-Ablauf.

Installation: `npx @steggl/openclaw-turbocharger` oder
`npm install -g @steggl/openclaw-turbocharger` und dann
`openclaw-turbocharger` aufrufen.

## License

MIT — see [LICENSE](./LICENSE). Copyright © 2026 Stefan Meggl.
