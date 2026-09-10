# Acceptance scenarios — OpenCode in Agor Cloud

Boundaries: **unit** (colocated Vitest, owner-run), **runtime** (real daemon +
real pinned executable, local), **cloud** (real Cell with compatible executor
image, real reviewed provider key supplied through the secure form). Formal QA
covers every `cloud` scenario; `unit`/`runtime` scenarios are developer
verification and are re-run by QA only where noted.

## Truthful capability states

| ID    | Boundary    | Scenario                                                                                                | Passing observation                                                                                                                                                               |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OC-01 | unit, cloud | Hosted workspace without the operator opt-in opens OpenCode settings                                    | Settings show a permanent capability notice with the structured reason; no Retry button; readiness reads "Not available in this workspace"; no executor process or Job is started |
| OC-02 | unit, cloud | Same workspace: New Session with OpenCode                                                               | Creation is refused with the same reason; no session row is created                                                                                                               |
| OC-03 | unit        | Local `simple`/`sandbox` deployment                                                                     | Behavior identical to today (`native-file` mode, OAuth and API-key connect work, existing 146 + 68 tests pass)                                                                    |
| OC-04 | unit        | Delegated deployment without `persistent-per-user` home, or without command template, or without opt-in | `unsupported` with the specific code; prompt admission refuses                                                                                                                    |
| OC-05 | cloud       | Enabled Cell: settings list                                                                             | Only reviewed providers; API-key connect and disconnect only; OAuth methods absent; `connect-oauth` request is refused with a structured reason                                   |

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

| ID    | Boundary    | Scenario                                                                                   | Passing observation                                                                                                                                                                              |
| ----- | ----------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OC-20 | cloud       | Create session, prompt, use a tool (read/edit in branch), complete                         | Streaming works; permission interception unchanged; task `completed`; session pointer records attempt digest; `attempts/<taskId>/manifest.json` present under the user's executor home namespace |
| OC-21 | cloud       | Second prompt (new Job, possibly another node)                                             | Resumes the same OpenCode session; prior conversation visible to the model; new attempt published; older non-accepted attempts pruned                                                            |
| OC-22 | cloud       | Stop during a long turn                                                                    | Task `stopped` after remote quiescence; no new checkpoint; next prompt resumes the previously accepted checkpoint                                                                                |
| OC-23 | cloud       | Kill the executor pod during the turn (before checkpoint)                                  | Task ends `failed` via heartbeat loss / containment; no publication; resume works from the prior checkpoint                                                                                      |
| OC-24 | cloud       | Kill the executor pod after checkpoint files were written but before the completion patch  | Task ends `failed`; the written attempt is ignored and pruned; resume uses the prior accepted checkpoint                                                                                         |
| OC-25 | unit, cloud | Force-fail an unverified stopping task, then prompt again                                  | New Job resumes accepted checkpoint; a late completion patch from the old Job is refused (terminal state immutable)                                                                              |
| OC-26 | unit        | Accepted digest mismatch / missing attempt file                                            | Turn fails before any provider call with "native state unavailable"; never starts an empty conversation                                                                                          |
| OC-27 | unit, cloud | Full ephemeral disk during checkpoint                                                      | Turn reported `failed` ("checkpoint not durable"); no partial artifact accepted; the scratch root is the `AGOR_OPENCODE_SCRATCH_ROOT` mount, never `TMPDIR`                                      |
| OC-32 | unit        | Completion patch with a native-state pointer from a non-OpenCode or non-managed session    | Refused with a client error before any repository write; no pointer or `sdk_session_id` recorded                                                                                                 |
| OC-28 | unit        | Old executor receives v2 context                                                           | Fails closed at context parsing; task `failed`; no silent legacy behavior                                                                                                                        |
| OC-29 | cloud       | Daemon restart during a running turn                                                       | Executor reconnects; completion and publication still occur exactly once                                                                                                                         |
| OC-30 | cloud       | Two daemon replicas (where the Cell supports HA)                                           | Settings/models served by either replica; no process-affine state; concurrent prompts on one session are serialized by the Session admission row                                                 |
| OC-31 | unit, cloud | HA replica serves `opencode-auth` for tenant T1 while `native-file` deployments stay gated | Managed mode answers 200 inside T1's tenant scope only; a `native-file` deployment in HA still receives the constrained-HA `Unavailable`                                                         |

## Isolation and posture

| ID    | Boundary | Scenario                                                                        | Passing observation                                                                                                                 |
| ----- | -------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OC-40 | cloud    | Inspect a running OpenCode executor pod                                         | Server bound to `127.0.0.1` only; no service-account token; no AWS credentials; per-run server password absent from logs and events |
| OC-41 | cloud    | Wrong branch id / wrong session id / crafted attempt path in a replayed payload | Rejected by existing task-credential and payload validation; no cross-user file access                                              |
| OC-42 | unit     | Repository `opencode.json` with permissive permissions or a plugin              | Agor interception still forces `ask` and disables `task`/`question` (existing behavior)                                             |
| OC-43 | cloud    | User B's Job payload replayed with user A's `namespaceKey`                      | Files resolve under B's own per-user home `subPath`; A's attempts remain unreachable; the accepted-digest check fails closed        |

## Lifecycle and portability

| ID    | Boundary | Scenario                                                                       | Passing observation                                                                                                                      |
| ----- | -------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| OC-50 | cloud    | Workspace deletion with OpenCode sessions                                      | `tenant delete` proves the tenant filesystem absent including attempt directories; user credential rows gone; neighbor tenant unaffected |
| OC-51 | cloud    | Workspace re-home                                                              | Attempts and pointer move together; a prompt after re-home resumes the same conversation                                                 |
| OC-52 | unit     | Import of a session whose accepted digest does not match the archived artifact | Next prompt fails closed with "native state unavailable"                                                                                 |
| OC-53 | cloud    | Deletion callback racing a late executor completion                            | Terminal deletion state wins; no resurrected pointer or files                                                                            |
| OC-54 | unit     | Imported session whose `attemptTaskId` belongs to another tenant's task        | Digest/manifest verification fails closed; no cross-tenant file is read                                                                  |

## Compatibility

| ID    | Boundary    | Scenario                                                                         | Passing observation                                                                                                 |
| ----- | ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| OC-60 | cloud       | Exact deployed revision                                                          | Daemon and executor image carry the same Agor release; OpenCode binary reports 1.14.33; recorded in the QA evidence |
| OC-61 | unit        | Mixed daemon/executor versions                                                   | Fail closed (OC-28); no partial feature                                                                             |
| OC-62 | unit, cloud | Scheduled, forked, or spawned session with OpenCode on an unsupported deployment | Creation fails at occurrence/fork/spawn time with the structured reason; no session row is created                  |
