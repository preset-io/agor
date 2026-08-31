# Branch and board point-read APM investigation (2026-08-28)

## Scope and evidence boundary

This investigation was opened for production APM rates of approximately
30,000 `branches.get` resources/hour and 10,000 `boards.get` resources/hour.
It covers the deployed source, every production call family, Feathers tracing
semantics, deterministic UI and service call counts, RBAC/RLS boundaries, and
bounded fixes.

No Datadog API, Datadog MCP server, or read-only Datadog credential was
available to this session. The deployed health endpoint was available, but it
does not expose trace samples or the dashboard query definition. Consequently:

- source and test statements below are **confirmed**;
- arithmetic projections against the reported rates are marked **inference**;
- no production tenant identifiers, resource identifiers, names, payloads,
  trace headers, or secrets were read or recorded; and
- the `boards.get` production split is deliberately left unattributed until the
  low-cardinality tag added here is deployed or existing traces are queried.

This is not a claim that all 30,000/10,000 reported hits are sampled spans,
indexed spans, or APM trace-metric estimates. The exact Datadog graph measure
and sampling/extrapolation settings must be captured with the follow-up query.

## Exact revisions

| Role                                              | Revision                                                                | Authored   | Subject                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| Investigated `main` / `origin/main` / branch base | `5d19fbc6d72f36c9672010396510b35f1f8afbb9`                              | 2026-08-27 | `fix: allow HA Codex auth with delegated user homes (#2575)`            |
| Deployed sandbox health response                  | `6a0074c1351f0a6d65540267dc7783b06cf7b258` (health reports `6a0074c13`) | 2026-08-26 | `feat(apm): trace postgres.js queries via Drizzle session shim (#2571)` |

Both revisions were reverified at completion on 2026-08-28. The deployed
revision is an ancestor of investigated `main`. The health response reports
Agor 0.25.2, build time `2026-08-27T06:00:20.945Z`, and
`realtime.required=false`, so this deployment uses the standalone
`HealthMonitor`, not the distributed HA health observer.

Relevant deployed changes are:

- `21363788b...` / #2518 added fenced health observations and the final
  canonical branch reload;
- `e57798a47d54b50bccf19ae7386132688464af6e` / #2520 added tenant-isolated
  realtime routing and repository-backed publication reauthorization;
- `714ea498df84856a7e1f984fa4ff8bf96ebe5ce3` / #2567 hardened authorized board
  presence; and
- `194dc722c471ee51417f1f7303b0946283b55d64` / #2570 made Feathers service
  invocations visible as `feathers.request` APM spans.

The high-rate health behavior predates #2520/#2567. #2518 increased a normal
active observation from two to three wrapped branch gets; #2570 then made all
three visible under the same APM resource.

## Executive result

### Confirmed dominant branch amplifier

The standalone environment monitor polls every five seconds. Before this
change, one ordinary observation of one active environment made exactly three
registered Feathers `branches.get` invocations:

1. `HealthMonitor` preflighted current lifecycle state with
   `branchesService.get`;
2. the direct custom `BranchesService.checkHealth()` call performed its initial
   `this.get`; and
3. claim-skip, aborted-observation, and successful-commit paths performed a
   final/revalidation `this.get`.

A direct custom service method is not itself Feathers-wrapped, but its
`this.get()` resolves the registered standard method and does run app/service
around hooks. An isolated Feathers/SQLite receipt proves the deployed shape is
three wrapped gets and the new automatic shape is zero.

Steady state is:

```text
12 observations/minute/environment
× 3 branches.get spans/observation
= 36 branches.get spans/minute/environment
= 2,160 branches.get spans/hour/environment
```

**Inference:** 30,000/hour divided by 2,160/hour is 13.9 average active local
environments. This is a strong numerical match, but must be confirmed by the
Datadog five-second clustering and parent/root-span query below.

The fix does not remove current-state or post-observation fencing. Automatic
checks still make the two required canonical tenant-scoped branch loads; they
no longer manufacture Feathers requests, and the redundant preflight plus an
entirely unused `repos.get` are removed.

### Board point reads

There is no board point-read polling loop. A normal cold board tab performs two
`boards.get` calls:

1. one full-board read in `useAgorData` after the lean global board list; and
2. one server-side cursor-room admission read for that socket/board.

Idle presence heartbeats, cursor movements, open/closed session panels, normal
realtime events, and reconnect data resync do not call `boards.get`. A reconnect
does require one fresh cursor-room admission per displayed board because socket
authority cannot be reused across connections.

The source alone cannot decide how much of 10,000/hour is cold hydration versus
cursor admission versus explicit UI/MCP/CLI actions. This change adds only the
bounded server-authored tag
`feathers.reason=presence_cursor_admission`. IDs and caller-controlled strings
are never tags.

### Follow-up: `tasks.custom` and `sessions.get`

