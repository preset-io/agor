# Codespaces + SQLite managed environment: feasibility and bounded prototype

**Date:** 2026-08-28

**Status:** design complete; provider-neutral lifecycle core prototyped and mock-tested; not wired

**Decision:** do **not** add a `codespaces-sqlite` entry to `.agor.yml` yet

## Executive conclusion

The product is feasible, but current `main` cannot represent it safely as a truthful repository
variant. A local shell bridge can create and stop a Codespace, but it cannot safely solve dynamic
URLs, a stable credential owner for shared branches, exact ref availability, duplicate Play across
replicas, stale executor callbacks, private forwarded-port health, or cleanup ownership. The
webhook-only HA path is even narrower: it is an unauthenticated static GET with no structured body.

PR #2304 adds useful generic facts, sync, readiness, and health behavior. It does not provide a
Codespaces controller or the durable authorization/binding/fencing contract this product needs. It
is a large draft with conflicts against current `main`; merging it is neither required nor safe for
this first prototype.

This branch therefore contains an opt-in, unconnected prototype at
`scripts/managed-environments/codespaces/bridge-core.mjs`. It models the provider lifecycle behind
an injected adapter and refuses to operate without a current-attempt check. Its tests use no
network and no credentials. No production config advertises a nonfunctional variant.

The shortest production path is an **Agor-native Codespaces controller**, initially restricted to
the GitHub user who authorized the resource, plus a small durable remote-environment binding and
operation lease. Do not use a repository shell script as the long-term security boundary.

## Revisions inspected

| Item                                                      | Exact revision/status on 2026-08-28                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `preset-io/agor` current `main`                           | `f1ba9474846c703639db71cb5a8cea1edfa73cf1`                                                                                |
| This branch at task start                                 | same revision, branch `codespaces-sqlite-variant`                                                                         |
| PR #2304                                                  | draft/open, head `1608be0d6d19f0ee7edc0fbee01d44954a6918e9`, 40 commits, 105 changed files, +6072/-57, merge status dirty |
| PR #2304 original design baseline                         | `47882bd9` (recorded in its design note, 2026-07-30)                                                                      |
| `preset-io/agor-cloud` current `main` inspected read-only | `67f2b38fc04343fbbf95fbf910c43e7adc0eaf97`                                                                                |
| Referenced `preset-codespaces` prototype branch           | `geido/feat/codespaces-ultra` at `93167bae21d9d12063394e2594e34f8898453510`                                               |

The GitHub REST API, PR archive, commit list, and file list were read without checking out or
merging the PR. No branch history was rewritten.

## Precise product interpretation

There are two Agor daemons in this scenario:

1. The existing **control-plane Agor** owns the board, branch, authorization, and managed
   environment record. Its database choice is unchanged.
2. The launched **preview Agor inside the Codespace** is the branch application. It uses the
   repository's existing standalone SQLite configuration, while all workspace, Docker, and agent
   processes run on the Codespace VM.

SQLite is not shared between the control plane and Codespace. It lives on the Codespace filesystem
and follows that Codespace's stop/delete persistence semantics. The Git repository remains the
source of truth; the remote SQLite database is disposable environment state.

## Current-main trace

### Schema and render time

- `.agor.yml` v2 variants support `start`, `stop`, `nuke`, `logs`, `health`, `app`, `description`,
  `extends`, and the default variant. The present `sqlite` variant runs Docker Compose locally.
- Canonical types are in `packages/core/src/types/branch.ts`. A
  `BranchEnvironmentInstance` stores status, process metadata, last health, static/dynamic
  `access_urls`, logs, error, and last command. There is no provider identity, fact bag,
  credential owner, lifecycle operation ID, or lifecycle attempt generation.
- `packages/core/src/environment/render-snapshot.ts` renders lifecycle strings when the branch
  snapshot is created or re-rendered. Available branch input includes `name`, `base_ref`,
  `ref_type`, path, and `unique_id`; it does not include a trustworthy exact current Git ref or
  commit SHA. Rendered app and health URLs are static strings.
- Template values are strings, not shell-escaped arguments. Putting a ref or slug inside a shell
  command is therefore not an acceptable trust boundary.

### Lifecycle execution

- In `hybrid` mode, a URL-shaped lifecycle string is fetched as a webhook; every other string is
  executed as a shell command by an environment executor.
