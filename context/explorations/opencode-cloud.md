# OpenCode in Agor Cloud — design contract

> Status: **Draft, implementation in progress, QA pending.** Canonical design for
> running the OpenCode agentic tool inside Agor Cloud (hosted, delegated,
> ephemeral executor Jobs). The public runtime (`preset-io/agor`) owns every
> behavior described here; Agor Cloud (`preset-io/agor-cloud`) owns only
> Kubernetes realization and references this document. Acceptance scenarios
> live in [`qa/specs/opencode-cloud/`](../../qa/specs/opencode-cloud/README.md).

## 1. Problem

Hosted workspaces offer OpenCode in the agent picker, but every hosted path
fails: provider settings throw a generic "could not be loaded" error with a
Retry button, readiness reports "Status unavailable", session creation is
accepted, and the first prompt is refused with a `BadRequest`. Three
independent runtime guards cause this and must stay in place until the
capabilities they protect exist:

| Guard                                   | Owner                                                                                                     | Why it exists                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Hosted tenancy / delegated mode refusal | `packages/agentic-tool-opencode/src/daemon/credential-namespace.ts` (`assertOpenCodeNativeAuthSupported`) | Native credentials and state live in a daemon-local XDG home; hosted daemons have no per-user home boundary |
| Templated transport refusal             | `execution-admission.ts`; `startInteractiveExecutor` / `startContainedExecutorCommand`                    | Provider operations promise local process containment; a remote launcher cannot prove it                    |
| Branch SDK-home refusal                 | `apps/agor-daemon/src/branch-sdk-home.ts` (`branchSdkHomeUnsupportedReason`)                              | The XDG data home mixes credentials with relocatable state                                                  |

Removing the guards would run OpenCode with the daemon pod's home as its
state root, no credential delivery, and a live SQLite WAL on the tenant network
filesystem. This document specifies the smallest safe first release instead.

## 2. Scope of the first release

**In scope**

- Owner-only OpenCode sessions in hosted (`required_from_auth`) workspaces
  that execute through the delegated ephemeral executor Job.
- API-key providers only, from a reviewed static provider/model list
  (`packages/agentic-tool-opencode/src/shared/known-models.ts`).
- Truthful unsupported/saved/connected/failed states in settings, readiness,
  session creation, and prompting.
- Durable native conversation state across executor Jobs, with an explicit
  recovery-point semantic (section 6).
- Stop, resume, disconnect, and deletion/portability of the new state.

**Explicitly out of scope (deferred, guarded fail-closed)**

- OAuth / subscription login in hosted mode (`connect-oauth` is refused with a
  structured reason; local mode keeps its existing OAuth path).
- Cross-user prompting, shared-session prompting, fork/adoption of OpenCode
  native state (`supportsSessionFork` remains `false`; spawn creates a fresh
  native session).
- Per-branch SDK home for OpenCode (branch-scoped sessions still refuse
  OpenCode; the reason text becomes capability-specific).
- Arbitrary plugins, local MCP `command` servers, custom provider endpoints,
  and remote auxiliary executor operations (discovery/verification Jobs).
- Any change to other agents' branch-home policy, Cloud's delegated execution
  mode, or the executor Job's network posture.

## 3. Trust and resource ownership