The follow-up confirms that `tasks.custom` is an attribution bucket, not a
single transport method. The task service already exposes four distinct custom
methods: `connectExecutor`, `reportTerminationComplete`,
`reportRuntimeTelemetry`, and `reportSdkHealthFailure`. The tracing normalizer
collapses all nonstandard Feathers methods to resource/method `custom`; creating
another heartbeat method would not improve APM attribution.

`reportRuntimeTelemetry` is sent once immediately and then every ten seconds
while an executor owns a Task. Its steady-state rate is therefore:

```text
tasks.custom telemetry = 360 calls/hour/active Task
```

The other three custom methods are normally once per Task, once per Stop, or
exceptional. A ten-second comb in production would strongly identify telemetry,
but production traces were unavailable, so this remains a model rather than an
observed attribution. This change adds a bounded `feathers.custom_method` tag
for exactly the four registered methods while deliberately retaining the
`tasks.custom` resource for dashboard continuity.

The heartbeat write itself is intentional HA control-plane work. It is the
durable liveness fact used by stale-task reconciliation and the response is how
an executor connected to any replica observes `STOPPING`. The ten-second
default was not changed. The optional operator heartbeat callback, however,
previously performed a fully enriched internal `sessions.get` on every tick
solely to obtain `branch_id`. It now performs one tenant-scoped branch-pointer
projection with PostgreSQL RLS. When that callback is configured, this removes
360 `sessions.get` resources/hour/active Task. The callback is disabled by
default; production configuration was not accessible.

The follow-up also confirms two independent `sessions.get` amplifiers:

1. external RBAC authorization recursively called the registered
   `sessions.get`, so `full` tracing recorded two spans and remote-relationship
   enrichment ran twice for every external get; and
2. an open session retained separate `none` and `lazy` reactive handles in
   `SessionPanel` and `ConversationView`, causing two bootstraps and two
   reconnect resyncs for the same canonical session.

Authorization now loads the canonical Session once through the tenant-scoped
repository and passes that exact row to the outer service. Both UI consumers
retain the same `lazy` handle. Session-stream room admission remains a separate,
fail-closed authorized `sessions.get` and is tagged
`feathers.reason=session_stream_admission`; it is not cached across sockets,
users, tenants, or policy epochs.

### Validated assumptions

- **UI hydration:** confirmed. The normal workspace path uses a lean
  `boards.findAll`, a board-scoped `branches.findAll`, and one full displayed
  `boards.get`; it does not point-read every branch.
- **Prompt volume:** one ordinary agent task produces a model-dependent small
  constant, typically 2–6 branch gets (working directory/safe-directory/git
  snapshots plus daemon settlement), not a loop or heartbeat. Explaining
  30,000/hour from prompts alone requires roughly 5,000–15,000 tasks/hour.
  Actual production task rate was not available here.
- **Internal calls:** confirmed. The largest branch source is an internal
  provider-less timer path. Internal service fanout, MCP ID resolution, and
  executor calls also contribute. Publication reauthorization itself uses
  repositories and therefore is not counted as `branches.get`/`boards.get` APM
  resources.

## What the observed resource counts

`apps/agor-daemon/src/tracing/feathers.ts` registers an app-level around hook.
For each traced hook invocation it creates:

```text
operation: feathers.request
resource:  <normalized service>.<normalized method>
service:   inherited agor-daemon service
tags:      feathers.service, feathers.method, feathers.transport, span.kind
new tags:  feathers.reason (bounded and server-authored only)
           feathers.custom_method (reviewed task-method allowlist only)
```

`full` depth traces every registered standard service invocation, including
nested service calls. `entrypoint` depth suppresses work nested inside its
`AsyncLocalStorage` scope. It does not suppress the three health gets because
the preflight scope ends before the direct custom call, the custom call is not
wrapped, and its two sequential `this.get()` calls each establish a new scope.
Thus the health signature is three in both depths.

The hook creates one span per actual Feathers invocation; it contains no
double-emission. An HTTP/Express or Socket.IO parent span is a different
operation, not a duplicate `branches.get`/`boards.get`. PostgreSQL child spans
are separate database operations. `health` is explicitly excluded.

Transport interpretation:

- browser/executor Socket.IO: `socketio`;
- REST/CLI: `rest`;
- MCP service params: `mcp`;
- standalone health timer: `internal`;
- internal fanout that preserves an external provider retains that transport.

The separate DogStatsD Feathers metrics hook is not equivalent: it always
suppresses nested calls and does not count provider-less calls. The reported
APM resource rates must not be compared directly with
`agor.daemon.feathers.requests` without accounting for that boundary.

Duration covers the whole Feathers hook: tenant scope/transaction setup,
authentication, RBAC, repository I/O, enrichment, and after hooks. Database
time can only be separated by comparing child `postgres.query` spans with the
parent duration. No production duration sample was available.

## Exact caller/frequency matrix

Counts are per stated action on deployed source unless the “after” column says
otherwise. Repository reads do not generate a Feathers resource span.

