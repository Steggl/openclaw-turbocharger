# Architecture

System-level architecture notes.

## Status

Scaffold. First real content lands with issue #2 (core proxy skeleton), which
will include:

- **HTTP framework choice.** A 3–5 line block naming the framework that was
  chosen, the alternatives considered (`node:http`, `itty-router`, `hono` —
  see brief §8), and a one-sentence rationale. The corresponding decision
  record is `ADR-0002` in [`DECISIONS.md`](./DECISIONS.md).
- **Request lifecycle diagram.** Text-based, matching the flow in
  `PROJECT_BRIEF.md` §3.
- **Module boundaries.** How `proxy`, `critic`, `escalation`, and
  `transparency` compose, and the single shared type surface in
  `src/types.ts`.

For now, the authoritative architecture reference is `PROJECT_BRIEF.md` §3
in the repository root.
