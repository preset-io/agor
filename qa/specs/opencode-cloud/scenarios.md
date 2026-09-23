# Acceptance scenarios — OpenCode in Agor Cloud

Boundaries: **unit** (colocated Vitest, owner-run), **runtime** (real daemon +
real pinned executable, local), **cloud** (real Cell with compatible executor
image, real reviewed provider key supplied through the secure form). Formal
hosted QA is **paused and has not run**; when authorized, it covers every `cloud`
scenario. `unit`/`runtime` scenarios are developer
verification and are re-run by QA only where noted.

## Truthful capability states

| ID    | Boundary    | Scenario                                                                                                | Passing observation                                                                                                                                                               |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC-01 | unit, cloud | Hosted workspace without the operator opt-in opens OpenCode settings                                    | Settings show a permanent capability notice with the structured reason; no Retry button; readiness reads "Not available in this workspace"; no executor process or Job is started |
| OC-02 | unit, cloud | Same workspace: New Session with OpenCode                                                               | Creation is refused with the same reason; no session row is created                                                                                                               |
| OC-03 | unit        | Local `simple`/`sandbox` deployment                                                                     | Behavior identical to today (`native-file` mode, OAuth and API-key connect work, existing 146 + 68 tests pass)                                                                    |
| OC-04 | unit        | Delegated deployment without `persistent-per-user` home, or without command template, or without opt-in | `unsupported` with the specific code; prompt admission refuses                                                                                                                    |
| OC-05 | cloud       | Enabled Cell: settings list                                                                             | Only reviewed providers; API-key connect and disconnect only; OAuth methods absent; `connect-oauth` request is refused with a structured reason                                   |
| OC-06 | unit, cloud | Enabled Cell: hosted user with no saved key opens settings / new session                                | No provider reported available, no suggested selection; the credential-less provider is not offered; the first prompt fails as a missing credential before any provider call      |

## Credentials

| ID    | Boundary    | Scenario                                                                      | Passing observation                                                                                                                                                                                                                          |
| ----- | ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC-10 | unit, cloud | User A saves an API key for a reviewed provider                               | Presence DTO shows the provider saved; value never appears in any API response, realtime event, log, or task output                                                                                                                          |
| OC-11 | unit, cloud | User B in the same tenant opens settings / prompts their own OpenCode session | B sees no A credential; B's Job env contains no A key; A's session is not promptable by B (existing owner-only refusal)                                                                                                                      |
| OC-12 | cloud       | Tenant T2 user with the same provider id                                      | Independent store; no cross-tenant visibility                                                                                                                                                                                                |
| OC-13 | unit, cloud | Invalid or revoked key, first prompt                                          | Turn fails with the provider "reconnect" message; task `failed`; no checkpoint published; session promptable again                                                                                                                           |
| OC-14 | unit, cloud | Disconnect while a session exists                                             | Next prompt fails truthfully (provider not connected); prior checkpoint untouched                                                                                                                                                            |
| OC-15 | unit        | Projected keys reach the managed server                                       | Each key value and the whole `OPENCODE_AUTH_CONTENT` map are redacted by the managed-server sanitizer in startup output, errors, and stacks; nothing is persisted to `auth.json`; the map never enters `process.env` or `AGOR_USER_ENV_KEYS` |
| OC-16 | unit        | Same user runs a Codex or Claude session                                      | That executor's resolved connection contains no `OPENCODE_*` field; an OpenCode session's connection contains only reviewed `OPENCODE_API_KEY_*` fields                                                                                      |

## Execution, stop, resume