| Caller / trigger                                                | Transport           |                                            Before |                         After | Frequency / fanout                                                | Notes                                                                                                |
| --------------------------------------------------------------- | ------------------- | ------------------------------------------------: | ----------------------------: | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Standalone `HealthMonitor`, active environment                  | internal            |                                     3 branch gets |                 0 branch gets | every 5 s/environment; 2,160 spans/h/environment removed          | Two canonical repository/service-body loads remain; one preflight and unused repo read removed       |
| Standalone health startup discovery                             | internal            |                                  1 branch get/ref |                             1 | once per daemon start/ref                                         | Not periodic; preserves lifecycle validation                                                         |
| Distributed HA health observer                                  | none                |                                                 0 |                             0 | scan/claim interval                                               | Direct `BranchRepository.findById`; a second read occurs only when state changed for publication     |
| UI cold displayed board                                         | socketio            |                            0 branch, 2 board gets |                          same | per tab/cold route                                                | One `useAgorData` full board + one cursor admission                                                  |
| UI cold Home                                                    | socketio            |                                               0/0 |                          same | per tab                                                           | Lists/finds only; no board cursor consumer                                                           |
| UI direct active session missing from recent slice              | socketio            |                                     +1 branch get |                          same | once on deep link                                                 | The session can still open when inaccessible; no broad branch hydration                              |
| UI direct branch link                                           | socketio            |                                     +1 branch get |                          same | once on cold deep link                                            | Establishes board scope, then uses scoped finds                                                      |
| UI reconnect/resync on displayed board                          | socketio            |                             0 branch, 1 board get |                          same | per reconnect/tab                                                 | Data resync uses full finds; new socket cursor authority is re-established once                      |
| UI same-socket board navigation                                 | socketio            |                             0 branch, 1 board get |                          same | per new board cursor room                                         | Unwatch removes the old authorization; new board fails closed through `boards.get`                   |
| UI idle board / 15 s presence heartbeat                         | socketio native     |                                               0/0 |                          same | periodic heartbeat                                                | Association authorization uses one bulk `boards.find` only on set/focus/reconnect changes            |
| Cursor move/leave (up to 10/s client throttle)                  | socketio native     |                                               0/0 |                          same | per movement                                                      | Uses socket-local authorized set; no service/repository point read                                   |
| Open/close session panel                                        | socketio            |                                               0/0 |                          same | per toggle                                                        | Existing client store/realtime state                                                                 |
| Normal realtime branch/session/card events                      | repository          |                                    0 service gets |                          same | per event                                                         | #2520 access cache and direct repository/audience queries; no Feathers point-read resource           |
| Native board cursor admission                                   | socketio            |                                       1 board get |            1 tagged board get | once per socket/board admission                                   | Duplicate mount/connect/auth emits collapse through pending/authorized maps                          |
| Board edit modal open                                           | socketio            |                                       1 board get |                             1 | explicit user action                                              | Refreshes current canonical board before edit                                                        |
| Multiple tabs                                                   | socketio            |                                            linear |                        linear | 2 board gets per cold displayed-board tab; 1 per reconnect/tab    | No shared browser authority/cache by design                                                          |
| Base Claude/Gemini/Copilot task                                 | socketio            |                           typically 5 branch gets |                          same | per task, not heartbeat                                           | safe-directory, start/end git state, SDK cwd, daemon completion; failure path has same bounded shape |
| Codex task                                                      | socketio            |                           typically 6 branch gets |                          same | per task                                                          | Includes separate edit-baseline and prompt-service cwd reads                                         |
| Cursor task                                                     | socketio            |                           typically 5 branch gets |                          same | per task                                                          | Explicit cwd plus safe-directory/start/end/settlement                                                |
| OpenCode task                                                   | socketio            |                           typically 2 branch gets |                          same | per task                                                          | Direct cwd plus daemon completion; does not use base executor git snapshot flow                      |
| Task pulse/heartbeat/watchdog                                   | socketio/repository |                               0 branch/board gets |                          same | periodic while active                                             | Task/session writes and runtime reconciliation, not branch/board service reads                       |
| Session create/fork/spawn hooks                                 | mixed               |                             0–1 branch get/action |                          same | per user/gateway/schedule action                                  | Branch entity and personal sharing checks; not polling                                               |
| CLI branch show/archive/remove/env actions                      | REST/socket client  |                              1 branch get/command |                          same | explicit command                                                  | Mutation may have its own later canonical reload                                                     |
| UI filesystem readiness                                         | socketio            |                                 1 branch get/poll |                          same | only while newly created branch is materializing, bounded timeout | Not idle-board polling                                                                               |
| MCP ID resolver                                                 | mcp                 |                                    1 matching get |             same unless below | once per supplied short/full ID                                   | Canonical service authorization boundary                                                             |
| MCP card create/bulk-create                                     | mcp                 |                           2 board gets/invocation |                             1 | explicit action                                                   | Reuses the canonical board returned by the first authorized get                                      |
| MCP branch set-zone                                             | mcp                 |                                     2 branch gets |                             1 | explicit action                                                   | Reuses canonical branch; board zone validation remains one board get                                 |
| MCP schedules list with board filter                            | mcp                 | N branch gets (one/schedule, duplicates included) | 0 branch gets + 1 branch find | explicit list                                                     | Unique branch IDs are bulk-authorized by scoped `$in`; empty list makes no branch call               |
| MCP bulk card move with zones                                   | mcp                 |                                up to N board gets |                     unchanged | one/moved card with zone                                          | Residual N+1; boards may differ and no policy-epoch-bound memo exists yet                            |
| MCP session/context/knowledge/artifact/environment tools        | mcp                 |                               small constant gets |                          same | explicit tool call                                                | Some perform stronger filesystem/policy checks after canonical resolution                            |
| Repos branch create/branch board move positioning               | inherited provider  |                                1 board get/action |                          same | explicit create/move                                              | Validates full board/zone or computes placement; not a list loop                                     |
| Files, single-file, artifacts, terminal, upload/download routes | repository          |                                    0 service gets |                          same | explicit request                                                  | Direct tenant-scoped `BranchRepository` reads plus resource-specific authorization                   |
| Scheduler/gateway/permission callbacks/MCP egress               | repository          |                      0 service gets in core loops |                          same | per scheduled run/message/decision                                | Direct branch lookup and explicit authorization; not represented by service resource rate            |
| Redis Feathers relay publication                                | repository/cache    |                                    0 service gets |                          same | per relayed event/receiving replica                               | Re-resolves tenant/audience without trusting Redis room names; revocation is preserved               |

