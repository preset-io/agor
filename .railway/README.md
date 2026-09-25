# Railway SQLite bootstrap

This deploys **Agor itself** from this branch. The opt-in `railway-sqlite` variant
now connects Play/Stop/Logs to the explicitly adopted bootstrap preview. One trusted deployment, one replica, one private
volume at `/home/agor/.agor`; no production data or shared tenant credentials.

The configuration currently targets the bootstrap branch
`investigate-railway-environment-variants`. Change that source deliberately before
using a different baseline or enabling Railway PR environments. A local
`railway up` uploads a worktree snapshot, not necessarily the GitHub commit.

## Configuration

Install the isolated tooling with `npm ci --prefix .railway`, then from `.railway`
run `npm test` and `npm run plan` before `npm run apply`. Authenticate through your secret store:
`RAILWAY_TOKEN` is an environment-scoped project token. Never put it in app
variables, this file, a Docker build argument, or a committed `.env` file.
For programmatic CLI invocation, ensure `_` names the Railway executable (SDK
3.11.0 uses it to check the CLI version).

The Dockerfile's `AGOR_RUNTIME_TARGET=runtime-build` selects the shared
dependency image and builds the branch release at startup (details below). It serves the UI and API on port 3030, runs SQLite
migrations at startup with the volume mounted, and enables Claude Code, Codex,
OpenCode, and Copilot. Railway's generated domain must target port 3030; `AGOR_BASE_URL` and
the exact `CORS_ORIGIN` follow that domain. The base URL alone does not authorize
browser origins; omitting CORS causes even same-origin module assets to fail.
Keep CSP and login enabled. Do not use a pre-deploy migration command: the SQLite volume is not
available during that phase.

Railway does not automatically apply `.railway/railway.ts` on GitHub pushes.
GitHub source deployment and IaC plan/apply are separate operations. Review every
plan: removing declared resources can destroy them. This file owns the whole
target environment; do not apply it to an environment with unrelated resources.

## Access and persistence

For operator-selected bootstrap passwords, save `RAILWAY_AGOR_ADMIN_PASSWORD` in
the launching user's secure global environment, then run
`node .railway/secrets.mjs` before planning/applying infrastructure. The helper
targets only this initial project's existing service/environment. It sends the
value directly to Railway as `AGOR_ADMIN_PASSWORD`, with deployment suppressed.
The IaC file uses `preserve()` so it neither embeds nor deletes that secret.
Railway operators with variable access can access this value; use a unique
preview-only password and do not share it across untrusted deployments.

Do not use `{{ user.env.RAILWAY_AGOR_ADMIN_PASSWORD }}` in `.agor.yml`: rendered
commands are persisted branch metadata. Lifecycle scripts should read the
invoking user's process environment instead. Agor's environment executor already
resolves user-global environment variables for its authorized execution user.
The helper is not yet wired into Play, and is not a per-branch provisioning API.

This is **bootstrap-only**. Updating the Railway variable does not rotate an
existing user's password. Change an existing password through Agor's authenticated
user settings/API, not by wiping the volume or re-running bootstrap on every start.

First startup generates a random admin password in the volume's
`admin-credentials` file, mode 0600, without logging it. Retrieve it privately
using Railway's authenticated terminal, or supply `AGOR_ADMIN_PASSWORD` securely
before the first boot. Never use the development default password. Setting the
variable later does not reset an existing account.

SQLite, configuration, signing/encryption keys, repositories, and branch homes
survive redeployment on the volume. Stop retains data; deleting the volume or PR
environment is destructive. Back up before cleanup. Storage can accrue charges
even when compute is stopped. No automatic PR fan-out is enabled by this config.
The volume is 2 GB, expanded in place from the initial 500 MB trial volume.
Runtime checkout and Turbo cache share this space with application data; monitor
usage before adding large repositories or agent runtimes. Paid storage/compute
usage is billed beyond the plan's included credit.

This is a trusted single-operator bootstrap, not a verified multi-tenant hosting
recipe. Default `simple` execution does not isolate users' processes or files.
Do not invite untrusted users; sandbox/bubblewrap support on Railway and delegated
execution need separate validation. No nested Docker support is assumed. Agent
credentials remain per-user and must be connected separately in the UI.

