# Prompt submission to executor claim latency audit (2026-08-28)

## Executive answer

The agreed queue-free signal already exists. With the deployed default prefix,
its exact Datadog name is:

```text
agor.daemon.executor.dispatch_to_connected.duration_ms
```

It is a DogStatsD **distribution** in milliseconds. Its exact code-level
formula is:

```text
max(0, Date.parse(task.executor_connected_at) - Date.parse(task.started_at))
```

It is emitted once on the first successful `DISPATCHING -> RUNNING` executor
claim, with runtime tags:

```text
mode:local|templated, outcome:connected
```

and the global tags on every Agor daemon metric:

```text
deployment_id, daemon_instance, deployment_mode
```

plus any operator-reviewed `metrics.statsd.global_tags`.

This is **durable dispatch intent to first authenticated executor claim**. It
deliberately excludes Task queue dwell (`created_at -> started_at`) and is not
literal UI-click-to-claim latency. It also does not mean that
Claude/Codex/Gemini/OpenCode/Cursor or another provider has begun processing.
“Connected” means that the executor wrapper has loaded its initial registry,
authenticated its Socket.IO client, and atomically claimed the Task from the
daemon.

Mode interpretation is important:

- `mode:local` means a daemon-spawned executor subprocess. It combines trusted
  `simple` execution and local `sandbox`/bubblewrap execution; the metric does
  not contain an `unix_user_mode` tag.
- `mode:templated` means the daemon spawned an `executor_command_template`
  launcher. That includes the Agor Cloud ephemeral-pod pattern, but can also be
  Docker or any arbitrary reviewed remote launcher. It is not intrinsically a
  “pod” label.

The same connection metric is emitted daemon-side for both modes when the
executor calls back. However, never-connected launches have no latency sample,
so both distributions are success/survivor-only and the pod distribution is
especially vulnerable to missing slow or failed starts.

At the original audit cutoff, no Datadog tool was callable. Max subsequently
attached the official Datadog MCP server and authorized creation of a focused
dashboard. Live queries on `2026-08-28` confirmed the metric, tags, deployments,
counts and outliers. Percentile aggregation initially returned
`missing_aggregation`; Max then enabled it and metric metadata now reports
`is_percentiles_enabled: true`. No historical p50/p75/p95 series was immediately
visible, so the percentile chart begins with post-enable observations. No broad
credential was requested or inferred.

## Revisions and deployed evidence

Audit cutoff: `2026-08-28T20:41:10Z`.

| Target                                         | Exact revision                             | Evidence                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree `HEAD`                                | `f1ba9474846c703639db71cb5a8cea1edfa73cf1` | `fix(ui): sanitize whitespace from pasted secrets across credential inputs (#2577)`, authored `2026-08-28T09:39:19-07:00`; `v0.25.2-94-gf1ba9474`                                                                                     |
| Local `main`                                   | `f1ba9474846c703639db71cb5a8cea1edfa73cf1` | `git rev-parse main`                                                                                                                                                                                                                  |
| Cached `origin/main`                           | `f1ba9474846c703639db71cb5a8cea1edfa73cf1` | `git rev-parse origin/main`                                                                                                                                                                                                           |
| Live remote `refs/heads/main`                  | `f1ba9474846c703639db71cb5a8cea1edfa73cf1` | `git ls-remote origin refs/heads/main` at audit time                                                                                                                                                                                  |
| Observed `agor.sandbox.preset.zone` deployment | `6a0074c1351f0a6d65540267dc7783b06cf7b258` | Public health reports version `0.25.2`, short build SHA `6a0074c13`, built `2026-08-27T06:00:20.945Z`; that short SHA resolves uniquely in this repository to `feat(apm): trace postgres.js queries via Drizzle session shim (#2571)` |

The observed sandbox deployment ID is
`e7de02dc-6109-4f36-9a57-09e8eef3a738`. It is a deployment-level identifier,
not a tenant/user/session ID, and is intended as a metric dimension.

The deployed daemon has been active since `2026-08-27T06:15:34Z` with zero
service restarts. Its journal proves:

```text
Deployment mode: standalone
DogStatsD metrics enabled (127.0.0.1:8125, prefix=agor.daemon.)
unix_user_mode=sandbox ... sandbox.enabled=true
```

The Datadog Agent is active and UDP `127.0.0.1:8125` is listening. The daemon
also started with `dd-trace` service `agor-daemon`, environment `sandbox`, and an
APM Unix socket. This establishes that the observed sandbox is emitting the
metric path. It does not independently prove Datadog retention or the presence
of a dashboard.

The lifecycle metric implementation and its call sites are byte-for-byte
unchanged between the deployed revision and current `main`. The metric was
introduced by:

```text
84440ab355e3363edf32fe76a255c6d19d41f525
2026-08-18T23:46:38-07:00
feat(daemon): add optional DogStatsD metrics foundation (#2470)
```

The repository has no checked-in Datadog dashboard, monitor, Terraform, or
other query definition for these lifecycle names. The canonical inventory is
`context/explorations/daemon-statsd-metrics.md`; implementation and tests are in
`apps/agor-daemon/src/metrics/`.

No authoritative Agor Cloud/external-pod build SHA or execution configuration
is present in this worktree or exposed by the observed sandbox health endpoint.
The later Datadog follow-up maps production templated observations to deployment
ID `cf47ead1-ba42-45b7-ae33-353f0703c774` and proves that deployment emitted the
metric, but the Cloud revision and exact launcher configuration remain
unverified deployment facts.
The health field `auth.externalLaunch.enabled` is about one-time external login
launching and must not be used to infer executor mode.

## Exact timeline and clock boundaries

