# Releasing

How an `openclaw-turbocharger` release is assembled and published.

## Status

Stub — landed as part of PR-A of issue #15. Will be expanded in PR-C
once the npm publish plumbing and Docker image build are wired up.
Below is the planned sequence; the final document will include exact
commands, prerequisite checks, and rollback steps for each step.

## Planned release sequence

1. **Prerequisites.** `pnpm check` is green on `main`. The
   `CHANGELOG.md` `[Unreleased]` section has been promoted to the
   target version with today's date and contains the actual changes
   shipping in this release. The `package.json` `version` field
   matches the version about to be released.
2. **Tag.** `git tag -a vX.Y.Z -m 'release X.Y.Z'` from `main` and
   `git push origin vX.Y.Z`. Tags are immutable once pushed; a botched
   tag is corrected by tagging a successor (`vX.Y.Z+1`), not by
   force-pushing the old one.
3. **GitHub Release.** Created from the tag, with notes copied from
   the `CHANGELOG.md` entry. The "Pre-release" flag is set for any
   `*-alpha`, `*-beta`, or `*-rc` version. Auto-generated release
   notes are appended below the manual notes for completeness, not
   used as a substitute.
4. **npm publish.** `pnpm publish --access public` with the
   appropriate dist-tag. Pre-releases use `--tag alpha` (or `beta`,
   `rc`) so that `npm install @steggl/openclaw-turbocharger` keeps
   resolving to the latest stable when one exists. The first
   non-pre-release version will set the `latest` dist-tag.
5. **Docker image.** `docker build` from the repository root, tagged
   as `ghcr.io/steggl/openclaw-turbocharger:X.Y.Z`. The `:latest` tag
   is only pushed for stable releases; pre-releases use only the
   explicit version tag.

## Versioning policy

- `0.x.y` while pre-MVP and during the alpha series. SemVer is
  applied; breaking changes are tolerated between `0.x` minors.
- `1.0.0` once the public API has stabilized. No firm date — driven
  by adoption and feedback rather than calendar.
- Pre-release tags follow SemVer 2.0.0: `-alpha.N`, `-beta.N`,
  `-rc.N`. The pre-release counter starts at `0`
  (`0.1.0-alpha.0`, `0.1.0-alpha.1`, …) so that the first published
  pre-release does not look like an afterthought.

## Out of scope for this stub

- **Exact `pnpm publish` invocation and `npm` access setup.** Lands
  with PR-B (npm plumbing) of issue #15.
- **Exact `Dockerfile` build context, image base, and registry push
  commands.** Lands with PR-C (Docker plumbing) of issue #15.
- **Automated release workflow** (GitHub Actions on tag push).
  Optional follow-up after the manual release path is documented and
  proven on at least one real release.
