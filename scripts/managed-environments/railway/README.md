# Branch-local Railway previews

`railway-sqlite` is an opt-in, compose-like launcher: **Start ensures the
branch preview is up**, Stop retains its data, and Nuke explicitly removes it.
It runs plain Node (22+) using built-in HTTP support. No npm install, Railway
SDK, PostgreSQL, or daemon-specific handler is needed. Railway builds the app;
its dependencies are separate from this trigger script.

## One-time setup

Choose an existing Railway project authorized for previews. Unrelated resources
(including bootstrap services) are left untouched; a dedicated preview-only
project/workspace is still recommended to limit credential exposure. Enable
Railway's GitHub integration for the public repository; private source resolution
is not supported.

Save these in the launching user's secure Global environment variables (use
Agor's secure widget for agent-assisted setup, never paste secrets into chat):

- `RAILWAY_AGOR_PROJECT_ID`: project UUID from your Railway dashboard URL,
  not the full URL. Each user can select their own project without editing the
  repo. The script reads this directly from its environment and discovers the
  workspace through Railway. Selecting a project and clicking Start is opt-in.
- `RAILWAY_API_TOKEN`: workspace-scoped token authorized for that project (or an
  account token with equivalent access). An environment-scoped `RAILWAY_API_KEY`
  or `RAILWAY_TOKEN` cannot provision across environments.
- `RAILWAY_AGOR_ADMIN_PASSWORD`: preview bootstrap password, at least 15
  characters and at most 72 UTF-8 bytes. Not a password-rotation mechanism.

The operator trusts branch scripts with the token's **full provider authority**.
Use preview-only credentials, never production credentials or untrusted PR code.
The selected project, API-returned workspace, repository and globally unique
Agor branch UUID identify resources. Version-2 receipts do not claim a separate
Agor tenant attestation: normal Agor authorization controls access to the branch
and invoking user's credentials. Sharing a provider token gives its holder full
provider authority, not tenant-isolated access. Agor's
normal branch permissions authorize lifecycle commands. Ownership markers detect
accidental cross-scope reuse, not malicious code holding the provisioning token.
Controller credentials are not sent to the app or written into command arguments.

Import this branch's `.agor.yml` in the repository environment editor, then select
`railway-sqlite` to refresh saved commands. Old `railway-preview:start`
markers are not executables. Subsequent launcher edits run directly from the
branch and need no daemon upgrade or dependency installation. Application source
must be **pushed**: deployment resolves the public GitHub ref to a commit SHA,
not the dirty local checkout. Creating a branch or selecting a variant provisions
nothing. Start is the explicit paid-resource opt-in.

For read-only configuration, authorization and ownership validation:

```sh
node scripts/managed-environments/railway/launcher.mjs check \
  --repository preset-io/agor --ref YOUR_PUSHED_REF --binding AGOR_BRANCH_UUID
```

`check` does not test source availability, deployment or readiness.

Legacy `RAILWAY_PREVIEW_CONFIG` JSON remains supported with its version-1,
tenant-scoped receipts and dedicated-project rules. If it is set, it remains the
active configuration; conflicting project IDs are rejected. Do not remove legacy
config to migrate an existing preview blindly: version-2 names are different.
Clean up or explicitly migrate existing resources first.

The automatic preview sets `AGOR_ADMIN_REQUIRE_PASSWORD_CHANGE=false` alongside
`AGOR_ADMIN_PASSWORD`, so newly bootstrapped admins can keep the operator-selected
password at first login. Other deployments still require a change by default;
generated passwords always require it. This only affects initial account creation:
restarts never reset an existing password or clear an existing change requirement.

## Lifecycle and guardrails

This runtime example currently supports only the public `preset-io/agor` source.
Start reuses the runtime checkout validator before any network/provisioning calls,
so unsupported repositories or branch formats fail before resource creation.

