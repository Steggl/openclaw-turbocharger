# @steggl/openclaw-turbocharger-provider

OpenClaw provider plugin for the
[openclaw-turbocharger](https://github.com/Steggl/openclaw-turbocharger)
sidecar.

## What it does

Registers `openclaw-turbocharger` as a Provider in OpenClaw. Once
configured, OpenClaw routes chat completions through the sidecar's
HTTP endpoint. The sidecar's reactive-escalation logic (critic +
escalation ladder) runs transparently; OpenClaw sees the final
response, with `X-Turbocharger-*` headers describing what happened.

This plugin is a thin onboarding adapter:

- It does not forward HTTP itself. OpenClaw's built-in OpenAI-compatible
  inference path does that.
- It writes a `models.providers.openclaw-turbocharger` entry into your
  OpenClaw config during setup. From there OpenClaw owns the routing.
- The sidecar itself is unchanged and runs as a separate process.

## Install

```bash
openclaw plugins install npm:@steggl/openclaw-turbocharger-provider
openclaw gateway restart
```

## Configure

The setup wizard prompts for three values:

| Prompt           | Default                                                                                          | Notes                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Sidecar base URL | `http://localhost:11435/v1`                                                                      | Must end in `/v1`. Auto-appended if you omit it.                   |
| API key          | _(empty)_                                                                                        | Optional. Leave blank if your sidecar runs without auth.           |
| Model IDs        | `anthropic/claude-haiku-4-5, anthropic/claude-sonnet-4-6, anthropic/claude-opus-4-7, qwen2.5:7b` | Comma-separated. Edit during setup or later via `openclaw config`. |

The wizard writes a `models.providers.openclaw-turbocharger` entry
into your OpenClaw config; OpenClaw uses that entry to route
requests to the sidecar.

## Verify

```bash
openclaw plugins inspect openclaw-turbocharger --runtime --json
```

Should show the plugin loaded and the Provider capability registered.

## Use

Reference any of the configured models with the
`openclaw-turbocharger/` prefix:

```bash
openclaw chat \
  --model openclaw-turbocharger/anthropic/claude-haiku-4-5 \
  "Hello, what's 2+2?"
```

The sidecar's `X-Turbocharger-*` response headers
(`X-Turbocharger-Decision`, `X-Turbocharger-Escalation-Path`,
`X-Turbocharger-Aggregate`, etc.) appear in OpenClaw's request logs
and tell you whether the response passed straight through or was
escalated.

## Sidecar setup

This plugin assumes the sidecar is reachable at the configured base
URL. To start the sidecar:

```bash
docker run -p 11435:11435 \
  -v ./turbocharger.yaml:/etc/turbocharger.yaml:ro \
  -e TURBOCHARGER_CONFIG=/etc/turbocharger.yaml \
  steggl/openclaw-turbocharger:0.1.0-alpha.0
```

See the
[sidecar repository](https://github.com/Steggl/openclaw-turbocharger)
for full configuration documentation and supported critic/escalation
modes.

## Compatibility

- OpenClaw `>=2026.5.6` (the version that exposes `openclaw/plugin-sdk`
  as a public package export)
- Sidecar `>=0.1.0-alpha.0` (any version that emits
  `X-Turbocharger-*` response headers)

## Status

`v0.1.0-alpha.0` — initial release. The plugin's onboarding wizard
and provider registration work; end-to-end validation against a real
OpenClaw process is tracked separately and was not yet completed at
publish time. Issues and feedback welcome at the
[main repository](https://github.com/Steggl/openclaw-turbocharger/issues).

## License

MIT