| ID    | Boundary    | Scenario                                                                                   | Passing observation                                                                                                                                                                                                                           |
| ----- | ----------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC-20 | cloud       | Create session, prompt, use a tool (read/edit in branch), complete                         | Streaming/permissions unchanged; completed Task and Session pointer reference the exact sealed store/task/holder object whose DB grant preceded every I/O                                                                                     |
| OC-21 | cloud       | Second prompt (new Job, possibly another node)                                             | Resumes the ledger-selected accepted checkpoint; output has a distinct DB-granted attempt; later healthy launches may retire eligible orphans only after permanent tombstone commit and closed references/writer; no cleanup SLA is assumed   |
| OC-22 | cloud       | Stop during a long turn                                                                    | Holder drains provider and file I/O, closes its input pin/write state, then reports holder-qualified quiescence; no new checkpoint; next prompt resumes prior accepted checkpoint                                                             |
| OC-23 | cloud       | Kill the executor pod during the turn (before checkpoint)                                  | Task may fail, but its input pin remains until exact holder closure is observed; missing/ambiguous evidence stays unknown; resume reads only the accepted checkpoint                                                                          |
| OC-24 | cloud       | Kill the executor pod after checkpoint files were written but before completion            | Task fails; sealed unaccepted output is not promoted or deleted by age; exact container observation may close its holder, and later DB retirement can authorize its exact deletion                                                            |
| OC-25 | unit, cloud | Force-fail an unverified stopping task, then prompt again                                  | New Job resumes accepted checkpoint; a late completion patch from the old Job is refused (terminal state immutable)                                                                                                                           |
| OC-26 | unit        | Accepted digest mismatch / missing attempt file                                            | Turn fails before any provider call with "native state unavailable"; never starts an empty conversation                                                                                                                                       |
| OC-27 | unit, cloud | Scratch volume filled during a turn (cloud) / checkpoint write fails (unit)                | Unit: turn fails ("checkpoint not durable"), nothing published. Cloud: eviction/failure creates no pointer; partial attempt is not deleted absent an exact committed tombstone; scratch remains on the pinned Job-local mount, never `TMPDIR` |
| OC-33 | unit        | Stale Job/collector runs after a newer attempt was accepted                                | Accepted object cannot be retired/deleted; UUID order, stale launch snapshots, missing manifests, and directory enumeration grant no authority                                                                                                |
| OC-34 | unit        | Managed turn on an executor without `AGOR_OPENCODE_SCRATCH_ROOT` or without `node:sqlite`  | Turn fails before any credential read or provider call with the specific message                                                                                                                                                              |
| OC-32 | unit        | Completion patch with a native-state pointer from a non-OpenCode or non-managed session    | Refused with a client error before any repository write; no pointer or `sdk_session_id` recorded                                                                                                                                              |
| OC-28 | unit        | Old managed executor/context or legacy/uncertain home reaches v3 admission                 | Fails closed before managed I/O or pointer publication; legacy bytes remain untouched and no implicit importer/reset occurs                                                                                                                   |
| OC-29 | cloud       | Daemon restart during a running turn                                                       | Executor reconnects; completion and publication still occur exactly once                                                                                                                                                                      |
| OC-30 | cloud       | Two daemon replicas (where the Cell supports HA)                                           | Settings/models served by either replica; no process-affine state; concurrent prompts on one session are serialized by the Session admission row                                                                                              |
| OC-31 | unit, cloud | HA replica serves `opencode-auth` for tenant T1 while `native-file` deployments stay gated | Managed mode answers 200 inside T1's tenant scope only; a `native-file` deployment in HA still receives the constrained-HA `Unavailable`                                                                                                      |

## Isolation and posture

| ID    | Boundary    | Scenario                                                                                                                           | Passing observation                                                                                                                                                                                                                              |
| ----- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OC-40 | cloud       | Inspect a running OpenCode executor pod                                                                                            | Server bound to `127.0.0.1` only; no service-account token; no AWS credentials; per-run server password absent from logs and events                                                                                                              |
| OC-41 | cloud       | Wrong branch/session/task/store/holder or crafted path in a replayed payload                                                       | DB grant and immutable exact locator binding reject mismatches before I/O; payload paths never select filesystem objects; no cross-user/tenant read or delete                                                                                    |
| OC-42 | runtime     | Repository/ancestor/home OpenCode config with a plugin, local MCP command, or custom provider endpoint; inherited config selectors | Pinned executable loads none of the excluded configuration, plugin/MCP markers remain absent, and Agor permissions remain authoritative; attached local MCP commands fail before spawn                                                           |
| OC-43 | cloud       | User B's Job payload replayed with user A's `namespaceKey`                                                                         | Caller-scoped per-user home plus DB owner/session/store binding rejects the replay; a payload digest cannot select or authorize another user's checkpoint                                                                                        |
| OC-44 | cloud       | Two Pods for one run; holder B admitted, then Pod A terminates                                                                     | Per-Pod UID + Job UID + exact `executor` container ID/image/restart tuple is observed; A's evidence cannot close B's holder pin; missing or conflicting tuples remain unknown                                                                    |
| OC-45 | unit, cloud | Native-state observer contends with generic executor recovery or has many older runs                                               | Observer is independent from lifecycle reconciliation and bounded by requests/time; eligible runs are prioritized inside the pre-TTL window; incomplete work is retried and never treated as closure; TTL capture is best-effort, not guaranteed |
| OC-46 | cloud       | `/finish` arrives before process exit, or observer is unavailable past Job TTL                                                     | `/finish`, terminal status, 404, TTL, and absent evidence do not close pins; only exact terminated-container evidence can close the matching holder; otherwise state remains pinned/unknown                                                      |

