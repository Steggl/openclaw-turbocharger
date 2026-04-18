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

<!-- First entry below. -->

## ADR-0001: Node.js version

- **Date:** 2026-04-18
- **Status:** accepted
- **Decision:** Pin Node 22 LTS in `.nvmrc`, `engines.node` in `package.json`,
  `tsup` build target, and the CI matrix.
- **Rationale:** `PROJECT_BRIEF.md` §8 specified Node 20 as "LTS" at the time
  of writing. Node 20 is scheduled to leave LTS imminently, which would mean
  the scaffold starts life on a soon-to-be-EOL runtime and forces a near-term
  follow-up upgrade. Node 22 is the current Active LTS. Taking the bump now
  as a one-line change is cheaper than carrying the mismatch. The brief's
  intent — "the current Active LTS" — is preserved; only the version number
  is updated.
- **Alternatives considered:**
  - *Stay on Node 20 until its scheduled maintenance-EOL.* Rejected: the
    remaining support window is too short to justify the carry, and any new
    contributor would install Node 20 on a machine that would outlive it.
  - *Jump straight to Node 24.* Rejected: Node 24 was not the Active LTS at
    the time of this decision; defaulting to the current Active LTS is the
    more defensive baseline. Revisit when Node 24 is promoted.
  - *Matrix-test both 20 and 22.* Rejected for this scaffold step: the
    project has no runtime dependencies yet and no Node-20-specific code
    paths, so there is nothing to validate against 20 today. The matrix
    structure is in place in `ci.yml`; adding versions is a one-line edit.
- **Related:** chore commit bumping `.nvmrc`, `package.json` (`engines`,
  `@types/node`), `tsup.config.ts` (target), and `.github/workflows/ci.yml`
  (matrix). Supersedes `PROJECT_BRIEF.md` §8 guidance on the Node version
  only; all other stack decisions in §8 remain as written.
