# Agor daemon operational log audit — 2026-08-28 (UTC)

**Status:** read-only production analysis snapshot. The audit itself made no
service, configuration, database, GitHub, or production-state changes; the
small local logging cleanup described below is tracked in this branch and is
pending deployment.

## Scope and handling

- Primary window: `2026-08-28 00:00:00`–`05:30:00 UTC` (the available
  current-day cut-off), with a baseline from `2026-08-25 00:00:00` through the
  cut-off (approximately 77.5 hours).
- Journal messages were counted by normalized message/category and severity;
  repeated stack frames and identifiers were not treated as separate events.
- Identifiers below are aliases or short build prefixes. No tenant names,
  prompts, emails, tokens, socket IDs, channel IDs, request payloads, or raw
  database records are retained here.

## Deployment and topology inventory

| Item                           | Observation                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host                           | One visible host, `agor-2`, UTC; host boot `host-boot-a` (2026-08-01 10:48 UTC).                                                                                                                                                                                                                 |
| Daemon                         | One active `agor-daemon.service` replica, systemd `Restart=on-failure`, `NRestarts=0`; current invocation `daemon-invocation-c` started 2026-08-27 06:15:34 UTC. Output is systemd journal.                                                                                                      |
| Build                          | Package `0.25.2`; deployed commit `6a0074c1` (APM/Postgres tracing, PR #2571), built 2026-08-27 06:00:20 UTC.                                                                                                                                                                                    |
| Runtime                        | Node 22; standalone task-runtime policy; PostgreSQL backend; sandbox execution/RBAC enabled; task reconciler, scheduler, gateway listener, and embedding loops started.                                                                                                                          |
| Ingress                        | Nginx active since 2026-08-01; WebSocket proxy listens on the configured public listener and forwards to daemon port 3031 (daemon startup confirms 3031). Nginx access/error files are present but unreadable to this audit account; systemd journal has no request-level entries in the window. |
| Redis/PostgreSQL host services | No host `postgresql`, `redis`, or `redis-server` units/processes. Daemon connects to remote PostgreSQL. No Redis adapter/readiness/loss event appears in the daemon journal; standalone mode is expected.                                                                                        |
| Containers                     | A named HA integration-test stack (two daemons plus Redis/PostgreSQL) and many branch/dev containers are running. It was excluded from application-log sampling because it is not the deployed production daemon and logs could contain tenant/test content.                                     |
| Retained files                 | No usable local daemon log directory; the local SQLite placeholder is empty. Executor output is captured in the daemon journal. No task-list/API dump or credential/config inspection was performed.                                                                                             |

## Quantitative results

### Volume and restarts

Daemon journal volume (all priorities): Aug 25 **156,063**, Aug 26
**108,785**, Aug 27 **123,625**, Aug 28 00:00–05:30 **17,134**. The service
had deliberate shutdown/restart windows around Aug 27 00:08, 02:46, and
06:15; the last is the current build. The 00:08 and 02:46 windows include
`SIGTERM`, socket closure, heartbeat-loss containment, and a close-timeout;
06:15 is the deployed-build cutover. These are not systemd crash restarts.

### Socket and task signals

| Normalized signal                         | Aug 25 | Aug 26 | Aug 27 | Aug 28 to 05:30 | 77.5h total |
| ----------------------------------------- | -----: | -----: | -----: | --------------: | ----------: |
| Literal `socket has been disconnected`    |      5 |      3 |     11 |           **1** |      **20** |
| Main socket `server namespace disconnect` |  1,971 |  1,820 |  2,286 |         **338** |       6,415 |
| Main socket `ping timeout`                |    419 |    191 |    409 |          **44** |       1,063 |
| Main socket `transport error`             |     28 |     26 |     83 |          **18** |         155 |
| Executor `io server disconnect`           |    122 |     33 |     89 |          **17** |         261 |
| Executor `io client disconnect`           |    188 |    237 |    197 |          **30** |         652 |
| Permission request timed out              |      8 |      4 |     16 |           **2** |          30 |
| Durable terminal task failed              |     32 |      8 |     33 |           **2** |          75 |
| Durable terminal task completed           |  1,630 |  1,738 |  1,949 |         **320** |       5,637 |

The literal had one current-day occurrence at **01:10:46.212 UTC**. Its
normalized sequence was: permission timeout → timeout state update → main
`server namespace disconnect` → executor `io server disconnect` →
`canUseTool` error with the literal. Fifteen of twenty historical literals
have this permission-timeout shape. The remaining five are startup/deploy or
short-lived metadata/write operations (including two during restart windows).

The current-day durable failures were:

1. 00:37:53 (short task, executor exit code 1) with no socket-literal or
   matching disconnect in that task's process context.
2. 04:54:22 (about 211 s) following a 04:53:11 server-namespace wave; the
   executor disconnected after ~140 s, scheduled an immediate reconnect, then
   provider execution failed, heartbeat write retried, and the task settled
   failed. No literal was emitted because no outstanding Feathers terminal
   acknowledgement was observed in the failure path.

There were **25** same-second waves of at least five main
`server namespace disconnect` events. In the current build invocation there
were seven waves; 52 active executor/task contexts were near those waves,
with 17 failed, 17 completed, and 13 without a terminal projection within the
30-minute correlation window. The largest current-day wave was 04:53:11 (15
main sockets; three executor contexts; one task failure). Clients
reauthenticated within roughly a second. No restart, Redis loss, or host
resource event coincided with it.

### Other normalized signals

- `unhandled promise rejection`: 247 root events in the baseline, 2 in the
  current build window (one at 04:54:27 after two Slack SDK errors). 211
  historical roots carried the quoted reason `undefined`; the prior burst
  subsided after the current deployment.
- `DATADOG TRACER CONFIGURATION`: 2,764 lines after the APM rollout (2,363 on
  Aug 27 and 401 current-day), often one full configuration object per child
  process.
- Historical gateway `flushOutboundBuffer: no thread mapping`: 8,142 (429
  current-day), with bursts up to 98/minute. This is expected for new
  conversations and non-gateway sessions; the local cleanup removes the log
  entirely rather than replacing it with debug noise.
- Git-state/not-a-git-repository diagnostics: 2,864 (181 current-day). These
  are probes against branch paths that were not valid Git worktrees at probe
  time (including broken/stale worktree metadata); the logs do not establish
  whether the cause was branch cleanup, mount visibility, or a storage-mode
  mismatch.
- Expired-JWT authentication failures: 745 baseline root messages (28
  current-day), fail-closed behavior with repeated stack/object lines.
- Slack Socket Mode heartbeat timeout: 478 baseline (43 current-day).
- `ws_active_connections` gauge: 953 baseline (66 current-day), approximately
  every five minutes.
- Current-day executor exits: 357 (346 code 0, 6 code 1, 5 null); no OOM or
  cgroup memory events. Host had ample memory/CPU/IO headroom and no swap
  pressure.

### Git-state capture path and branch storage modes

Production call-site inspection found `getGitState` only in the prompt
executor's start/end capture helpers (the shared SDK base executor and the
Cursor executor). The daemon has no branch-state polling path and does not
spawn an executor solely to read Git state. Every one of the 2,855 baseline
(148 current-day) `getGitState` failure events came from a PID that also had a
preceding executor task-start marker; there were zero failure events from a
PID without that marker. Separate one-purpose `git.branch.clean/remove`
executors exist for branch filesystem lifecycle work, but they do not call
`getGitState`.