## Lifecycle and portability

| ID    | Boundary | Scenario                                                                       | Passing observation                                                                                                                                         |
| ----- | -------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC-50 | cloud    | Workspace/tenant/user/branch/session deletion with affected OpenCode state     | Rejected with `opencode_native_state_handoff_required` before the first destructive effect; dry-run identifies blocker; unaffected tenants remain untouched |
| OC-51 | cloud    | Workspace re-home or export of affected native state                           | Rejected before source deletion/export completion; no claim that pointer and tenant files can be moved safely                                               |
| OC-52 | unit     | Import archive/restore target contains affected native state                   | Rejected before filesystem materialization or target mutation; archives with no native-state payload retain prior behavior                                  |
| OC-53 | cloud    | A deletion callback races late executor completion while affected state exists | Delete is rejected before effects with the handoff diagnostic; neither callback nor completion may erase/restore ledger authority                           |
| OC-54 | unit     | Legacy/imported session contains an accepted native pointer or foreign attempt | Legacy/uncertain state fails closed before read; no cross-tenant restore, pointer reuse, or silent migration occurs                                         |

## Compatibility

| ID    | Boundary    | Scenario                                                                         | Passing observation                                                                                                                                                  |
| ----- | ----------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC-60 | cloud       | Exact deployed revision                                                          | Daemon and executor image carry the same Agor release; OpenCode binary reports the pinned `OPENCODE_VERSION` (1.18.31 at this revision); recorded in the QA evidence |
| OC-61 | unit        | Mixed daemon/executor versions                                                   | Fail closed (OC-28); no partial feature                                                                                                                              |
| OC-62 | unit, cloud | Scheduled, forked, or spawned session with OpenCode on an unsupported deployment | Creation fails at occurrence/fork/spawn time with the structured reason; no session row is created                                                                   |

### Credential-free composition and compatibility regressions

- Scheduled OpenCode occurrences use the same deployment gate as interactive
  creation. Manual and cron paths reject missing opt-in or persistent homes
  before creating a row, preserve the structured reason in the refusal log,
  and admit a properly configured hosted occurrence (fake prompt delivery).
  Real session creation and manual/cron scheduling replay the launch-enabled
  provisioning/Helm configuration (`per_branch`) and select `execution_home` for
  OpenCode, whether or not another tool has adopted the branch. Existing branch
  intent, inherited lineage refusal, other tools' branch homes, and owner-only
  launch admission remain unchanged.

- Hosted execute-handler composition: real capability/admission/launch contributions
  with a fake templated launcher admit repeated turns and concurrent same-owner
  sessions without a daemon-local containment slot. Local native-file containment
  and foreign-actor refusal remain enforced. This is not remote Job/provider QA.
- A session pinned to provider A with only provider B saved fails as missing
  credentials before scratch preparation or provider startup; only A's key is
  projected when present. Session recovery checks the selected provider.
- Checkpoint schema v3 records the store ID and pinned OpenCode version. Legacy
  v1/v2 or a different runtime version refuses restore without replacing
  accepted state.
- Missing, empty, unrelated-schema and wrong-session SQLite files cannot publish.
- Noncanonical uppercase session/task/store UUIDs are rejected before path
  creation; UUID order is never used for retirement/deletion eligibility.