Successful main CI publishes a separate preview dependency image and promotes
`preview-runtime-main` only for the current tested main commit. Start resolves
that public tag to a digest before provisioning; only the digest is passed as
`AGOR_PREVIEW_BASE`, never registry/controller credentials. Railway builds the
thin `railway-preview` stage from it, copying branch startup scripts and dependency
inputs. Matching dependency fingerprints reuse installed packages; changed inputs
run a frozen install. Application source still follows the pushed branch.
When the image is not publicly available (registry 401/404), Start reports a
fallback to the local Dockerfile `runtime-build` stage. The repository must allow
public pulls for reuse; no registry credentials are injected into branch builds. Other registry failures stop before provisioning. Already
running previews are left alone. PR CI builds and checks the image without
publishing it; there is no nightly publishing requirement.

Start inspects deterministic branch-scoped resources and provider-side
`AGOR_PREVIEW_BINDING` receipts. It creates an empty environment, an
**environment-specific** service, private volume at `/home/agor/.agor` and domain
when missing. It never clones production data/secrets or edits `bindings.json`.
An already-running owned deployment is left alone, without a redeploy. App/health
URLs are reported after deployment admission; Agor's health observer establishes
readiness. The application's runtime watch mode follows its pushed branch.

Railway service creation can briefly add empty instances of the **new** service
in other project environments. The launcher verifies those instances have no
source, deployments or volumes, then removes only those new empty instances
before configuring the preview. It never changes existing services. Interrupted
service creation/cleanup fails closed and may require operator reconciliation.
For strict separation with no transient instances in production, choose a
preview-only project.

Stop removes/cancels compute only; repeat Stop after draining if needed. Service,
volume and domain remain, and storage charges continue. Nuke explicitly deletes
the owned service, private volume and environment, never the project.
Railway volume deletion may retain data during the provider's recovery window;
Nuke accepts confirmed pending deletion, not merely a successful API response.
Partial cleanup may require manual Railway recovery; no broad orphan deletion is done.
Missing recorded volumes are never silently replaced with empty storage.

Use **one lifecycle controller per project**, and serialize lifecycle actions.
This lightweight implementation does **not** provide distributed locking,
exactly-once creation or HA-safe concurrent starts. Ownership markers are not
atomic compare-and-swap locks. Failed/ambiguous mutations are never retried in
an invocation. Let Railway settle and inspect before another action; visible
partial resources can be resumed. Pending volume/domain/deployment receipts with
no confirmed outcome fail closed and need operator reconciliation. Initial
environment/service creation has no external durable fence: concurrent starts
or retries before eventual visibility can duplicate resources. Do not use this
example where that risk is unacceptable.

Capacity is three retained previews in the simplified setup (legacy JSON can
configure 1–10), checked before
creation, not an atomic quota. Stopped previews count. Each app has one `sfo`
replica, 2 vCPUs/8 GB limit and bounded restart retries. Inventory reads are
bounded at 100 resources; API calls have a four-minute deadline. These are not
dollar spending limits: configure Railway spending controls separately.

There is no automatic expiry or branch/tenant deletion cleanup. Stop/Nuke and
review inventory before deleting the branch or revoking credentials.

## Local verification

```sh
node --test scripts/managed-environments/railway/*.test.mjs
```

Tests use mocked APIs and create no provider resources. Live deployment behavior
still requires an approved smoke test in the selected preview project.

Provider references: [API authentication](https://docs.railway.com/integrations/api),
[services](https://docs.railway.com/integrations/api/manage-services),
[environments](https://docs.railway.com/integrations/api/manage-environments),
[variables](https://docs.railway.com/integrations/api/manage-variables).

## Migration

The automatic variant was renamed from `railway-auto-sqlite` to `railway-sqlite`.
Import the new `.agor.yml`, then select `railway-sqlite` to re-render saved commands
(stop running environments before switching). Automatic resource identities are
unchanged; no reprovisioning or data migration is required.

The old binding-based launcher, `bindings.json`, volume-reset helper and `.railway`
SDK tooling were removed. Their manually provisioned/bootstrap resources remain
untouched and are not adopted by this launcher. Manage them directly in Railway,
or retain the earlier source revision for old tooling. Review saved commands
before using the renamed variant; the old variant name alone does not migrate data.
