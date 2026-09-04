# Provider subscription sign-in in HA

Status: **normative remaining Claude design with a dated implementation
snapshot**. Code facts below were re-verified on 2026-08-25 against `main` and
the live heads of PRs #2317, #2462, and #2521. The named revisions are historical
evidence, not moving implementation requirements.

This document originally proposed one future design for Codex device sign-in and
Claude subscription OAuth. That is no longer an accurate shape:

- [PR #2521](https://github.com/preset-io/agor/pull/2521) has implemented the
  Codex half on `main`, with materially stronger credential-mutation fencing than
  the original proposal.
- Claude subscription OAuth is not on `main`. Its standalone foundation remains
  in [PR #2317](https://github.com/preset-io/agor/pull/2317), and the first durable
  attempt implementation remains in the stacked
  [PR #2462](https://github.com/preset-io/agor/pull/2462).

The current Codex contract lives in
[`codex-device-auth-ha.md`](https://github.com/preset-io/agor/blob/main/context/explorations/codex-device-auth-ha.md)
and the operator contract lives in
[`daemon-ha.mdx`](../../apps/agor-docs/content/guide/daemon-ha.mdx). Do not use
the deleted revisions of this document as an implementation specification.

## Scope

This document does two things:

1. records dated PR lineage and the currently shipped Codex behavior; and
2. defines the smallest sound design still required before Claude subscription
   OAuth may be enabled in `deployment.mode: ha`.

MCP OAuth, OpenCode auth, and API-key-only flows are out of scope. The reusable
MCP security primitives remain relevant; its state machine is not a generic
provider-auth state machine.

## Dated implementation snapshot (non-normative)

This section answers "what had landed where when this design was reviewed?"
It must not be used as a merge recipe. Commit counts, migration ordinals,
mergeability, and branch divergence change as the branches move. An implementer
must refresh all of them against the actual merge target.

As verified on **2026-08-25**:

The branches are siblings plus one stack, not one four-PR stack:

```text
main @ 84ee55c8
├── oauth-signin-ha-enablement-design      # PR #2449, this document
├── claude-code-oauth-signin               # PR #2317 @ b57d7372
│   └── oauth-signin-ha-durable-attempts   # PR #2462 @ 57e62ae8
└── #2521                                  # merged to main as a44bba08
```

- `main` was `84ee55c8a1674c7d6b037f50894ac0b74ae04c5b`.
- #2521 had merged on 2026-08-22 as
  `a44bba086dafd01a4504a8a693725ec2eaaa7bfa`; its PR head was `dc0dd9bf`.
- #2317's head was `b57d737250d2367c3d23a15a72b05e9cb2ecc926`.
  Its merge-base with that day's `main` was `390e9216`; `main` had advanced by
  four commits.
- #2462 was stacked directly on that exact #2317 head. Its head was
  `57e62ae8ffd5547917e8e93c945f5d6df479b86c`, and the GitHub stack range held
  eleven commits. Its merge-base with that day's `main` was `add0c0c0`; `main`
  had advanced by two commits.
- The Claude attempt migrations on that #2462 head were PostgreSQL
  `0094_claude_oauth_attempts` and SQLite `0097_claude_oauth_attempts`.

Earlier revisions of this document recorded #2462 at five commits on the old
`019095cc` #2317 head, with colliding `0088`/`0091` migration ordinals and
pre-#2521 primitives. That was true historical context and is no longer current.
In particular, the 2026-08-25 #2462 head already contains the shared bound-secret,
credential-home, generation-fenced mutation, capability, realtime-deny, and
offline-cutover work. Never preserve a migration ordinal or duplicate a helper
merely because an older document named it.

### Completed work versus remaining requirements

| Location at the dated snapshot | Completed there                                                                                                                                  | Still required before activation on `main`                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                         | #2521's durable Codex attempt and credential authority                                                                                           | No Claude subscription service or HA capability was present                                                                                                                                     |
| #2317 head                     | Claude provider protocol, standalone service/logout, exact-user credential route, and UI                                                         | Integrate with the eventual merge target and the unified HA authority                                                                                                                           |
| #2462 head                     | Durable Claude rows/claims, unified daemon-side mutation authority, generation-fenced file operations, capability computation, and HA tests/docs | Refresh against the eventual merge target; satisfy the normative continuation, runtime-writer, rollout/rollback, validation, and product/legal gates below before activating those capabilities |

The remaining sections describe acceptance requirements regardless of whether
the implementation arrives by rebasing these PRs, merging them, or replacing
parts of them. A branch implementation is evidence, not shipped behavior, until
it is on `main` and activated under the rollout contract.

## Current state on `main`

### Codex device sign-in is implemented, conditionally

PostgreSQL HA uses `codex_device_auth_attempts`; standalone SQLite deliberately
keeps the process-local flow. The durable implementation is in:

- `apps/agor-daemon/src/services/codex-device-auth-durable.ts`
- `apps/agor-daemon/src/services/codex-device-auth-attempt-authority.ts`
- `packages/core/src/db/repositories/codex-device-auth-attempts.ts`
- `packages/core/src/codex/credential-file.ts`

The flow reserves a short-lived `starting` row before requesting a provider user
code, attaches the grant with a compare-and-set transition, leases polling on the
database clock, claims exchange once, and serializes final credential mutation
against start/cancel/import/logout. Provider network waits do not hold a database
transaction.

The approved poll result and exchanged tokens stay in the winning daemon's heap.
They are not added to PostgreSQL. Death before the one-shot exchange claim can be
recovered by polling the still-current device grant again; uncertainty after the
claim becomes `ambiguous` and is never replayed automatically.

`codexDeviceAuth` is now a `boolean` capability and
`isHaFeatureUnavailable()` reads it. Admission is deliberately narrower than
replica-visible storage:

- exact tenant/user routing through local `sandbox` execution;
- `executor_storage.user_home: persistent-per-user`; and
- an operator-verified
  `executor_storage.user_home_locking: cross-replica-flock` contract.

Shared identities, `simple`, delegated writers, local-only locks, and user home
overrides remain gated. A persistent path alone does not prove that two replicas
cannot race or that a timed-out remote writer has stopped.

### Claude subscription OAuth is not implemented on `main`

At the dated snapshot, the `claude-auth/oauth` and `claude-auth/logout` services,
their UI, and the `claudeOAuth`/`claudeAuth` HA feature keys existed only on
#2317/#2462. Any Claude HA release therefore still depends on integrating that
work with the then-current `main`.

The useful foundation from #2317 is the provider protocol and standalone UX:
authorization code plus PKCE, a manual `CODE#STATE` paste, and a managed
`~/.claude/.credentials.json`. The 2026-08-25 #2462 head extends that foundation
with tenant/user/attempt-bound PostgreSQL claims and the shared credential
authority. Those implementations still must be reviewed against the normative
contract below at integration time; older pre-authority revisions must not be
resurrected.

### `processAffineAuth` is not an enablement switch

`processAffineAuth` still has only a resolved-config declaration, assignment to
`false`, and a test fixture. No runtime code reads it. Provider-specific
capabilities must express provider-specific evidence. Removing this unused field
is valid cleanup, but it is not part of the Claude safety mechanism.

## Corrections to the original proposal

### 1. Storage visibility is not credential mutation authority

The old proposal treated a replica-visible executor home plus atomic rename as
leaving only the attempt `Map` to solve. That was incomplete.

Database revalidation immediately before and after a file write does not close
the race. A worker can pass its first check, lose ownership, and write after a
new login or logout. Deleting "the file it wrote" after a failed second check is
also unsafe: the path may already contain a newer winner's credential. A delayed
cleanup pass has the same flaw.

#2521 added the missing authority:

- one tenant/user database advisory lock for every competing mutation;
- a monotonically increasing mutation generation;
- a per-home generation tombstone;
- a non-age-stealable cross-replica kernel `flock`;
- file and directory fsync;
- no-follow, opened-directory filesystem operations; and
- a contained local writer whose lifetime cannot exceed the authority-owning
  daemon unnoticed.

Claude must reuse or generalize that mechanism. It must not add a second
precheck/write/postcheck protocol.

The old EFS-specific supporting claims are also not admission evidence. The
[AWS EFS CSI driver](https://github.com/kubernetes-sigs/aws-efs-csi-driver)
documents PVC capacity as a Kubernetes placeholder for elastic EFS, so a
reported 20 GiB claim is not by itself a 20 GiB quota. AWS documents Regional
EFS writes as durable after either file close or a synchronous write such as
`fsync` in its
[data-consistency contract](https://docs.aws.amazon.com/efs/latest/ug/features.html).
The current fsync behavior is useful general hardening; neither fact proves
exact-user routing, cross-client locking, or stale-writer containment.

### 2. An exchange claim does not make a provider retry safe

The original proposal preserved `exchangeWithOneRetry` when both calls were made
by one claim holder. That is unsafe. A claim prevents a second owner; it cannot
tell whether a timed-out, reset, 5xx, or unusable-success request consumed the
one-time authorization code.

Make exactly one exchange request. A validated provider rejection is `failed`.
Any outcome for which consumption cannot be disproved is `ambiguous`. The user
starts a fresh attempt; no owner replays the old code.

### 3. The approved Codex result does not need another durable secret state

The repeatable-poll observation recorded on #2449 supports one narrow behavior:
a new lease owner may re-poll before exchange. It does not justify persisting an
`approval_observed` authorization code/verifier or transient tokens.

The smaller shipped state machine is the model: keep the poll result in heap,
atomically claim exchange, and make every post-claim uncertainty terminal. The
initial provider user-code request also needs its shipped `starting` reservation;
the old proposal omitted that nontransactional call.

The 2026-08-18 probe used one egress IP and proprietary OpenAI endpoints. It did
not establish RFC 8628 compliance or cross-egress-IP behavior. The implementation
therefore retains safe restart behavior rather than inferring a broader provider
contract.

### 4. Browser-visible protocol material must be named honestly

Codex's user code is intentionally returned to the owning browser. Claude's
authorization URL includes raw `state`, and the authorization code and state
return through the user's `CODE#STATE` paste. These values must be scoped,
short-lived, excluded from logs/Redis/other users, and treated as capabilities;
they cannot be described as never reaching the client.

Server-only material includes the Codex `device_auth_id`, PKCE verifiers, Codex's
polled authorization code, and access/refresh tokens. Claude's pasted
authorization code necessarily touches its owning browser before the daemon.

### 5. Master-secret rotation is deployment-wide

Provider-attempt rows are short-lived, so draining them can simplify their part
of a rotation. It is not a complete `AGOR_MASTER_SECRET` rotation plan. The same
secret protects long-lived MCP OAuth grant material and other bound envelopes.
A safe rotation must account for every encrypted-at-rest consumer and either
re-encrypt or deliberately invalidate/reconnect it; never imply that waiting
10-15 minutes makes the whole fleet safe to re-key.

## Smallest sound remaining Claude design

### Resource classification

| Resource                           | Classification                       | Authority                                                             |
| ---------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Claude OAuth attempt               | tenant-owned, user-scoped, transient | PostgreSQL in HA; in-memory in standalone                             |
| Raw OAuth `state`                  | short-lived browser capability       | browser/request; PostgreSQL stores SHA-256 only in the minimal design |
| PKCE verifier and credential route | secret/derived attempt material      | purpose-separated bound envelope                                      |
| Authorization code and tokens      | single-use/credential material       | request-handler heap only, then exact-user credential file            |
| `.credentials.json`                | tenant-owned, user-derived file      | generation-fenced exact-user home                                     |
| Runtime credential copy            | tenant-owned, user/session-derived   | session-private executor directory; never promoted implicitly         |
| Fleet maintenance                  | narrow system/global operation       | explicit maintenance capability plus forced RLS                       |

Transient attempts are deleted with their tenant but are not portable. Exporting
or restoring an in-flight provider capability is not a supported operation.

### Attempt record and start

Use a Claude-specific table and state machine. Reuse current generic primitives,
not the MCP compatibility names:

- `sealBoundSecret` / `openBoundSecret` with a new Claude-specific purpose;
- `lockTenantAuthoritySubject` for concurrent generation allocation;
- `runWithTenantDatabaseScope` for ordinary access; and
- `runWithSystemDatabaseScope` with a narrow Claude maintenance capability for
  expiry and pruning across tenants.

The row needs trusted `tenant_id`, authenticated `user_id`, public-safe
`attempt_id`, a monotonic generation, `is_current`, DB-clock expiry, status,
`state_hash`, a one-shot exchange claim, a purpose/AAD-bound envelope, and
lifecycle timestamps. Bind the envelope to tenant, user, attempt, and generation.
Clear it on every terminal transition.

The minimal envelope contains the PKCE verifier and exact credential route, not
raw state. Start returns the authorization URL once. A page that loses the URL
may continue with an already-open provider tab and its `attempt_id`, or start
over. If product explicitly requires reconstructing the URL after a full reload,
sealing raw state is an intentional additional exposure and must be documented;
the implementation and security claim cannot say both "hash-only" and "sealed
raw state".

**Start over is the only replacement operation; there is no cancel operation in
this contract.** Starting takes the tenant/user/provider authority lock and
linearizes one transaction as follows:

1. allocate a generation greater than every earlier credential/attempt mutation
   for that tenant/user/provider;
2. make the prior current row non-current and clear its sealed material;
3. terminalize a prior `pending` row with status `failed` and failure code
   `superseded_by_newer_attempt`; terminalize a prior `exchanging` or
   `persisting` row with status `ambiguous` and the same failure code, because
   provider or filesystem effects may already have occurred; and
4. insert the new `pending`, `is_current` row, then commit before returning
   `{attemptId, verificationUrl, expiresAt}`.

This transition is intentionally not request-idempotent: two accepted Start over
requests create two ordered generations and the later transaction wins. The UI
disables duplicate clicks, but correctness comes from the authority lock and the
one-current-row constraint. A race with submit is decided by database order: a
claim that commits first is superseded as `ambiguous`; a supersede that commits
first makes the old claim predicate fail before provider I/O. A race with
finalization is serialized by the same mutation authority: finalization that
wins may leave the existing credential usable, while a Start over that wins
fences the old writer. Merely starting again does not delete a previously valid
credential.

The initial authenticated "discover my current attempt" status read may omit an
ID. After a start or discovery returns one, every status continuation and submit
must echo that exact `attemptId`; a stale tab never falls forward to a replacement
attempt. Start over sends no old attempt ID because the atomic supersede is the
entire operation. Adding cancel later would require its own atomic predicate,
terminal state, idempotency, and ordering contract; it must not be implemented as
an alias for logout or a best-effort flag.

### Claim and exchange

On submit:

1. parse `CODE#STATE` without mutating the attempt;
2. hash the pasted state;
3. atomically transition the exact current, unexpired
   `(tenant,user,attempt,state_hash)` row from `pending` to `exchanging` with a
   random claim ID;
4. commit before provider I/O;
5. open and validate the bound verifier/route; and
6. perform one token exchange outside the transaction.

A malformed paste or wrong state does not consume the attempt. Two replicas
racing the same submit produce one claimant and one provider call. A definite
provider rejection becomes `failed`; uncertain provider/transport/response
outcomes become `ambiguous`. No authorization code or token is persisted in the
attempt table.

### Credential and auth-method finalization

Finalization is the hard boundary. It must generalize the authority shipped for
Codex rather than relying on two reads around an executor call:

1. take the tenant/user/provider credential-mutation authority;
2. revalidate exact attempt generation, current status, and claim;
3. mark `persisting`;
4. write `~/.claude/.credentials.json` with the same per-home lock, generation
   tombstone, no-follow directory capability, atomic write, and durability
   semantics used for Codex;
5. update the user's Claude auth method and clear a shadowing pasted token under
   the same logical authority; and
6. terminalize with the exact claim/generation.

Provider I/O must never occur while this authority is held. A file/DB crash gap
may still yield an `ambiguous` user-visible result, but a stale writer must not be
able to overtake the next higher generation. Do not add loser-delete or delayed
path-delete cleanup.

The authority must cover **all** Claude credential-source and method mutations,
not only OAuth start and logout. On #2317, ordinary `users.patch` calls can save
or clear `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` and change
`agentic_auth_methods`. If those paths do not participate in the authority (or a
durable compare-and-set generation), an older OAuth completion can erase a newer
token choice and flip the method back. This is a server boundary; UI sequencing
is not a correctness mechanism.

### Native runtime refresh is another credential writer

The daemon services are not the only possible writers. #2317 deliberately relies
on the pinned Claude CLI/SDK to auto-refresh from `.credentials.json`; that
binary contains its own `.oauth_refresh.lock`, token-save path, and dead-refresh-
token disk cleanup. A long-running native session with the canonical home
writable could therefore update or clear the file without Agor's advisory lock,
generation tombstone, or auth-method transaction. It could overtake a new login
or recreate state after logout. Calling the daemon-side paths "one authority"
without containing this writer would be false.

For the first safe HA release, the daemon-owned canonical credential file must
not be writable by a Claude runtime:

1. under the tenant/user credential authority, launch takes a generation-checked
   snapshot into a tenant/user/session-private credential directory;
2. the executor exposes only that private directory to the Claude process, so
   vendor refresh locking and token writes cannot reach the canonical home;
3. the private credential never syncs back automatically, never enters Redis or
   logs, and is deleted through tenant/session cleanup; and
4. logout, replacement, or auth-source change advances the canonical generation
   and governs future launches. It does not claim to revoke bytes already held by
   an active process; immediate revocation additionally requires terminating that
   process and/or provider-side revocation.

This minimal containment trades availability for correctness if Anthropic
rotates a refresh token in the private copy: a later launch may find the
canonical refresh token unusable and must fail closed with an explicit fresh
sign-in path. It must not promote a private copy opportunistically. A future
write-back optimization needs an authenticated, secret-safe runtime-to-daemon
operation bound to tenant, user, launch ID, and the launch's credential
generation; the daemon then performs the normal locked generation CAS. The
operation must be idempotent/queryable, and a stale generation must be rejected.

If the execution substrate cannot prove that the native process writes only its
private credential directory, `claudeOAuth` and `claudeAuth` remain false. A
vendor-local lock is not a substitute: it neither participates in Agor's
generation order nor covers API-key/method mutations.

### HA capability and external execution

Add narrow `claudeOAuth` and `claudeAuth` capabilities. For the first safe HA
version, compute them from the same evidence as the local exact-user Codex route:

- `sandbox` exact-user home;
- `persistent-per-user`; and
- verified `cross-replica-flock`; and
- session-private runtime credential routing that does not expose the canonical
  file as writable to the pinned Claude process.

Do not key interactive Claude sign-in only from the broader
`codexCredentialFiles` capability. A tenant-safe shared identity can be valid for
an operator-managed import yet still be unsafe for one browser user replacing
credentials on behalf of another.

Keep delegated/external Claude sign-in gated until the external credential
writer owns a reviewed protocol that provides all of the following:

- exact trusted tenant/user routing;
- a persistent per-home mutation generation and atomic stale-generation reject;
- cross-client mutual exclusion;
- idempotent operation identity and queryable completion state; and
- a proof that timeout/authority loss cannot let an older writer commit after a
  newer mutation (by containment, termination acknowledgement, or substrate-owned
  generation CAS).

`persistent-per-user` by itself proves none of those. Widen the capability only
from an explicit, validated substrate contract.

### Mixed-version rollout and rollback

The unified authority is safe only when **every** writer participates. A schema
table and a new daemon's capability check cannot fence an older daemon that does
not acquire the advisory lock or honor the filesystem generation. The first
Claude-authority release therefore requires an **offline, all-at-once cohort
cutover**. Rolling replacement and old/new overlap are unsupported. A future
rolling protocol would need a durable fleet activation epoch that every possible
writer, including the old version, understands and refuses to cross; this design
does not have one.

#### Activation order

1. **Preflight without activation.** Pin the exact activation and rollback
   binaries; take and restore-test a PostgreSQL backup and, if rollback may need
   credential restoration, a coordinated exact-user-home backup. Provision one
   stable `AGOR_MASTER_SECRET` and verify exact-user routing,
   `persistent-per-user`, cross-replica `flock`, and private runtime credential
   routing on every future replica. Keep `claudeOAuth` and `claudeAuth`
   unavailable. Credential-home backups contain
   plaintext provider tokens at the consumption boundary: encrypt them, restrict
   operator access, bound retention, and include their tenant-owned bytes in
   deletion/offboarding procedures.
2. **Quiesce the old cohort.** Remove all daemons from ingress so no OAuth start,
   logout, API-key/token patch, auth-method change, or session launch can begin.
   Let bounded provider exchanges and credential writers finish. Then stop every
   old daemon, executor, native Claude session, and contained writer and verify
   that none remains. Do not start a new daemon while an old process can still
   touch a credential home.
3. **Classify old in-flight work.** A process-local `pending` attempt is not
   migrated; the user gets Start over after activation. A request known to have
   failed before provider exchange is failed. Any request interrupted after the
   exchange POST began, or after a credential mutation began without confirmed
   completion, is operationally `ambiguous`: do not replay its code or delete a
   path in compensation. Reconcile the user's method/file with the authenticated
   inspect path or let the user explicitly Start over/disconnect after activation.
4. **Migrate offline.** With no application daemon running, apply the activation
   binary's complete migration set using the repository's offline-cutover path.
   The Claude migration was `0094` on the dated #2462 head, but the actual
   migration ledger and ordinal at cutover are authoritative. Do not hand-edit an
   older ordinal into the ledger.
5. **Start dark, then activate.** Start the whole new cohort out of ingress. Each
   replica must verify the schema watermark, stable master secret, exact-user
   route, shared locking contract, private runtime credential routing, and the
   same capability result. In PostgreSQL HA, all Claude auth-source/method writers
   must route through the unified authority even before interactive OAuth is
   advertised. Only after every
   replica reports the expected `claudeOAuth` and `claudeAuth` capabilities may
   ingress and Claude credential mutation reopen. A nonempty secret on each pod
   is insufficient evidence that the values match: the deployment must compare
   an immutable secret revision out of band or require every replica to open a
   purpose-bound activation canary written during the offline cutover. Do not
   expose the secret or a reusable verifier in health output.

Missing schema, a migration watermark the binary does not understand, missing or
mismatched master secret, unsupported storage/locking, or cohort-version
uncertainty fails closed. In HA, the daemon must not fall back to the standalone
in-memory attempt store, an unfenced writer, plaintext material, a shared home,
or a different auth source. Keep the user's method and credential bytes intact
while denying the affected sign-in, mutation, or launch with a stable unavailable
error.

#### Binary rollback and subscription-auth users

Rollback is also offline and all-at-once:

1. remove the activation cohort from ingress, drain bounded work, stop every new
   daemon/writer, and preserve its database plus credential-home state;
2. treat any nonterminal durable attempt as abandoned. Never transfer or replay
   its authorization code. Rows may remain inert for a later new-version
   maintenance pass, or an offline procedure owned by the activation version may
   terminalize them; an old binary must not mutate them;
3. start at most one rollback daemon in `deployment.mode: standalone`, with no
   new-version daemon or writer alive. A rollback to HA is prohibited because
   that binary does not share the unified authority; and
4. before reopening traffic, run the same authenticated file/method consistency
   check for every subscription-auth user affected by an interrupted mutation.

A rollback binary is **subscription-aware** only if it understands
`agentic_auth_methods['claude-code'] = 'subscription'`, resolves the same exact
user home and `.credentials.json` format, and leaves that method/file untouched
on errors. Such a binary may continue using an already-confirmed credential in
single-daemon standalone mode, but its Claude credential mutations remain closed
during the rollback window unless its single-writer behavior has been explicitly
validated.

A binary that predates subscription auth, maps it to API-key or pasted-token
auth, probes a daemon/shared home, or silently clears the method is not a valid
in-place rollback for subscription-auth users. Keep Claude launches and auth
mutation unavailable and either re-upgrade, move each user through an explicit
new credential choice under a supported binary, or restore a tested pre-cutover
**database and credential-home pair**. Never restore only PostgreSQL while
leaving newer credential files, and never silently borrow an API key or token as
a downgrade fallback. A restore rolls back credential changes and revocations
made after its checkpoint; keep launches closed until those users are audited
and any provider-side revocation or fresh sign-in is completed.

The additive attempt table may remain only when the rollback binary is known to
tolerate the newer migration watermark and will not perform unsafe lifecycle or
tenant-deletion work. Otherwise restore the coordinated pre-cutover backup with
all binaries stopped. Schema rollback is not ad hoc reverse DDL: it must restore
or update both schema and migration ledger through a tested procedure.

### Tenant, realtime, and secret boundaries

- Register Claude auth services as tenant-identity-only request paths. Open short
  tenant database units at each DB access; never hold an HTTP-long transaction
  across provider I/O.
- Force RLS on the attempt table and cover cross-tenant and cross-user reads,
  claims, completion, cleanup, and ciphertext rebinding negatively.
- Give fleet maintenance its own narrow system capability; normal tenant policy
  must exclude it.
- Add `claude-auth/oauth` and `claude-auth/logout` to
  `REALTIME_PUBLISH_POLICY` with `audience: 'none'` and to
  `REDIS_FEATHERS_DENIED_PATHS`. Current publication is default-deny, but the
  explicit credential-control-plane barrier remains defense in depth.
- Never log provider bodies, codes, state, verifiers, credential routes, or
  tokens. Stable failure categories and aggregate counters are safe.
- A missing or mismatched fleet master secret fails closed. Never fall back to
  plaintext.

## Required validation before activation

### Database and service

- two independent PostgreSQL pools complete one attempt across replicas;
- simultaneous starts allocate ordered generations and leave one current row;
- simultaneous submits result in exactly one provider exchange;
- wrong state and malformed paste do not consume the attempt;
- abandoned/uncertain exchange becomes `ambiguous` and is never replayed;
- expiry and system-capability maintenance use the database clock;
- cross-tenant, cross-user, and ciphertext-rebinding attempts fail; and
- tenant deletion removes attempts while portability omits them.

### Credential authority

- logout, replacement OAuth, API-key save, pasted-token save/clear, and OAuth
  completion are raced at each write/method boundary;
- a native Claude session can refresh or clear only its private credential copy;
  after logout or replacement it cannot recreate or overwrite the canonical
  file, and a rotated private refresh token is never silently promoted;
- normal completion, crash cleanup, tenant deletion, and offboarding remove
  private copies without crossing tenant/user/session ownership;
- a lower filesystem generation cannot overwrite or delete a higher one;
- lock contention and database-authority loss cannot release a still-live writer
  into a later mutation;
- symlink/path replacement cannot redirect a write to another home; and
- file write success is not reported when durability/read-back fails.

### HA and UI

- start on replica A and submit/exact-attempt status on B;
- kill the claimant before exchange versus after exchange and verify the distinct
  retry contracts;
- simultaneous Start over requests leave one current generation; Start over
  versus submit/finalization follows the specified database/authority ordering;
- stale tabs cannot submit or poll forward into a replacement attempt, and no
  cancel endpoint or cancel-shaped client fallback exists;
- auth results never enter Redis or a second user's connection;
- supported sandbox topology reports the capabilities true; shared/simple,
  missing-lock, home-override, and delegated cases remain false; and
- a full page reload follows the chosen raw-state contract: reconstruct only if
  raw state was deliberately sealed, otherwise offer a clean Start over path.

### Rollout and rollback

- migration preflight leaves both capabilities false, and schema/master-secret/
  storage/private-runtime-routing mismatch fails closed without choosing the
  in-memory store;
- an old writer is deliberately held open while a new cohort tries to activate;
  activation remains closed until the old cohort and writer are gone;
- old process-local pending and uncertain exchange/write attempts become Start
  over/ambiguous outcomes and are never replayed during cutover;
- a full new cohort activates only after every replica reports the same schema
  and capability evidence; mixed binaries never serve traffic together;
- rollback leaves durable attempts inert, runs at most one standalone rollback
  daemon, and never races a new-version writer; and
- subscription-auth users retain the same method/file under a compatible
  rollback binary, while an incompatible downgrade blocks Claude instead of
  falling back to an API key, pasted token, or shared home.

After code changes, run the focused daemon/core/executor/UI suites, PostgreSQL
non-superuser RLS tests, `pnpm check:multitenancy-boundaries`, typecheck/lint, and
the managed two-daemon HA harness. External support additionally requires an
environment test against the real writer protocol; Compose cannot certify it.

## Integration checklist (refresh at merge time)

Do not translate the dated snapshot into a mechanical rebase plan. On the
2026-08-25 #2462 head, the migration renumbering, current shared helpers,
provider-wide mutation authority, capability checks, explicit realtime deny,
and Redis hard deny were already present. Re-doing those steps from an older
revision would be a regression.

The integration owner must instead:

1. fetch the actual `main`, #2317, and #2462 heads; recompute ancestry and diffs;
   then choose rebase, merge, or selective replacement based on code, not the
   historical SHAs or commit counts above;
2. regenerate or verify migration files and both journals against the merge
   target's current schema. No ordinal in this document is reserved;
3. review the resulting tree for exactly one current bound-envelope,
   credential-home, credential-file, and tenant/user mutation authority path;
   ensure OAuth, logout, Start over, API-key/token patch, and method changes all
   enter it;
4. contain the pinned CLI/SDK's refresh-token file writes in a session-private
   credential directory, or keep both Claude HA capabilities false;
5. require exact `attemptId` for every continuation after discovery/start, keep
   Start over as the only replacement operation, and ensure no cancel API/client
   or cancel validation case survives;
6. choose and document the raw-state/reload contract. Do not use MCP's
   `pending-exchange` purpose for Claude material;
7. mirror the offline all-at-once activation, in-flight classification,
   subscription-aware downgrade, and fail-closed rules in the operator guide;
8. keep delegated/external capability false until its writer contract is proved;
   and
9. preserve #2317's unresolved ToS/AUP review as a pre-GA product/legal
   prerequisite. HA correctness does not answer that question.

## Decision

Codex is implemented and its existing focused document is authoritative. For
Claude, durable PostgreSQL attempt state is necessary but not sufficient. The
smallest sound first release is a request-driven, one-shot claim plus a
generation-fenced **local exact-user sandbox** canonical credential authority and
a session-private native-runtime credential copy. External writer support and
generation-checked refresh write-back are separate protocol projects, not
capability flips based on shared storage.