### Common prompt/admission path

```mermaid
sequenceDiagram
    participant UI as Browser UI
    participant HTTP as POST /sessions/:id/prompt
    participant DB as Task repository / DB
    participant D as Daemon dispatch
    participant L as Child or launcher
    participant E as Executor wrapper
    participant P as SDK/provider

    UI->>UI: Snapshot prompt; upload attachments first
    UI->>HTTP: client.sessions.prompt(...)
    HTTP->>HTTP: Auth, session load, RBAC, preset/tool validation, lock/reconcile
    HTTP->>DB: createPending()
    DB-->>HTTP: Task(created_at) [t_created]
    HTTP->>HTTP: Auto-title and created event
    HTTP->>DB: Atomic queued/created -> dispatching claim
    DB-->>HTTP: Task(started_at, executor_mode) [t_started]
    HTTP->>HTTP: Write/reconcile initial user message and Session projection
    HTTP-->>UI: Return DISPATCHING/QUEUED Task
    D->>D: Deferred execute-handler preparation
    D->>L: spawn() child/launcher [t_child_spawn]
    L->>E: Start executor locally or arrange remote pod
    E->>E: Read payload; initialize initial tool registry
    E->>D: Socket.IO authenticate; tasks.connectExecutor()
    D->>DB: Atomic dispatching -> running
    DB-->>D: executor_connected_at [t_connected]
    Note over D,DB: Emit connections + both connected latency distributions
    E->>E: Start heartbeat/watchdog, record in-memory sdk_started pulse
    E->>P: Initialize registry again; ToolRegistry.execute(...)
    P-->>E: First SDK/provider event (no dedicated Datadog metric)
    E->>DB: Terminal Task patch/finish [t_completed]
    Note over D,DB: Emit settlement metrics on first terminal transition
```

The prompt endpoint is `apps/agor-daemon/src/register-routes.ts` around lines
1884-2160. UI submission is in
`apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx` around lines
1207-1271 and `apps/agor-ui/src/App.tsx` around lines 1370-1379; the API helper
is `packages/core/src/api/index.ts` around lines 1388-1393.

The HTTP response does not wait for a live executor. After the durable dispatch
claim and synchronous transcript/session projection work, actual execution is
deferred into a fresh tenant scope. Therefore the external HTTP/APM request
span ends before the executor normally connects.

### Timestamp authority

| Timestamp / clock             | Written at                                                     | Authority                                                                                                                             | Consequences                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI click / API-send time      | Not persisted for this purpose                                 | None                                                                                                                                  | No current metric includes literal user submission time. Attachment upload happens before the API call.                                                          |
| HTTP request arrival          | HTTP `performance.now()` only for request-duration telemetry   | Daemon monotonic clock                                                                                                                | Not correlated into the Task lifecycle distributions.                                                                                                            |
| `Task.created_at`             | `TaskRepository.taskToInsert()` at actual row insertion        | Node wall clock (`Date.now()`) on both SQLite and PostgreSQL                                                                          | Excludes all earlier UI/network/admission work. On PostgreSQL it is a different clock domain from later DB-authored transitions.                                 |
| `Task.started_at`             | Atomic durable dispatch/launch-intent claim                    | PostgreSQL `CURRENT_TIMESTAMP`; SQLite daemon/process time; test override allowed                                                     | This is dispatch intent, not child spawn. A queued Task can spend a long time between `created_at` and `started_at`.                                             |
| Child/launcher spawn          | Successful local `spawn()` return                              | Daemon monotonic `performance.now()` only for `executor.launch.duration_ms`                                                           | Not persisted as a Task timestamp.                                                                                                                               |
| `Task.executor_connected_at`  | First successful authenticated `tasks.connectExecutor()` claim | PostgreSQL `CURRENT_TIMESTAMP`; SQLite daemon/process time                                                                            | Durable, idempotent transition. This is wrapper claim, not provider start.                                                                                       |
| First SDK/provider processing | No authoritative durable first-event timestamp                 | An in-memory `sdk_started` pulse is queued after claim; provider events arrive later                                                  | Heartbeat pulses are coalesced and received on cadence; they cannot reconstruct exact first processing. Cursor does not create the watchdog/`sdk_started` pulse. |
| `Task.completed_at`           | First terminal settlement                                      | Often executor-supplied wall clock on normal completion; daemon/process clock for some failures; DB clock in termination coordination | Settlement durations can mix daemon/DB/external-pod clocks.                                                                                                      |

`apps/agor-daemon/src/metrics/task-lifecycle.ts` clamps every wall-clock
difference with `Math.max(0, end - start)`. This prevents a negative metric but
silently turns clock skew into a zero-latency observation.

### Meaning of each latency

```text
executor.request_to_dispatch.duration_ms
  = max(0, started_at - created_at)
  = durable Task creation -> durable dispatch intent

executor.dispatch_to_connected.duration_ms
  = max(0, executor_connected_at - started_at)
  = durable dispatch intent -> first authenticated executor claim

executor.request_to_connected.duration_ms
  = max(0, executor_connected_at - created_at)
  = durable Task creation -> first authenticated executor claim
```

`dispatch_to_connected` is the cleanest clock comparison in PostgreSQL because
both endpoints use the database clock. `request_to_dispatch` and
`request_to_connected` mix Node and PostgreSQL clocks. For an immediately
admitted Task, the queue-inclusive candidate includes auto-title, dispatch
claim, synchronous initial-message/session work, execute preparation,
subprocess/launcher/pod startup, wrapper module loading, networking,
authentication, and claim. For a queued Task it also includes queue dwell time.

## Local subprocess versus external ephemeral pod