The helper itself is storage-mode agnostic: it asks Git for `--git-dir`, then
`HEAD` and clean/dirty state. For a linked worktree, executor launch resolves
the authoritative base repository from the branch row and the sandbox
re-exposes that base `.git` alongside the branch directory. Clone mode relies
on the branch's own `.git`; no base repository is required. Thus the check is
not using a daemon-side checkout or an inherently wrong path. A missing branch
directory, stale linked-worktree pointer, incorrect storage metadata, or a
sandbox mount/visibility race can still make a correct check return
`unknown`.

There is a concrete lifecycle correlation worth investigating: across the
baseline, 21 failure events (10 unique paths) occurred within five minutes
_after_ a same-path branch filesystem action, and 26 (10 paths) within fifteen
minutes. Fifteen distinct current-day failed paths were absent when checked
afterward. This is temporal evidence, not proof of causality. In source,
`archiveOrDelete` can archive a branch and asynchronously dispatch filesystem
deletion without the `assertNoUnfinishedTasks` guard used by hard-delete
`remove`; deletion removes the worktree/clone directory. An active prompt can
therefore lose its checkout before its end snapshot. A linked-worktree mount
problem remains an alternative and needs a reproducer.

The prompt route currently auto-unarchives an archived **session**, but not
its archived branch. It then admits the Task without checking the branch's
`filesystem_status` or verifying the working directory; `spawnTaskExecutor`
passes the stored path to the executor. A direct prompt to a session whose
branch was archived with `filesystemAction='deleted'` can therefore be
accepted against a deliberately absent checkout. This path is not proven to
explain the observed waves, but it is a concrete gate gap. A safe follow-up is
to reject (or explicitly restore) deleted/creating/failed branch filesystems
before admission, while avoiding a hidden branch resurrection and avoiding a
new executor solely for every normal Git snapshot.

