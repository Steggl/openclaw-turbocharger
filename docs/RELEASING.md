# Releasing

How an `openclaw-turbocharger` release is assembled and published.

## Status

PR-A introduced this runbook with the planned five-step sequence.
PR-B expanded step 4 (npm publish) with the verified flow,
including the `prepublishOnly` hook and the `npm pack --dry-run`
pre-flight. PR-C expanded step 5 (Docker image) with the
multi-stage build, a CI-verified smoke test (run on every PR
via the `docker-smoke` job in `.github/workflows/ci.yml`), and
dual-registry push (Docker Hub plus GHCR). All five steps now
have concrete commands.

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
4. **npm publish.** Pre-flight: verify the tarball contents.

   ```bash
   npm pack --dry-run
   ```

   Should match the `files` allowlist in `package.json`: `dist/`,
   `README.md`, `LICENSE`, `CHANGELOG.md`. Any other path appearing
   in the dry-run output is a misconfiguration of the allowlist
   and should be fixed before publishing.

   Publish:

   ```bash
   pnpm publish --tag alpha
   ```

   `--tag alpha` keeps `npm install @steggl/openclaw-turbocharger`
   resolving to the latest stable when one exists. Without `--tag`,
   npm uses `latest` by default; the first non-pre-release version
   will be published without `--tag` so `latest` claims it.

   The `prepublishOnly` script in `package.json` runs `pnpm check:ci`
   first (lint, format check, typecheck, test, build); if anything
   is broken, no artifact is pushed to npm. Public access is
   declared via `publishConfig.access` in `package.json`, so the
   scoped `@steggl/...` namespace publishes publicly without
   `--access public` on every invocation.

5. **Docker image.** Pre-flight: the build and smoke test run on
   every PR via the `docker-smoke` job in
   `.github/workflows/ci.yml`, so a green CI on `main` already
   implies a working image. To reproduce the smoke test locally
   (requires Docker installed):

   ```bash
   docker build -t openclaw-turbocharger:smoke .

   docker run -d --rm --name turbocharger-smoke \
     -p 11435:11435 \
     -e TURBOCHARGER_DOWNSTREAM_BASE_URL=http://localhost:9999 \
     openclaw-turbocharger:smoke

   sleep 3

   docker ps --filter name=turbocharger-smoke --format '{{.Status}}'
   docker logs turbocharger-smoke
   nc -zv localhost 11435 2>&1 | head -1

   docker stop turbocharger-smoke
   ```

   The smoke test confirms three things: the image builds without
   error, the container stays alive past the startup window, and
   the configured port is bound. The dummy `localhost:9999`
   downstream URL is intentional — the sidecar should start
   regardless of whether the downstream is reachable; that
   contract gets verified here.

   Tag and push to both registries.

   ```bash
   echo "$GITHUB_TOKEN" | docker login ghcr.io -u steggl --password-stdin
   docker login --username steggl

   VERSION=X.Y.Z

   docker build \
     --label org.opencontainers.image.version="$VERSION" \
     -t openclaw-turbocharger:"$VERSION" .

   docker tag openclaw-turbocharger:"$VERSION" \
     ghcr.io/steggl/openclaw-turbocharger:"$VERSION"
   docker push ghcr.io/steggl/openclaw-turbocharger:"$VERSION"

   docker tag openclaw-turbocharger:"$VERSION" \
     steggl/openclaw-turbocharger:"$VERSION"
   docker push steggl/openclaw-turbocharger:"$VERSION"
   ```

   The `:latest` tag is pushed only for stable releases (no
   `-alpha`, `-beta`, or `-rc` suffix). Pre-releases use only the
   explicit version tag so `docker pull steggl/openclaw-turbocharger`
   keeps resolving to the latest stable when one exists.

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

- **Automated release workflow** (GitHub Actions on tag push).
  Optional follow-up after the manual release path is documented and
  proven on at least one real release.