### Local (`mode:local`)

The daemon spawns the packaged executor CLI and, in `sandbox` mode, wraps it in
bubblewrap. `onSpawn` fires when Node's `spawn()` has returned. The local process
is then tracked in the daemon process registry and contributes to
`executors.running{mode:local,scope:process_group}`.

The observed deployed sandbox logs contain 2,912 exact
`Sandbox: wrapping executor via bwrap` lines and zero `Templated execution mode`
lines in the sampled service uptime. Thus the log sample below is local
sandbox, even though the lifecycle metric itself only says `mode:local`.

### Template/Agor Cloud pod (`mode:templated`)

When `execution.executor_command_template` is configured, the daemon spawns a
local `sh -c` launcher and writes the authenticated executor payload to it. A
Cloud launcher can submit an ephemeral pod, and that pod later connects to any
daemon through the same authenticated task service.

Important limits:

- `executor.launch.duration_ms{mode:templated}` ends when the **local launcher
  shell** is spawned; it is not pod scheduled/running/ready latency.
- `executor.process_exits{mode:templated}` describes the local launcher child,
  not the pod lifecycle.
- `executor.dispatch_to_connected.duration_ms{mode:templated}` does include
  launcher handling, scheduler wait, image/container startup, executor wrapper
  startup, connection and claim, provided the pod eventually calls back.
- A failed or indefinitely pending pod never emits a connected latency. Compare
  connected counts with claimed dispatches and settlement/failure signals; do
  not read low p95 as proof that all starts are healthy.
- The label cannot distinguish Kubernetes from Docker/SSH/another template.
  Compare only deployment IDs whose configuration is independently known.

## Metric inventory and emission contract

All full names below use the deployed default `agor.daemon.` prefix.

| Full name                                                | Type / unit            | Runtime tags                                   | Emission point and meaning                                                                                   |
| -------------------------------------------------------- | ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `agor.daemon.http.requests`                              | count / events         | `method,route,status_code,outcome`             | Instrumented HTTP response finish/close.                                                                     |
| `agor.daemon.http.request.duration_ms`                   | distribution / ms      | same                                           | HTTP middleware entry to response finish/close.                                                              |
| `agor.daemon.feathers.requests`                          | count / events         | `service,method,transport,outcome,status_code` | Outermost external Feathers call.                                                                            |
| `agor.daemon.feathers.request.duration_ms`               | distribution / ms      | same                                           | Whole external Feathers hook; prompt response ends before connection.                                        |
| `agor.daemon.executors.running`                          | gauge / process groups | `mode:local,scope:process_group`               | Absolute local process groups tracked by this daemon. External executors excluded.                           |
| `agor.daemon.executor.dispatches`                        | count / attempts       | `mode,outcome`                                 | Every durable dispatch-claim result (`claimed`, `already_claimed`, `condition_changed`, or `actor_missing`). |
| `agor.daemon.executor.request_to_dispatch.duration_ms`   | distribution / ms      | `mode,outcome:claimed`                         | `created_at -> started_at`, claimed only.                                                                    |
| `agor.daemon.executor.connections`                       | count / events         | `mode,outcome:connected`                       | First authenticated executor claim only.                                                                     |
| `agor.daemon.executor.dispatch_to_connected.duration_ms` | distribution / ms      | same                                           | `started_at -> executor_connected_at`; agreed queue-free KPI.                                                |
| `agor.daemon.executor.request_to_connected.duration_ms`  | distribution / ms      | same                                           | `created_at -> executor_connected_at`; queue-inclusive companion.                                            |
| `agor.daemon.executor.launches`                          | count / children       | `mode`                                         | Local executor or local templated-launcher child successfully spawned.                                       |
| `agor.daemon.executor.launch.duration_ms`                | distribution / ms      | `mode`                                         | Deferred execute-handler entry through preparation to local child spawn. It does not start at `started_at`.  |
| `agor.daemon.executor.process_exits`                     | count / events         | `mode,outcome`                                 | Local child exit callback; for templated mode this is the launcher.                                          |
| `agor.daemon.task.settlements`                           | count / events         | `mode,status`                                  | First Task terminal transition observed by TasksService.                                                     |
| `agor.daemon.task.dispatch_to_settlement.duration_ms`    | distribution / ms      | same                                           | `started_at -> completed_at`.                                                                                |
| `agor.daemon.task.connected_to_settlement.duration_ms`   | distribution / ms      | same                                           | `executor_connected_at -> completed_at`.                                                                     |

The adapter is `apps/agor-daemon/src/metrics/statsd.ts` and configuration is in
`apps/agor-daemon/src/metrics/index.ts`.

- Protocol: DogStatsD over UDP; default `127.0.0.1:8125`.
- Every call uses Datadog low-cardinality mode.
- No sampling rate is passed, so the application attempts one sample/event for
  every eligible transition. UDP remains best-effort and can drop packets.
- DogStatsD normally aggregates on its agent flush cadence (10 seconds); a
  distribution remains suitable for fleet-wide percentiles.
- Runtime tag keys are allow-listed to `job`, `method`, `mode`, `outcome`,
  `route`, `scope`, `service`, `status`, `status_code`, and `transport`.
- At most 12 runtime tags are accepted; UUID-containing values are dropped and
  values are cleaned/truncated. Tenant, user, session, Task, branch, repository,
  prompt, model, raw path and arbitrary-error identifiers are not emitted.
- Global tags are bounded separately. `deployment_id`, `daemon_instance`, and
  `deployment_mode` are canonical. `deployment_mode` means `standalone` versus
  HA; it does not mean local versus Cloud.