References: [Railway IaC](https://docs.railway.com/infrastructure-as-code),
[Dockerfiles](https://docs.railway.com/builds/dockerfiles),
[Volumes](https://docs.railway.com/volumes).

## Experimental runtime-build target

`docker/Dockerfile --target runtime-build` reuses the development dependency
layers and the existing source-release builder/production bootstrap. It does not
copy application source into the image and does not run watch processes or the
development-default admin bootstrap. The Railway configuration selects this
target with a 600-second health startup window. Hobby capacity is required;
local cold/warm tests passed with a 6 GiB container memory limit.

The new target requires `AGOR_SOURCE_BRANCH`; `AGOR_SOURCE_REPO` currently only
accepts `https://github.com/preset-io/agor.git`. At startup it shallow-clones into
`/home/agor/.agor/runtime-build/checkout` if missing, otherwise fetches and resets
that **owned, disposable checkout** to the branch tip. This can be newer than the
commit that triggered the deployment. The resolved SHA is logged and stamped in
the release. Never edit that checkout or use it as an Agor managed workspace.

A volume lock prevents concurrent startups; an ownership marker rejects reuse
for another branch or repository. Dependency manifests, lockfile, workspace
configuration, and patches must match the image fingerprint, otherwise startup
fails closed and requires an image rebuild. It does not reinstall dependencies
from arbitrary branch changes at startup.

Runtime rsync copies source into disposable `/app`, preserving the dependency
directories baked into the image. Build outputs remain disposable; Turbo's cache
at `runtime-build/turbo` persists and restores unchanged outputs. The normal watch
entrypoint's blanket dist/cache cleanup is not used. Build subprocesses receive
an allowlisted environment without the operator's password/provider tokens.
The packaged daemon still starts through `docker-entrypoint-prod.sh` and retains
the existing SQLite configuration, users, keys, and managed workspaces.

Runtime compilation needs substantially more memory/storage and a longer health
startup window than serving an already-built image. Validate cold and warm boots
under the intended resource limits before changing `AGOR_RUNTIME_TARGET` to
`runtime-build`. No automatic cache pruning or private-repository authentication
is implemented in this prototype. With a volume-backed service the old daemon
cannot stay online throughout a long startup build; active sessions are interrupted.
The full release build is not supported by the trial's 1 GB runtime RAM and
1 GB ephemeral-disk limits. Budget memory for compilation and scratch disk for
source, package staging, and the installed release, not only the final daemon.
Warm Turbo hits avoid compilation but still pack and install the release.

Local preparation tests: `node --test docker/runtime-checkout.test.mjs`.

## Runtime agent tools

`AGOR_RUNTIME_ADD_TOOLS` explicitly adds the four configured tools to an existing
volume's `agentic_tools.installed` policy before the daemon starts. It leaves
other selected tools and unrelated settings intact, creates a private backup of
changed config, and performs an atomic replacement. A read-only or symlinked
config fails closed; this opt-in helper is only for the owned runtime-build
volume, not general compose or externally managed configuration.

`agor install --sync` then installs exact-version integrations into the persistent
`.agor/agentic-tools` directory, using its existing installer lock and validation.
The normal installer removes stale versions/unselected packages. Authentication
is separate: each user connects provider credentials through Agor, never through
committed config. Existing password and account data are not reset.

## Play/Stop integration (adopted preview MVP)

The repository's opt-in `railway-sqlite` variant calls the dependency-free
`scripts/managed-environments/railway/launcher.mjs`. The default remains SQLite
Compose. Import this branch's `.agor.yml` into Agor, then select that variant.
It uses the merged tiny `AGOR_ENVIRONMENT_RESULT={"app":"...","health":"..."}`
contract, not the larger unmerged versioned result/Sync design.

The caller needs secure **global** `RAILWAY_API_KEY` (an environment-scoped
Railway project token, despite the variable name) and
`RAILWAY_AGOR_ADMIN_PASSWORD`. Values are read from the authorized executor's
process environment, never interpolated into commands or returned as results.
Play transfers only the app password and nonsecret app configuration to Railway;
the provider token never enters the deployed app. Existing passwords are not reset.

`bindings.json` explicitly binds the initial Agor branch UUID and exact repo/ref
to the existing service, environment, volume and reviewed domain. Every action
checks project-token scope, provider source, volume, domain and the provider-side
`AGOR_MANAGED_BRANCH_ID` marker. Initial adoption is an operator action, never
implicit on Play. Unknown branches fail before API access. This is **not** an
automatic per-branch provisioner; new branches require separately provisioned,
reviewed bindings and an appropriately scoped caller token. Never duplicate the
bootstrap service/volume binding for another branch.

- **Play:** preserve unrelated variables;
  adopt a pending/running deployment or deploy the pushed GitHub branch; wait up
  to 18 minutes for provider success and app health; return App/health URLs.
- **Stop:** remove that service's matching GitHub push trigger, cancel queued
  deployments, stop live deployments, and poll until the inventory is inactive.
  Keep the service, domain, database, config and cache. Storage remains billable.
- **Logs:** read bounded provider logs without SSH, starts, or variable changes.
- **Nuke:** deliberately refused for this adopted, data-bearing bootstrap volume.
  Destructive reprovisioning is not implemented; use Stop, not project deletion.

The local exclusive lifecycle lock is not a distributed provider lease. A hard
kill can leave a lock under `~/.agor/railway-lifecycle/`; inspect provider state
and ensure no controller is active before manually removing it. Timeouts or
interrupted API mutations can leave billable resources: inspect and use Stop,
never blindly retry Create. Direct Railway changes or a second independent
controller remain outside this single-trusted-operator MVP's coordination.

The environment-scoped project token cannot create GitHub push triggers. Play
deploys the latest pushed branch explicitly; after Stop, pushes alone do not
restart or update the preview. **IaC apply may restore
a removed trigger**; do not apply the infrastructure config while intending to
keep the environment stopped. Play does not recreate the trigger. Runtime
source remains branch-tip based, not an exact-revision Sync guarantee. The domain
is discovered and checked against the reviewed binding; recreation with a new
domain requires an explicit binding update.
