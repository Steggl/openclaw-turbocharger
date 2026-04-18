# openclaw-turbocharger

> Reactive model escalation sidecar for OpenClaw and any OpenAI-compatible client.

**Status:** scaffold (`v0.0.1`). No functional implementation yet — this repository
currently contains project tooling, CI, and empty module stubs only.

openclaw-turbocharger fills the gap between "one cheap model for everything" and
"one expensive model for everything." It runs whichever model you configured
first, checks if the answer actually held up, and escalates only when signals
say it didn't. You see the escalation when it happens and why.

It is **not** a predictive router and **not** a replacement for existing
OpenClaw routers (ClawRouter, iblai-openclaw-router, openmark-router,
openrouter/auto). It complements them.

## What lands next

The MVP is tracked as issues #2–#15 (see `PROJECT_BRIEF.md` §10). The next
three, in order:

1. **#2 `core`** — OpenAI-compatible HTTP server skeleton with pass-through proxy.
2. **#3 `critic:hard-signals`** — deterministic adequacy detector.
3. **#4 `critic:llm`** — small-model LLM critic adapter.

Full positioning, install instructions, configuration reference, and the
related-work section (including a respectful comparison to ClawRouter) will
land with issues #13 and #14.

## Development

Requires Node ≥ 20 (pin: `.nvmrc`). pnpm preferred.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Kurzfassung (DE)

`openclaw-turbocharger` ist ein provider-agnostischer Sidecar zwischen Client
und Modell-Provider. Er führt die konfigurierte Default-Anfrage aus, prüft die
Antwort anhand von Adäquanz-Signalen und eskaliert bei Bedarf auf ein stärkeres
Modell. Eskalationen werden dem Nutzer standardmäßig transparent gemacht.

Stand: Scaffold (`v0.0.1`). Funktionale Implementierung folgt ab Issue #2.

## License

MIT — see [LICENSE](./LICENSE). Copyright © 2026 Stefan Meggl.