### Follow-up caller/frequency matrix

The counts below are exact source/test counts. “Full” and “entrypoint” refer to
`metrics.apm.trace_services` depth, not to different numbers of browser calls.

| Caller / trigger                                           | Transport          |                                      Before |                                        After | Frequency / fanout                                       | Security and query notes                                                                                       |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------: | -------------------------------------------: | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Active executor `reportRuntimeTelemetry`                   | socketio           |                            1 `tasks.custom` |                      1 tagged `tasks.custom` | immediate + every 10 s; steady 360/h/Task                | Required durable HA write/control read; interval unchanged                                                     |
| `connectExecutor`                                          | socketio           |                  1 anonymous `tasks.custom` |                      1 tagged `tasks.custom` | normal once/Task; reconnect/retry can repeat safely      | Row-locked executor admission                                                                                  |
| `reportTerminationComplete`                                | socketio           |                  1 anonymous `tasks.custom` |                      1 tagged `tasks.custom` | normally once/Stop, retry-safe                           | Task/request-fenced quiescence evidence                                                                        |
| `reportSdkHealthFailure`                                   | socketio           |                  1 anonymous `tasks.custom` |                      1 tagged `tasks.custom` | exceptional watchdog path                                | Bounded failure reasons; may initiate containment                                                              |
| Configured heartbeat callback enrichment                   | internal           |                   1 enriched `sessions.get` | 0 service gets + 1 Session branch projection | every telemetry tick; 360/h/Task removed when configured | Fresh originating-tenant DB scope; cross-tenant RLS returns no row                                             |
| One external authorized `sessions.get`, full tracing       | any external       |                      2 `sessions.get` spans |                                            1 | per call                                                 | Repository authorization remains current; relationship enrichment 2 -> 1                                       |
| One external authorized `sessions.get`, entrypoint tracing | any external       |                              1 visible span |                                            1 | per call                                                 | Nested auth span was already suppressed, but its work still ran before                                         |
| Cold-open session UI, full tracing                         | socketio           |                      6 `sessions.get` spans |                                            2 | per open tab/session                                     | Before: stream admission + panel + conversation, each doubled by auth; after: admission + one shared bootstrap |
| Cold-open session UI, entrypoint tracing                   | socketio           |                             2 visible spans |                                            1 | per open tab/session                                     | Stream admission is nested under `session-streams.create` and remains authorized                               |
| Cold-open session relationship enrichment                  | socketio/database  |                      6 relationship queries |                                            2 | per open tab/session                                     | Canonical Session-row reads 3 -> 2; no policy cache introduced                                                 |
| Reconnect with an open session                             | socketio           |                           same as cold open |                            same as cold open | per reconnect/tab                                        | New connection reauthorizes stream room; one shared handle resyncs                                             |
| Close an open session                                      | socketio           |                            0 `sessions.get` |                                            0 | once/close                                               | Canonical stream ID leaves without a resolve read                                                              |
| Idle board with no open session                            | socketio           |                   0 periodic `sessions.get` |                                            0 | idle                                                     | No session polling found                                                                                       |
| External task/message/session RBAC hook needing a Session  | inherited external | 1 nested `sessions.get` plus outer resource |    0 nested service gets + 1 repository load | per protected request                                    | Same request/tenant authority; canonical row is request-local only                                             |

