# Railway SQLite bootstrap

This deploys **Agor itself** from this branch. It does not implement Agor Play
controlling Railway previews. One trusted deployment, one replica, one private
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

The Dockerfile's `AGOR_RUNTIME_TARGET=production-source` selects the existing
source-built production image. It serves the UI and API on port 3030, runs SQLite
migrations at startup with the volume mounted, and installs no agent runtimes by
default. Railway's generated domain must target port 3030; `AGOR_BASE_URL` and
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
The initial volume is only 500 MB to fit the trial plan: do not clone large
repositories or install agent runtimes until capacity is reviewed.

This is a trusted single-operator bootstrap, not a verified multi-tenant hosting
recipe. Default `simple` execution does not isolate users' processes or files.
Do not invite untrusted users; sandbox/bubblewrap support on Railway and delegated
execution need separate validation. No nested Docker support is assumed. Agent
credentials and tool installation are separate from verifying the UI/API.

References: [Railway IaC](https://docs.railway.com/infrastructure-as-code),
[Dockerfiles](https://docs.railway.com/builds/dockerfiles),
[Volumes](https://docs.railway.com/volumes).