| Resource                                                                                              | Owner / boundary                                                                                                                                                                                                                                                                                                                                                                                           | Persistence                                              | Delete / export                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider API key                                                                                      | Tenant + user + tool. Existing encrypted per-tool credential store `users.data.agentic_tools.opencode` (AES via `AGOR_MASTER_SECRET`, `apps/agor-daemon/src/services/users.ts`)                                                                                                                                                                                                                            | Database row                                             | Deleted with the user row / tenant rows (existing)                                                                                                                                                         |
| Projected credential at run time                                                                      | Task-scoped executor Job only. The executor pulls the session owner's OpenCode connection through the existing task-scoped daemon read (`config/resolve-api-key`, executor runtime JWT bound to the task), exactly as other SDK handlers pull their provider connection, and hands it to OpenCode as `OPENCODE_AUTH_CONTENT`. It never travels in the executor payload Secret or the generic user env loop | Process memory of one Job; never written to disk by Agor | Nothing to delete                                                                                                                                                                                          |
| Live native database (`opencode.db` + WAL), logs, state locks, cache, generated config, git snapshots | One executor Job, one task. All four `XDG_*` roots and `OPENCODE_DB` live on the Job's local scratch (`emptyDir`-backed `/tmp/agor-opencode/<taskId>`)                                                                                                                                                                                                                                                     | Ephemeral                                                | Dies with the Job                                                                                                                                                                                          |
| Published native checkpoint                                                                           | Session lineage. Immutable per-attempt directory under the caller's persistent executor home on the tenant claim: `$HOME/.local/share/agor/opencode/<namespaceKey>/sessions/<agorSessionId>/attempts/<taskId>/`                                                                                                                                                                                            | Tenant filesystem (FSx/EFS)                              | Inside the tenant root, so tenant delete / export / import / re-home cover it with no new lifecycle code; every attempt directory other than the accepted one is pruned at the next launch of that session |
| Accepted checkpoint pointer                                                                           | Session row (`sessions.data.sdk_native_state`), written only by the task terminal transition                                                                                                                                                                                                                                                                                                               | Database                                                 | Moves with the session rows                                                                                                                                                                                |
| OpenCode server password                                                                              | One Job, random per run                                                                                                                                                                                                                                                                                                                                                                                    | Process env                                              | n/a                                                                                                                                                                                                        |

Physical isolation of the persistent files is Cloud's per-user home `subPath`
(`home/cp-<hash(userId)>`), not the namespace key: a payload replayed with
another user's `namespaceKey` still resolves under the caller's own home and
cannot reach the other user's attempts. The namespace key only separates
tenants/users that could share one Unix home in local deployments.

Identity rules:

- `namespaceKey = sha256(["agor-opencode-v1", tenantId, subjectUserId])`
  (existing). The subject is the session owner, who is also the only allowed
  prompter (existing owner-only check stays).
- Knowing a session id, attempt id, or namespace key grants nothing; every
  read/write is authorized by the task credential and the row-locked task
  transition.
- The executor never receives an absolute daemon-side path. It receives a
  logical context (`namespaceKey`, `agorSessionId`, `taskId`, accepted
  checkpoint digest) and resolves paths under its own `$HOME`, which Cloud
  already mounts as the immutable per-user home (`/home/cp-<hash>`).
- Promise: cross-user and cross-tenant isolation plus controlled delivery. Not
  promised: protecting the owner's key from code the owner runs in their own
  Job (that requires a provider broker; deferred).

## 4. Credential authority

Exactly one authority applies per deployment, selected by the capability
resolver (section 8), never both:

| Authority            | Deployment                                                                                                    | Mechanism                                                                                                                                                                                                    | Status    |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `native-file`        | Local `simple`/`sandbox` without executor command template                                                    | Existing: `auth.json` in the daemon-owned namespace, mutated by contained local executor operations, OAuth supported                                                                                         | Unchanged |
| `managed-projection` | Hosted + delegated + templated executor + `executor_storage.user_home: persistent-per-user` + operator opt-in | Keys stored encrypted in `users.data.agentic_tools.opencode`; the executor pulls them through `config/resolve-api-key` and projects `OPENCODE_AUTH_CONTENT`; no `auth.json`, no daemon-side OpenCode process | New       |

`managed-projection` facts established from the pinned OpenCode 1.14.33 source:
`Auth.all()` returns the parsed `OPENCODE_AUTH_CONTENT` map when set, so
readiness and `provider.list().connected` see the key; API keys never refresh,
so the "stale snapshot after refresh" hazard applies only to OAuth, which is
excluded. A malformed value falls through to the (absent) file, which reads as
"no credential" and fails the first prompt with the truthful provider error.