For the open-session full-depth receipt, the six pre-fix spans were one outer
and one recursive authorization get for each of stream admission, panel
bootstrap, and conversation bootstrap. After both fixes, the only two are the
preserved stream admission and one shared bootstrap. This is `6 -> 2` spans and
relationship queries (66.7% reduction), while entrypoint-visible bootstraps are
`2 -> 1` (50% reduction).

## Production call-site inventory

### Standard `branches.get` service callers

- **UI:** `useAgorData.ts` (direct session/branch healing),
  `waitForBranchFilesystemReady.ts`, gateway channel selection, onboarding, and
  explicit branch/settings actions.
- **CLI:** branch show/remove/archive/unarchive and environment
  status/start/stop/restart commands.
- **Executor:** safe-directory setup, start/end git snapshots, SDK working
  directory resolution, file/git/environment commands, and the Feathers-backed
  branch repository.
- **Daemon:** standalone health startup/polling, session fork/spawn, session
  create enrichment, task settlement origin alignment, repo actions, route
  authorization/context, and widget submissions.
- **MCP:** `resolveBranchId`, branch get/update/archive/delete/unarchive/zone,
  session context/create, environment, artifact, Knowledge, schedule, and
  analytics tools.

Generated `packages/executor/dist` occurrences mirror the TypeScript source and
are not an additional runtime call path.

### Standard `boards.get` service callers

- **UI:** displayed-board full hydration and Board Edit refresh.
- **Native Socket.IO:** cursor-room admission.
- **Daemon:** route branch→board context, branch placement, and repo branch
  creation validation.
- **MCP:** `resolveBoardId`, board get/update, card create/move/bulk operations,
  branch zone context, and session context/detail.
- **CLI:** board add-session and board import/export/clone operations where a
  point entity is required.

### Repository point reads (not counted by these APM resources)

`BranchRepository.findById` is used by branch RBAC helpers, files/file,
artifacts, terminal and upload/download routes, group checks, scheduler,
gateway, permission decisions, MCP egress, Knowledge, and both health
architectures. `BoardRepository.findById/findBySlugOrId` is used by board
authorization, board routes, artifacts, and realtime publication.

These reads matter for database load but cannot explain a
`resource_name=branches.get|boards.get` count. Conversely, reducing an internal
Feathers wrapper to a direct canonical load reduces APM and hook/transaction
overhead even when a required database read remains.

### Standard `sessions.get` service callers

- **UI/client:** the shared reactive-session bootstrap/reconnect path, direct
  session-link healing, environment-variable widgets, and explicit session
  detail actions. The session-stream subscription performs its own server-side
  access check.
- **Executor:** safe-directory preparation and Claude/Cursor/OpenCode/base SDK
  setup. These are bounded startup reads, not the ten-second heartbeat.
- **Daemon task lifecycle:** startup recovery, executor startup, Stop and
  reconciliation, completion/auto-title/parent-context paths, permission
  decisions, callbacks, config/session tokens, widgets, routes, and gateway
  orchestration.
- **MCP:** ID resolution, session/context/Knowledge/server tools, and MCP server
  setup. These are explicit tool actions.
- **Authorization:** before this follow-up, shared branch/session RBAC helpers
  recursively invoked `sessions.get` for external session-, task-, and
  message-scoped operations. These calls were internal provider-less children
  but visible at `full` APM depth.

No idle `sessions.get` polling loop was found. The only ten-second coupling is
the opt-in executor-heartbeat callback. Realtime publication uses
`SessionRepository.findBranchIdBySessionId` behind a one-hour, invalidation-
fenced session-to-branch cache and a five-minute, invalidation-fenced branch
visibility cache; it does not call the Feathers Session service. Each replica
reauthorizes Redis-relayed delivery and never trusts relay room names.

## Authorization and realtime findings

### Sessions

The shared external authorization loader previously called the registered
Session service with `provider:undefined`. That was fail-closed, but it crossed
the full Feathers service/hook/enrichment boundary recursively. The outer get
reused the returned row through `_agorPrefetchedRecord`; nevertheless both
service bodies queried remote relationships. The same helper amplified
session-dependent task and message authorization even when their outer resource
was not `sessions.get`.

The loader now accepts only a tenant-scoped `SessionRepository.findById`,
canonicalizes short IDs, and passes the exact row through the same prefetched
record boundary. The current request still resolves the Session and Branch and
performs current user/group/policy authorization. Nothing is cached across a
request, transaction, tenant, user, connection, or policy epoch. Missing and
cross-tenant rows remain non-enumerating failures. PostgreSQL validation under a
`NOSUPERUSER`, `NOBYPASSRLS` role proves both the full Session load and the
heartbeat branch projection return no row in a different tenant scope.

### Branches

#2520 already gives branch point authorization a bounded request cache and
passes the just-authorized record to the generic Drizzle adapter through
`_agorPrefetchedRecord`. External `branches.get` therefore does not reread the
branch row in its service body. The cache is request-local, limited, and bound
to the same params/tenant unit of work. List visibility is set-based SQL rather
than `find` followed by per-row gets.

### Boards