- In `webhook-only` mode, Start/Stop/Nuke/Logs must be public HTTP(S) URLs. The current webhook is a
  GET with no request body, signature, authorization header, redirect following, or dynamic
  provider response contract. URL credentials are rejected. This is insufficient for a mutating
  multi-tenant controller.
- `apps/agor-daemon/src/services/branches.ts` checks branch environment-control permission and
  tenant-scopes the branch lookup. Shell execution receives the **actual caller's** saved global
  user environment variables through `createUserProcessEnvironment`; session-scoped variables are
  excluded. This preserves caller attribution, but makes resource ownership change with whichever
  collaborator presses Play.
- The executor runs the rendered command with `shell: true`, captures stdout/stderr, mirrors it to
  executor logs, and persists a bounded tail. Current main has no `AGOR_FACT` parser or output
  redaction contract.
- `startEnvironment` rejects `running`, but does not atomically claim `starting`. Two simultaneous
  callers can both dispatch Start. Executor completion is not compared with a lifecycle operation
  ID, so a late Start success can publish process/URL state after Stop or Nuke.
- Delegated execution transports the action and caller environment to the external launcher, but
  it does not add provider ownership or lifecycle fencing. HA deployments remain webhook-only
  because no daemon replica owns the lifecycle subprocess.

### Health, persistence, and consumers

- SQLite and PostgreSQL branches have a durable `environment_generation` and health-claim fields.
  `EnvironmentHealthRepository` uses them to fence **health observations**, not lifecycle actions.
- The health monitor probes only the rendered `branch.health_check_url`. One successful 2xx
  promotes `starting` to `running`; a running environment is not demoted on failure in current
  main. Without a health URL, a completed shell start remains `starting`.
- `environment_instance.access_urls` is returned by branch API, CLI, and MCP environment tools.
  The current executor only seeds it from static `branch.app_url`.
- `EnvironmentPill.tsx` uses `branch.app_url`, not `environment_instance.access_urls`. Thus even a
  hypothetical dynamic URL in the instance would not make the current Play/App pill useful.
- Optional rendered fields and nested instance clears deserve care: repository deep merge can
  retain an omitted nested value unless the clear is explicit. PR #2304 includes a fix for this.

## Feasibility matrix using current primitives

| Capability           | Current local/hybrid                                                      | Current Cloud/HA webhook-only                     | Result for first variant                                                   |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| Create via `gh`/REST | Possible in a shell with the caller's saved token                         | Only through an external public GET controller    | Mechanically possible, not a safe shared-branch contract                   |
| Exact repository     | `repo.slug` exists; no bound provider repository ID                       | Could be baked into static URL                    | Must resolve and persist numeric provider repo ID                          |
| Exact branch/ref     | No exact current ref/commit in render context; local work may be unpushed | Static URL cannot carry a safe structured payload | Blocking policy decision; require pushed immutable SHA/ref for v0          |
| Idempotent Play      | A bridge can list before create                                           | Controller can reconcile                          | Missing atomic/durable per-branch lease and provider binding               |
| Start timeout        | Shell can poll and then exit                                              | Controller can poll                               | Possible, but late executor result is not fenced                           |
| Stop                 | `gh codespace stop` possible for token owner                              | Static controller endpoint possible               | Must rediscover and revalidate identity immediately before mutation        |
| Nuke                 | `gh codespace delete` possible for token owner                            | Same                                              | Must be fail-closed and cleanup/retry aware                                |
| Health               | Static URL only                                                           | Static public URL only                            | Provider state is possible; dynamic/private app readiness is not           |
| Logs                 | Shell output is captured                                                  | GET text can be returned                          | `gh codespace logs` is creation diagnostics, not preview Agor runtime logs |
| Dynamic app URL      | Instance field exists, no command-output path on main                     | No structured response                            | Blocking; UI also ignores dynamic instance URL                             |
| SSH                  | `gh codespace ssh` is an authenticated action                             | No representation                                 | Do not invent or persist an SSH URL; add an authorized action later        |
| Restart/recreate     | Shell can list on every action                                            | Controller can list on every action               | Feasible only with a deterministic binding marker and validation           |
| Credentials          | Actual caller's saved global env can hold `GITHUB_TOKEN`                  | No header/body auth to controller                 | Not safe for collaborator-owned resources or central HA                    |
| Tenant isolation     | Branch service is tenant scoped                                           | Controller URL has no tenant proof                | Needs signed structured request plus tenant-scoped binding                 |
| Attempt fencing      | Health only                                                               | Health only                                       | Blocking for safe mutations/results                                        |
| SQLite preview       | Existing repo `sqlite` stack can run in the Codespace                     | Same once the VM exists                           | Feasible; requires repository-owned devcontainer/bootstrap contract        |