- In HA, StatsD refuses to start without an explicit stable
  `AGOR_DAEMON_INSTANCE_ID`. Standalone forces `daemon_instance:standalone`.
- Metrics default to disabled and degrade to a no-op if `hot-shots` is absent.
  Sandbox enablement is proven from configuration; live production observations
  prove Cloud emission even though its deployment receipt is unavailable.

Connections are emitted only when `TaskRepository.connectExecutor()` returns
`transitioned:true`. An idempotent reconnect to an already-running Task returns
`transitioned:false`, so it does not duplicate the connection or duration
samples. Likewise, settlement emission is guarded to the first terminal
transition. The durable dispatch fence normally prevents duplicate launch
claims across daemons.

## APM and analytics: useful but not the target

Datadog auto-instrumentation sees HTTP/Express/PostgreSQL work. Agor optionally
wraps Feathers calls in operation `feathers.request`, resource
`<service>.<method>`, with bounded tags `feathers.service`, `feathers.method`,
`feathers.transport`, optional reason/custom method, and `span.kind:server`.
`metrics.apm.trace_services` controls `off|entrypoint|full`.

The prompt request span cannot measure Task-to-claim because executor execution
is deliberately deferred and the HTTP call returns first. There is no trace
context persisted onto the Task and propagated into a remote pod by this path.

There is also an attribution defect: `normalizeFeathersService()` rejects `:`,
while the registered custom path is `/sessions/:id/prompt`. Consequently the
Feathers metric/span classifies this parameterized path as `service:other` and
resource `other.create`; the HTTP metric still uses the reviewed route template.
This limits endpoint-specific APM analysis, but it does not alter the lifecycle
distribution. Fixing it safely would change the shared normalization contract
for every parameterized custom route, so it was not changed as part of this
instrumentation audit.

Product analytics events named `task.created`, `task.started`, and
`task.completed` are not substitutes. Repository prompt admission bypasses the
normal Task service create path, and analytics “started” is associated with the
executor connection rather than the dispatch-intent timestamp. Those events
also carry resource identities unsuitable for a low-cardinality Datadog metric
dashboard.

## Concrete read-only Datadog queries

Use the exact deployed metric names. Do not group or filter by tenant, user,
session, Task, branch, repository, or runtime ID.

### Agreed dispatch-to-claim percentile widgets

For the observed sandbox deployment:

```text
p50:agor.daemon.executor.dispatch_to_connected.duration_ms{deployment_id:e7de02dc-6109-4f36-9a57-09e8eef3a738,outcome:connected,mode:local} by {deployment_mode,mode,daemon_instance}

p75:agor.daemon.executor.dispatch_to_connected.duration_ms{deployment_id:e7de02dc-6109-4f36-9a57-09e8eef3a738,outcome:connected,mode:local} by {deployment_mode,mode,daemon_instance}

p95:agor.daemon.executor.dispatch_to_connected.duration_ms{deployment_id:e7de02dc-6109-4f36-9a57-09e8eef3a738,outcome:connected,mode:local} by {deployment_mode,mode,daemon_instance}
```

For a known Cloud deployment, substitute its deployment ID and
`mode:templated`. If the same deployment intentionally exercises both paths,
omit the `mode` filter and group by it:

```text
p95:agor.daemon.executor.dispatch_to_connected.duration_ms{deployment_id:<CLOUD_DEPLOYMENT_ID>,outcome:connected} by {mode,daemon_instance}
```

For cross-deployment comparison, include `deployment_id` in the grouping and
also use a reviewed low-cardinality global environment/region tag if configured:

```text
p95:agor.daemon.executor.dispatch_to_connected.duration_ms{deployment_id IN (<SANDBOX_DEPLOYMENT_ID>,<CLOUD_DEPLOYMENT_ID>),outcome:connected} by {deployment_id,mode}
```

If the Datadog editor does not accept `IN`, create two queries with one
deployment filter each. A dashboard formula can show `cloud_p95 / local_p95`,
but keep the two absolute millisecond series visible.

### Optional queue-inclusive diagnostics

```text
p50:agor.daemon.executor.request_to_dispatch.duration_ms{deployment_id:<ID>,outcome:claimed} by {mode}
p95:agor.daemon.executor.request_to_dispatch.duration_ms{deployment_id:<ID>,outcome:claimed} by {mode}
p99:agor.daemon.executor.request_to_dispatch.duration_ms{deployment_id:<ID>,outcome:claimed} by {mode}

p50:agor.daemon.executor.dispatch_to_connected.duration_ms{deployment_id:<ID>,outcome:connected} by {mode}
p95:agor.daemon.executor.dispatch_to_connected.duration_ms{deployment_id:<ID>,outcome:connected} by {mode}
p99:agor.daemon.executor.dispatch_to_connected.duration_ms{deployment_id:<ID>,outcome:connected} by {mode}
```

Do not add p95 or p99 values from the two legs. Percentiles are not additive.
The operational KPI is the direct `dispatch_to_connected` percentile; use the
queue-inclusive metrics only when explicitly investigating admission or queue
dwell.

### Volume, observation coverage, and failure context

```text
# A: durable claims in the selected window
sum:agor.daemon.executor.dispatches{deployment_id:<ID>,outcome:claimed} by {mode}.as_count()

# B: first successful connections in the selected window
sum:agor.daemon.executor.connections{deployment_id:<ID>,outcome:connected} by {mode}.as_count()

# C: latency distribution observation count
count:agor.daemon.executor.dispatch_to_connected.duration_ms{deployment_id:<ID>,outcome:connected} by {mode}.as_count()

# D: local child / templated launcher exits
sum:agor.daemon.executor.process_exits{deployment_id:<ID>} by {mode,outcome}.as_count()

# E: terminal Task statuses
sum:agor.daemon.task.settlements{deployment_id:<ID>} by {mode,status}.as_count()
```