Before this change, an external non-admin `boards.get` loaded the canonical
board in `ensureBoardAccess`, loaded the same board again inside
`BoardRepository.canView/canMutate`, then loaded it again in the service body.
Authorization policy/group/user queries occurred between those reads.

Now `canViewResolved/canMutateResolved` accepts only the canonical board loaded
by the current hook, and the hook passes that same row into the generic adapter.
Every external call still resolves the current policy. There is no cross-user,
cross-tenant, cross-request, or time-based cache. For a canonical full ID this
removes exactly two board-row SELECTs; short identifiers can also avoid a
second prefix resolution after canonicalization. Policy, membership, user, and
RLS queries are unchanged.

### Presence and revocation

Cursor rooms are raw Socket.IO rooms, so their one `boards.get` admission is a
necessary fail-closed boundary. It cannot safely be replaced with UI state or
shared across sockets/users/tenants. The socket tracks an in-flight admission
and authorized board set so duplicate React mount/connect/auth emissions do
not repeat the get. Unwatch, disconnect, authority change, and revocation clear
authorization; reconnect performs a fresh get.

Low-frequency navbar associations use a bounded `boards.find` with `$in`,
`archived:false`, `lean:true`, and the authenticated tenant/caller. The 15 s
heartbeat merely publishes against that acknowledged set. Cursor movement
does not grant association authority.

Realtime Feathers publication in #2520 uses a bounded access cache for branch
and session mapping and direct board repository/audience queries. HA Redis
delivery is a hint, not authority; the receiving replica reauthorizes. None of
these paths calls standard `branches.get`/`boards.get`, though they can
contribute separate database query volume. #2567 retained the cursor
`boards.get`, added in-flight/authorized deduplication, and introduced bulk
association `boards.find`; it did not add periodic board gets.

## Before/after critical query model

### Active standalone health tick

Before:

```text
Feathers branches.get
  -> branch row
  -> zone-enrichment JOIN when board-attached
direct checkHealth
  -> Feathers branches.get
     -> branch row
     -> optional zone enrichment
  -> unused Feathers repos.get -> repo row
  -> health claim/fetch/commit
  -> Feathers branches.get
     -> branch row
     -> optional zone enrichment
```

After:

```text
direct automatic checkHealth under the same tenant ALS/DB scope
  -> unwrapped canonical branch row (+ optional zone enrichment)
  -> health claim/fetch/commit
  -> unwrapped canonical branch row (+ optional zone enrichment)
```

Savings per active tick are three Feathers spans, one branch-row SELECT, one
repo-row SELECT, and (for a board-attached branch) one enrichment query. The
two correctness/fencing branch reads and health coordination queries remain.

### External non-admin board get with a canonical ID

Before:

```text
slug miss + canonical board row
second board row in canView/canMutate
current policy / principal / group resolution
third board row in service get
```

After:

```text
slug miss + canonical board row
current policy / principal / group resolution against that row's ID
service adapter consumes the same request-scoped canonical row
```

The Feathers span count remains one; database board-row reads fall by two.
Authorization query count and revocation semantics do not change.

### External authorized Session get

Before:

```text
outer Feathers sessions.get
  -> external RBAC hook
     -> inner provider-less Feathers sessions.get
        -> tenant-scoped Session row + Branch join/derived board_id
        -> remote relationship enrichment
     -> current Branch + user/group/policy authorization
  -> prefetched Session row
  -> remote relationship enrichment again
```

After:

```text
outer Feathers sessions.get
  -> external RBAC hook
     -> tenant-scoped canonical Session row + Branch join/derived board_id
     -> current Branch + user/group/policy authorization
  -> same request-scoped prefetched Session row
  -> remote relationship enrichment once
```

This is `2 -> 1` full-depth service spans and `2 -> 1` relationship queries per
external call. The required Session/Branch/policy reads remain and still run in
the request's tenant transaction.

### Executor runtime telemetry tick

For a full UUID on SQLite, the normal heartbeat repository path is one
`BEGIN IMMEDIATE` unit containing one Task-row SELECT and one UPDATE; row-lock
acquisition is a no-op and the timestamp uses the process clock. On PostgreSQL,
it is one transaction containing `SELECT 1 ... FOR UPDATE`, one Task-row SELECT,
one database-clock SELECT, and one UPDATE. The row is returned to the executor
and published as `tasks.patched`. If the write is rejected because the Task is
no longer executor-owned, one exceptional fallback read lets a reconnected
executor observe `STOPPING`; otherwise the call conflicts.

The main transaction was not weakened or cached. It serializes heartbeat/
termination races, advances only a newer bounded pulse fact, and supplies the
durable HA timestamp. Replacing it with an in-memory heartbeat or a blind update
would break cross-replica stale detection and Stop propagation.

Configured callback enrichment before:

```text
post-commit callback in originating tenant context
  -> internal Feathers sessions.get
     -> full Session row + Branch join/derived board_id
     -> remote relationship enrichment
  -> extract branch_id
```