## PR #2304: what it adds and what v0 needs

The PR starts with facts and grows into a broader remote-environment change set:

| Primitive in PR #2304                                                                                       | Representative commit                          | Value for this product                                       | Needed for v0?                                                         |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Parse `AGOR_FACT key=value`; persist `facts`; reserved URL updates access URLs; expose `env.*` to templates | `597c49a52fce`                                 | Makes a shell command report a generated URL                 | Useful, but raw stdout is the wrong controller protocol                |
| `sync` variant/action and renderer                                                                          | `3184d1dec9bc`                                 | Can move local changes to a remote environment               | No if v0 requires an already-pushed ref/SHA                            |
| Task-completion auto-sync/internal operation                                                                | `5a5495508748`, `e6ccf63cbf23`                 | Keeps a long-lived remote workspace current                  | Defer; broad Git write behavior needs separate review                  |
| Health-gated readiness and catch-up sync                                                                    | `5d1e4d4e7084`                                 | Separates provider creation from app readiness               | Concept required; implementation can be controller-owned               |
| Demotion/recovery, startup timeout, local/HA transition parity                                              | `5d0ce5266420`, `f994ab494fb6`, `781df1637372` | Better generic remote health behavior                        | Useful after the controller contract exists                            |
| Reject a second Start while already starting                                                                | `bc727b8bc0ab`                                 | Reduces common duplicate Play                                | Insufficient: check/update is not a durable atomic cross-replica lease |
| Treat fact health URL as untrusted                                                                          | `5af7d8854e98`                                 | Important SSRF defense                                       | Necessary principle; the PR's syntactic host check is not pinned DNS   |
| Persist field clears correctly                                                                              | `a85271a567b6`                                 | Prevents stale local health/app fields after variant changes | Needed independently of Codespaces                                     |
| Serialize health observations and syncs                                                                     | `e1b6bb44b9e2`, `831d141df6c0`                 | Avoids local overlap                                         | Sync lock is process-local, not a lifecycle HA lease                   |

The fact protocol has no typed schema, provenance, secret classification, durable attempt binding,
or complete log-redaction boundary. Because current execution combines captured output with
executor logs, a bridge that prints a token or credential-bearing URL can leak it before parsing.
Facts also do not solve resource ownership or atomic mutation.

The PR's own Codespaces bridge is not in this repository. No Codespaces bridge was found in current
`preset-io/agor` or the inspected `agor-cloud` main tree. Its design note points to a separate
`preset-codespaces` feature branch; that branch was also inspected read-only at the revision above.

### Assessment of the referenced shell bridge

The separate `scripts/agor-codespace.sh` is valuable evidence that a single-user happy path can be
built from today's CLI and PR facts. It can create for a repository/ref, resume, stop, delete,
retrieve a persisted creation log over SSH, register ports, synthesize forwarded URLs, and
rediscover by repository + deterministic display name. It also correctly distinguishes a failed
list from an empty list before the billable Create path.

It is not safe or generic enough to reuse as this variant's production controller:

- `.agor.yml` interpolates branch/custom ref/name values into a `shell: true` command without a
  structured escaping contract.
- Ownership is whichever `gh` account belongs to the executor process. There is no tenant,
  credential sponsor, provider account, or actual-caller binding. Its display marker derives from
  branch text, not tenant/branch UUID, so separate Agor installations can adopt the same resource.
- Discovery validates the repository but not the expected ref/commit or explicit provider owner.
  When duplicates exist it selects the oldest instead of failing closed.
- There is no lifecycle lease, generation, operation ID, or bounded timeout around `gh`. Concurrent
  Play can create twice, and a late result can win after Stop/Nuke.
- Stop/Nuke use `find_codespace || true`, so a provider lookup failure is treated like absence and
  returned as success. Destructive calls do not re-fetch and revalidate immediately before action.
- URLs are assembled from the remembered Codespace name and port rather than read from current port
  metadata. Port-publication failure is logged but Start continues and emits the URL.
