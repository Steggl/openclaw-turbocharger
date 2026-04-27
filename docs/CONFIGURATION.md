# Configuration Reference

Configuration reference for `openclaw-turbocharger`. All types
below correspond directly to interfaces in
[`src/types.ts`](../src/types.ts) — that file remains the
authoritative source of truth.

## Status

The configuration shape is settled at the TypeScript level. A
Zod-validated config file shape lands with issue #11 and may
adjust naming or add validation; the underlying interfaces here
will not change without an ADR.

The example configs under [`examples/`](../examples) are
illustrative — they show the eventual file shape but are not yet
parsed by the running sidecar (which currently reads its
configuration from environment variables, see below).

## Top-level shape

A turbocharger deployment has up to six configuration objects, each
optional unless its feature is in use:

```text
AppConfig                   — port + downstream target (always required)
OrchestratorConfig          — adequacy critic settings (single mode)
EscalationConfig            — ladder/max strategy (single mode + escalate)
ChorusConfig                — chorus endpoint (chorus mode only)
TransparencyConfig          — banner/silent (display)
defaultAnswerMode: AnswerMode — single (default) or chorus
```

The breakdown below matches that order.

## `AppConfig`

The minimum viable configuration. Every deployment needs this.

| Field               | Type     | Required | Description                                                                                         |
| ------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------- |
| `port`              | `number` | Yes      | TCP port the sidecar listens on.                                                                    |
| `downstreamBaseUrl` | `string` | Yes      | OpenAI-compatible base URL. Trailing slashes are normalised away.                                   |
| `downstreamApiKey`  | `string` | No       | Bearer token injected as `Authorization: Bearer <key>` when the upstream client did not supply one. |

Examples of `downstreamBaseUrl`:
`http://localhost:11434/v1` (Ollama),
`https://api.openai.com/v1`,
`https://api.anthropic.com/v1`,
or another router like `https://openrouter.ai/api/v1`.

## `AnswerMode`

Selects the high-level paradigm for shaping the answer:

```ts
type AnswerMode = 'single' | 'chorus';
```

- `'single'` (default): forward to the configured downstream
  target, evaluate the response, optionally escalate. The reactive
  core of the project. See `OrchestratorConfig` and `EscalationConfig`.
- `'chorus'`: dispatch directly to a configured chorus endpoint
  that synthesises a multi-model consensus answer. The
  orchestrator does not run in this mode. See `ChorusConfig`.

The mode is set on `AppDeps` as `defaultAnswerMode` and applies to
every request. Per-request overrides via the
`X-Turbocharger-Answer-Mode` header arrive with issue #12.

## `OrchestratorConfig`

Tunes the adequacy critic. Required for single-mode requests when
the orchestrator should run; absent means pass-through proxy
behaviour.

| Field       | Type               | Default                      | Description                                                                            |
| ----------- | ------------------ | ---------------------------- | -------------------------------------------------------------------------------------- |
| `threshold` | `number`           | —                            | Escalation threshold for the noisy-OR aggregate (`[0, 1]`). ADR-0006 recommends `0.6`. |
| `weights`   | `SignalWeights`    | —                            | Per-category multiplier applied to each signal's confidence before aggregation.        |
| `greyBand`  | `[number, number]` | `[0.30, 0.60]` (recommended) | Range in which the LLM-critic is invoked, when configured. ADR-0010.                   |
| `llmCritic` | `{ run, config }`  | absent                       | Optional LLM-critic. When present, runs only inside the grey band.                     |

`SignalWeights` covers six categories: `refusal`, `truncation`,
`repetition`, `empty`, `tool_error`, `syntax_error`. A weight of
`0` disables the category. The brief recommends starting weights
at `1.0` and tuning per workload.

## `EscalationConfig`

Tells the pipeline what to do when the orchestrator decides
`escalate`. Only consulted in `single` answer mode.

| Field      | Type                | Required                       | Description                                                                                                                         |
| ---------- | ------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `mode`     | `'ladder' \| 'max'` | Yes                            | Strategy. ADR-0021 reduced this from three to two — chorus is no longer an escalation strategy.                                     |
| `ladder`   | `string[]`          | Yes (use `[]` for max-only)    | Ordered weak-to-strong list of model ids understood by the downstream target.                                                       |
| `maxModel` | `string`            | Required when `mode === 'max'` | Single jump target. Per ADR-0019 there is no implicit fallback; missing `maxModel` in max mode produces a `max_model_not_set` stop. |
| `maxDepth` | `number`            | Yes                            | Maximum escalation steps. `0` disables escalation entirely (decisions still reported via headers). ADR-0018 recommends `2`.         |

Per ADR-0016 all ladder steps share the single configured downstream
target — there are no per-model `baseUrl` overrides in v0.1.

