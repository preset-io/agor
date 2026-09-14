# Codex device authentication in HA

## History and former risk

The constrained-active-active guard was added in commit `803b965f` (PR #2230)
when HA support first shipped. At that point `codex-device-auth.ts` owned one
process-local `Map` and timer per user. Issue #2345 recorded the deliberate
follow-up. Later credential-home work made `auth.json` replica-consistent, but
did not change attempt ownership; the guard was therefore not stale.

The old flow was unsafe to admit in HA:

- a create on replica A was invisible to status requests routed to B;
- a restart lost the provider device identifiers and polling timer;
- two replicas could issue and poll separate codes for the same tenant/user;
- object identity, rather than a deployment-wide generation, fenced the final
  credential write; and
- import/logout did not serialize with a device-flow completion on another
  replica.

PR #2449 documented the target design and an empirical provider observation:
polling an approved Codex device grant again returned the same authorization
code/verifier. That makes a short duplicate-poll window during lease takeover
tolerable. It does **not** make authorization-code exchange replay safe, so the
exchange remains a separate one-shot claim.

## Current state machine

PostgreSQL HA uses `codex_device_auth_attempts`; standalone SQLite deliberately
keeps the former in-memory implementation.

```text
starting --provider grant--> pending --poll approval + CAS--> exchanging
    |                         |                                  |
    |                         +-- pending/slow_down --> pending  +-- one exchange
    |                         +-- denial/expiry --> terminal     |
    +-- unavailable/error --> terminal                          v
                                                          persisting
                                                              |
                                                         succeeded
```

`failed`, `denied`, `expired`, `unavailable`, `cancelled`, `superseded`, and
`ambiguous` are terminal. An abandoned exchange/persist is `ambiguous`, never
replayed automatically.

## Authority and fencing

- The row and AES-GCM envelope bind exact tenant, user, attempt UUID, and a
  deployment-wide monotonic generation. Device ID, user code, and credential
  route exist only in the envelope. Tokens never enter PostgreSQL.
- A DB-clock lease plus opaque claim ID/generation admits one poller. A peer may
  take over after lease expiry. The stale poll response cannot advance state.
- `authorization_pending` retains the interval; `slow_down` adds five seconds;
  denial and expiry terminalize. Transient poll transport/5xx failures schedule
  the next database-time poll.
- Approval is converted with CAS into one `exchange_claim_id`. Exchange is
  attempted once. Transport/5xx/contract uncertainty becomes `ambiguous`.
- Final credential persistence takes the same tenant/user advisory transaction
  lock as new attempts, cancel, import, and logout; it rechecks attempt,
  generation, and exchange claim before writing. Provider waits never occur in
  that transaction.
- The credential store additionally keeps a per-home generation tombstone
  under a Linux kernel `flock`. The lock is not age-stealable: a database
  disconnect cannot admit a second filesystem writer while the first daemon is
  still alive. A fixed, secret-free `flock` helper applies the lock to the
  daemon's open-file description; the daemon retains its descriptor throughout
  mutation, and process/container death releases it. In the admitted sandbox profile, the
  authority-owning daemon performs the short local mutation itself while it
  retains the database lock; there is no detached credential writer that can
  survive that daemon. Linux file operations are anchored to an opened
  directory capability, so replacing `.codex` with a symlink cannot redirect
  them into another home. File and directory fsync make successful local
  responses durable.
- A new attempt is latest-wins. Overlapping creates serialize before generation
  allocation, and only the newest row remains current. UI cancellation names
  the exact attempt UUID, so a stale tab cannot cancel a newer code. A replica
  lost before it attaches the provider grant leaves a resumeless `starting`
  reservation, which expires within one minute rather than posing as a live
  device code for the full provider lifetime.

## Failure and retry contract

This is an authentication convenience flow, not an exactly-once transaction.
Provider calls and UI polling are bounded and surface terminal failures, but
Agor does not automatically replay an ambiguous authorization-code exchange or
reconcile every possible daemon-crash point. The local mutation is deliberately
not wrapped in a fake promise timeout: Node filesystem work cannot be cancelled
safely after such a timeout. A retry waits up to 10 seconds for the kernel lock
and then fails visibly rather than stealing authority from a still-live writer;
restarting that daemon closes its lock descriptor.
A daemon crash between the local credential mutation and the database state
transition may leave the filesystem and attempt row temporarily disagreeing,
but it cannot leave a detached writer that later overwrites a retry. The
supported recovery is explicit: the user starts over, which supersedes the
previous attempt and issues a new code.

The OpenAI device code remains valid for 15 minutes to allow human sign-in.
That is not a 15-minute request timeout: each provider request is bounded to 15
seconds, HA poll ownership is leased for 25 seconds, executor-routed auth-file
requests and HA filesystem lock admission are bounded to 10 seconds, and the UI
checks status every two seconds. The pending UI always offers **Start over**, so
a user who has returned from OpenAI but sees no progress need not wait for code
expiry.

## Boundaries

The service is tenant-identity-only at the HTTP layer and opens short database
transactions around each metadata transition. RLS excludes normal tenant policy
while the narrow maintenance capability is active. The attempt service publishes
no realtime events and remains denied from the Redis Feathers relay. Successful
login changes the caller's user auth method through the users service; its
existing tenant/user publication policy provides the UI notification. In the
generation-fenced HA transaction the automatic pre-commit users event is
suppressed and a redacted equivalent is queued for after commit, so a peer
cannot re-probe the old credential state and miss the only notification.

`auth.json` necessarily contains plaintext tokens at the Codex consumption
boundary. It is written only into the trusted, tenant/user-keyed credential
route with directory mode 0700 and file mode 0600. The HA capability stays
disabled when that route is replica-local, shared between users, or merely
declared `persistent-per-user` while `simple` execution would still use the
daemon's home. It also requires the operator assertion
`user_home_locking: cross-replica-flock`; shared paths with local-only locks
(including NFS `local_lock`) are not admitted. Local HA admission therefore
requires `sandbox`; delegated admission requires the external substrate's
`persistent-per-user` contract so the authenticated tenant/user home key
selects the same durable home for auth helpers and later Tasks. HA Codex auth
also rejects admin `filesystem_home` overrides because the schema does not
prove those paths unique across users. The checked-in HA smoke profile uses
sandbox per-user homes on its shared Agor volume.

Executor native-auth resolution uses the Task creator's saved auth method but
the filesystem sandbox mounts the Session owner's home. The resolver now
compares those concrete homes and fails closed when they differ, preventing a
collaborator from borrowing an owner's `auth.json` or receiving a misleading
native-auth result. Auth-resolved multi-tenancy admits Codex native auth only on
the same exact-user sandbox or delegated route required by the device capability.

Migration `0091_codex_device_auth_attempts` is an offline-cutover protocol
migration. Mixed versions fail closed: the old cohort's HA device guard remains,
and operators must not overlap old import/logout code (which lacks filesystem
generations) with the new cohort.
