# Publishing Agor

This is the maintainer runbook for SDK/model changes and the `agor-live` npm release.
The executable release contract lives in
[release-agor-live.yml](.github/workflows/release-agor-live.yml).

The order for packaged installs is: **prepare the release PR → merge → push the
version tag → approve publishing → verify npm → upgrade and sync integrations**.
A merged model entry alone does not update an installed agent runtime.

## SDK and model changes

For an SDK/runtime bump, follow the
[SDK bump skill](.agents/skills/bump-agent-sdk/SKILL.md): it maps exact wrapper pins,
source-only SDK copies, watchdog versions, platform packages, and lockfile checks.

For a new model, check all affected owners before preparing the release:

| Owner                                                       | What to check                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/core/src/models/claude.ts`                        | Claude choices, context capacity, and `DEFAULT_CLAUDE_MODEL`                                             |
| `packages/core/src/models/codex.ts`                         | Codex lifecycle, selectability, account/provider availability, context limits, and `DEFAULT_CODEX_MODEL` |
| `packages/core/src/models/`                                 | Other tool registries and configuration resolution, when affected                                        |
| `packages/agentic-tool-opencode/src/shared/known-models.ts` | Matching OpenCode provider catalog entries, when supported                                               |
| `packages/executor/src/sdk-handlers/<tool>/`                | Runtime model mapping, context/effort behavior, and SDK integration                                      |
| `packages/executor/src/handlers/sdk/opencode.ts`            | OpenCode runtime handler                                                                                 |
| `packages/executor/src/handlers/sdk/cursor.ts`              | Cursor runtime handler                                                                                   |

Verify model IDs, pricing, capacities, and availability from the provider's current
documentation and the pinned runtime. Search for the previous model's ID/display
name with `rg` to find related accounting, defaults, tests, and docs. Change defaults
deliberately; adding a model does not require changing the default.

For Claude, distinguish native 1M context from a supported `[1m]` variant; do not
invent a suffix choice. For Codex, preserve lifecycle metadata and account/provider
restrictions. A model appearing in a dropdown is not proof the packaged SDK can run it.
Run a real turn through the updated integration using the intended authentication
method, confirm effective context/effort behavior, and record sanitized results in
the PR. Mocked handler tests do not establish provider availability. See the
[model-selection guide](apps/agor-docs/content/guide/rich-chat-ux.mdx) for user-facing behavior.

Run the relevant registry and handler tests, plus:

```bash
node scripts/check-agentic-tool-packages.mjs
node scripts/sync-agor-live-deps.mjs --check
```

## Prepare the release PR

1. Choose the next version with the maintainers. An SDK pin change needs a new
   aligned release version because published wrapper versions are immutable.
2. Bump every aligned version before opening the release PR. Choose either the
   release artifact builder from the repository root, which bumps versions and
   then runs a full build:

   ```bash
   packages/agor-live/build.sh --bump patch
   # Or choose an exact version, including a release candidate:
   # packages/agor-live/build.sh --version <version>
   ```

   Or update the same 15 files by hand when a local build is not needed:

   - `packages/agor-live/package.json`
   - `packages/client/package.json`
   - `apps/agor-cli/package.json`
   - Each `packages/agor-{claude,codex,copilot,gemini,opencode,cursor}/package.json`
   - Each matching `src/index.ts` file's `AGOR_INTEGRATION_VERSION` constant

   Set every package's `version` and every integration constant to the same release
   version and run `pnpm install` to refresh
   the lockfile. Review the version and lockfile diff and run the alignment checks
   above. Neither method publishes packages or creates a release tag; CI builds
   the tarballs used for publication.

3. Finalize a `CHANGELOG.md` section for the version, covering merged changes since
   the previous release tag. For model/SDK changes, name the supported models and
   runtime versions and include the upgrade/sync instructions below.
4. Run the alignment checks above and relevant tests; require the release PR's CI
   checks to pass. The publishing workflow independently builds once and runs the
   packaged-install matrix before allowing publication.

Keep generated artifacts out of the source PR. A local build can be prepared
before npm publication. The local tarballs can be installed for artifact inspection,
but syncing their registry-backed wrappers and starting a packaged daemon requires
those exact wrapper versions to have been published.

## Tag and approve publication

After the release PR merges, a maintainer creates and pushes `v<version>` on the
merged release commit. Verify the commit is contained in `origin/main`, its
`packages/agor-live/package.json` version matches the tag, and all packages align.
Use an explicit commit when creating the tag so an unrelated local HEAD cannot
become the release. Do not move or recreate an existing release tag.

Open [Release agor-live](https://github.com/preset-io/agor/actions/workflows/release-agor-live.yml)
and select the run triggered by that tag. Once validation passes, an authorized
maintainer approves the pending **`npm` environment** deployment through
**Review deployments**. Approval lets the publish
job proceed; it is not evidence that npm publication has completed.

The workflow publishes the exact validated tarballs through npm trusted publishing,
with integration wrappers and the client first and `agor-live` last. Stable versions
use `latest`; SemVer prereleases use `next`. A manual **Run workflow** invocation
is a **non-publishing preflight**, not a replacement for pushing a release tag.

## Artifact retention and delayed recovery

[agor-live-smoke.yml](.github/workflows/agor-live-smoke.yml) retains the
`agor-live-release` artifact for **7 days after upload**. The protected publish job,
publication retries, and verification against CI artifacts all download that set.
Complete approval/publication and retries within the retention window. Save the
validated archive before expiry if verification or investigation may happen later.
Approval after expiry cannot make the missing artifact available.

If the workflow artifact has expired, inspect all eight release-version package
records on npm before retrying; checking only `agor-live` can miss a partial release:

- **No package at the release version was published:** use **Re-run all jobs** on
  the original **tag-triggered** workflow run to build and validate a fresh artifact
  set, then approve publication. Manual **Run workflow** still does not publish.
- **Any package at the release version was published:** do not rebuild that version
  or use **Re-run all jobs** to recover it. When the original workflow artifact is
  no longer available, prepare a new aligned patch release with a new tag; leave
  already published versions intact. Do not assume rebuilding from the same tag
  produces identical bytes.

An independently saved archive preserves the originals for verification and
investigation, but does not restore the workflow's expired download. Do not bypass
the protected publishing path to recover a partial release.

## Verify npm before installation

Require successful publication and registry verification for all eight packages:
`agor-live`, `@agor-live/client`, and `@agor-live/{claude,codex,copilot,gemini,opencode,cursor}`.
Checking only `agor-live` is insufficient.

For an independent read-only registry check, from the repo root:

```bash
: "${AGOR_RELEASE_VERSION:?set the exact release version being verified}"
node scripts/verify-npm-release.mjs "$AGOR_RELEASE_VERSION" latest --registry-only
# Use next instead of latest for a prerelease.
```

This checks registry tags and downloadable bytes against registry shasums. To
verify against the actual CI artifacts, download the tag run's `agor-live-release`
artifact and pass its extracted directory instead of `--registry-only`.
Registry-only verification does not prove equality with CI artifacts.

Registry propagation can lag publication. The verifier defaults to one shared
600-second deadline; the workflow's `NPM_VERIFY_TIMEOUT_SECONDS` repository
variable can raise it to 1200 seconds. A timeout requires investigation and a
read-only recheck, not an immediate new release or a forced republish.

If publishing failed, inspect which packages exist and why the job failed before
using **Re-run failed jobs** while the validated artifact remains available.
Retrying re-enters publication: matching existing
tarballs are skipped, but an existing version with different bytes is refused.
Reuse the validated artifacts; do not rebuild different bytes under the same version.

## Upgrade packaged installs

Before changing packages, review the release's migration impact and arrange the
deployment's task drain and restart window. `agor install --sync` removes older
integration directories, so drain tasks that still use them before syncing. For
offline cutovers, stop every affected daemon/executor writer and follow the
deployment's stop/migrate/start procedure.

After npm verification, run as the daemon's installation user:

```bash
: "${AGOR_RELEASE_VERSION:?set the exact published release version to install}"
npm install -g "agor-live@$AGOR_RELEASE_VERSION"
agor install --sync
agor doctor
```

For a source-built package, `packages/agor-live/build.sh` prints the exact local
tarball install command. Install the intended version, then run `agor install --sync`
and `agor doctor` as above. Rebuilding or replacing the global CLI alone does not
update the managed SDKs.

An ordinary compatible local upgrade can use `agor daemon restart` after package
reconciliation. See
[installation and upgrading](apps/agor-docs/content/guide/extended-install.mdx)
for package validation, migration preflights, and rollback limits. Then confirm the
new model is selectable and completes a real turn in the installed runtime.

## Hosted deployments and documentation boundary

An npm release does not deploy Agor Cloud. Hosted runtime rollout is a separate
operator action; use the release runbook maintained in the private cloud repository
to build, deploy, and verify the chosen Agor source revision.

Keep this repository's instructions limited to Agor source, public packages, and
public release workflows. Cloud infrastructure, registry/deployment configuration,
operator commands, environment identifiers, credentials, and private runbook links
belong in the private repository. The private runbook can link here for the public
release steps.