- It makes app/manager ports public by default. The URLs and health endpoint are therefore reachable
  only by accepting unauthenticated public exposure.
- `status` can emit refreshed facts, but the variant does not wire a status lifecycle and current
  health monitoring does not execute commands. It cannot repair a recreated URL in normal health
  polling.
- “Logs” uses SSH and can wake stopped compute; it is creation diagnostics, not a bounded,
  redacted preview-runtime stream.
- Its sync path force-pushes provider refs and hard-resets/stashes the remote tree. That is a
  separate, materially destructive source-management feature rather than a prerequisite for a
  pushed-ref v0.

The branch is repository-specific to a different application stack, not the Agor SQLite preview.
It should be treated as experimental evidence, not copied. The PR should be split/rebased and
useful generic pieces reviewed independently; this prototype does not merge it.

## GitHub interface and authentication

### Verified provider surfaces

GitHub CLI 2.89.0 on the development host exposes `gh codespace create`, `list`, `view`, `stop`,
`delete`, `logs`, `ports`, and `ssh`. The create command accepts repository, branch, display name,
machine, location, devcontainer path, idle timeout, and retention period. It does not accept an
arbitrary Agor environment payload.

The documented REST API supports create/list/get/start/stop/delete for the authenticated user's
Codespaces. Create takes a repository ID and ref and returns a provider-generated name, state,
repository, owner, `git_status.ref`, and editor URL. The authenticated user owns the resulting
Codespace. GitHub App **user access tokens** and appropriate fine-grained tokens are supported by
the user Codespaces endpoints; an installation token is not a substitute for the user's ownership
credential. A classic token needs the `codespace` scope. Organization admin endpoints are a
different, privileged control surface and should not be the default.

Authoritative references:

- <https://docs.github.com/en/rest/codespaces/codespaces?apiVersion=2026-03-10>
- <https://cli.github.com/manual/gh_codespace_create>
- <https://cli.github.com/manual/gh_codespace_ports>
- <https://docs.github.com/en/codespaces/reference/security-in-github-codespaces>

The local `gh auth status` check found an authenticated developer account with Codespaces scope,
but no mutation was attempted. That ambient developer token is not a production design.

### Recommended auth model

1. A user explicitly connects GitHub to Agor through a reviewed GitHub App OAuth flow that returns
   a user access token with the minimum Codespaces and repository permissions.
2. Agor stores the grant encrypted in the tenant/user credential store. The token is never written
   to `.agor.yml`, branch rows, environment facts, commands, URLs, process arguments, or logs.
3. First Start records an immutable **credential sponsor** (normally the branch primary owner),
   provider account ID/login, repository ID, and tenant on the environment binding.
4. Simplest v0: only that sponsor may perform lifecycle actions. If collaborators must control the
   same resource, add an explicit owner-authored delegation. Authorization uses the actual Agor
   caller; the provider request uses the sponsor's grant; the audit event records both. Never
   silently fall back to the caller's unrelated token.
5. The controller resolves the token immediately before an API call and passes it only in an
   Authorization header to the fixed `api.github.com` origin. No redirects. Provider error bodies
   are categorized and sanitized, not logged wholesale.
6. Revocation makes lifecycle actions fail clearly but does not weaken identity checks. A cleanup
   queue records the orphan and retries after reauthorization or administrator action.

The existing GitHub gateway/comment App credential must not be reused merely because it is a
GitHub token. Its bot/installation identity, permissions, ownership, and tenant lifecycle differ.

### Multi-tenant resource classification

- The binding, lifecycle lease, Codespace, remote SQLite state, access URLs, and sanitized
  diagnostics are **tenant-owned or tenant-derived** resources.
- The GitHub OAuth grant is a **tenant/user-owned secret**. Only its opaque encrypted-store
  reference belongs in the binding.
- GitHub's API is shared infrastructure, but every call must carry trusted tenant/branch context
  from the authenticated Agor boundary and select exactly one sponsor grant. Provider IDs and the
  marker never establish Agor authorization.
- Access URLs are branch data even when they contain no query secret. Return them only through the
  branch authorization boundary and do not put them in operational logs.
- Cleanup and health jobs must restore the binding's trusted tenant context before repository or
  credential lookup. Global scans select tenant IDs only for routing, never as caller input.

