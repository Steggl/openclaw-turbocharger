# Configuration examples

Two ready-to-adapt examples of an `openclaw-turbocharger` config:

- [`standalone-config.example.yaml`](./standalone-config.example.yaml) — YAML
  format, with inline comments explaining each field.
- [`openclaw-config.example.json`](./openclaw-config.example.json) — JSON
  format, same content as the YAML example minus the comments
  (JSON has no comment syntax).

Both are **schema-conformant** against
[`TurbochargerConfigSchema`](../src/config/schema.ts) as of
v0.1.0-alpha.0. Operators can copy either file, adapt the values,
and load it via the `TURBOCHARGER_CONFIG` environment variable:

```bash
TURBOCHARGER_CONFIG=/path/to/config.yaml openclaw-turbocharger
```

Field-by-field reference: [`docs/CONFIGURATION.md`](../docs/CONFIGURATION.md).

## What the examples show

Both demonstrate `answerMode: 'single'` (reactive escalation) with:

- An orchestrator threshold of `0.6` and a grey band of `[0.30, 0.60]`.
- All six signal categories at weight `1.0` (neutral; tune as needed).
- A ladder-strategy escalation across four models (one local, three
  hosted), `maxDepth: 2`.
- A chorus block included for completeness, with a placeholder
  endpoint URL. The block is ignored unless `answerMode: 'chorus'`.
- Transparency in `banner` mode (the technical default is `silent`).

## What the examples do _not_ show

### `llmCritic` is absent

The orchestrator supports an optional LLM critic for tie-breaking
inside the grey band, but it cannot be configured purely from a
static config file. The loader populates the static fields
(`baseUrl`, `model`, `apiKey`, `timeoutMs`, `budgetUsd`, `pricing`),
but the critic also needs a `run` callable that actually calls the
LLM and parses the verdict — this has to be assembled in code and
merged onto the loaded config before passing it to `startServer`.

The YAML example shows the static-field shape as a commented block
for reference. The JSON example omits it entirely (JSON has no
comment syntax). See `docs/CONFIGURATION.md` for the in-code
wiring pattern.

### `chorus` mode

Both examples use `answerMode: 'single'`. To use chorus mode, set
`answerMode: 'chorus'` and replace the placeholder
`chorus.endpoint` with a real chorus-server URL. Per ADR-0021
chorus is an orthogonal answer mode, not a stage of the
single-mode pipeline; the orchestrator and escalation blocks are
ignored in chorus mode.

## Status: validated

These examples were stale prior to the v0.1.0-alpha.0 release —
they used snake_case field names and a `turbocharger:` wrapper that
predated the Zod schema in `src/config/schema.ts`. They have been
refreshed to match the live schema and are now part of the
schema's contract: changes to the schema that break these
examples will require a corresponding update here.