## `ChorusConfig`

Configures chorus dispatch. Required when `defaultAnswerMode` is
`chorus`; ignored otherwise. ADR-0021 separates this from
`EscalationConfig` because chorus is an answer paradigm, not an
escalation strategy.

| Field       | Type     | Required              | Description                                                                                                                                         |
| ----------- | -------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`  | `string` | Yes                   | URL of the chorus endpoint. OpenAI-compatible: receives a standard chat/completions request body plus `X-Turbocharger-*` context headers.           |
| `timeoutMs` | `number` | No (default `90_000`) | Per-request timeout. Chorus endpoints are slower than single-model calls because they fan out internally; ADR-0020 documents the 90-second default. |

Per ADR-0020 (retained under ADR-0021), chorus dispatch is
hard-fail. Missing, unreachable, timing-out, or
error-responding endpoints surface specific outcomes
(`endpoint_not_set`, `unreachable`, `timeout`, `non_ok_status`)
rather than falling back to single mode.

## `TransparencyConfig`

Controls whether escalation events are surfaced in the response
body to end users. Decisions are always reported as
`x-turbocharger-*` response headers and structured log fields
regardless of this setting.

| Field  | Type                   | Required                                | Description                                                        |
| ------ | ---------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `mode` | `'banner' \| 'silent'` | Yes when transparencyConfig is supplied | Body-level display mode. The `'card'` mode arrives with issue #10. |

**The technical default is silent.** Per [ADR-0022](./DECISIONS.md), a
sidecar started without an explicit `transparencyConfig` does not
modify response bodies — even when escalation happens. Operators
who want end users to see escalation events MUST opt in by setting
`transparencyConfig: { mode: 'banner' }`. This is a deliberate
choice: response-body mutation is invasive enough that it should
only happen when the operator has consciously chosen it.

When opted in, the banner is a single line marked with
`[turbocharger]` and a blank line separator, prepended to
`choices[0].message.content`. Banner text is locale-aware (English
default, German for `de-*`). Pass decisions on the first try
(`depth === 0`) produce no banner. Streaming responses (per
ADR-0013) and chorus-mode responses (per ADR-0021) are exempt.

## Environment variables

For deployments that don't yet use the file-based config (most
of them, since #11 hasn't landed), `loadEnvConfig` reads the
following:

| Variable                           | Type   | Required             | Maps to                       |
| ---------------------------------- | ------ | -------------------- | ----------------------------- |
| `TURBOCHARGER_PORT`                | number | No (default `11435`) | `AppConfig.port`              |
| `TURBOCHARGER_DOWNSTREAM_BASE_URL` | string | Yes                  | `AppConfig.downstreamBaseUrl` |
| `TURBOCHARGER_DOWNSTREAM_API_KEY`  | string | No                   | `AppConfig.downstreamApiKey`  |

Other config objects (orchestrator, escalation, chorus,
transparency) are wired in code via `AppDeps` for now. The full
file-based configuration loader arrives with issue #11.

## Example deployments

The `examples/` directory has two illustrative configs in YAML and
JSON. They show the eventual file shape (post-issue-#11). For the
moment, treat them as design intent — the running sidecar reads
its configuration from environment variables and `AppDeps` as
described above.

### Minimal: pass-through proxy

```yaml
turbocharger:
  port: 11435
  downstream_base_url: http://localhost:11434/v1
```

### Single mode with ladder escalation and banner transparency

```yaml
turbocharger:
  port: 11435
  downstream_base_url: http://localhost:11434/v1

  answer_mode: single

  orchestrator:
    threshold: 0.6
    grey_band: [0.30, 0.60]
    weights:
      refusal: 1.0
      truncation: 1.0
      repetition: 1.0
      empty: 1.0
      tool_error: 1.0
      syntax_error: 1.0
    llm_critic:
      base_url: http://localhost:11434/v1
      model: qwen2.5:7b
      budget_usd: 0.01

  escalation:
    mode: ladder
    ladder:
      - ollama/qwen2.5:7b
      - anthropic/claude-haiku-4-5
      - anthropic/claude-sonnet-4-6
      - anthropic/claude-opus-4-7
    max_depth: 2

  transparency:
    mode: banner
```

### Chorus mode

```yaml
turbocharger:
  port: 11435
  downstream_base_url: http://localhost:11434/v1

  answer_mode: chorus

  chorus:
    endpoint: http://localhost:11436/v1/chat/completions
    timeout_ms: 90000
```

When chorus is the default answer mode, the sidecar bypasses the
orchestrator and the escalation loop entirely — the chorus
endpoint is responsible for the multi-model synthesis and the
sidecar forwards its response unchanged.