## Proposed lifecycle and data flow

```mermaid
sequenceDiagram
  participant U as Authorized Agor user
  participant B as Branch service
  participant C as Codespaces controller
  participant D as Tenant-scoped binding/lease
  participant G as GitHub API
  participant R as Codespace bootstrap

  U->>B: Play(branch)
  B->>B: authorize actual caller in tenant
  B->>D: atomically claim generation + operation ID
  B->>C: structured request + caller + sponsor grant reference
  C->>G: resolve viewer and numeric repository ID
  C->>G: list current resources by repository
  C->>C: match deterministic marker; validate owner/repo/ref
  alt valid stopped resource
    C->>G: start exact resource
  else no valid resource
    C->>G: create exact pushed ref with marker
  else duplicate or mismatched resource
    C-->>B: fail closed; no mutation
  end
  C->>G: bounded readiness polling
  R->>R: start preview Agor with SQLite
  C->>D: compare-and-set current attempt; publish current URLs/state
  B-->>U: realtime environment update
```

### Required durable binding

Use a tenant-owned table or an explicitly typed extension of environment state, not free-form
facts:

- `tenant_id`, `branch_id`, `provider` (unique together);
- `provider_account_id`, display login, encrypted-grant reference/credential sponsor user ID;
- numeric `provider_repository_id`, canonical repository name;
- requested immutable commit SHA and creation ref;
- deterministic nonsecret marker, last validated provider resource name/ID;
- lifecycle generation, operation UUID, action, lease owner/expiry, attempt status;
- last validated provider state and nonsecret access URLs with observation time;
- cleanup state, retry count, retention deadline, and last safe error code.

Every lookup begins with trusted tenant + branch context. The hash marker is for provider
rediscovery, not authorization. A returned Codespace must match marker, credential owner,
repository ID/name, and ref/SHA. More than one match is an incident/fail-closed state.

The prototype computes `agor-<32 hex>` from tenant and branch, lists provider reality on every
action, re-fetches immediately before Stop/Nuke, and validates all published `*.github.dev` HTTPS
URLs. A last-known resource name is only a drift detector: if it still exists with a renamed marker,
the controller freezes rather than adopting or duplicating it; if it is genuinely gone, Start can
create a replacement. A production marker should also be placed in a provider field whose semantics
GitHub guarantees (currently display name is the practical candidate) and its collision/rename
behavior should be confirmed in a disposable account.

### Action semantics

| UI action  | Controller behavior                                                                                                                                                                   | Clear limitation                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Play**   | Under one durable lease, rediscover; start a valid stopped Codespace or create exact pushed ref; poll provider readiness with deadline; then require preview readiness before publish | Cold boot can be long; no dirty/local-only commits in v0                      |
| **Stop**   | Rediscover and validate; stop exact resource; retain Codespace disk and remote SQLite                                                                                                 | Storage remains billed until retention/delete                                 |
| **Nuke**   | Rediscover, re-fetch, validate all identity fields, delete exact resource, clear binding URLs only after current-attempt CAS                                                          | Never wildcard-delete by prefix or stale name                                 |
| **Health** | Reconcile provider state and current URLs; separately report preview readiness                                                                                                        | Private/org port auth may prevent a central HTTP probe                        |
| **Logs**   | Return bounded sanitized controller audit + Codespaces creation diagnostics                                                                                                           | Not the preview daemon/container logs; those need an in-Codespace log channel |
| **App**    | Link the newly observed forwarded UI URL, with visibility/auth indicated                                                                                                              | Current EnvironmentPill must be changed to consume instance URLs              |
| **SSH**    | Future explicit authorized action using the sponsor grant                                                                                                                             | It is not an access URL and must not be fabricated or persisted as one        |

Codespaces can be stopped or recreated outside Agor. Health and every mutating action must list and
validate current provider state. Stored names and URLs are hints only. If the old resource is gone,
Start may create a new one and atomically replace URLs; Stop/Nuke should return already absent.

## Forwarded ports and health

GitHub says only the creator can connect to a Codespace. Forwarded ports are private by default;
organization/public visibility has different access and policy implications. A public port is an
unauthenticated internet exposure and must not be selected merely to make central health polling
easy. Browser links may require the user's GitHub session, which is separate from Agor auth.

Max must choose one v0 posture:

1. **Private ports, sponsor-only UI access:** safest first slice. Health is provider state plus a
   signed in-Codespace readiness callback; collaborators cannot necessarily open App.
2. **Organization-visible ports:** workable only when Agor users and GitHub organization identity
   are mapped and org policy permits it. Server-side health still needs auth.
3. **Public preview port:** only for explicitly disposable, nonsecret demo data, with a prominent
   warning and repository opt-in. Do not use it as the default.

The controller must read current port metadata after every resume. Do not synthesize
`https://<remembered-name>-<port>.app.github.dev`; GitHub returns browse URLs and policies can
change. True preview readiness can come from a short-lived signed callback or a controller that
runs the probe inside the Codespace. Provider `Available` alone means VM-ready, not Agor-ready.

## Remote source and SQLite bootstrap

Codespaces clone from GitHub, not from `~/.agor/worktrees`. For v0:

1. Require a pushed ref and resolve it to a commit SHA before creation.
2. Persist the expected SHA and verify the created Codespace initially resolves to it. If a user
   changes branches inside the Codespace, subsequent mutation fails closed until explicit rebind.
3. A repository-owned, reviewed devcontainer bootstrap starts the same standalone SQLite preview
   stack as the local `sqlite` variant, but uses Codespaces port forwarding rather than host port
   arithmetic.
4. Keep the SQLite DB on the Codespace filesystem/volume. Stop preserves it; Nuke deletes it. Do
   not sync the database back into Agor or Git.
5. Defer automatic source sync. PR #2304's sync path is not needed for a pushed-ref v0 and any
   force-pushed scratch-ref design needs separate authorization, retention, and conflict policy.

## Local subprocess versus Cloud/HA

### Local/hybrid prototype

A shell bridge can be proven on a trusted single-daemon installation if it receives a per-user
token through the prepared environment and passes all repository/ref values as structured data to
a non-shell API client. It must never print raw child output. Even then, current Agor cannot
atomically fence the executor callback or surface the dynamic App URL in the UI. Treat this only as
a developer experiment, not the shipping backend.

### Cloud/HA

Do not route this through today's generic webhook. A public unauthenticated GET cannot prove tenant,
actor, generation, payload integrity, or credential sponsor and has no idempotency contract. Add
either:

- an Agor-native service that all replicas call through the shared database/queue; or
- a signed POST controller protocol with structured body, short-lived audience-bound token,
  tenant/branch/action/operation claims, replay protection, response schema, and durable callback.

The lifecycle lease must be database-backed. Provider calls and final state publication use the
same operation ID; callbacks compare-and-set generation so Start cannot overwrite a later
Stop/Nuke. In-memory serialization, including the prototype lease and PR #2304 sync lock, is not HA
coordination.

## Prototype contract and measured validation

`bridge-core.mjs` deliberately has no GitHub token resolver and no `.agor.yml` entry. A future
adapter supplies viewer/repository resolution, list/create/get/start/stop/delete, creation logs, and
current access URLs. The core supplies:

- allowlisted structured request validation, including UUID attribution and exact non-shell ref
  transport; arbitrary credential fields are dropped before the provider boundary;
- deterministic tenant+branch marker;
- credential owner, repository ID/name, ref, and marker validation;
- rediscovery on every action and revalidation before destructive calls;
- bounded provider calls and start/stop polling, with sanitized failures and fail-closed states;
- current-attempt checks before mutations and before publishing results;
- same-process duplicate Play serialization for the prototype;
- `github.dev` HTTPS URL allowlist with credentials/query/fragment rejected;
- bounded provider-output sanitization; `AGOR_FACT` control lines are never honored.

Command run:

```text
node --test scripts/managed-environments/codespaces/bridge-core.test.mjs
```

Measured result: **16/16 tests passed in 91 ms** on Node's built-in test runner. Coverage includes
create/readiness, stopped resume, idempotent Stop, concurrent Play, cross-tenant non-adoption,
stale/deleted rediscovery, changed URL, renamed-resource freeze, reconciled Health, validated Nuke,
shell-looking ref preservation, lifecycle/provider timeout, sanitized provider failure,
owner/repository/ref/duplicate identity rejection, stale attempt, destructive revalidation, log
redaction/bounds, invalid URL rejection, and invalid input. The test provider is fully in-memory; no
GitHub resource or customer repository was read or mutated by the tests.