Dashboard formula for a directional connection-coverage check:

```text
100 * B / A
```

This is not a strict cohort success rate: claims near the right edge may connect
after the window and queued/reconciled work can cross boundaries. Use a long
window, exclude a recent tail, or export timestamped aggregate events for a true
cohort. Verify `B` and `C` agree within expected UDP loss.

Launch preparation is separately visible as:

```text
p95:agor.daemon.executor.launch.duration_ms{deployment_id:<ID>} by {mode,daemon_instance}
```

Do not label the templated result “pod startup.”

The local process gauge is:

```text
sum:agor.daemon.executors.running{deployment_id:<ID>,mode:local,scope:process_group} by {daemon_instance}
```

It is process-local and has no templated counterpart. A crashed daemon can
leave a stale last value until no-data handling or replacement. Do not use it as
the denominator for Cloud executor health.

Datadog distributions support globally aggregated percentiles, but the desired
percentile aggregations must be enabled/available for the metric in Metrics
Summary. Count metrics display as rates by default, hence `.as_count()` for
window totals. Keep the automatic rollup rather than forcing a rollup smaller
than the DogStatsD aggregation interval.

### APM cross-checks

The APM query convention is:

```text
service:agor-daemon operation_name:feathers.request
```

For the current parameterized prompt route defect, add:

```text
resource_name:other.create @feathers.service:other @feathers.method:create
```

This is not exclusive to prompt submission and therefore cannot be used as the
prompt denominator. The auto-instrumented HTTP resource can narrow the REST
route if its framework resource name is stable, but Socket.IO prompt calls will
not share that HTTP shape. APM is appropriate for diagnosing the pre-insert
admission portion; the lifecycle distributions are authoritative after insert.

## Recent local sandbox sample from deployment logs

At the original audit cutoff, no live Datadog metric values were available. The
deployed service journal does log one lifecycle leg using the exact same formula as
`executor.dispatch_to_connected.duration_ms`:

```text
Executor connected for task <short-id> in <milliseconds>ms
```

For service uptime `2026-08-27T06:15:34Z` through
`2026-08-28T20:41:10Z`, after removing all resource IDs and aggregating only the
duration values:

| Sample                 |        Value |
| ---------------------- | -----------: |
| Connected observations |        2,850 |
| Minimum                |     1,410 ms |
| p50                    |     2,901 ms |
| p95                    |  6,907.85 ms |
| p99                    | 11,537.46 ms |
| Maximum                |    23,219 ms |
| Mean                   |  3,392.95 ms |

This sample is the agreed **dispatch-to-connected** KPI. It intentionally cannot
recover queue/admission time. The same window has 2,912 sandbox/bubblewrap launch
log lines and zero templated-mode lines, so it provides no Cloud/pod comparison.
Generic `Spawning executor at` lines are not a valid denominator because
auxiliary git/repository commands use the same logger. The sample excludes every
dispatch that never connected and may be biased by log availability; Datadog
supplies the authoritative distribution and count series.

## Live Datadog follow-up (2026-08-28)

The official Datadog MCP connection became callable after the initial audit.
The first live query evaluated the original queue-inclusive candidate; metric
context confirmed:

```text
metric: agor.daemon.executor.request_to_connected.duration_ms
type: distribution
percentiles enabled: false
modes: local, templated
environments: sandbox, production
```

The attempted p50/p95/p99 query failed with Datadog's
`missing_aggregation` configuration error. The following summaries use exact
distribution `avg`, `max`, and `count` points from `2026-08-19T00:00:00Z` to the
follow-up query time. Observation-weighted means were calculated from aligned
raw average/count points; maxima came from the raw maximum series.

| Deployment / known path                                      | Connected observations | Observation-weighted mean |                 Maximum | Claimed / connected counter coverage |
| ------------------------------------------------------------ | ---------------------: | ------------------------: | ----------------------: | -----------------------------------: |
| `e7de02dc-6109-4f36-9a57-09e8eef3a738`, sandbox local        |                 14,186 |                 80,397 ms | 61,354,145 ms (17.04 h) |             14,187 / 14,304 = 99.18% |
| `cf47ead1-ba42-45b7-ae33-353f0703c774`, production templated |                    252 |                  8,319 ms |              286,183 ms |                   252 / 297 = 84.85% |
| `e0cd5eb9-1dcd-4995-acc3-026a558540c8`, sandbox templated    |                      2 |                 23,135 ms |               43,554 ms |                         2 / 2 = 100% |

The one-observation difference between the local distribution count and
connection counter is consistent with separate best-effort UDP emissions. The
coverage ratios are directional, not strict cohorts: window boundaries, UDP
loss, and in-flight work remain possible. Production templated latency has
substantial survivor bias (45 more claims than connections), while the local
target distribution is dominated by queue dwell outliers because it begins at
Task creation. It would be incorrect to conclude from these means that pod
startup is faster than local subprocess startup.

Read-only Datadog links:

