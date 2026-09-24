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
run `npm run plan` before `npm run apply`. Authenticate through your secret store:
`RAILWAY_TOKEN` is an environment-scoped project token. Never put it in app
variables, this file, a Docker build argument, or a committed `.env` file.
For programmatic CLI invocation, ensure `_` names the Railway executable (SDK
3.11.0 uses it to check the CLI version).

The Dockerfile's `AGOR_RUNTIME_TARGET=production-source` selects the existing
source-built production image. It serves the UI and API on port 3030, runs SQLite
migrations at startup with the volume mounted, and installs no agent runtimes by
default. Railway's generated domain must target port 3030; `AGOR_BASE_URL` follows
that domain. Do not use a pre-deploy migration command: the SQLite volume is not
available during that phase.

Railway does not automatically apply `.railway/railway.ts` on GitHub pushes.
GitHub source deployment and IaC plan/apply are separate operations. Review every
plan: removing declared resources can destroy them. This file owns the whole
target environment; do not apply it to an environment with unrelated resources.

## Access and persistence

First startup generates a random admin password in the volume's
`admin-credentials` file, mode 0600, without logging it. Retrieve it privately
using Railway's authenticated terminal, or supply `AGOR_ADMIN_PASSWORD` securely
before the first boot. Never use the development default password. Setting the
variable later does not reset an existing account.

SQLite, configuration, signing/encryption keys, repositories, and branch homes
survive redeployment on the volume. Stop retains data; deleting the volume or PR
environment is destructive. Back up before cleanup. Storage can accrue charges
even when compute is stopped. No automatic PR fan-out is enabled by this config.

This is a trusted single-operator bootstrap, not a verified multi-tenant hosting
recipe. Default `simple` execution does not isolate users' processes or files.
Do not invite untrusted users; sandbox/bubblewrap support on Railway and delegated
execution need separate validation. No nested Docker support is assumed. Agent
credentials and tool installation are separate from verifying the UI/API.

References: [Railway IaC](https://docs.railway.com/infrastructure-as-code),
[Dockerfiles](https://docs.railway.com/builds/dockerfiles),
[Volumes](https://docs.railway.com/volumes).