Storage shape: OpenCode becomes an ordinary provider-connection tool with one
static, env-safe field per reviewed key-bearing provider
(`OPENCODE_API_KEY_ANTHROPIC`, `OPENCODE_API_KEY_OPENAI`,
`OPENCODE_API_KEY_KIMI_FOR_CODING`), declared in
`PROVIDER_CONNECTION_FIELDS`. This reuses the existing tenant resolution
policy, the presence DTO (`AgenticToolsStatus`), per-field delete, and the
missing-credential classification without any read-modify-write of a JSON
blob. Workspace-level (tenant) OpenCode connections are not offered in the
first release (`TENANT_PROVIDER_CONNECTION_FIELDS.opencode` is empty). The
generic user env loop never sees these fields because prompt launch does not
pass a tool to it; the OpenCode executor handler alone converts the pulled
connection into the `OPENCODE_AUTH_CONTENT` map, restricted to the reviewed
list, keeps it out of `process.env` and `AGOR_USER_ENV_KEYS`, and registers
each key value individually with the managed-server sanitizer (whose env-name
pattern also learns the `_CONTENT` suffix).

Saved keys are **saved, unverified**. Verification happens on the first
prompt: `assertExplicitModelAvailable` (existing) checks the provider is
connected and the model exists; a provider rejection surfaces as the existing
"reconnect provider" failure. No verification Job is spawned from settings.

## 5. Execution protocol (runtime ↔ executor ↔ Cloud)

Nothing new is added to the Cloud executor-run API. The existing chain is
reused unchanged: daemon `executor_command_template` → `agor-cloud-executor-launch`
→ `/executor-runs/start` + `/execute` → Job with the persistent per-user home
→ `agor-executor --stdin`. OpenCode-specific data travels inside the existing
executor payload:

```jsonc
// executorPayload (daemon → executor), OpenCode addition
"agenticToolContext": {
  "version": 2,
  "mode": "managed-projection",          // or "native-file" with the legacy dataHome
  "namespaceKey": "<sha256>",
  "agorSessionId": "<uuid>",
  "taskId": "<uuid>",
  "accepted": null | {                    // accepted checkpoint to resume from
    "attemptTaskId": "<uuid>",
    "openCodeSessionId": "ses_…",
    "digest": "sha256:<hex>",
    "publishedAt": "<iso>"
  }
}
```

The payload carries no credential. The executor pulls the owner's connection
through `config/resolve-api-key` (tool `opencode`) after claiming the task and
sets `OPENCODE_AUTH_CONTENT` only on the managed server's environment; the
existing `OPENCODE_CONFIG_CONTENT` / `OPENCODE_PERMISSION` interception values
are set by the executor as today. Old executors that only understand
`{ dataHome }` fail closed on the v2 context (parse error → task failed), which
is the intended mixed-version behavior; daemon and executor images are one
release.

Executor turn (managed-projection mode), all inside `OpenCodeTool.runTurn`:

1. Create a Job-private scratch root `<scratch>/<taskId>/` and point
   **all four** `XDG_*` roots and `OPENCODE_DB` at it. `<scratch>` is
   `AGOR_OPENCODE_SCRATCH_ROOT` when set (Cloud pins it to the `emptyDir`
   mount `/tmp/agor-opencode`), otherwise the process temp directory;
   `TMPDIR` is never consulted, and the executor's payload-environment boundary
   refuses a user-defined `AGOR_OPENCODE_SCRATCH_ROOT`, so neither can redirect
   live native state onto the network filesystem. Nothing OpenCode writes
   during the turn touches the network filesystem: logs, the `mkdir`-based
   state locks (whose staleness detection depends on mtime and would otherwise
   stall the next Job after a kill), cache, generated config, and the git
   snapshot object store are all Job-local. Cross-turn OpenCode "revert" is
   therefore not offered; Agor's own diff enrichment does not depend on it.
   The persistent home holds only `sessions/<agorSessionId>/attempts/`.
2. If `accepted` is set: copy `attempts/<attemptTaskId>/opencode.db` to the
   scratch DB, verify size and sha256 against `manifest.json` and the payload
   digest. Mismatch or absence → fail the turn before any provider call
   ("native state unavailable"); never fall back to an empty database.
