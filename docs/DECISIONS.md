# Architecture Decision Records

Log of non-trivial architectural decisions made during development.

`DESIGN.md` is the final, trimmed design document — the stable stand.
This file is the **logbook** of the paths that led there: decisions,
their rationale, alternatives considered, and the link to the issue
or PR where the decision was made.

## Format

Each entry uses this shape:

```
## ADR-NNNN: <short title>

- **Date:** YYYY-MM-DD
- **Status:** accepted | superseded-by ADR-XXXX | revised
- **Decision:** one-sentence statement of what was chosen.
- **Rationale:** why — in two to five sentences, not a blog post.
- **Alternatives considered:** what else was on the table and why it was not chosen.
- **Related:** issue / PR / commit hashes.
```

Entries are numbered sequentially (`ADR-0001`, `ADR-0002`, …) and append-only.
Revisions add a new entry that supersedes the old one rather than rewriting history.

---

<!-- First entry lands with issue #2 (HTTP framework choice). -->
