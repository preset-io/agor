# Daemon StatsD/DogStatsD metrics foundation

Status: implemented foundation and deliberately bounded first metric set.

## Choice

Agor uses [`hot-shots`](https://github.com/bdeitte/hot-shots) behind an
Agor-owned `DaemonMetrics` interface. Datadog lists hot-shots as a community
DogStatsD client, it supports current Node releases and TypeScript, and it
already owns UDP formatting, tag escaping, socket errors, flush, and close.
The optional native `unix-dgram` addon is disabled because Agor uses UDP.

References: [Datadog DogStatsD](https://docs.datadoghq.com/developers/dogstatsd/),
[Datadog metric types](https://docs.datadoghq.com/metrics/types/), and
[OpenTelemetry JS exporters](https://opentelemetry.io/docs/languages/js/exporters/).

A direct `node:dgram` implementation would be less dependency code but more
Agor-owned protocol, socket, DNS, sanitation, buffering, and shutdown code.
OpenTelemetry metrics are stable, but an SDK, reader, exporter, and usually a
Collector are materially more infrastructure than a local DogStatsD Agent
requires. The internal interface leaves room for a future OpenTelemetry
exporter without putting OTel SDK objects throughout daemon services.

## Before and after

Before:

```text
daemon modules -> console logging
daemon modules -> curated analytics / community telemetry
```

There was no operational metric lifecycle or request-wide instrumentation.

After:

```text
config.yaml + supported env overrides
              |
              v
immutable effective config snapshot
              |
              v
composition root -> app.set("metrics", DaemonMetrics)
                         |
       +-----------------+-------------------+
       |                 |                   |
Express middleware  Feathers around hook  lifecycle seams
       |                 |                   |
       +-----------------+-------------------+
                         |
                  hot-shots UDP client
                         |
                  local Datadog Agent
```

The Feathers application owns the dependency and its socket lifecycle. Modules
use `getDaemonMetrics(app)`, which returns the application-owned metrics
abstraction or the shared no-op. This follows Agor's existing application-owned
config, database, work identity, scheduler, and monitor dependencies without a
mutable process singleton or constructor changes across every service.

Both passive boundaries are needed:

- Express middleware observes real HTTP method/status/latency for REST, raw
  API, probes, and MCP. It accepts only Express route templates or registered
  Feathers service templates and otherwise emits `/_unmatched`; raw paths are
  never tags.
- The global Feathers around hook observes logical service/method/result for
  REST and Socket.IO. Calls without `params.provider` are internal and skipped,
  preventing recursive double-counting. A REST request intentionally produces
  one HTTP signal and one Feathers signal because they describe different
  layers.

Static/UI traffic, CSP reports, and the OAuth callback are intentionally
outside the first metric set. The middleware runs before API body parsing, so
parser-generated 4xx responses are included.

## Metric inventory

The default prefix is `agor.daemon.`. Names below omit that prefix.

| Name                                         | DogStatsD type | Tags                                                       | Semantics                                                |
| -------------------------------------------- | -------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `http.requests`                              | count          | `method`, `route`, `status_code`, `outcome`                | Completed/aborted instrumented HTTP requests             |
| `http.request.duration_ms`                   | distribution   | same                                                       | Middleware entry to response finish/close                |
| `feathers.requests`                          | count          | `service`, `method`, `transport`, `outcome`, `status_code` | External logical service calls only                      |
| `feathers.request.duration_ms`               | distribution   | same                                                       | Whole external Feathers hook duration                    |
| `executors.running`                          | gauge          | `mode=local`, `scope=process_group`                        | Absolute local process groups tracked by this daemon     |
| `executor.dispatches`                        | count          | `mode`, `outcome`                                          | Durable dispatch-claim attempts/results                  |
| `executor.request_to_dispatch.duration_ms`   | distribution   | `mode`, `outcome=claimed`                                  | Persisted Task `created_at` to DB-authored `started_at`  |
| `executor.connections`                       | count          | `mode`, `outcome=connected`                                | First authenticated executor claim                       |
| `executor.dispatch_to_connected.duration_ms` | distribution   | same                                                       | `started_at` to `executor_connected_at`                  |
| `executor.request_to_connected.duration_ms`  | distribution   | same                                                       | `created_at` to `executor_connected_at`                  |
| `executor.launches`                          | count          | `mode`                                                     | Local executor child or external launcher child spawned  |
| `executor.launch.duration_ms`                | distribution   | `mode`                                                     | Execute-handler entry through preparation to child spawn |
| `executor.process_exits`                     | count          | `mode`, `outcome`                                          | Local executor/templated launcher child exit callback    |
| `task.settlements`                           | count          | `mode`, `status`                                           | Terminal Task transition observed by the Tasks service   |
| `task.execution.duration_ms`                 | distribution   | same                                                       | `started_at` to `completed_at`                           |
| `task.connected.duration_ms`                 | distribution   | same                                                       | `executor_connected_at` to `completed_at`                |
| `background_job.runs`                        | count          | `job`, `outcome`                                           | Bounded startup post-job completion                      |
| `background_job.duration_ms`                 | distribution   | same                                                       | Startup post-job wall time                               |

Configured global tags plus `daemon_instance` and `deployment_mode` accompany
every metric. Runtime tag keys are allow-listed in code. Tenant/user/session/
task/branch/repository IDs, model names, prompts, raw paths, and arbitrary
errors are not emitted.

Distributions are used for cross-agent percentile aggregation. The one gauge
is an absolute current value. Counts represent events; there is no sampled
counter behavior in this foundation. Histogram and timing methods remain on
the abstraction for modules with Agent-local histogram or plain StatsD timer
needs, but the initial latencies use distributions for correct fleet-wide
DogStatsD percentiles.

## Running executor and HA contract

“Running executor” means a **local executor process group present in this
daemon process's authoritative tracking registry**. A leader exit does not
decrement the gauge because managed descendants may still exist. The gauge
decrements only when containment/settlement releases the tracked identity.
Templated/external executors are excluded; their launcher process is not the
remote executor.

The daemon emits the registry's absolute size, including zero immediately at
startup and zero before graceful metrics shutdown. After a restart the new
process owns an empty registry; standalone startup cleanup handles durable Task
repair separately. An ungraceful death can leave Datadog displaying the last
gauge value until the series becomes stale or the stable instance restarts, so
alerts must also handle no-data/staleness.

Every series has a stable `daemon_instance` dimension and never a boot ID. In
HA the gauge is per replica, not a global last-writer-wins gauge. Fleet queries
sum by/over `daemon_instance`. Set stable unique
`AGOR_DAEMON_INSTANCE_ID` values. An HA replica without one disables its
StatsD exporter and warns at startup.

## Executor timestamp honesty

Existing persisted timestamps support request-to-dispatch, dispatch-to-
connected, request-to-connected, and terminal durations. They do **not** prove
when an SDK/provider began processing the prompt. `executor_connected_at`
means the authenticated wrapper claimed the Task, not first SDK progress.
Therefore no metric is named “processing begins.” Measuring that requires a
new immutable first-progress timestamp or event at the executor/SDK boundary.

## Lifecycle and failure contract

- Construction happens once at daemon composition. Disabled config never
  creates a socket.
- Hot-shots receives an error handler; every adapter call also catches
  synchronous failures. Initialization failure falls back to no-op.
- UDP loss or an absent Agent never changes product behavior.
- Shutdown is idempotent, emits the final process-local gauge, and bounds the
  hot-shots close callback. `close()` flushes hot-shots' pending transport
  state before closing its socket.
- Config is startup-only. Executors consume their existing resolved executor
  slice and never load or receive metrics config.

## Multi-tenancy classification

Operational metrics are intentional system/global infrastructure. No
tenant-owned resource is selected, persisted, or crossed, and tenant context
is not an allowed metric dimension. This is narrower than analytics: metric
tags describe bounded daemon/control-flow categories only.

## Deliberately deferred seams

1. Persist a first SDK-progress timestamp, then add an honestly named
   request-to-first-progress distribution.
2. Add queue-worker scan/claim/empty/error metrics after defining one durable
   fleet ownership contract and bounded reason vocabulary.
3. Add database query metrics through one dialect-neutral repository/driver
   boundary with code-defined operation names; do not tag SQL or resource IDs.
4. Add Redis adapter/realtime delivery health counters at the Redis runtime
   boundary. Feathers Socket.IO calls are already covered; high-frequency raw
   stream events are not.
5. Add scheduler, health monitor, knowledge indexer, and termination-
   coordinator metrics only where each worker has authoritative claim/result
   outcomes. Avoid generic timer-by-callback names.
6. Consider event-loop lag and process CPU/memory through standard runtime
   integrations rather than hand-rolled high-frequency gauges.