After:

```text
post-commit callback in originating tenant context
  -> fresh tenant/RLS database unit
     -> SELECT sessions.branch_id for this Session
```

The default callback is disabled. Operator analytics are also disabled by
default; if enabled, `executor.heartbeat` is emitted once per tick and the
built-in HTTP plugin batches it. That analytics event is separate from the
Feathers/APM count and can be excluded through the existing bounded event
filter if an operator does not need it.

## Implemented bounded fixes

1. Remove the standalone health monitor preflight and unused repo read.
2. Split branch canonical loading from the standard Feathers `get`; automatic
   health uses the unwrapped loader, explicit user/MCP health keeps standard
   authorization hooks.
3. Preserve monitor self-cleanup by using `checkHealth`'s canonical result when
   a lifecycle realtime hint was missed.
4. Reuse a freshly authorized canonical board through board policy resolution
   and the generic adapter, scoped to one request/tenant transaction.
5. Reuse canonical MCP branch/board entities where an ID resolver immediately
   performed the same get again.
6. Replace schedule board-filter N+1 branch gets with one authorized bulk find
   over unique IDs.
7. Add the bounded server-only `presence_cursor_admission` APM reason.
8. Add deterministic UI and daemon call-count receipts.
9. Add the bounded `feathers.custom_method` tag for exactly the four registered
   Task custom methods without changing the `tasks.custom` resource.
10. Replace recursive authorization `sessions.get` calls with a tenant-scoped
    canonical repository load passed through the current request.
11. Make `SessionPanel` and `ConversationView` retain the same lazy reactive
    handle, collapsing duplicate bootstrap/reconnect work.
12. Replace opt-in heartbeat callback Session enrichment with a fresh
    originating-tenant `branch_id` projection.
13. Tag necessary Session stream admission separately, and prove cursor samples
    perform no Feathers/database work after admission. Cursor positions use
    lossy Socket.IO volatile fanout; authorization/revocation edge events remain
    reliable.

No global/TTL entity cache was introduced. No production data/configuration was
changed and no deployment was performed.

## Validation receipts

- Combined daemon health, tracing, native Socket.IO, branch, MCP, hook, and
  adapter suites: 375 tests passed across 9 files.
- UI data/presence suites: 40 tests passed.
- Branch health SQLite/Feathers receipt: 9 focused tests passed, including
  exact wrapped-get reduction `3 -> 0`.
- MCP card/branch/schedule focused suites passed, including schedule
  `N branches.get -> 1 branches.find` and duplicate create/set-zone receipts.
- Hook/Drizzle prefetch suites: 105 tests passed.
- Core SQLite board repository suite: 103 tests passed.
- PostgreSQL 16 under a non-superuser, `NOBYPASSRLS` role: capability-policy
  concurrency plus environment-health HA suites, 9/9 tests passed.
- Follow-up daemon tracing/session/auth/heartbeat/native-Socket.IO suites:
  231/231 tests passed across 6 files.
- Executor heartbeat cadence/single-flight/control-response suite: 6/6 tests
  passed. Focused SQLite Task repository telemetry suite: 5/5 tests passed.
- Follow-up shared client reactive-session suite: 40/40 tests passed, including
  exact cold/reconnect call counts and final-release unsubscribe.
- Follow-up SessionPanel suite: 17/17 tests passed, including the shared lazy
  cache-key contract.
- Focused UI cursor hot-path receipt: 1/1 test passed; a 20-event mouse burst
  produces one immediate and one coalesced volatile sample, with no reliable
  cursor-move emission.
- Follow-up PostgreSQL 16 Task-runtime HA/RLS suite under a verified
  `NOSUPERUSER`, `NOBYPASSRLS` role: 6/6 tests passed. A fresh callback
  projection succeeds for the owning tenant and both full Session and branch
  projection reads return no row cross-tenant.
- The multitenancy-boundary static check passed. A subsequent `pnpm check`
  completed end-to-end: workspace typechecks, Biome/lint, short-ID,
  multitenancy, filesystem, realtime-boundary checks, and the Turbo build all
  passed (21/21 tasks). The build generated the previously missing client
  declarations, so the UI workspace typecheck now passes as well. Focused UI
  tests compile and pass.

The managed disposable UI environment was healthy, but live browser capture
was blocked by a Vite stale optimized-dependency response. UI scenario counts
therefore come from source inspection plus deterministic hook/socket tests,
not a claim of a successful browser network trace.

## Datadog confirmation plan

Use the same time window and graph definition as the reported rates. Never add
resource IDs, user IDs, tenant IDs, names, raw URLs, payloads, or trace headers
as tags.

1. Filter `operation_name:feathers.request` and
   `resource_name:(branches.get OR boards.get)`.
2. Group by service, `feathers.transport`, build/revision, replica, status/error,
   and (after rollout) `feathers.reason`.
3. For `branches.get AND feathers.transport:internal`, graph per-minute counts
   and inspect autocorrelation/five-second buckets. The predicted signature is
   three-span clusters every five seconds per active local environment on the
   owning replica.
