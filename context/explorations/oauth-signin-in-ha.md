# Enabling Codex and Claude subscription OAuth sign-in in HA

Status: **design proposal, not implemented.** August 2026.
Revision 2 — corrects a refuted claim in revision 1; see [Revision history](#revision-history).

Scope: make the two provider subscription sign-in flows — Codex device auth
(`codex-auth/device`) and Claude subscription OAuth (`claude-auth/oauth`, added
by PR #2317) — actually work under `deployment.mode: ha` /
`support_profile: constrained-active-active`, instead of returning
`503 HA_FEATURE_UNSUPPORTED`.

Non-goals: MCP OAuth (`mcp-servers/oauth-*`), OpenCode auth, and provider API-key
paste flows.

Throughout, **VERIFIED** means read from the tree at this commit with a
`file:line` citation. **DESIGN** means proposed and not yet built.
**PRECONDITION** means an external fact this design depends on that has *not*
been established and must be before the corresponding phase ships.

---

## TL;DR

1. The blocking mechanism is the **in-memory `attempts` map** that holds
   per-attempt secret material between requests
   (`codex-device-auth.ts:263`; `claude-oauth.ts:292` on #2317).
2. Credential-file visibility is **solved for the checked-in `shared-local`
   topology** and is a **declared, unverified contract** for `external` / Cloud.
   It is not a second implementation blocker, but it is an open deployment
   precondition (§1.6, §3).
3. `processAffineAuth` has **zero consumers** — declared, assigned `false`, one
   test fixture. It is not a switch. **Delete it**; do not rehabilitate it.
4. Redis is fanout-only and auth paths are explicitly denied the relay.
   PostgreSQL claims/leases are the house pattern. Redis is not a candidate.
5. Agor's MCP OAuth authority provides reusable **primitives** — sealed envelope,
   atomic one-shot claim, tenant scope, TTL/prune. Reuse the primitives.
   **Do not** assume one generic table serves both providers: Codex's flow has a
   materially different external-call shape and needs its own state machine (§2.3).
6. **Recommended: Phase 1 = minimal affinity-scoped enablement for `shared-local`;
   Phase 2 = durable PostgreSQL attempt state serving `external` too. Codex
   poll-lease *resumption* stays gated behind proving provider semantics
   (PRECONDITION B); until proven, owner death in the approval window is
   `ambiguous` and the user restarts.**

---

## 1. Verified baseline

### 1.1 The constrained HA profile and its fail-closed gate

- Profile constant `constrained-active-active` (`apps/agor-daemon/src/ha-support.ts:6`).
- `isConstrainedHa()` is just `deployment.mode === 'ha'` (`:20-24`).
- `isHaFeatureUnavailable()` (`:33-40`):

  ```ts
  if (!isConstrainedHa(deployment)) return false;
  if (feature === 'codexAuth') return !deployment.capabilities.codexCredentialFiles;
  return true;                       // <-- everything else: unconditionally gated
  ```

  `codexAuth` is the only feature with a real condition; `codexDeviceAuth` falls
  through to the unconditional `return true`.
- Applied as a `before:{all}` hook over `CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES`
  (`register-hooks.ts:525-539`), throwing `Unavailable` with
  `code: 'HA_FEATURE_UNSUPPORTED'` (`ha-support.ts:26-31`).

**The gates already read from capabilities**, so making a capability
conditionally true opens its gates with no change to hook wiring.

### 1.2 The capability flags are typed as literal `false`

`ResolvedDeploymentConfig` (`deployment.ts:55-88`):

```ts
codexCredentialFiles: boolean;   // :74  <-- computed
codexDeviceAuth: false;          // :75  <-- literal type
processAffineAuth: false;        // :76  <-- literal type
```

The *type* is the literal `false`, so assigning `true` is a compile error until
the type widens. Enablement is necessarily a typed, reviewed change.
`deployment.test.ts:50-58` pins the resolved object exactly.

### 1.3 `processAffineAuth` has no consumers — delete it

Three occurrences repo-wide: type declaration (`deployment.ts:76`), assignment
(`:472`), test fixture (`ha-support.test.ts:31`). **No `capabilities.processAffineAuth`
read exists anywhere.** It is absent from the support matrix's prose.

It is a documentary placeholder, not a switch. This design **deletes it** rather
than giving it meaning: narrowly-named per-provider capabilities
(`codexDeviceAuth`, `claudeOAuth`) express the actual conditions, and a
general-sounding "process affine auth" flag would invite exactly the
over-broad reasoning that produced revision 1's error.

### 1.4 Blocker: process-local attempt maps

**Codex** — `codex-device-auth.ts:263`: `const attempts = new Map<string, DeviceAuthAttempt>()`.
Attempt holds device auth ID, user code, target identity, status; a
`setTimeout`-driven `pollTick()` (`:297-330`) polls OpenAI and writes credentials
only after a local ownership check (`:330`).

**Claude** (#2317) — `claude-oauth.ts:292`, keyed `` `${tenantId}:${userId}` ``
(`:343`), holding `verifier` and `state` (`:253-254`), zeroed on completion
(`:307-308`).

Stated intent (`docs/internal/process-affine-ha-support-matrix-2026-08-07.md:253`):

> Initial HA disposition: Keep disabled in hosted/multi-tenant HA […] **A future
> design needs durable attempt generation and a per-user poller lease/fence.
> Device IDs, codes, authorization codes, and tokens never go to Redis.**

### 1.5 The two flows differ structurally, and it drives the whole design

| | Codex device auth | Claude OAuth (#2317) |
| --- | --- | --- |
| Grant | RFC 8628 device authorization | authorization-code + PKCE (S256) |
| Who generates the PKCE verifier | **the provider** — returned in the poll response (`codex-device-auth.ts:151`) | **the daemon** (`claude-oauth.ts:114`) |
| Who drives completion | **daemon background poll loop** | **the user's next request** (paste `CODE#STATE`) |
| Needs a live in-process timer | **Yes** | **No** |
| Authorization code arrives | mid-poll, unprompted (`:150-156`) | from the user, in a request |
| Code lifetime | fixed 15 min constant `DEVICE_CODE_LIFETIME_MS` (`:57-58`), applied as `Date.now() + …` (`:435`) | 10 min daemon-side |
| Client ID | fixed public `app_EMoamEEZ73f0CkXaXp7hrann` (`:56`) | fixed public `9d1c250a-…` (`claude-oauth.ts:65`) |

Two consequences that revision 1 under-weighted:

**(a) Claude is purely request-driven.** Three calls (`create({})` → `find()` →
`create({code})`) with no server-side timer. Making it HA-safe requires only that
the attempt be *findable*.

**(b) Codex receives the authorization code as an unprompted side effect of a
poll.** `pollDeviceToken()` (`:137-157`) returns `{authorizationCode, codeVerifier}`
the moment the user approves. That value exists only in the polling replica's
heap until something durably records it. This is the crux of §2.3: **the
observation itself may be the consuming event**, and Agor cannot assume
re-polling reproduces it.

Note also that the Codex `usercode` response parses only `device_auth_id`,
`user_code`, and `interval` (`:115-128`) — **there is no `expires_in`**. Lifetime
is the fixed local constant. Any durable design must keep using a fixed lifetime
(preferably recomputed on the DB clock) and must not invent an `expires_in`.

### 1.6 Credential-file visibility: solved for `shared-local`, declared for `external`

`codexCredentialFiles` (`deployment.ts:469-470`) is true when
`user_home !== 'replica-local'` **and** `hasTenantSafeExecutorCredentialHome()`
(`executor-credential-storage.ts:8-15`):

```ts
config.multi_tenancy?.mode !== 'required_from_auth' ||
config.execution?.executor_storage?.user_home === 'persistent-per-user'
```

HA refuses to boot without a tenant-safe home (`deployment.ts:375-380`).
Credential path resolution is already replica-independent: the daemon computes
the target home (`sandbox-context.ts:108-124`), passes `CODEX_HOME`
(`executor-codex-auth.ts:25-43`), and the executor writes `0600`
(`packages/executor/src/commands/codex-auth-file.ts:84-85`).

**What is actually proven, and what is not:**

| Topology | Status |
| --- | --- |
| `shared-local` (checked-in Compose HA stack) | **VERIFIED working.** `docker-compose.ha.yml:47,157` mounts named volume `agor-ha-user-home` at `/home/agor` on both daemons; `docker/ha/config.yaml:31` declares `user_home: shared`. The config comment states this "makes auth-file import/logout and Tasks replica-consistent". |
| `external` / Cloud (`persistent-per-user`) | **PRECONDITION A — declared, not demonstrated.** `AgorExecutorStorageSettings` is explicitly a *"Declarative execution-substrate storage contract"* (`packages/core/src/config/types.ts:728-739`); `persistent-per-user` is described as *"the only mode suitable for user credential homes in a multi-tenant external executor fleet"*. That is a statement of what the operator must supply, **not evidence that any deployment supplies it.** No concrete provisioning of a durable, replica-consistent per-user home was located in this repo. |

**Reconciling this with "one blocker":** the *implementation* blocker is the
attempt map — no new credential mechanism needs to be built. But Phase 2/3
enablement for `external` is **gated on PRECONDITION A**, which is a deployment
fact this repo cannot settle. Revision 1's "already solved" was too strong; it
was true of the smoke stack and asserted of Cloud.

### 1.7 Redis is fanout-only and explicitly denied to auth paths

- Redis is required in HA but used **solely** as the Socket.IO adapter /
  `serverSideEmit` relay (`realtime/redis-realtime.ts`; boot fails closed
  `:129-130`). `ioredis` behind `@socket.io/redis-adapter`; **no generic
  GET/SET/SETEX/lock surface is exposed to application code.**
- `REDIS_FEATHERS_DENIED_PATHS` (`utils/realtime-publish.ts:251-273`) lists
  `codex-auth/*`, every `mcp-servers/oauth-*`, `user-mcp-oauth-tokens`,
  `session-tokens`, `terminals`, under (`:249-250`):

  > Authentication and credential control-plane results must never enter shared
  > Redis, even if a future service accidentally enables publication for them.

- All other HA coordination is **PostgreSQL**: knowledge-embedding claims
  (`repositories/knowledge-embedding-work.ts:29-49`), environment-health leases
  (`repositories/environment-health.ts:26-41`), widget resolution, gateway
  listener leases, executor token bounded-use. Same idiom: atomic conditional
  `UPDATE` fenced by `claim_token` + `claim_generation` + DB-clock expiry. No
  leader election, no `SELECT … FOR UPDATE`.

**Redis is not a candidate** and is recorded here only so it is not re-proposed.

### 1.8 The MCP OAuth authority: what it actually seals

`mcp_oauth_pending_flows` (`packages/core/src/db/schema.postgres.ts:1792-1858`)
with `services/mcp-oauth-pending-flow-authority.ts`. Precisely:

- **`state` is stored hash-only.** The row's `state_hash` is
  `fingerprintMCPOAuthState(input.context.state)` (`authority.ts:165`), UNIQUE
  (`schema.postgres.ts:1834`). **The raw `state` is never sealed and never
  stored** — it is not a field of the sealed material at all.
- **`sealed_material`** (`authority.ts:127-148`) contains `pkceVerifier`,
  **`clientId`, optional `clientSecret`**, the resolved endpoints
  (`authorizationEndpoint`, `tokenEndpoint`, `metadataUrl`, `redirectUri`,
  `issuer`, `resourceUri`), `grantGeneration`, config fingerprint, and
  compatibility flags. `clientId` is *required* by the validator (`:76`) and both
  client fields are returned to the claiming replica (`:277-278`).
- Sealed with `sealMCPOAuthSecret()` (`packages/core/src/db/oauth-secret-envelope.ts`)
  — AES-256-GCM, scrypt-derived key from `AGOR_MASTER_SECRET`, purpose domain
  `'pending-exchange'`, with tenant/user/server/attempt/generation binding as
  **AAD** (`authority.ts:149-161`).
- `expires_at` DB-clock TTL, 10 minutes (`authority.ts:34`).
- One-shot claim: atomic `UPDATE … SET status='exchanging', exchange_claim_id=?
  WHERE state_hash=? AND status='pending' AND expires_at > CURRENT_TIMESTAMP AND
  is_current=true RETURNING *` (`repositories/mcp-oauth-pending-flows.ts:357-372`).
  Two-pool race test: `mcp-oauth-pending-flow-authority.postgres.test.ts:352-372`.
- `maintain()` (`repositories/…:532-575`) expires overdue, marks abandoned
  exchanges `ambiguous` after 2 min, deletes terminal rows after 24h.
- Tenant scope via `runWithTenantDatabaseScope()`
  (`packages/core/src/db/tenant-scope.ts:200-240`) — native transaction + tenant
  GUC for RLS.

**Reusable primitives:** the envelope, the atomic claim idiom, tenant scoping,
DB-clock TTL, `maintain()`. Reuse these. The *table* and the *state machine* are
flow-specific — see §2.3.

### 1.9 Why MCP OAuth is still gated (corrected)

**Revision 1 claimed MCP OAuth stays gated because its dynamically-registered
`client_id`/`client_secret` is process-local. That claim is REFUTED.** The
durable row seals `clientId` and `clientSecret` (`authority.ts:143-145`), the
validator requires `clientId` (`:76`), and the claiming replica receives both
(`:277-278`). A replica that wins the claim therefore *does* hold the client
credentials. `dynamicClientCache` (`packages/core/src/tools/mcp/oauth-mcp-transport.ts:415`)
is a registration-time optimization behind a `reuseLocalCache` flag (`:525`); it
is not on the durable claim path, and no daemon source file references it.

The actual reason is stated in the support matrix
(`docs/internal/process-affine-ha-support-matrix-2026-08-07.md:250-252`):

> The durable prerequisite is implemented after enforced offline migration `0078`,
> a shared stable `AGOR_MASTER_SECRET`, and whole-cohort rollout, **but the
> current constrained profile still gates MCP OAuth pending separate
> activation.** […] Legacy providers require explicit per-server compatibility;
> DCR is explicit fallback.

and for the token authority (`:251`):

> The active-active authority is implemented on PostgreSQL after `0078` […] **but
> the constrained profile still gates the browser flow pending separate
> activation.**

So MCP OAuth is **technically durable and deliberately not yet activated** — a
certification/rollout decision, not an unsolved mechanism.

**What this means for provider sign-in.** The correct comparison is scope of
client contract, not "MCP is blocked":

| | MCP OAuth | Codex / Claude sign-in |
| --- | --- | --- |
| Client identity | per-server; may be dynamically registered (DCR as explicit fallback) | one fixed, public, compile-time client ID per provider |
| Per-server config | issuer/resource/metadata/endpoint discovery, versioned config fingerprint, per-server compatibility modes | none — endpoints are constants |
| Secret to seal | verifier **+ client credentials + resolved endpoints** | Claude: verifier only. Codex: provider-supplied verifier + authorization code |
| Activation surface | every MCP server a user can add | two known providers |

Provider sign-in is **narrower** — a fixed, non-negotiated client contract with
no discovery and no DCR — which is why its durable record is simpler and its
certification surface smaller. That is a genuine argument for it being easier to
activate. It is **not** an argument that MCP is technically blocked and sign-in
is not.

### 1.10 Ingress affinity is already mandatory

- HA refuses to boot without it (`deployment.ts:349-353`).
- Resolved topology types it literally `ingressAffinity: true` in both variants
  (`:86-87`).
- The browser uses Socket.IO (`packages/core/src/api/index.ts:1413`,
  `transports: ['websocket','polling']` `:1384`); the sign-in pane calls
  `client.service('claude-auth/oauth')` (`ClaudeOAuthSignIn.tsx:44-52`) — all
  three calls of one sign-in ride **one sticky connection to one replica**.
- Caveat (`docs/internal/daemon-ha-redis-realtime-2026-08-07.md:92-93`): affinity
  is configured for `/socket.io/` only — *"leave REST unsticky"*. A live
  WebSocket never migrates; after daemon loss the client makes a **new**
  connection which may land anywhere.
- Precedent: web terminals (`terminal-capability.ts:25-32`) ship on exactly this
  contract, with *"Owner loss ends the Agor attachment… requires an explicit
  Reconnect"* (`context/explorations/web-terminal-ownership-ha.md`).

---

## 2. Design

### 2.1 Phase 1 — minimal affinity-scoped enablement (`shared-local` only)

Sticky Socket.IO already routes all three calls of a sign-in to one replica.
Until the socket reconnects, the existing in-process map is **already correct**.
So Phase 1 needs almost nothing:

1. Widen `codexDeviceAuth` / add `claudeOAuth` to `boolean`; compute as
   `topology.execution === 'shared-local' && topology.ingressAffinity &&
   executorCredentialFiles`.
2. Delete `processAffineAuth` (§1.3).
3. On reconnect to a replica with no live attempt, `find()` already returns "no
   attempt" naturally (empty map) — surface it as **"sign-in lost, start over"**
   in the UI, matching the terminal Reconnect contract.

**Explicitly dropped as over-engineering:** daemon boot-ID stamping and
`SIGTERM` attempt-drain machinery. Neither buys anything the empty-map path does
not already give, and both add protocol surface to a stopgap.

**One narrow refinement is still required** (see push-back note in §7): the
attempt key is `` `${tenantId}:${userId}` `` (`claude-oauth.ts:343`) with **no
attempt identity**. If a user starts a sign-in on replica A, then reconnects to
replica B that still holds an *older, unpruned* attempt for the same key,
`find()` returns B's stale status and `submit()` validates the pasted code
against B's stale `state` — failing as "wrong state" rather than "start over"
(`claude-oauth.ts:392-407`). Fix by returning an opaque `attempt_id` to the
client and requiring it to be echoed on `find`/`submit`; a mismatch means "start
over". This is a few lines and removes a genuinely confusing failure, unlike
boot-ID.

**Risk: medium.** Correctness depends on operator ingress config the daemon
cannot verify; a misconfigured ingress degrades to "sometimes works", which is
worse than today's honest 503. Mitigate by scoping strictly to `shared-local`
and documenting loudly. Phase 1 does **not** serve `external`.

### 2.2 Phase 2 — durable attempt state (shared primitives, per-flow tables)

Reuse the §1.8 primitives: `sealMCPOAuthSecret`/`openMCPOAuthSecret` under a
**new purpose domain** (`'provider-signin'`, so envelopes cannot be cross-used
with MCP), the atomic-claim idiom, `runWithTenantDatabaseScope()`, DB-clock TTL,
`maintain()`.

Common columns for both providers:

| Column | Purpose |
| --- | --- |
| `tenant_id`, `user_id` | tenant scoping / RLS |
| `attempt_id` (PK) | identity; echoed to the client |
| `provider` | `codex` \| `claude` |
| `attempt_generation` | monotonic per `(tenant_id, user_id)`; fences superseded attempts |
| `is_current` | exactly one live attempt per user |
| `status` | per-flow state machine (§2.3, §2.4) |
| `expires_at` | DB-clock TTL — Claude 10 min; Codex fixed 15 min (§1.5), **not** a provider `expires_in` |
| `sealed_material` | AES-256-GCM, AAD-bound; **contents differ per provider** |
| `claim_id` | one-shot fence for the unreplayable step |
| `created_at`/`updated_at`/`finished_at` | lifecycle + prune |

**`state_hash` (Claude only), UNIQUE.** Following the MCP authority exactly:
**seal `{verifier}` only; store `state` as a hash and never in sealed material.**
Validation compares `sha256(pasted_state)` against `state_hash`. This keeps the
raw CSRF token out of the ciphertext entirely and matches `authority.ts:165`.

**Do not force one table on both flows.** Codex needs `poll_lease_owner` /
`poll_lease_expires_at` and an `approval_observed` state that Claude has no
analogue for; Claude needs `state_hash` that Codex has no analogue for. A single
table would carry a union of mutually-exclusive nullable columns and a status
enum whose values are only valid for one provider. Two tables (or one table with
a genuinely shared core and a per-provider detail) with **shared primitives and
separate state machines** is the honest shape.

### 2.3 Codex fenced state machine (the hard case)

Two non-transactional external calls: the poll (`codex-device-auth.ts:137-157`)
and the exchange (`:165-191`). The authorization code arrives *inside* the poll
response, unprompted.

States: `pending → approval_observed → exchanging → persisting → succeeded`,
with terminals `failed` / `expired` / `ambiguous` / `superseded`.

| # | Transition | Atomic predicate | Durable secret after commit | Crash in this window | Replay? |
| --- | --- | --- | --- | --- | --- |
| 1 | *(create)* → `pending` | In one tx: `UPDATE … SET is_current=false, status='superseded' WHERE tenant/user AND is_current`, then `INSERT` with `attempt_generation = prev+1`, `expires_at = now() + 15min` (DB clock) | `deviceAuthId`, `userCode` sealed | Nothing issued yet; user retries | n/a |
| 2 | acquire poll lease | `UPDATE … SET poll_lease_owner=?, poll_lease_expires_at=now()+L WHERE attempt_id=? AND status='pending' AND is_current AND (poll_lease_expires_at IS NULL OR poll_lease_expires_at <= now()) RETURNING *` | unchanged | No owner polls until lease is free; attempt still valid | Lease re-acquire is safe |
| 3 | `pending` → `approval_observed` | `UPDATE … SET status='approval_observed', sealed_material=? WHERE attempt_id=? AND status='pending' AND attempt_generation=? AND poll_lease_owner=? AND poll_lease_expires_at > now()` | + `authorizationCode`, `codeVerifier` (both provider-supplied) | **DANGEROUS — see below** | **No** |
| 4 | `approval_observed` → `exchanging` | one-shot: `UPDATE … SET status='exchanging', claim_id=? WHERE attempt_id=? AND status='approval_observed' AND is_current AND attempt_generation=?` | unchanged | Abandoned `exchanging` → `ambiguous` after timeout | **No** — authorization codes are single-use |
| 5 | `exchanging` → `persisting` | `UPDATE … SET status='persisting', sealed_material=? WHERE attempt_id=? AND status='exchanging' AND claim_id=?` | tokens sealed (separate purpose domain), code cleared | Crash before commit → `ambiguous`; tokens lost, user restarts | **No** |
| 6 | `persisting` → `succeeded` | re-validate `(attempt_generation, claim_id, status='persisting', is_current)` **immediately before** the credential write **and again before** the user-method mutation; then `UPDATE … SET status='succeeded', sealed_material=NULL` | cleared | See §2.5 filesystem gap | Write is idempotent (same tokens, same path) |

**Transition 3 is the one that must not over-promise.** The provider returns the
authorization code in the poll response. Whether that response is
single-delivery — i.e. whether *observing* approval consumes it — is
**PRECONDITION B, unverified**. Therefore:

- **Default (until B is proven): lease takeover of a `pending` attempt whose
  lease expired transitions it to `ambiguous`, not back to polling.** The user
  restarts sign-in. Owner death anywhere in the approval window is a restart, not
  a transparent resume.
- Rationale: if re-polling does *not* reproduce the code, a resuming owner silently
  hangs until expiry; if the code *can* be delivered twice, two owners may both
  proceed. Neither is acceptable without evidence.
- Resumable polling (a genuine availability win) may be enabled **only** after B
  is proven, and even then only for a `pending` attempt that has never reached
  `approval_observed`.
- Make lease expiry rare rather than relying on takeover: short renew interval
  (~15 s) against a generous lease (~60 s), well inside the 15-minute window.

**Retry policy.** The existing `exchangeWithOneRetry` (`:199`) must stay
*within a single claim holder* — one process, one `claim_id`. A retry must never
cross owners, because the second attempt cannot know whether the first consumed
the code.

### 2.4 Claude state machine (the easy case)

`pending → exchanging → persisting → succeeded`; terminals as above. No lease —
nothing polls.

| # | Transition | Atomic predicate | Durable secret | Replay? |
| --- | --- | --- | --- | --- |
| 1 | *(create)* → `pending` | supersede-then-insert as Codex #1 | `{verifier}` sealed; `state_hash` stored | n/a |
| 2 | `pending` → `exchanging` | one-shot: `UPDATE … SET status='exchanging', claim_id=? WHERE state_hash=? AND status='pending' AND is_current AND expires_at > now() RETURNING *`; the pasted state is validated by hash comparison **before** the claim | unchanged | **No** |
| 3 | `exchanging` → `persisting` | as Codex #5 | tokens sealed | **No** |
| 4 | `persisting` → `succeeded` | as Codex #6 | cleared | idempotent |

Validating the pasted state by hash *before* reserving the attempt preserves the
current ordering (`claude-oauth.ts:404-407`), where a malformed or wrong-state
paste is rejected without burning the attempt.

### 2.5 Durable logout and replacement fencing

Today ownership is process-local `isCurrent()` — `attempts.get(key) === attempt`
(`claude-oauth.ts:294-297`), re-checked after the exchange (`:426-428`) and again
inside `persist()` immediately before the write (`:346-350`). In HA every one of
those becomes a **durable** check.

**Invalidation is atomic and generation-based.** Both "logout" and "start a new
attempt" run, in one transaction:

```sql
UPDATE provider_auth_attempts
   SET is_current = false, status = 'superseded', sealed_material = NULL
 WHERE tenant_id = ? AND user_id = ? AND provider = ? AND is_current;
```

Logout additionally clears the stored auth method and deletes the credential
file.

**Every stale worker re-validates before each side effect.** A worker holding an
in-flight claim must re-read and confirm `(attempt_generation, claim_id,
status, is_current)` **immediately before the credential write** and **again
immediately before the user-method mutation** — the two mutations are separate
and a supersede can land between them. On mismatch it aborts and performs the
cleanup below.

**The filesystem↔DB transaction gap is real and must be stated.** The credential
write is a file operation on the executor; it is not in the database
transaction. A worker can therefore complete a write for a generation that was
superseded microseconds earlier. Defined behavior:

1. A worker whose post-write re-validation fails **immediately deletes the
   credential file it just wrote** — it knows it wrote it and knows it lost.
2. Because step 1 can itself crash, `logout` is **not** complete on its DB
   commit alone. It records a `revoked_at` marker and a **second delete pass**
   runs after the maximum `persisting` claim lifetime has elapsed, sweeping any
   file written by a worker that lost the race and died before cleaning up.
3. `maintain()` treats a `persisting` row older than that lifetime as
   `ambiguous` and enqueues the same delete pass.
4. Consequence to document: for a bounded window after logout, a superseded
   credential file may exist on disk. It is deleted by pass 2. **Local deletion
   is not provider-side revocation** in either case — the same caveat MCP OAuth
   already carries.

---

## 3. Credential visibility: options

### Option A — shared / per-user executor credential home (RECOMMENDED)

Nothing to build for `shared-local` (§1.6, VERIFIED). For `external` the
requirement is already enforced at boot (`deployment.ts:375-380`), but the
backing store is **PRECONDITION A** — a declarative contract
(`types.ts:728-739`), not demonstrated provisioning. Must be confirmed with the
deployment owner before Phase 3 is scoped: durable, replica-consistent,
per-tenant/per-user home at a stable path (RWX PVC / NFS / per-user volume).

### Option B — credentials in encrypted DB, materialized per session

**Not now.** The provider CLIs *own* these files and refresh tokens in place, so
a DB copy goes stale or clobbers a refreshed token. Materializing credentials
into a workspace on every session start widens exposure. The DB today
deliberately stores only the auth *method*, never token material
(`packages/core/src/db/schema.sqlite.ts:1041`). Revisit only if a topology
genuinely cannot provide a consistent per-user home.

---

## 4. Enablement mechanism

1. Widen the literal types (`deployment.ts:74-76`): `codexDeviceAuth` → `boolean`;
   add `claudeOAuth: boolean`.
2. Rename `codexCredentialFiles` → `executorCredentialFiles` (same computation).
   It already gates Claude in #2317 — correct behavior under a misleading name.
3. **Delete `processAffineAuth`** (§1.3).
4. `claudeAuth`/`claudeOAuth` feature keys and gate entries are **already added
   by #2317** (`ha-support.ts`; `register-hooks.ts` +`['claude-auth/oauth','claudeOAuth']`,
   `['claude-auth/logout','claudeAuth']`). This design builds on that.
5. Extend `isHaFeatureUnavailable()` so `codexDeviceAuth` and `claudeOAuth` read
   their capabilities instead of falling through to `return true`.
6. Shared executor plumbing already de-duplicated by #2317
   (`utils/executor-credential-auth.ts`,
   `packages/executor/src/commands/credential-file-io.ts`). Reuse it. Attempt
   *storage primitives* are shared; *state machines* are not (§2.2).

Tests currently pinning the closed state: `ha-support.test.ts:116-138`,
`deployment.test.ts:50-58`, `register-hooks.test.ts:386`.

---

## 5. Security review

### 5.1 Secret handling

- [ ] Verifiers, `state`, device codes, authorization codes, and tokens never
      logged, never returned to the client, never in agent/LLM context
      (`claude-oauth.ts:29-30`).
- [ ] Claude: seal `{verifier}` only; store `state_hash`, never raw `state`
      (matching `authority.ts:165`).
- [ ] Distinct seal purpose domain (`'provider-signin'`) from MCP's
      `'pending-exchange'`; separate domain again for transiently sealed tokens.
- [ ] AAD binds tenant+user+provider+attempt+generation; a moved or retagged row
      fails to open.
- [ ] Sealed material cleared on every terminal status.
- [ ] Add `claude-auth/oauth` and `claude-auth/logout` to
      `REDIS_FEATHERS_DENIED_PATHS`. **Gap found in this review, best fixed on
      #2317.** `mayEnterRedisRelay()` (`realtime-publish.ts:275-282`) is
      **default-allow**; all three Codex counterparts are denied (`:268-270`) but
      the Claude equivalents were not added. Not a confirmed leak — payloads are
      status metadata and `claude-auth/logout` emits `patched` by design
      (`register-services.ts:742-743`) — but the denied set is defense-in-depth
      (`:249-250`), and HA enablement is what makes the omission load-bearing.

### 5.2 Blast radius of persisting secrets (expanded)

Persisting attempt material is a **real increase in blast radius**, not a
formality. Sealing with AAD narrows misuse of a *stolen row*; it does nothing
about the key, the backups, or the decrypt window.

- [ ] **Master-secret rotation.** `AGOR_MASTER_SECRET` is scrypt-derived per
      envelope with a random salt, so rotation is not transparent. Define: dual-key
      read (try new, fall back to old) during a rotation window, and — because
      attempt rows are short-lived (10–15 min) — **prefer draining over
      re-encrypting**: stop issuing attempts, let the TTL expire the table, then
      cut over. Persisted *tokens* (if §2.3 step 5 is adopted) live minutes, not
      months, so the same drain applies. Document that a rotation with no drain
      strands unopenable rows, which must fail closed to `ambiguous`, never
      plaintext.
- [ ] **Backups retain decryptable rows.** A database backup taken mid-flow
      contains sealed verifiers/codes/tokens that remain decryptable for as long as
      the master secret is valid — *far* longer than the 15-minute TTL. Rotation
      policy and backup retention must be considered together; state the effective
      exposure window as `max(backup retention, secret lifetime)`, not the TTL.
- [ ] **Least privilege.** The attempt table should be readable/writable only by
      the daemon role; no analytics/reporting/read-replica role should hold
      `SELECT` on `sealed_material`. Confirm RLS policy plus explicit column or
      table grants, and that the tenant GUC is required even for tenant `default`
      (the pattern used by the GitHub install-state table).
- [ ] **Plaintext lifetime after decrypt.** Once opened, the verifier/code/tokens
      are ordinary heap strings. Keep the decrypt as late and as narrow as
      possible; do not attach opened material to long-lived objects, logs, error
      payloads, or Feathers context; zero references on completion as the current
      in-memory code already does (`claude-oauth.ts:307-308`).
- [ ] **Mixed / missing key across the fleet.** A replica without
      `AGOR_MASTER_SECRET`, or with a different one, must **fail closed** — refuse
      to seal or open, mark `ambiguous`, and never fall back to plaintext (the
      SQLite dev fallback in `packages/core/src/db/encryption.ts` must not be
      reachable in HA). A partially-keyed fleet is a rollout error and should be
      loud, not silently degraded.
- [ ] Reconfirm at review time that persisting the verifier is still judged worth
      it versus Phase 1's in-process-only contract. This is a deliberate change of
      contract, not an implementation detail.

### 5.3 Tenant / user isolation

- [ ] Every read and write via `runWithTenantDatabaseScope()`; no unscoped query.
- [ ] An attempt is bound to `(tenant_id, user_id)` and can only be found,
      claimed, or completed by that identity.
- [ ] Cross-tenant and cross-user negative tests, mirroring
      `mcp-oauth-pending-flow-authority.postgres.test.ts:228-293`.
- [ ] Credential write targets the caller's own resolved home; `required_from_auth`
      + non-`persistent-per-user` stays refused at boot.

### 5.4 Lifecycle, revocation, rollout

- [ ] TTL on DB clock (`CURRENT_TIMESTAMP`), never application clock. Codex uses
      the fixed 15-minute constant (§1.5) — no invented `expires_in`.
- [ ] `maintain()`: expire overdue, mark abandoned claims `ambiguous`, delete
      terminal rows, enqueue the §2.5 delete pass.
- [ ] One-shot claim on every unreplayable step; codes never replayed after
      `ambiguous`.
- [ ] Codex poll lease single-owner; resumption disabled until PRECONDITION B.
- [ ] Newer attempt fences older via `attempt_generation`; logout invalidates
      atomically (§2.5).
- [ ] Fleet-shared stable `AGOR_MASTER_SECRET`; whole-cohort/offline cutover for
      the migration (pattern of `0078`/`0082`).
- [ ] Rate limiting: the auth limiter is in-memory and per-replica, so N replicas
      multiply allowed attempts. Enabling these endpoints in HA raises the value of
      edge/WAF quota enforcement; do not imply the local limiter is fleet
      enforcement.

---

## 6. Testing strategy

Beyond unit coverage of the state machines, the following crash/race cases must
be covered — the two-pool PostgreSQL harness in
`mcp-oauth-pending-flow-authority.postgres.test.ts:352-372` is the model.

**Claim and lease races**
- [ ] Two replicas race the exchange claim; exactly one wins, loser does not call
      the provider.
- [ ] Poll lease expires while a poll is in flight; the old owner's transition-3
      commit is rejected by the lease predicate.
- [ ] Stale owner receives approval after losing its lease → cannot commit; row
      resolves `ambiguous`.

**Crash windows**
- [ ] Death after approval observed, before the durable `approval_observed`
      commit → `ambiguous`, user restarts (never silently resumed).
- [ ] Death during `exchanging` → `ambiguous` after timeout; the authorization
      code is never retried.
- [ ] Death during `persisting` → `ambiguous`; §2.5 delete pass removes any file
      written.

**Invalidation races**
- [ ] Logout during `exchanging` and during `persisting`.
- [ ] New attempt supersedes an already-claimed older attempt; the older worker's
      pre-write re-validation aborts it.
- [ ] Post-write re-validation fails → worker deletes the file it wrote.
- [ ] Worker dies between a losing write and its own cleanup → logout's second
      delete pass removes the file.
- [ ] Supersede lands *between* the credential write and the user-method
      mutation.

**Crypto and fleet**
- [ ] AAD tamper (retagged tenant/user/generation) fails to open.
- [ ] Replica with a different master secret fails closed, never plaintext.
- [ ] Replica with a missing master secret refuses to seal/open in HA.
- [ ] TTL expiry and `maintain()` prune, including terminal-row deletion.

**Isolation**
- [ ] Cross-tenant claim rejection; cross-user claim rejection within a tenant.

**Integration**
- [ ] Kill a replica mid-flow on the Compose HA stack for each crash window.
- [ ] Phase 1 only: reconnect to a replica holding a stale attempt for the same
      user → `attempt_id` mismatch yields "start over", not "wrong state" (§2.1).

---

## 7. Recommendation

**Phase 1 = minimal affinity-scoped enablement for `shared-local`. Phase 2 =
durable PostgreSQL attempt state, which also serves `external`. Codex
resumable-lease stays gated behind PRECONDITION B.**

Phase 1 is genuinely small — sticky Socket.IO already does the routing, so it is
capability wiring plus an `attempt_id` echo plus a "start over" message. It keeps
the verifier in-process, preserving today's security contract exactly. It cannot
serve `external`, and it trades an honest 503 for a silent dependence on ingress
config, so it is a stopgap and should be labelled one.

Phase 2 is the design the support matrix already asked for. It reuses shipped,
race-tested primitives, survives replica loss and rolling deploys, and is the
only option that works for `external`. Its cost is a real change in blast radius
(§5.2) and a migration/rollout.

If only one phase can be funded, do Phase 2.

**Push-back on one review point.** The review asked to drop the boot-ID protocol
and drain machinery entirely. Agreed on both — but *not* on dropping attempt
identity with them. The attempt key is `` `${tenantId}:${userId}` ``
(`claude-oauth.ts:343`) with no attempt ID, so a reconnect onto a replica holding
an older unpruned attempt for the same user returns stale status and validates
the pasted code against the wrong `state`, surfacing as "wrong state" instead of
"start over" (`:392-407`). The `attempt_id` echo in §2.1 is a few lines, is
needed by Phase 2 anyway, and removes a confusing failure. Boot-ID and drain stay
dropped.

---

## 8. Phased plan

### Phase 0 — land #2317 (prerequisite, in flight)
Claude sign-in and its `claudeAuth`/`claudeOAuth` keys on `main`. No HA behavior
change; both fail closed. Ideally also lands the §5.1 Redis-denied-paths fix.

### Phase 1 — affinity-scoped `shared-local` (~1-2 days)
Capability widening + computation; delete `processAffineAuth`; rename to
`executorCredentialFiles`; `attempt_id` echo; "start over" UX; update
`ha-support.test.ts` / `deployment.test.ts` / `register-hooks.test.ts`; negative
coverage that `external` stays 503. Docs: `daemon-ha.mdx` — affinity requirement
and that replica loss aborts an in-flight sign-in.
**Risk: medium** (unverifiable operator dependency).

### Phase 2 — durable attempt state (~2-3 weeks)
Migration + RLS; repository with atomic claim, lease, `maintain()`; authority
service with the new seal purpose domain; Claude state machine (§2.4); Codex
state machine (§2.3) with resumption **disabled**; durable logout/replacement
fencing incl. the filesystem-gap delete passes (§2.5); keep the local Map for
SQLite/standalone as MCP OAuth does; §6 test matrix.
**Risk: medium-high** — migration, rollout ordering, blast-radius change.
Requires §5 signed off and a fleet-shared `AGOR_MASTER_SECRET`.

### Phase 3 — `external` / Cloud (blocked on PRECONDITION A)
Confirm Cloud's real `persistent-per-user` backing store, then validate the
credential write path end-to-end. Cannot be scoped from this repo alone.

### Phase 4 — Codex resumable polling (blocked on PRECONDITION B)
Only after provider poll semantics are established. Until then, owner death in
the approval window is `ambiguous` by design, not by omission.

### Rollout / flagging
Enablement is config-derived; no new feature flag. A deployment opts in by
declaring topology and storage guarantees and the existing gates open. Because
capabilities are computed per-replica, a partially-upgraded fleet can advertise
different capabilities — prefer an offline cutover to a rolling one.

---

## 9. Preconditions and open questions

- **PRECONDITION A — Cloud's `persistent-per-user` backing store.** Declared
  contract (`types.ts:728-739`), no demonstrated provisioning found in-repo. Must
  verify with the deployment owner **before enabling `external`**. (§1.6, §3)
- **PRECONDITION B — Codex device-poll semantics.** Whether observing approval
  consumes the authorization code, and whether re-polling reproduces it, is
  unverified. **Must verify before enabling resumable polling.** Until then,
  owner death in the approval window ⇒ `ambiguous` ⇒ user restarts. (§2.3)
- Whether `shared-local` should remain a permanently supported sign-in topology
  or Phase 1's code is deleted once Phase 2 lands.
- Whether transiently sealing exchanged tokens (§2.3 step 5) is worth the
  blast-radius increase versus making a post-exchange crash a full restart.

---

## 10. Notes on #2317's exploration doc

`context/explorations/claude-code-oauth-signin.md` (on #2317) remains accurate
for the shipped in-memory design. Two statements need qualifying if this design
lands:

1. **"The PKCE verifier never leaves the daemon."** True of the shipped design —
   it lives in one process's heap and is zeroed on completion
   (`claude-oauth.ts:307-308`). Under Phase 2 it becomes a sealed, AAD-bound row
   in PostgreSQL. Still never leaves Agor's trust boundary, but it becomes
   persisted and encrypted rather than memory-only, with the backup/rotation
   consequences in §5.2.
2. **"Token material flows browser → daemon → filesystem"** is imprecise. The
   browser carries the *authorization code and state* (pasted `CODE#STATE`); the
   access and refresh **tokens** never touch the browser — they go Anthropic →
   daemon → executor → `~/.claude/.credentials.json`. Worth correcting there, as
   the imprecise phrasing overstates browser exposure.

---

## Revision history

- **r2** (this revision) — Corrected the refuted MCP/DCR claim (§1.9): the durable
  MCP row seals `clientId`/`clientSecret`; MCP is gated pending separate
  activation, not by process-local DCR state. Added the Codex fenced state machine
  (§2.3) and durable logout/replacement fencing (§2.5). Made `state` hash-only and
  removed the r1 internal contradiction. Softened "Blocker 2 already solved" to a
  per-topology claim with PRECONDITION A. Corrected Codex TTL (fixed 15-min
  constant, no `expires_in`). Expanded security to rotation/backups/least
  privilege/plaintext lifetime/mixed keys. Reframed Phase 1 as minimal (dropped
  boot-ID and drain). Added the testing matrix and the #2317 cross-reference notes.
- **r1** — Initial design.

---

## Related

- `context/explorations/claude-code-oauth-signin.md` (#2317) — Claude flow protocol
  details; see §10.
- `context/explorations/web-terminal-ownership-ha.md` — affinity + owner fencing +
  visible reconnect precedent.
- `docs/internal/process-affine-ha-support-matrix-2026-08-07.md` — authoritative
  per-flow HA classification and stated intent.
- `docs/internal/daemon-ha-redis-realtime-2026-08-07.md` — Redis fanout contract,
  ingress affinity operational guidance.
- `apps/agor-docs/content/guide/daemon-ha.mdx` — operator-facing HA contract.
