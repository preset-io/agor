# Web terminal ownership and HA contract

Status: proposed 1.0 contract, implemented on this branch (August 2026)

## Decision

Agor does not distribute, migrate, or durably resume PTYs. A web terminal is an
ephemeral attachment owned by one daemon boot and scoped to exactly one trusted
tenant, user, and branch.

The browser creates the attachment through its authenticated Feathers
Socket.IO connection. The response contains a random `terminalId`, the daemon
instance/boot owner, and a tenant/user/terminal-qualified local room. Browser
input, resize, executor output, and readiness all carry that terminal ID and
remain Socket.IO `.local`; terminal contents and commands never enter Redis.
The executor capability is fenced by tenant, user, branch, terminal ID, and
owner boot ID. A capability minted by daemon A cannot be adopted by daemon B or
by a replacement boot of A.

Owner loss ends the Agor attachment. The UI displays **Disconnected** and
requires an explicit **Reconnect**. Reconnect creates a fresh PTY bridge. It
may reattach to a surviving Zellij shell on the same runtime, but Agor makes no
transport-resume guarantee and has no server-side scrollback replay.

## Root architecture map

| Layer            | Durable/shared                                                         | Owner-process local                                                 |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| UI               | branch ID in the open-modal model                                      | xterm instance, scrollback, attachment ID, connection state         |
| Database         | tenant, user, branch, RBAC and Unix identity metadata                  | no terminal row, owner lease, output, or command history            |
| Terminal service | none                                                                   | attachment registry, same-scope start barrier, ready state          |
| Socket.IO        | authenticated tenant context; Redis handles ordinary HA realtime       | terminal room, active executor socket, rate limiter, all PTY frames |
| Executor         | user home/current branch mounts supplied by the runtime                | node-pty, output coalescer, Zellij attach client                    |
| Zellij           | configuration/serialization under effective home when storage persists | live Zellij server/socket and shell process                         |

For first creation Agor uses Zellij's new-session path, not `attach --create`:
the bundled Zellij 0.43 accepts the latter but does not retain it as an exited,
resurrectable session. A preflight distinguishes known active/exited sessions;
the new-session form also attaches if another shared-host replica wins the
active-session creation race.

The executor sets `ZELLIJ_SOCKET_DIR` beneath the effective-home cache. In the
supported shared-host topology that directory is a local volume mounted into
each daemon container, so all replicas see the same Unix socket and therefore
the same live Zellij server. A home mounted over NFS across hosts does not make
Unix sockets cross-host; that topology remains unsupported rather than being
mistaken for persistence.

The old one-executor-per-user / one-Zellij-tab-per-branch abstraction was
removed. It assumed that one process could see every branch checkout and caused
browser tabs and branches to share one input stream. The session name is now
stable per tenant/user/branch, and every executor gets a server-derived branch
cwd. No client can choose cwd or Unix identity.

## Failure semantics

- Browser refresh loses xterm scrollback. Reopening may reuse the still-live
  attachment on the same owner; otherwise reconnect creates a new attachment.
- Browser/daemon transport loss is visible and never triggers silent creation.
- Daemon or pod death loses the PTY and process-local registry. Its boot-fenced
  executor token is rejected by all replacement owners.
- Redis outage does not put PTY bytes at risk. A same-owner terminal can
  continue locally until broader HA readiness/ingress policy removes the
  replica; no terminal replay exists.
- Archive/delete emits only tenant-qualified branch lifecycle metadata across
  replicas and retires matching local attachments. If coordination is
  unavailable, remote cleanup is best-effort and the removed workspace remains
  the ultimate filesystem boundary.
- Logout or authentication replacement removes terminal rooms immediately, so
  the old socket receives no further output and cannot send input.
- Closing the modal removes the attachment and asks its executor to shut down.
  Agor intentionally quits the live Zellij server rather than retaining an
  unbounded background process. Zellij serializes layout, cwd, viewport, and
  up to 1,000 lines of scrollback beneath the effective user's home; a later
  attachment may resurrect that bounded context with new processes.
- There is not yet an idle timeout. Orphan executors exit after their daemon
  connection grace expires; adding a bounded attachment idle timeout remains
  desirable.

## Compatibility matrix

| Topology                                      | 1.0 status                                                                             | Contract                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Local, `simple`                               | Supported with warning                                                                 | Replica-local PTY as daemon user; daemon ambient authority risk remains explicit                                                          |
| Local, `insulated` / `strict`                 | Supported                                                                              | Server resolves effective Unix user; cwd is the authorized branch                                                                         |
| Two daemons, shared host/storage              | Supported, ephemeral transport with optional shell resurrection                        | PTY bytes stay owner-local; the effective home and its Agor-managed Zellij socket directory must be the same local mount in every replica |
| Multiple daemons, separate hosts              | Safely disabled                                                                        | A shared/NFS home does not carry a live Unix socket or PTY across kernels; no cross-host Zellij or PTY migration                          |
| Ephemeral Kubernetes task executors           | Safely disabled                                                                        | A one-shot task pod is not a terminal owner                                                                                               |
| External executor command template            | Safely disabled                                                                        | Callback ingress is not yet owner-affine                                                                                                  |
| Persistent or scale-to-zero workspace runtime | Future/preferred                                                                       | Runtime should own Files, terminal, optional IDE, mount lease, and reconnect semantics                                                    |
| Agor Cloud / managed private cloud            | Disabled unless deployed as supported shared-local; otherwise future workspace runtime | Capability endpoint hides UI when unsupported                                                                                             |

The public health response advertises `webTerminalCapability` with
`owner-local-ephemeral` or a disabled reason. `allow_web_terminal: false`
remains the operator kill switch. HA external execution must keep terminals
disabled.

## Security boundary