There were 14 session auto-unarchive events in the 77.5-hour baseline and
none in the current-day slice. 131 `getGitState` failure lines fell within
five minutes of one of those events, but the logs lack a safe session/branch
join for those records and the overall probe rate is high; this is only a
weak temporal signal, not attribution.

The UI intentionally hides a SHA equal to `unknown`. Most captures remain
valid (8,788 valid versus 2,855 unknown snapshots in the baseline; 526 versus
about 148 current-day), while unknown snapshots can belong to archived or
removed sessions. Consistently seeing before/after values in visible task
headers is therefore compatible with these failures and does not imply a
second, zombie Git-state caller.

Two utility comments still describe "daemon-internal ... git-state probes" as
an example of `requestExecutor`/sandbox work. They are stale wording left from
the pre-#1258 layout, not an additional call site; updating those comments is
safe cleanup but would not change runtime behavior.

## Interpretation and limitations

The daemon's `invalidateTenantAuthorization` path intentionally loops over all
sockets for a tenant and calls `socket.disconnect(true)`. The source emits
no durable audit event naming the mutation, tenant-safe correlation, or
initiator. Therefore the repeated non-restart waves with immediate
reauthentication are **consistent with** broad authorization invalidation (and
the code path is the leading hypothesis), but the journal cannot prove which
RBAC/token/branch/board mutation initiated any wave. Network rotation,
proxy behavior, and a remote control-plane action remain alternatives; the
unreadable Nginx request/error logs prevent ruling those out.

PR #2545 (terminal-write acknowledgement before revocation teardown) is in
the deployed ancestry. The literal is still an expected socket.io-client
ack-drain symptom when a socket closes while a Feathers acknowledgement is
pending; current evidence does **not** demonstrate a regression of the
terminal-ACK race. The one current literal is tied to a permission timeout,
not a durable terminal projection.

Main currently contains PR #2555 (normalized board/branch capability policy)
and later commits not in the deployed build. Its changed invalidation hooks
are a deployment-drift consideration only; this audit does not attribute the
current waves to that not-yet-deployed code.

## Prioritized follow-up queue

1. **P1 — authorization-eviction wave attribution (separate branch/issue).**
   Add a bounded, tenant-safe invalidation event ID and initiator category;
   count sockets/active executors evicted and task outcomes; correlate with
   the mutation transaction. Decide whether active executors should be
   drained or exempted for narrowly scoped additive changes. Do not weaken
   fail-closed authorization.