4. Inspect parent/root operations. Health gets should be standalone
   `feathers.request` roots or timer descendants rather than HTTP/Socket/MCP
   request descendants. UI hydration/admission should have Socket.IO ancestry;
   executor reads should cluster under task/executor activity.
5. Compare distinct recurring **trace-local equality groups** only. If same-ID
   detection is needed, compute an ephemeral one-way fingerprint offline and
   discard it; do not emit IDs or fingerprints as production metric tags.
6. Compare sum of child `postgres.query` duration with Feathers duration and
   count transaction setup/policy/enrichment children. This separates DB time
   from hooks/RBAC/ALS/transaction overhead.
7. Correlate with low-cardinality task settlement, executor connection, and
   environment counts. Test the 2–6 branch-gets/task and 2,160
   branch-gets/hour/environment models rather than assuming either.
8. For boards, split `feathers.reason:presence_cursor_admission`; the remaining
   Socket.IO volume contains cold full-board hydration and explicit UI actions.
   Compare it with Socket connect/reconnect and route-load counts.
9. Compare before/after by build and replica. During a mixed rollout, old
   replicas retain three health gets and have no reason tag; new replicas have
   zero automatic health gets and tag cursor admissions.
10. For `resource_name:tasks.custom`, group new-revision spans by
    `feathers.custom_method`. `reportRuntimeTelemetry` should show a ten-second
    comb and scale at 360/hour per average active Task. Old-revision spans are
    expected to have no custom-method tag; do not interpret them as a fifth
    method.
11. For `sessions.get`, split
    `feathers.reason:session_stream_admission`, transport, trace depth, and
    parent operation. Compare open-session/reconnect clusters with Task starts
    and check specifically for ten-second callback coupling. A callback comb
    can exist only when the operator callback is configured.
12. For a sampled old-revision external `sessions.get` at full depth, verify
    the expected child `sessions.get` and two relationship-query children. New
    revisions should have no recursive Session service span and one
    relationship query. Compare trace-local resource equality only; never emit
    a Session/resource fingerprint as a production tag.

Expected post-rollout health reduction, if the production pattern matches the
source-derived model, is up to 2,160 `branches.get` spans/hour per active local
environment—approximately the reported 30,000/hour at 13.9 average active
environments. This is an expectation to verify, not an observed production
result.

For Session traffic, expected savings are source-dependent: every external
authorized `sessions.get` loses one full-depth nested span and relationship
query; an open UI Session loses four of six full-depth spans; and a configured
heartbeat callback loses all 360 Session service resources/hour/active Task.
No production percentage is claimed until the tag/config/time-cluster splits
are observed.

## Residual risks and follow-up branches

1. **Datadog attribution receipt (blocking for exact production percentages):**
   capture the dashboard measure, transport/parent/replica/time-cluster split,
   duration decomposition, and pre/post build comparison.
2. **MCP bulk card move:** group moves by board, bulk-load currently authorized
   boards once, and prove policy-revision semantics before removing its N+1.
3. **Executor task context:** pass one already-authorized immutable execution
   context (branch path/repo) through safe-directory, git snapshots, and SDK
   setup. Today 2–6 gets/task are bounded but duplicated. Preserve task-token
   caller authority and do not cache across tasks/users/tenants.
4. **Session/task internal canonical context:** remove small constant internal
   branch service re-reads only where the same operation already holds an
   authorized canonical branch. Add request/transaction/authority binding
   tests first.
5. **Board policy query timing:** after the board-row reduction is in APM,
   determine whether policy/principal/group queries rather than row reads
   dominate duration. Optimize only with a policy-revision/transaction-bound
   design and cross-tenant negative coverage.
6. **Heartbeat transport/DB measurement:** after the bounded custom-method tag
   is deployed, verify the ten-second comb, active-Task fanout, transaction
   duration, lock wait, replica balance, errors, and STOPPING fallback rate.
   Do not change the default interval from 10 s without explicitly accepting
   that 20 s halves write volume but moves the default stale threshold from
   30 s to 60 s.
7. **Heartbeat realtime/analytics:** `tasks.patched` is intentionally published
   because the UI exposes current heartbeat/pulse state, and realtime authority
   is invalidation-fenced. Measure Redis/publication and optional analytics
   plugin cost separately. If it dominates, design a bounded coarse UI signal
   rather than silently removing durable writes or revocation checks.
8. **Remaining Session reads:** pass an already-authorized canonical Session
   within task startup/completion/Stop operations only where the authority and
   transaction are identical. Executor startup reads are bounded and should be
   handled as an immutable per-Task execution context, not a global Session
   cache.
9. **Mixed-version observation:** old replicas emit untagged `tasks.custom`,
   recursively trace Session authorization at full depth, and use two reactive
   UI handles; new replicas emit bounded tags and reduced counts. Group every
   rollout comparison by build and replica before drawing a rate conclusion.
