# Changelog

All notable changes to this project will be documented in this file.

The format is based on
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.0] — 2026-04-30

First published alpha release. All 15 MVP issues from `PROJECT_BRIEF.md`
§10 are merged.

### Added — server and proxy

- OpenAI-compatible HTTP server with pass-through proxy. Forwards
  `POST /v1/chat/completions` byte-for-byte, streams responses without
  buffering, preserves end-to-end headers per RFC 7230. (#2)

### Added — adequacy critic

- Hard-signal adequacy detectors for refusal, truncation, repetition,
  empty/short responses, tool-error, and JSON syntax. Each detector
  emits a continuous confidence in `[0, 1]` so the orchestrator can
  aggregate without losing weak-but-present evidence. (#3)
- LLM-critic adapter for small-model adequacy judgement.
  OpenAI-compatible, locale-keyed prompts (en/de), opt-in per-request
  budget check, tolerant JSON extraction with a discriminated result
  so failure modes are never silently converted into a pass. (#4)
- Orchestrator and pipeline combining hard signals (noisy-OR
  aggregation with per-category weights) with the LLM-critic in a
  configurable grey band into a single `pass` / `escalate` /
  `skip-with-reason` decision. Surfaced as `X-Turbocharger-*`
  response headers and structured log fields. (#5)

### Added — escalation strategies

- Ladder escalation: on `escalate`, re-queries with the next step on
  a configured model ladder until the answer passes, the ladder is
  exhausted, or `maxDepth` is reached. (#6)
- Max escalation: alternative single-jump strategy that re-queries
  directly with a configured `maxModel` rather than walking up a
  ladder. (#7)

### Added — answer modes

- Top-level `AnswerMode` axis (`single` and `chorus`) parallel to but
  separate from the escalation strategies. (#8, ADR-0021)
- Chorus dispatch to an external multi-model consensus endpoint, with
  classified errors (`endpoint_not_set`, `unreachable`, `timeout`,
  `non_ok_status`) and no silent fallback. The orchestrator does not
  run in chorus mode — chorus carries its own meta-adequacy logic.

### Added — transparency

- Banner mode: single-line localized annotation prepended to the
  assistant content when escalation or skip-with-reason happened in
  single mode. Opt-in via `transparencyConfig.mode = 'banner'`;
  technical default is `silent`. (#9, ADR-0022)
- Card mode: opt-in structured Markdown card with the full decision
  context (initial model, decision kind, signals, aggregate, escalation
  path, outcome). Locale-aware structural labels (en/de); values stay
  English. (#10, ADR-0023)

### Added — configuration

- Zod-validated configuration loader accepting YAML or JSON files via
  `TURBOCHARGER_CONFIG`, environment-variable overrides via
  `TURBOCHARGER_*` (`__` for nesting, `,` for arrays), and hard-coded
  defaults. Validation errors are aggregated with full dotted-path
  context so operators see every misconfiguration in one error
  message. (#11, ADR-0024)
- Per-request header overrides for answer mode and transparency mode
  (`X-Turbocharger-Answer-Mode`, `X-Turbocharger-Transparency`),
  layered on top of the static configuration. Invalid values are
  rejected and reported on a `x-turbocharger-override-rejected`
  response header rather than silently falling through. (#12, ADR-0025)

### Added — documentation

- README, `docs/COMPARISON.md`, `docs/CONFIGURATION.md`,
  `docs/ARCHITECTURE.md`, and `CONTRIBUTING.md` brought to
  release-ready state, including the `Two answer modes` section and
  the configuration overview. (#13, #14)
- `CHANGELOG.md` (this file) and `docs/RELEASING.md` (release runbook)
  added as part of the v0.1.0-alpha cut. (#15)

### Architecture decisions

24 ADRs documenting the design — see
[`docs/DECISIONS.md`](./docs/DECISIONS.md). Notable for users:

- **ADR-0021** — chorus reclassified from escalation strategy to a
  parallel `AnswerMode`. Chorus is a user-selected paradigm for
  multi-model consensus, not a reactive fallback.
- **ADR-0022** — banner phrasing is deliberately vague
  ("looked incomplete" rather than "was wrong") because the adequacy
  critic flags signals, not proven inadequacy.
- **ADR-0024** — environment overrides file overrides defaults; the
  loader follows 12-factor precedence and works with immutable
  container images.

### Out of scope for v0.1.0-alpha

- **Native OpenClaw plugin integration** is tracked as #22 for a later
  release. v0.1.0-alpha ships as a standalone OpenAI-compatible HTTP
  sidecar; OpenClaw users can configure it as a custom provider URL.
  When #22 lands, `openclaw plugins install
@steggl/openclaw-turbocharger` will work end-to-end and the project
  will be submitted to the openclaw/docs `plugins/community.md` listing.
- **Streaming response transparency annotations** (per ADR-0013).
  Banner and card mode apply only to non-streaming responses.
- **Chorus-mode transparency** is intentionally absent (per ADR-0021).
  Chorus carries its own transparency via the minority reports of the
  chorus endpoint; layering banner or card on top would be redundant
  noise.

[Unreleased]: https://github.com/Steggl/openclaw-turbocharger/compare/v0.1.0-alpha.0...HEAD
[0.1.0-alpha.0]: https://github.com/Steggl/openclaw-turbocharger/releases/tag/v0.1.0-alpha.0