2. **P1 — active-turn disconnect handling (separate branch/issue).**
   Reproduce the 04:53 pattern with a task/session-safe correlation ID and
   verify reconnect/heartbeat/settlement behavior after a server namespace
   close. Preserve the deployed #2545 terminal-ACK ordering tests; add a
   regression test only if an active-turn loss is confirmed.
3. **P2 — socket literal/permission timeout instrumentation (bounded branch).**
   Record ACK-pending count, request class, socket close reason/initiator, and
   terminal-ACK observed (all redacted/structured). This will distinguish a
   permission timeout from a terminal ACK race without logging payloads.
4. **P2 — ingress evidence.** Obtain least-privilege, redacted Nginx
   WebSocket close/upstream status and latency counters. Compare proxy
   rotation/ping timeout intervals with daemon waves before changing retry
   policy.
5. **P2 — gateway rejection (separate issue).** Classify the Slack SDK error
   and `undefined` unhandled-rejection path; ensure one bounded error category
   and no daemon-wide rejection storm. The current-day event is temporally
   adjacent to, but not proven causal for, the task failure.
6. **P3 — log hygiene/metrics (small observability branch).** Demote or
   rate-limit full Datadog configuration, Git SHA sandbox diagnostics,
   expired-JWT stacks, and five-minute gauges; retain counters and sampled
   exemplars. The expected missing gateway mapping path is now silent.
7. **P1/P2 — Git snapshot versus branch lifecycle (separate issue/branch).**
   Reproduce archive/delete during an active prompt in both clone and linked
   worktree modes. Decide whether filesystem deletion must wait for task
   terminality/quiescence (or be rejected while work is active), and add an
   integration test for sandbox mounts and linked-worktree `.git` metadata.
   Independently classify missing-path, stale-pointer, and mount-denied
   outcomes before demoting the existing warnings.
8. **P2 — archived-session prompt gate (small, separately testable).** The
   route currently restores the session flag but not the branch/filesystem.
   Decide whether prompting a branch with `filesystem_status='deleted'`,
   `creating`, or `failed` should return a clear conflict and require explicit
   branch unarchive/recreation. Include a race test between archive cleanup and
   prompt admission; do not silently resurrect an intentionally archived
   branch.
9. **P2 — contextual Git-state warning (implemented locally, pending deploy).**
   The prompt executor now adds short session, task, and branch IDs plus phase,
   `storage_mode`, `archived`, and `filesystem_status` to one contextual
   warning. The generic Git helper returns its documented `unknown` sentinel
   without logging path-only diagnostics, avoiding duplicate warning noise.
   This uses the existing capture wrapper context and no extra executor/process.

## Expected / fail-closed (“nothing actionable” by itself)

- Executor `io client disconnect` after a terminal task and one
  `server namespace disconnect` per explicit executor retirement are normal.
- JWT expiry, invalid/expired executor credentials, token-terminal, and
  authority-revoked messages are correct fail-closed security behavior; only
  their volume/level needs tuning.
- Ping timeouts and transport errors are client/network symptoms without host
  pressure evidence; they need ingress correlation, not an authorization
  relaxation.
- Deployment SIGTERM, orphan cleanup, task containment, and startup loop
  messages are expected around deliberate restarts.
- A missing gateway thread mapping during outbound-buffer flushing is expected
  for new conversations and non-gateway sessions; absence alone is not an
  operational event.
- Git-state failures are not proof of task loss, but they are not automatically
  benign sandbox noise either. Investigate branch/worktree lifecycle and
  sandbox visibility separately; only demote them after the cause is known.

## Observability gaps recorded

The current logs lack a bounded socket namespace, initiator, invalidation
event ID, adapter/replica ID, tenant-safe hash, task/session-safe hash,
ACK-pending/ACK-observed state, and a durable disconnect-to-settlement link.
There are no production-visible counters for disconnect reason × initiator,
active-executor eviction, reconnect success/attempt, ACK timeout, or task
failure-after-disconnect. Nginx evidence is not available to the daemon
operator account, and standalone mode emits no Redis adapter health state.