1. Global member-role and branch `session` permission gates run before spawn.
2. Branch lookup always uses the active tenant database scope and normalized
   Branch authorization.
3. Terminal create is Socket.IO-only, binding control and PTY traffic to the
   same owner connection. REST creation is rejected.
4. Raw rooms contain tenant, user, and random terminal ID. Browsers and
   executors must match the authenticated tenant and capability scope.
5. Executor JWTs have no Feathers/REST privilege. Their terminal scope also
   includes branch, terminal, and owner boot fencing.
6. Input is accepted only from a user socket currently joined to that exact
   local attachment and is routed to one active executor socket.
7. No PTY bytes, commands, environment values, or contents are logged or sent
   through Redis. Logs use short identities and lifecycle metadata only.

## Relationship to Files and IDE

The branch-files direction remains the long-term architecture. A persistent or
scale-to-zero workspace runtime can own the branch mount lease and expose a
narrow Files API, terminal transport, and optional IDE together. The daemon
should remain the authorization/capability resolver, while ephemeral task
executors remain independently scheduled consumers of the branch. This patch
does not make the daemon a general remote workspace or add a distributed PTY
protocol; it makes the current local runtime honest and replaceable.

## Non-goals and follow-ups

- live PTY migration, Redis output replay, distributed scrollback;
- treating Zellij home files as proof that a live session exists on another
  host/container;
- promising resurrection of PIDs, shell variables, or running process state;
- external terminal runtime support before it can return an owner-affine
  callback/capability;
- multiple independent terminals for the same user/branch on one owner (1.0
  reuses one live attachment; separate branches are independent);
- a durable terminal inventory. If future product needs audit/lifecycle state,
  store metadata only, never terminal contents.

## Managed HA evidence (2026-08-11)

The two-daemon `ha` harness built and started with this contract and advertised
`webTerminalCapability: { enabled: true, mode: "owner-local-ephemeral" }`.
An authenticated Socket.IO smoke test created a branch-scoped attachment on
`daemon-b`, coalesced concurrent same-scope creates to one terminal ID,
observed bidirectional output, sent resize, and verified the server-derived cwd,
effective uid 1000, and `/home/agor` home. Both daemon containers were healthy.
Direct daemon-A/daemon-B probes then confirmed that a non-owner replica neither
forwarded input nor received output, while the owner continued normally. Killing
the owner disconnected the browser and a new attachment was created on the
survivor with a new terminal ID and boot fence. Established owner-local I/O also
continued during a Redis outage, and recovered after Redis returned. Archiving
a branch retired attachments on both replicas using only tenant/branch lifecycle
metadata; archived branches reject new terminal creation.

A separate Zellij check closed the Agor attachment, created a new terminal ID,
and reused the same stable session name. The exported shell variable did not
survive because Zellij resurrection recreates panes rather than checkpointing
process memory. This is the intended distinction: Agor transport persistence
is never promised, and Zellij shell resurrection is an independently
deployable/runtime-specific feature, not inferred from a persistent home
volume.

## Live browser evidence (2026-08-12)

Playwright exercised the managed HA UI through nginx rather than direct daemon
endpoints. The terminal opened from a session action and reported the trusted
branch cwd, uid/gid 1000, `/home/agor`, and a branch-scoped Zellij session.
Viewport resizing changed the PTY from 29x126 to 24x88. Explicit close/reopen
created a new shell PID and did not retain an exported variable; a short browser
refresh instead reattached the still-live attachment and retained its PID and
variable, which is allowed but not promised.

Two browser tabs reached different ordinary HTTP replica labels while their
terminal sockets were both confirmed in daemon-A lifecycle logs. Both attached
to the same branch-scoped Zellij shell and saw the same shell PID/output. Stopping
non-owner daemon B did not disturb either terminal. After restoring B, stopping
confirmed owner daemon A made both modals show **Disconnected** with an explicit
**Reconnect** button. Reconnect created a fresh attachment on B with a new
container hostname and shell PID, and the previous shell variable was absent.
Both replicas were restored healthy afterward, and closing the Playwright pages
left no `zellij.attach` executor processes behind.

## Zellij home-resurrection evidence (2026-08-12)

The bundled Zellij 0.43.1 was tested separately from the Agor transport. Its
`attach --create` path did not leave an exited, resurrectable session, while a
true new-session launch with serialization enabled did. Agor now preflights the
stable tenant/user/branch session name: known active or exited sessions use
`attach`; an absent session uses the new-session path with attach-on-race
enabled. Runtime options pin force-close serialization, pane viewport capture,
1,000 scrollback lines, and a one-second serialization interval without
overwriting the user's cosmetic Zellij configuration.

The rebuilt managed HA environment then provided an end-to-end proof. A branch
terminal changed to `/tmp`, printed a marker, and ran `sleep 300`. The effective
home contained a mode-0700 session cache whose serialized layout recorded the
`/tmp` cwd and `sleep` pane. Replacing both daemon containers killed the owning
PTY but preserved that cache. Reopening through the UI resurrected the stable
session with the command behind Zellij's safety confirmation rather than
silently restarting it. Both daemon containers reported the same live session
and could query its tab through the mode-0700
`$HOME/.cache/zellij/sockets` directory, proving that the supported same-host
topology has one Zellij server rather than two replicas misreading shared cache
metadata. Explicitly closing the modal made both replicas report the session as
`EXITED - attach to resurrect`; reopening made both report it active again.

This does not expand isolation. In `simple` or `insulated` mode, users sharing
one effective Unix uid/home can already inspect and control one another's
processes and files; the stable tenant/user/branch names prevent accidental
reuse but are not an OS security boundary. `strict` and delegated runtimes use
per-user effective homes when the execution substrate provides them.