- [10-day latency explorer: average, maximum, and observation count by deployment/environment/mode](https://app.datadoghq.com/metric/explorer?start=1787086563895&end=1787950563895&paused=true#N4Ig7glgJg5gpgFxALlFOAzCA7CCID22KoATnAI4CucAzgrSgNpoS0AOANgIYCeA+gl7s4KEJxyiANCAwFSAWyo9GyFrPlKeY6nFK8ADCAC+U0HMXLuOmvoCMJsxsvbkIXfoBMJgLoyPEHTMaNwI3Py0BFSkAMaibgqIpBAxjDLY3Ik2eoYg-ra8YtwAbjDI3DDyAHRQ3HAKRFVwAB5wMVQI1eS69IIE-DFE2G0IcFA10aGE2PwKtMDoXAS8idgI-NDIcADs6AaeUDEAtABsdgYAnEcALBgAzCdHF9wArNtHl3AAHHCYd9zbO5fKRRBCDRLIQbYYYxUZQKQNdDITgEGLcTjGRwhMIRKKxeIgRIIZKpPIgDJZNweXgOfI5MQKbjNcqVUg1OoNbBNVrtTps7o0XqdAZDEZjCakKZEWbzRYolZwNYbKBbXZwfaHU7nK63B5PV7vT4-P4AoEgjrguCQ0WwsYIghIlFojFYkC1HGRaJxBlJFJpcmZAnU7x0-RiQZUNYs6q1eqNFptDpdSiC9bCqEwuESqUzOYLOBLBVKzY7PYHY5nS43e6PZ5vD4Xb6-e6m4Ggy3W6Fi+GIq1O9GY4x+EDkDhEWhwfgWRlINz4RIT5JBGT0XiceKgCTDQTCAmRCRQMlbyeQKAIAAWYmwmnRZPY6MQozEUAIMAGKloKRMQ5kQhEYnnOg9ECRhTHEPhQRIEBzzgCAYHPWc7BkU8LxQJCQGaNCZEKZA7GMMCOAkBAAGEiCwGAUGwZQMSAA)
- [Claimed dispatch versus connected counts by deployment/environment/mode](https://app.datadoghq.com/metric/explorer?start=1787097600000&end=1787950628750&paused=true#N4Ig7glgJg5gpgFxALlFOAzCA7CCID22KoATnAI4CucAzgrSgNpoS0AOANgIYCeA+gl7s4KEJxyiANCAwFSAWyo9GyFrPlKeY6nFK8ADCAC+U0HMXLuOmvoCMJgLozdpCHWZpuCbv1oEqUgBjUWQQBUQ3IMYZbG4Imz1DEBdbXjFaKgVkbhh5ADoobjgFIny4AA84IKoEAqg2dm8ggAs6YACEIIII5CCeCAioYwACACNeEeB0LgJeCOwEfmgpOGwANwhSIgWEKVL0Y3zuWn5uqkWACgBKEzMQIp8-AODQ8MiIaJSQOISw114DlSSQyWRyeVIhWKpWw5SqNTqkO62Gw1XwRFoHVq3V6yNRQQQcGG40m0zgs3mayWKzWm222F2+wIh2Op3OV1uxmcIHIHAxcH4FgU3jE+AitD07hiIHovE4oVAElRgmEb38Eig3yVAsgUAQLTE2E03E43ya8oQhLEUAIMDOKlonxMXJkQhEosGdElHlM4j4nRIIDaEBgLSQyDsMl1+pQkZAFVjMnSEeMvo4EgQAGEiFgYChsMpOMYgA)

### Clarified KPI: dispatch to executor claim

Max clarified that queue dwell is not part of the desired operational KPI. No
new daemon instrumentation is required: the existing canonical metric is

```text
agor.daemon.executor.dispatch_to_connected.duration_ms
```

It is exactly PostgreSQL DB-authored `started_at -> executor_connected_at`, so
it excludes `created_at -> started_at` queue dwell and avoids the mixed
Node/PostgreSQL clock boundary in the queue-inclusive metric. Live raw points
from `2026-08-19T00:00:00Z` through the follow-up query time show:

| Deployment / known path | Connected observations | Observation-weighted mean |   Maximum |
| ----------------------- | ---------------------: | ------------------------: | --------: |
| sandbox local           |                 14,205 |                  2,597 ms | 70,176 ms |
| production templated    |                    252 |                  4,025 ms | 66,428 ms |
| sandbox templated       |                      2 |                 23,071 ms | 43,512 ms |

[Open dispatch-to-claim average/maximum/count in Metrics Explorer](https://app.datadoghq.com/metric/explorer?start=1787097600000&end=1787951214323&paused=true#N4Ig7glgJg5gpgFxALlFOAzCA7CCID22KoATnAI4CucAzgrSgNpoS0AOANgIYCeA+gl7s4KEJxyiANCAwFSAWyo9GyFrPlKeY6nFK8ADCAC+U0HMXLuOmvoCMJsxsvbkIXfoBMJgLoyPEHTMaNwI3Py0BFSkAMaibgqIpBAxjDLY3Ik2eoYg-ra8YtwAbjDI3DDyAHRQ3HAKRFVwAB5wMVQI1eS69IIE-DFE2G0IcFA10aGE2PwKtMDoXAS8idgI-NDIcADs6AaeUDEAtABsdgYAnEcALBgAzCdHF9wArNtHl3AAHHCYd9zbO5fKRRBCDRLIQbYYYxUZQKQNdDITgEGLcTjGRwhMIRKKxeIgRIIZKpPIgDJZNweXgOfI5MQKbjNcqVUg1OoNbBNVrtTps7o0XqdAZDEZjCakKZEWbzRYolZwNYbKBbXZwfaHU7nK63B5PV7vT4-P4AoEgjrguCQ0WwsYIghIlFojFYkC1HGRaJxBlJFJpcmZAnU7x0-RiQZUNYs6q1eqNFptDpdSiC9bCqEwuESqUzOYLOBLBVKzY7PYHY5nS43e6PZ5vD4Xb6-e6m4Ggy3W6Fi+GIq1O9GY4x+EDkDhEWhwfgWRlINz4RIT5JBGT0XiceKgCTDQTCAmRCRQMlbyeQKAIAAWYmwmnRZPY6MQozEUAIMAGKloKRMQ5kQhEYnnOg9ECRhTHEPhQRIEBzzgCAYHPWc7BkU8LxQJCQGaNCZEKZA7GMMCOAkBAAGEiCwGAUGwZQMSAA)

At the first query time, Datadog reported percentile aggregation disabled for
this distribution. The correct change was to enable percentiles for this metric
and make its p95 the primary startup KPI, not to add another metric or redefine
its timestamps. Max subsequently enabled percentiles as recorded below.

A focused dashboard was created for the agreed KPI:
[Agor — Executor Pickup Latency](https://app.datadoghq.com/dashboard/6p2-pim-zy9).
It overlays p50 (dotted), p75 (dashed), and p95 (solid), with every query grouped
by `deployment_id`, plus a companion observation-count panel. `environment` and
`mode` are template filters and the widgets use a two-week window. The
percentile aggregation was enabled later on 2026-08-28 and metric metadata now
reports `is_percentiles_enabled: true`. An immediate p50/p75/p95 query over the
full ten-day window returned no data, while the baseline count/avg/max history
remained available. No historical percentile backfill is currently visible;
the saved chart should begin with post-enable observations. Its note was updated
accordingly.

### Production outlier validation

The daemon also logs the exact same DB-to-DB duration when the first executor
claim transitions the Task to `running`. DDSQL over indexed production logs
(`service:agor-daemon "Executor connected for task"`) produced 258 observations:

| Statistic | Production templated |
| --------- | -------------------: |
| mean      |             4,192 ms |
| p50       |             2,952 ms |
| p90       |             3,396 ms |
| p95       |             3,534 ms |
| p99       |            43,058 ms |
| maximum   |            66,428 ms |
| `> 5 s`   |       9 / 258 (3.5%) |
| `> 10 s`  |       9 / 258 (3.5%) |
| `> 30 s`  |       8 / 258 (3.1%) |

This is bimodal rather than a broad ordinary tail: there were no observations
between 5 and 10 seconds. Seven of the nine `>10 s` observations occurred in a
22-minute cluster on 2026-08-21, across three daemon hosts on build
`7c8b85ec...`; an eighth occurred on the same build later that day, and the
ninth was a 36,422 ms observation on build `add0c0c0...` on 2026-08-24. Several
connections landed at the same millisecond during the main cluster, consistent
with a shared launch/scheduling stall clearing in a burst. The service only
emits the log and metric on the first atomic `dispatching -> running` claim, so
ordinary idempotent reconnects do not duplicate these observations.

The two most recent production builds are qualitatively different in the small
available sample: 17 observations total, mean about 2.76 seconds, maximum 3.30
seconds, and none over 5 seconds. The current build's six observations in the
last 24 hours have p50 about 2.78 seconds and maximum 3.30 seconds. That agrees
with manual 2--3 second tests. The historical outliers therefore appear real at
the application boundary, but episodic and concentrated in older deployments;
the dataset does not establish whether the underlying cause was external pod
scheduling, image/runtime startup, networking, or another shared dependency.

[Open the redacted connection-log search in Logs Explorer](https://app.datadoghq.com/logs?from_ts=1787097600000&live=false&query=service%3Aagor-daemon+%22Executor+connected+for+task%22&stream_sort=desc&to_ts=1787952346879).

The related-assets lookup found only two dashboards and no monitors/SLOs using
these lifecycle metrics. Both dashboards currently mix queue-inclusive and
dispatch-to-connected panels. If queue dwell is intentionally out of scope,
remove `request_to_dispatch` and `request_to_connected` series from those
widgets, relabel them as dispatch-to-claim startup, and only then consider
stopping the two unused queue-inclusive emissions in a later code cleanup.

## Defects, biases, and residual risks

1. **The queue-inclusive companion name overstates its start.** “Request” in
   `request_to_*` begins at the durable Task insert, after browser/network and
   daemon pre-admission work. There is no literal user-submit timestamp.
2. **The queue-inclusive PostgreSQL metrics mix clock domains.** `created_at`
   uses Node wall time; `started_at` and `executor_connected_at` use PostgreSQL
   time. Those companion metrics can be skewed and negative skew is silently
   clamped to zero. The agreed `dispatch_to_connected` KPI is DB-to-DB.
3. **Connected is not provider started.** It is wrapper authentication/claim.
   There is no dedicated immutable metric for first `ToolRegistry.execute`, SDK
   request, token, progress event, or provider response.
4. **Heartbeat pulses cannot repair that gap.** `sdk_started` is recorded only
   after connection, coalesced with later pulses, normally transported on the
   heartbeat cadence, timestamped at daemon receipt, and absent for Cursor's
   watchdog path.
5. **Never-connected attempts are absent from latency percentiles.** Slow/failing
   ephemeral pods can make observed p95 look better, not worse. Always pair
   latency with claimed/connected/settlement counts and right-censoring care.
6. **Mode is under-specified for the requested product split.** `local` combines
   simple and sandbox; `templated` combines pods and every other command
   template. Deployment knowledge is required.
7. **External launch telemetry stops at the shell boundary.** Launch duration
   and process exit describe the local launcher, not pod scheduled/running/exit.
8. **HA instance grouping is easy to misread.** The daemon that claims a Task can
   differ from the one that launched it or accepts its connection. A
   `daemon_instance` group identifies the emitter for each event, not stable
   Task affinity. Per-instance launch/connection ratios are not reliable.
9. **The running gauge is process-local.** It excludes templated executors, can
   be stale after an ungraceful death, and must be summed across stable replica
   series with explicit no-data handling.
10. **Settlement clocks also mix.** Normal terminal patches commonly accept
    executor-supplied `completed_at`; external pod skew can affect execution
    duration metrics and negative values are again clamped.
11. **UDP is best effort.** The application samples every eligible event, but
    transport or Agent loss can create small count discrepancies.
12. **Parameterized prompt APM attribution collapses to `other`.** This prevents
    an exact APM prompt query and makes `other.create` potentially heterogeneous.
13. **Retries/reconnects are intentionally hidden after the first claim.** A
    normal idempotent reconnect does not duplicate the metric, which is correct
    for first-claim latency but provides no reconnect reliability measure.
14. **No Cloud deployment receipt was available.** Code parity alone is not
    proof that the external deployment is on this revision, exports StatsD, or
    uses the expected global tags.

## Why this audit did not change code

Concrete semantic defects exist, chiefly the mixed clock domain and the
parameterized Feathers attribution. Neither is a safe one-line metric fix:

- making `created_at` DB-authored changes Task repository timestamp semantics
  across SQLite/PostgreSQL, queue admission and tests;
- adding a true UI/request-arrival start requires a trusted, propagated
  timestamp contract and a decision about attachment/network/admission scope;
- adding pod lifecycle requires an explicit launcher/orchestrator reporting
  contract;
- changing Feathers normalization affects every custom parameterized route and
  existing Datadog series/resource names.

The requested metric already exists, is low-cardinality, and is deployed in the
observed sandbox. Redefining the series would add risk without improving the
agreed KPI. Therefore the resulting repository change is documentation only;
no runtime instrumentation was changed.

Publication validation on `2026-08-28` completed successfully:

- `pnpm check` (typecheck, lint, boundary checks and workspace build);
- the complete daemon suite (`290` files / `3,860` tests passed, with `26` files
  / `145` tests skipped by their existing gates);
- the focused core Task repository suite (`1` file / `117` tests passed).

## Actionable follow-up checklist

The official Datadog MCP connection, percentile setting and focused dashboard
are now in place. Remaining operational follow-up:

1. Generate post-enable observations in both the sandbox/local and known
   Cloud/templated deployments; Datadog did not immediately expose historical
   percentile data.
2. Use the [Executor Pickup Latency dashboard](https://app.datadoghq.com/dashboard/6p2-pim-zy9)
   to compare p50, p75 and p95 by `deployment_id` over 1h, 24h and 7d. Keep the
   observation-count panel visible with every comparison.
3. Compare claimed dispatches, connected events and distribution observations,
   plus settlement statuses. Exclude the newest 15--30 minutes when evaluating
   slow pod coverage to reduce right-edge censoring.
4. Ask Max for the authoritative Cloud deployment receipt: full build SHA,
   `deployment_id`, execution configuration showing the intended pod launcher,
   and confirmation that `metrics.statsd.enabled=true` with the same prefix.
5. Investigate another clustered tail event with launcher/orchestrator telemetry.
   The current daemon metric cannot distinguish pod scheduling, image startup,
   wrapper startup, networking or authentication within the interval.
6. Use APM only for pre-insert admission and launch preparation; do not present
   the prompt HTTP/Feathers span as dispatch-to-claim or provider-start latency.
7. Consider bounded follow-ups only if needed: an explicit launcher-kind tag,
   pod lifecycle telemetry, first-provider-progress telemetry, and outcomes for
   launches that never connect. Do not add tenant/user/session identifiers.

## Confidence and blockers

- **High confidence:** exact metric name, type, formula, code emission point,
  timestamp semantics, idempotency, tags/cardinality, default prefix, current
  and observed deployed code parity, and local-versus-templated behavior.
- **High confidence for observed sandbox:** StatsD and Datadog Agent enabled,
  standalone/sandbox local execution, revision, deployment ID, and the
  dispatch-to-connected log sample.
- **High confidence after live query:** the metric type, active deployment/mode
  series, available environment tags, observation counts, weighted means,
  maxima, and claimed/connected counter totals reported above.
- **Blocked or incomplete:** historical metric-native percentiles before the
  2026-08-28 enablement, Cloud build revision/launcher configuration, direct pod
  lifecycle stages, and reconstruction of never-connected attempt latency.

Primary code references:

- `apps/agor-daemon/src/metrics/task-lifecycle.ts`
- `apps/agor-daemon/src/metrics/statsd.ts`
- `apps/agor-daemon/src/metrics/index.ts`
- `apps/agor-daemon/src/register-routes.ts`
- `apps/agor-daemon/src/register-services.ts`
- `apps/agor-daemon/src/services/tasks.ts`
- `apps/agor-daemon/src/utils/spawn-executor.ts`
- `packages/core/src/db/repositories/tasks.ts`
- `packages/executor/src/cli.ts`
- `packages/executor/src/index.ts`
- `apps/agor-daemon/src/tracing/feathers.ts`
- `apps/agor-daemon/src/utils/feathers-instrumentation.ts`
- `context/explorations/daemon-statsd-metrics.md`

Official Datadog references:

- <https://docs.datadoghq.com/mcp_server/setup/>
- <https://docs.datadoghq.com/mcp_server/tools/>
- <https://docs.datadoghq.com/account_management/rbac/permissions/>
- <https://docs.datadoghq.com/extend/dogstatsd/data_aggregation/>
- <https://docs.datadoghq.com/metrics/custom_metrics/dogstatsd_metrics_submission/>
- <https://docs.datadoghq.com/metrics/distributions/>
- <https://docs.datadoghq.com/metrics/advanced-filtering/>
- <https://docs.datadoghq.com/dashboards/functions/rollup/>