Agor's read-only environment status confirms this branch is rendered with the existing `sqlite`
variant and static daemon/UI ports; it was stopped (`status: unknown`) during validation. Per the
repository's watch-mode rule, the prototype did not start Docker or a background development stack.
The lifecycle behavior above was exercised hermetically from the managed branch worktree rather
than pretending an unconnected `.agor.yml` variant was live.

The prototype current-attempt callback demonstrates the required boundary but cannot make the
check and remote API mutation atomic. Only the durable controller operation/lease described above
can close that race.

## Smallest follow-up primitives and decisions for Max

### Engineering primitives, in order

1. **Exact source contract:** add trustworthy current ref + commit SHA as structured controller
   input; choose pushed-only v0 or design a separate sync ref.
2. **Tenant-scoped binding and lifecycle CAS:** provider identity, sponsor grant reference,
   generation/operation ID, lease, cleanup state; unique by tenant/branch/provider.
3. **Authenticated structured controller path:** Agor-native is preferred; otherwise signed POST,
   never today's generic GET webhook.
4. **GitHub user OAuth grant:** minimal permissions, encrypted storage, revoke/reauthorize UX, and
   explicit credential sponsor policy.
5. **Dynamic result contract:** typed nonsecret state/access URLs, generation-bound persistence,
   realtime update, EnvironmentPill/App consumption, and URL visibility metadata.
6. **Readiness channel:** distinguish GitHub VM state from preview Agor readiness without making a
   private port public.
7. **Reconciler/cleanup:** retry orphan cleanup, enforce retention, inventory verified bindings,
   and alert on ambiguous/mismatched resources.
8. **Repository bootstrap:** a Codespaces devcontainer path that starts the SQLite preview and emits
   a signed readiness signal. Only after this exists should `.agor.yml` advertise the variant.

Useful parts of PR #2304 (clear persistence, typed dynamic rendering idea, health transitions) can
be split and rebased. Do not make raw lifecycle stdout the authoritative provider protocol.

### Product decisions

- Who sponsors/owns the Codespace: branch primary owner, each caller separately, or an explicitly
  delegated organization service account?
- Are collaborators expected to open the App, and therefore which private/org/public port posture
  applies?
- Is v0 pushed-ref-only, or must Play include uncommitted/local branch state?
- Does Stop retain SQLite/storage indefinitely, for a fixed retention, or until branch archive?
- Should archive/delete synchronously Nuke, enqueue cleanup, or block while cleanup is uncertain?
- Are “Logs” creation diagnostics sufficient for v0, or is remote preview log streaming required?
- Which organization pays for Codespaces and what machine/idle/retention limits are mandatory?

## Rollout, rollback, and cleanup

1. Ship behind an experimental server feature and per-repository opt-in; no default variant.
2. Start with one disposable test repository, sponsor-only actions, private ports, pushed refs, a
   small machine, short idle timeout, and a bounded retention period.
3. Audit safe categories only: tenant-scoped operation ID, action, provider result category, and
   cleanup outcome. Never log repository/ref/name/URL/token/raw provider output under the current
   logging policy.
4. Reconcile inventory before expanding: every remote resource must map to exactly one binding;
   ambiguous or identity-drifted resources freeze rather than mutate.
5. Rollback disables new Start immediately. Existing bindings remain visible for explicit Stop and
   Nuke through the same validating controller. A cleanup job stops verified running resources,
   then deletes them only according to the chosen retention policy.
6. On failed creation after GitHub allocated a resource, persist an orphan-cleanup record. Retry
   with the original sponsor grant. Never guess by URL/name prefix or delete a resource whose
   owner/repository/ref cannot be revalidated.
7. Branch archive/removal should enqueue a generation-fenced Nuke and retain a tombstone until
   GitHub confirms absence. Token revocation creates an actionable cleanup state, not silent
   success.

## Naming

`codespaces-sqlite` is acceptable as the stable configuration key if its description is explicit:
“GitHub Codespaces workspace running the standalone Agor SQLite preview.” It matches the existing
database-oriented variant names and is discoverable.

For UI copy, **“Codespaces + SQLite (experimental)”** is clearer. Avoid plain `codespaces`, which
hides the preview database semantics, and avoid `sqlite-remote`, which hides the provider. A more
architecturally literal key such as `remote-codespaces-sqlite` adds length without resolving a real
ambiguity.