3. Start the loopback server (existing `startManagedOpenCodeServer`), resume
   `accepted.openCodeSessionId` or create a new session, run the prompt with
   the existing permission interception. In managed mode the executor does
   **not** patch `sdk_session_id` at native-session creation; the id is
   published only with the accepted checkpoint.
4. On a successful turn: close the server (existing bounded SIGTERM/SIGKILL),
   then run the **durability barrier**: open the scratch DB with `node:sqlite`
   (available unflagged in the executor image's Node 22.13),
   `PRAGMA wal_checkpoint(TRUNCATE)`, `PRAGMA integrity_check`, close; write
   `attempts/<taskId>/opencode.db` via temp file + `fsync(file)` + `rename`,
   then `manifest.json` (sha256, bytes, `openCodeSessionId`, OpenCode version,
   task id) the same way, then `fsync(directory)`. Any failure → the turn is
   reported **failed** ("checkpoint not durable"); nothing is published.
5. Report completion to the daemon with the attempt pointer in a new
   executor-managed task field (`native_state_attempt`, added to the executor
   patch allowlist). The task terminal transition takes the **Session lock
   first, then the Task lock** (the repository's documented order, shared with
   `settleTermination`, so completion and Stop/heartbeat-loss settlement on
   one task cannot deadlock) and writes `sessions.data.sdk_native_state =
{ attemptTaskId, digest, openCodeSessionId, publishedAt }` plus
   `sdk_session_id` in the same transaction as `status = completed`. Before
   that transition the daemon re-resolves the capability resolver and admits a
   pointer only from an executor-authenticated patch on a task whose session
   uses OpenCode in `managed-projection` mode; any other executor is refused
   with a client error and nothing is written. A terminal
   task (stopped, failed, force-failed) never accepts a pointer, so a stale
   executor's artifact is never referenced. This transition is the atomic,
   authorized publication decision.
6. On failure, Stop, or abort: no publication. The scratch root is discarded
   with the Job. The session resumes from the previously accepted checkpoint.
7. Before step 2 the executor deletes every attempt directory of this session
   except the accepted one. Live Jobs for one session are serialized by the
   Session admission row, so an orphan from a lost completion (checkpoint
   written, completion patch never accepted) is removed by the next launch and
   a stale Job re-creating its own directory is harmless.

Cloud-side realization (agor-cloud): no new endpoint, table, or storage class.
The Job template already provides the immutable per-user home; an `emptyDir`
with a `sizeLimit` is added at `/tmp/agor-opencode` so ENOSPC during checkpoint
fails the turn instead of publishing a partial file (the workspace runtime
config's ephemeral-storage limit is not guaranteed on legacy rows). Network
posture is unchanged (OpenCode binds `127.0.0.1` only; the pod has no
service-account token). Cell enablement is an operator config value rendered
into the daemon config (section 8).

## 6. Storage decision: checkpointed local DB versus block-backed live DB

Measured with the pinned `opencode` 1.14.33 executable (local, credential-free,
`serve` + session API; see `qa/specs/opencode-cloud/proof-log.md`):

| Question                                                                | Result                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does `OPENCODE_DB` move only the database?                              | Yes. `auth.json`, `log/`, config `.gitignore`, and state lock dirs stayed under the XDG roots; only `opencode.db{,-wal,-shm}` moved.                                                                                                                          |
| Is committed data durable across `SIGKILL` of `serve`?                  | Yes. Session created, server killed, restart on the same files: `session.get` 200.                                                                                                                                                                            |
| Is a copy of only `opencode.db` usable?                                 | **No.** Before checkpoint the main file was 4 KB with no schema; all rows were in the WAL (206 KB).                                                                                                                                                           |
| Is `db + wal` copy usable?                                              | Yes (row visible via sqlite3).                                                                                                                                                                                                                                |
| Does `wal_checkpoint(TRUNCATE)` after close yield one publishable file? | Yes. WAL → 0 bytes, `integrity_check` ok, resume from the single copied file: `session.get` 200.                                                                                                                                                              |
| Does SQLite fence a second writer?                                      | **No.** Two servers on one local DB both created sessions (2 rows). WAL is additionally unsupported on NFS.                                                                                                                                                   |
| Startup cost                                                            | ~1.1–1.4 s per `serve` readiness (local, warm).                                                                                                                                                                                                               |
| Marker quirk                                                            | With `OPENCODE_DB` outside the data root, every launch prints the one-time migration banner because the marker check reads `<data>/opencode.db`; the migration is a no-op without a `storage/` directory. Cosmetic; `OPENCODE_SKIP_MIGRATIONS` is not needed. |

Comparison:

|                     | A. Block PVC per session (RWOP)                                                                                                                     | B. Local DB + immutable checkpoint + DB-authorized publication (**selected**)                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Live WAL location   | Block volume (supported)                                                                                                                            | Job-local disk (supported)                                                                                               |
| Writer fence        | Attach controller only if the CSI honours RWOP; not a fence on `ontap-nas`/EFS; `gp2-enc-ebs` binds immediately to one AZ and pins every resume Job | Publication is refused for terminal tasks by the existing row lock; a stale Job can only write its own attempt directory |
| Failed/stopped turn | Keeps partial native rows Agor calls failed                                                                                                         | Loses that turn's native rows; conversation returns to the last accepted checkpoint                                      |
| Lifecycle           | New volume object per session: delete, export, re-home, quota all need new code                                                                     | Files sit in the tenant root already covered by delete/export/import/re-home                                             |
| Per-turn cost       | Attach/detach per Job, zone pinning, attachment limits                                                                                              | Copy ≤ tens of MB in/out per turn; checkpoint ~ms                                                                        |
| New infrastructure  | Storage class validation, RWOP support, cost model                                                                                                  | None                                                                                                                     |

Selected: **B**. Recovery-point semantic: a turn's native state becomes durable
only when Agor records the turn as completed. External effects of a failed or
stopped turn (tool writes, commits, API calls) are **not** rolled back and are
**never** replayed automatically; the transcript in Agor keeps whatever was
streamed. This is the same rule as today's runtime invariant "supervision does
not imply prompt replay or exactly-once external effects".

Not proven locally and deliberately left to Cloud QA: fsync semantics on the
real FSx ONTAP / EFS mounts, cross-node resume, ephemeral-storage pressure
(full disk during checkpoint must fail the turn, not publish), and Job
replacement while a previous Job is unreachable.

## 7. Lifecycle, cancellation, and fencing

- **Stop**: existing socket-first termination; the executor aborts the OpenCode
  session, closes the server, reports quiescence. No checkpoint is published.
  Templated containment stays "remote executor quiescence"; the OpenCode
  descriptor's `unverifiedTerminationReason` continues to mark server-side
  termination as unverified. Because a stale Job cannot publish, force-fail
  (`STOP` confirmation) is safe to use to unblock the session; the next prompt
  launches a new Job that resumes the accepted checkpoint.
- **Stale writer**: the fence is the task terminal state, not storage. A late
  completion patch from an old Job is refused by the immutable terminal state;
  its artifact directory is pruned at the next launch (every attempt other than
  the accepted one is removed). Because all live native files are Job-local,
  a stale Job that outlives a force-fail can only write its own scratch and its
  own attempt directory; it cannot touch the accepted checkpoint or the new
  Job's files. Its external effects (tool calls, commits) are not fenced; that
  is the documented limit of force-fail for every tool.
- **Daemon death after launch, before executor claim**: unchanged (durable
  `dispatching` intent, reconciler warning, no automatic re-enqueue).
- **Node partition**: unchanged; the session remains non-promptable until
  quiescence or force-fail. No replacement writer is authorized by timeout.
- **Delete / revoke / offboard**: keys go with the user row; artifacts go with
  the tenant filesystem root; the Job's payload Secret goes with the Job.
  Revocation observed by heartbeat (`authorization_revoked`) contains the Job as
  for any other tool.
- **Portability / re-home**: artifacts and pointer move together (tenant files
  - tenant rows). A restored session whose accepted artifact digest does not
    match fails closed on the next prompt instead of resuming a different state.
- **HA / two daemon replicas**: managed-projection has no daemon-local native
  state, so `opencode-auth`/`opencode-models` in that mode are database-backed
  and may be served by any replica; the constrained-HA gate becomes
  mode-conditional and keeps rejecting `native-file` in HA. Two replicas racing
  the same session are already fenced by the Session admission row.

## 8. Capability resolver and truthful UI

One resolver in `packages/agentic-tool-opencode/src/daemon/capabilities.ts`
replaces the scattered guards and returns:

```ts
type OpenCodeCapabilities =
  | { mode: 'native-file'; unixUserMode: 'simple' | 'sandbox' }
  | { mode: 'managed-projection' }
  | { mode: 'unsupported'; reason: { code: OpenCodeUnsupportedCode; message: string } };
```

`managed-projection` requires all of: `multi_tenancy.mode === 'required_from_auth'`,
`execution.unix_user_mode === 'delegated'`, `execution.executor_command_template`
set, `execution.executor_storage.user_home === 'persistent-per-user'`, and the
operator opt-in `agentic_tools.opencode_hosted_native_state: 'checkpointed'`
(default absent → unsupported with code `hosted_native_state_disabled`).
`native-file` requires the existing local conditions. Anything else is
`unsupported` with a stable code (`hosted_tenancy`, `delegated_execution`,
`templated_transport`, `persistent_user_home_required`, `hosted_native_state_disabled`).

Consumers (all read the same resolver): `opencode-auth` find/create/remove,
`opencode-models` find, session creation and tool switch (`sessions.ts`), task
admission (`admitExecutor`), executor launch (`getExecutorLaunch`), the task
completion publication gate (`tasks.ts`), the executor credential resolver
(`config/resolve-api-key`, which serves a tool only its own reviewed
provider-connection fields), and the settings/readiness UI. The tenant policy
for OpenCode accepts only `user_required` or `user_preferred`; tenant-shared
provider keys are refused because the tool has no tenant-level fields. `opencode-auth.find` returns a 200 response with
`runtime: 'unsupported'` and the structured reason instead of throwing; the UI
renders a permanent capability notice without Retry, readiness shows
"Not available in this workspace", and New Session rejects OpenCode with the
same reason. In `managed-projection` the settings list shows only reviewed
providers with API-key connect/disconnect, presence "Saved (verified on first
prompt)", and the isolation notice reads "Keys are stored encrypted for your
account and delivered only to your own executor runs".

## 9. Invariants

1. Guards are removed only by the resolver granting a mode; every consumer
   fails closed on `unsupported`.
2. No absolute daemon path or credential value crosses the executor payload
   except inside `env` through the existing per-tool credential path.
3. A live SQLite WAL never resides on the tenant network filesystem.
4. Only the task terminal transition publishes a checkpoint pointer; terminal
   tasks are immutable; the executor never overwrites an accepted artifact.
5. A turn is reported completed only after its checkpoint is verified and
   fsynced.
6. Missing or mismatched accepted state fails the turn; it never silently
   starts an empty conversation.
7. Owner-only prompting, permission interception, and MCP tool gating are
   unchanged.
8. Nothing here auto-replays prompts or claims exactly-once external effects.
9. Local `native-file` behavior and every other agent's branch-home policy are
   unchanged.

## 10. Implementation sequence (slices, one branch per repository)

1. **Truthful unsupported behavior** (runtime): capability resolver, structured
   unsupported reason through `opencode-auth`/`opencode-models`, session
   creation/tool-switch refusal, UI notice/readiness without Retry. Ships
   independently.
2. **Credential store and projection** (runtime): static per-provider fields in
   the encrypted per-tool store, OpenCode as a provider-connection tool,
   settings connect/disconnect in managed mode, executor pull and projection
   to `OPENCODE_AUTH_CONTENT`, redaction coverage, mode-conditional HA gate.
3. **Native-state checkpointing** (runtime): v2 executor context, executor
   copy-in/verify, durability barrier, publication through the task terminal
   transition, session pointer, prune, executor patch-field allowlist.
4. **Cloud realization** (agor-cloud): scratch `emptyDir`, operator opt-in
   value rendered into daemon config only for tested Cells, doc/runbook updates
   referencing this contract, executor Job template tests.
5. **Independent code/security review**, remediation, then formal QA (paused
   pending explicit continuation).

## 11. Proof

Developer checks (owner): colocated Vitest for the resolver, store/projection,
checkpoint/publication (including terminal-task refusal, digest mismatch,
disk-full failure via injected fs seam), executor context parsing (v1 vs v2),
UI rendering of unsupported/saved states; typecheck and lint in both repos;
Cloud pod-template tests for the scratch volume and config rendering; the local
executable spike above (retained as `qa/specs/opencode-cloud/proof-log.md`).

Formal QA (not run; requires Richard's continuation): the scenarios in
`qa/specs/opencode-cloud/` against a real Cell with the compatible executor
image, two tenants, two users in one tenant, two daemon replicas where
supported, a real reviewed provider key supplied through the secure form,
crash/kill points, full disk, node partition, deletion race, and exact deployed
revision attestation.

## 12. Resolved decisions and assumptions

- Owner-only, API-key-first, reviewed static model list; no auxiliary
  discovery Jobs (approved plan and reconciliation).
- Credential authority in hosted mode is the existing encrypted per-tool user
  store, not `auth.json`: the hosted daemon has no filesystem path to a user's
  executor home (it resolves only a delegated home key), and Cloud's per-user
  home segment is Cloud-private. This keeps the runtime Cloud-agnostic and
  reuses the store that already holds Claude/Codex/Gemini API keys.
- Storage: option B (section 6) after local proof; no per-session volume.
- Inherited agent-pod egress risk (Cloud isolation record R1/R2) is disclosed,
  not fixed here; the OpenCode server is loopback-only and the pod has no
  service-account token.

## 13. Decisions still owned by Richard (with recommended defaults)

1. **Recovery-point semantic** — accept "a failed or stopped turn loses that
   turn's native rows, external effects are neither rolled back nor replayed".
   Recommended: accept; it is the cleaner semantic and matches the runtime's
   existing supervision invariant. Implementation proceeds on this default;
   choosing A instead changes slices 3–4 materially.
2. **Reviewed provider set for the beta** — recommended: `anthropic` and
   `openai` (API key) from the pinned list; `opencode` (Zen, credential-less)
   and `kimi-for-coding` stay listed but can be disabled per Cell.
3. **Saved-unverified credential state** — recommended: accept, verify on
   first prompt.
4. **Egress disclosure** — recommended: note the inherited agent-pod egress
   risk in the beta terms rather than blocking on the FQDN allowlist work.

## 14. Open technical unknowns (do not change accepted behavior)

- Ephemeral-storage `sizeLimit` for the scratch root (DB, WAL, logs, snapshot
  objects, copy buffers); the pod-template test pins whatever value QA
  confirms.

## 15. Independent design challenge (2026-09-10)

A fresh, read-only adversarial review of sections 4–8 found no launch blocker
and three high findings, all adopted above: publication must take the Session
lock before the Task lock and carry the pointer in an executor-managed task
field (section 5 step 5); credentials must use the executor's task-scoped pull,
not the generic user env loop, with static env-safe field names (section 4);
and the projected keys must be registered individually with the sanitizer
(section 4). Medium findings adopted: all `XDG_*` roots on Job-local scratch,
"prune all but accepted", the Cloud `emptyDir` `sizeLimit`, and the
mode-conditional HA gate. Scenario additions from the review are in
`qa/specs/opencode-cloud/scenarios.md` (OC-16, OC-31, OC-43, OC-54, OC-62).
The reviewer did not run code and did not verify NFS or executor-image
behavior; those remain QA items.
