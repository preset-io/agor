# Enabling Codex and Claude subscription OAuth sign-in in HA

Status: **design proposal, not implemented.** August 2026.

Scope: make the two provider subscription sign-in flows — Codex device auth
(`codex-auth/device`) and Claude subscription OAuth (`claude-auth/oauth`, added
by PR #2317) — actually work under `deployment.mode: ha` /
`support_profile: constrained-active-active`, instead of returning
`503 HA_FEATURE_UNSUPPORTED`.

Non-goals: MCP OAuth (`mcp-servers/oauth-*`), OpenCode auth, and provider API-key
paste flows. MCP OAuth has a distinct residual blocker described in
[Why MCP OAuth stays gated](#why-mcp-oauth-stays-gated-and-why-that-does-not-apply-here);
it is deliberately out of scope.

Throughout, **VERIFIED** means read from the tree at this commit with a
`file:line` citation. **DESIGN** means proposed and not yet built.

---

## TL;DR

1. There is only **one** real blocker, not two. Credential-file visibility
   (Blocker 2) is **already solved and already ungated** — `codexCredentialFiles`
   is the one HA capability that is computed rather than hardcoded, and
   `codex-auth/import` / `codex-auth/logout` already pass in a correctly
   configured HA deployment. The remaining blocker is the **in-memory `attempts`
   map** that holds the PKCE verifier / device code between requests.
2. `processAffineAuth` is **not** a ready-made hook. It has **zero consumers** —
   it is declared, assigned `false`, and asserted in one test fixture. Nothing
   reads it. It cannot be "flipped on".
3. Redis is **fanout-only** and is the wrong place for this. Auth paths are
   explicitly denied entry to the Redis relay, and the house pattern for every
   other HA-coordinated subsystem is PostgreSQL claims/leases.
4. Agor already ships a **complete, production-grade durable OAuth attempt
   store** for MCP OAuth: sealed PKCE material, tenant scoping, TTL, atomic
   one-shot claim, ambiguity handling. Codex/Claude should reuse that pattern
   rather than invent one.
5. **Recommended: Phase 1 ships affinity-based enablement (small, low risk,
   unblocks the shared-local topology today); Phase 2 ships the durable
   PostgreSQL attempt store (unblocks `external` / multi-replica Cloud).**

---

## 1. Verified baseline

### 1.1 The constrained HA profile and its fail-closed gate

- The profile constant is `constrained-active-active`
  (`apps/agor-daemon/src/ha-support.ts:6`).
- `isConstrainedHa()` is simply `deployment.mode === 'ha'`
  (`ha-support.ts:20-24`) — there is currently only one HA profile.
- `isHaFeatureUnavailable()` (`ha-support.ts:33-40`) is the whole decision:

  ```ts
  if (!isConstrainedHa(deployment)) return false;
  if (feature === 'codexAuth') return !deployment.capabilities.codexCredentialFiles;
  return true;                       // <-- everything else: unconditionally gated
  ```

  Note the shape: **`codexAuth` is the only feature with a real condition.**
  Every other feature — including `codexDeviceAuth` — falls through to the
  unconditional `return true`.
- The gate is applied as a `before:{all}` hook over an explicit inventory,
  `CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES`
  (`apps/agor-daemon/src/register-hooks.ts:525-539`), which contains
  `['codex-auth/device', 'codexDeviceAuth']`, `['codex-auth/import', 'codexAuth']`,
  and `['codex-auth/logout', 'codexAuth']`. It throws `Unavailable` with
  `code: 'HA_FEATURE_UNSUPPORTED'` (`ha-support.ts:26-31`).

This inventory-plus-capability shape is the key enablement lever: **the gates
already read from capabilities, so making a capability conditionally true opens
its gates with no change to the hook wiring.**

### 1.2 The capability flags are typed as literal `false`

`ResolvedDeploymentConfig` (`packages/core/src/config/deployment.ts:55-88`):

```ts
codexCredentialFiles: boolean;   // :74  <-- computed
codexDeviceAuth: false;          // :75  <-- literal type, not boolean
processAffineAuth: false;        // :76  <-- literal type, not boolean
```

and the values (`deployment.ts:469-472`):

```ts
codexCredentialFiles:
  executorStorage.user_home !== 'replica-local' && tenantSafeCredentialHome,
codexDeviceAuth: false,
processAffineAuth: false,
```

**This is a stronger statement than "hardcoded false".** The *type* is the
literal `false`, so assigning `true` is a compile error until the type widens to
`boolean`. That is deliberate: it makes the capability un-flippable by accident,
and it means enablement is necessarily a reviewed, typed change. `deployment.test.ts:50-58`
asserts the resolved capability object exactly, so it pins this too.

### 1.3 `processAffineAuth` has no consumers — it is vestigial

Repo-wide, `processAffineAuth` appears exactly three times:

| Site | What it is |
| --- | --- |
| `packages/core/src/config/deployment.ts:76` | type declaration (`false`) |
| `packages/core/src/config/deployment.ts:472` | assignment (`false`) |
| `apps/agor-daemon/src/ha-support.test.ts:31` | test fixture field |

There is **no** `deployment.capabilities.processAffineAuth` read anywhere — not
in `ha-support.ts`, not in `register-hooks.ts`, not in any service. It is also
absent from the authoritative support matrix's prose
(`docs/internal/process-affine-ha-support-matrix-2026-08-07.md`), which
discusses the concept but never names the flag.

**Conclusion:** `processAffineAuth` is a documentary placeholder, not a switch.
The brief's hypothesis that it is "a ready-made hook intended to be flipped true
when the deployment guarantees request affinity" is **not supported by the code**.
Any affinity-based design must add its own wiring; it should either give this
flag a real meaning and consumers, or delete it. Leaving an unread capability
flag in the resolved config is itself a small hazard — it reads like a control
and is not one.

### 1.4 Blocker 1 (VERIFIED): process-local attempt maps

**Codex device auth** — `apps/agor-daemon/src/services/codex-device-auth.ts:263`:

```ts
const attempts = new Map<string, DeviceAuthAttempt>();
```

The attempt holds the device auth ID, user code, target identity, and status;
a `setTimeout`-driven `pollTick()` loop (`:297-330`) polls OpenAI and writes
credentials only after a local ownership check (`isCurrent`, `:330`). A pruning
sweep expires overdue attempts (`:290-292`).

**Claude OAuth** — `apps/agor-daemon/src/services/claude-oauth.ts:292` (on
PR #2317 branch `claude-code-oauth-signin`; not yet on `main`):

```ts
const attempts = new Map<string, OAuthAttempt>();
```

keyed `` `${tenantId}:${userId}` `` (`:343`), holding `verifier` and `state`
(`:253-254`), zeroed on completion (`:307-308`).

The authoritative support matrix already states the intended fix
(`docs/internal/process-affine-ha-support-matrix-2026-08-07.md:253`, Codex
device auth row):

> Classification: **D** initially; later **P+E** per user.
> Owner death stops polling and status becomes idle elsewhere. User must request
> a fresh provider code. **Two replicas can each create a "single" attempt in
> static HA.**
> Initial HA disposition: Keep disabled in hosted/multi-tenant HA […] **A future
> design needs durable attempt generation and a per-user poller lease/fence.
> Device IDs, codes, authorization codes, and tokens never go to Redis.**

This design follows that stated intent.

### 1.5 The two flows are structurally different, and it matters

| | Codex device auth | Claude OAuth (PR #2317) |
| --- | --- | --- |
| Grant | RFC 8628 device authorization | authorization-code + PKCE (S256) |
| Secret in attempt | device auth ID + user code | PKCE `verifier` + `state` |
| Who drives completion | **daemon background poll loop** | **the user's next request** (paste `CODE#STATE`) |
| Needs a live in-process timer | **Yes** | **No** |
| Client ID | fixed public `app_EMoamEEZ73f0CkXaXp7hrann` (`codex-device-auth.ts:56`) | fixed public `9d1c250a-…` (`claude-oauth.ts:65`) |

The asymmetry is the crux. **Claude OAuth is purely request-driven** — three
calls (`create({})` → `find()` → `create({code})`) with no server-side timer.
Making it HA-safe requires only that the attempt be *findable*.

**Codex device auth additionally owns a live poll loop.** Even with durable
attempt state, exactly one replica must own the polling, or N replicas each poll
and race to redeem the same device code. That needs a lease, not just a row.

### 1.6 Blocker 2 (VERIFIED): largely already solved

`codexCredentialFiles` (`deployment.ts:469-470`) is true when
`user_home !== 'replica-local'` **and** `hasTenantSafeExecutorCredentialHome()`,
which is (`packages/core/src/config/executor-credential-storage.ts:8-15`):

```ts
config.multi_tenancy?.mode !== 'required_from_auth' ||
config.execution?.executor_storage?.user_home === 'persistent-per-user'
```

`user_home` accepts `replica-local` | `shared` | `persistent-per-user`
(`packages/core/src/config/types.ts:716-740`). HA startup already *refuses to
boot* without a tenant-safe home (`deployment.ts:375-380`).

A shared credential home is **not hypothetical — it is already provisioned and
exercised**. `docker-compose.ha.yml:47,157` mounts a named volume
`agor-ha-user-home` at `/home/agor` on both daemons, and `docker/ha/config.yaml:31`
declares `user_home: shared`, with the comment:

> One shared execution home for this static smoke profile. This makes auth-file
> import/logout and Tasks replica-consistent, but is not Cloud's per-user
> isolation contract. **The device-code poller remains gated.**

Credential path resolution is already replica-independent: the daemon computes
the target home (`resolveOwnerHomeStore()`,
`apps/agor-daemon/src/utils/sandbox-context.ts:108-124` →
`<data_home>/tenants/<tenant>/homes/<user>`), passes it to the executor as
`CODEX_HOME` (`apps/agor-daemon/src/utils/executor-codex-auth.ts:25-43`), and the
executor writes `0600` (`packages/executor/src/commands/codex-auth-file.ts:84-85`).
Nothing in that path is process-affine.

**Therefore: Blocker 2 needs no new mechanism for the supported topologies.**
It needs (a) generalizing the Codex-specific capability name to cover Claude, and
(b) an operator-facing storage contract for `persistent-per-user` on Cloud. It is
a naming and documentation gap, not an architecture gap.

### 1.7 Redis is fanout-only and is explicitly denied to auth paths

- Redis is required in HA but used **solely** as the Socket.IO adapter /
  `serverSideEmit` relay (`apps/agor-daemon/src/realtime/redis-realtime.ts`;
  boot fails closed at `:129-130`). It is `ioredis` behind
  `@socket.io/redis-adapter`; **no generic GET/SET/SETEX/lock surface is exposed
  to application code.**
- `REDIS_FEATHERS_DENIED_PATHS`
  (`apps/agor-daemon/src/utils/realtime-publish.ts:251-273`) explicitly lists
  `codex-auth/device`, `codex-auth/import`, `codex-auth/logout`, every
  `mcp-servers/oauth-*`, `user-mcp-oauth-tokens`, `session-tokens`, and
  `terminals`, under the comment (`:249-250`):

  > Authentication and credential control-plane results must never enter shared
  > Redis, even if a future service accidentally enables publication for them.

- Every other HA-coordinated subsystem coordinates through **PostgreSQL**, not
  Redis: knowledge-embedding claims
  (`packages/core/src/db/repositories/knowledge-embedding-work.ts:29-49`),
  environment-health leases (`repositories/environment-health.ts:26-41`), widget
  resolution durable claims, gateway listener leases, executor session-token
  bounded-use. All use the same idiom: atomic conditional `UPDATE` fenced by a
  `claim_token` + `claim_generation` + DB-clock `expires_at`. There is no leader
  election and no `SELECT … FOR UPDATE`.

**Conclusion: Redis is not a candidate for attempt state.** Using it would mean
building a new key/value surface, breaching a stated security boundary, and
diverging from the house coordination pattern — three costs for no benefit over
PostgreSQL.

### 1.8 The durable-attempt pattern already exists (MCP OAuth)

`mcp_oauth_pending_flows` (`packages/core/src/db/schema.postgres.ts:1792-1858`)
is a complete worked example of exactly the record this design needs:

- `tenant_id`, `user_id`, `attempt_id` (PK), `status`
  (`pending`/`exchanging`/`succeeded`/`failed`/`ambiguous`/`expired`).
- `state_hash` — SHA-256 of the OAuth `state`, **UNIQUE** (`:1834`). The raw
  state is never a column.
- `sealed_material` — the PKCE verifier and state, **AES-256-GCM sealed** via
  `sealMCPOAuthSecret()` (`packages/core/src/db/oauth-secret-envelope.ts`),
  scrypt-derived key from `AGOR_MASTER_SECRET`, with the tenant/user/server/
  attempt/generation binding as **AAD** so a moved or retagged row fails to open.
  Cleared on terminal states.
- `expires_at` — DB-clock TTL, 10 minutes
  (`services/mcp-oauth-pending-flow-authority.ts:34`).
- `exchange_claim_id` — the one-shot fence. Claim is a single atomic
  `UPDATE … SET status='exchanging', exchange_claim_id=? WHERE state_hash=? AND
  status='pending' AND expires_at > CURRENT_TIMESTAMP AND is_current=true
  RETURNING *` (`repositories/mcp-oauth-pending-flows.ts:357-372`). Two racing
  replicas: exactly one gets a row. Proven by a two-pool race test
  (`mcp-oauth-pending-flow-authority.postgres.test.ts:352-372`).
- `maintain()` (`repositories/mcp-oauth-pending-flows.ts:532-575`) expires
  overdue rows, marks abandoned exchanges `ambiguous` after 2 minutes, and
  deletes terminal rows after 24h.
- Tenant scoping via `runWithTenantDatabaseScope(db, tenantId, …)`
  (`packages/core/src/db/tenant-scope.ts:200-240`), which opens a native
  transaction and sets the tenant GUC for RLS.

**This is the blueprint.** Phase 2 below is largely "instantiate this table
shape for provider sign-in", not "design a durable OAuth store".

### 1.9 Why MCP OAuth stays gated, and why that does not apply here

MCP OAuth has a durable table and is *still* gated. The residual reason is
process-local **Dynamic Client Registration** state
(`oauth-mcp-transport.ts:415-418`):

```ts
// Cache for dynamically registered clients (per authorization server)
const dynamicClientCache = new Map<string, { client_id; client_secret?; redirect_uri }>();
```

The sealed material does not carry the dynamically registered `client_id` /
`client_secret`, so a replica that wins the durable claim may not hold the client
credentials needed to complete the exchange.

**Codex and Claude have no DCR.** Both use a single fixed, public, compile-time
client ID (`codex-device-auth.ts:56`; `claude-oauth.ts:65`). Every replica is
identically configured to talk to the provider.

This is the most consequential finding in this document: **provider sign-in is
strictly easier to make HA-safe than MCP OAuth**, and it is blocked only by the
attempt map, not by the harder problem that keeps MCP OAuth gated.

### 1.10 Ingress affinity is already mandatory

- HA **refuses to boot** without it (`deployment.ts:349-353`):
  `'Config error: HA requires deployment.ha.ingress_affinity: true for Engine.IO polling'`.
- The resolved topology types it as literally `ingressAffinity: true` in both
  variants (`deployment.ts:86-87`).
- The browser talks to the daemon over **Socket.IO**
  (`packages/core/src/api/index.ts:1413`, `transports: ['websocket','polling']`
  at `:1384`), and the Claude sign-in pane calls
  `client.service('claude-auth/oauth')`
  (`ClaudeOAuthSignIn.tsx:44-52`) — so all three calls of one sign-in ride **one
  sticky connection to one replica**.
- Caveat, stated in the ops guidance
  (`docs/internal/daemon-ha-redis-realtime-2026-08-07.md:92-93`): affinity is
  configured for the `/socket.io/` path only — *"leave REST unsticky"*. A live
  WebSocket never migrates; after daemon loss the client makes a **new**
  connection which may land anywhere.
- There is an accepted precedent for shipping a feature on exactly this
  contract: web terminals (`apps/agor-daemon/src/terminal-capability.ts:25-32`)
  are enabled only when `execution === 'shared-local' && sharedFilesystem &&
  ingressAffinity`, with the documented failure semantics in
  `context/explorations/web-terminal-ownership-ha.md`: *"Owner loss ends the Agor
  attachment. The UI displays Disconnected and requires an explicit Reconnect."*

---

## 2. Blocker 1 — attempt state: options

### Option A — affinity-scoped, owner-fenced in-process attempt

Keep the `attempts` map in process. Make the capability conditionally true when
the deployment's topology guarantees affinity, and make owner loss an explicit,
visible "start over" rather than a silent wrong answer.

**DESIGN sketch**

1. Widen `codexDeviceAuth` / add `claudeOAuth` from literal `false` to `boolean`
   in `ResolvedDeploymentConfig`.
2. Compute them from real guarantees, mirroring `terminal-capability.ts`:
   `topology.ingressAffinity === true && topology.execution === 'shared-local'
   && codexCredentialFiles`. (`shared-local` is required because Codex's poller
   must write the credential file from the replica that owns the poll.)
3. Stamp each attempt with the daemon **boot ID** and return it in the status
   payload. A `find()`/`create({code})` arriving at a replica whose boot ID does
   not match returns a distinct, non-scary `attempt_not_on_this_replica` status,
   and the UI restarts the sign-in — the same UX contract as terminal Reconnect.
4. Drain handling: on `SIGTERM`, cancel live attempts and push a terminal status
   before the replica leaves the pool.

**Pros.** Small and well-precedented; no schema, no migration, no new secret
storage. **Keeps the PKCE verifier in-process, preserving the current security
contract exactly** — no new place for a verifier to live. Ships for the
`shared-local` topology, which is the checked-in HA smoke stack.

**Cons.** Does **not** work for `execution_topology: external` (Cloud's intended
shape), because affinity is only asserted for `/socket.io/` — a REST or
external-callback entry can land anywhere. Rolling deploys become user-visible:
every replica restart aborts in-flight sign-ins. Affinity is an *operational*
promise from ingress config, and the daemon cannot verify it; a misconfigured
ingress silently degrades to "sometimes works", which is a worse failure mode
than the honest 503 today. Two replicas can still each create a "single" attempt
if the client reconnects mid-flow (the matrix's stated concern,
`process-affine-ha-support-matrix-2026-08-07.md:253`).

### Option B — durable attempt state in PostgreSQL (sealed), + poller lease

Instantiate the `mcp_oauth_pending_flows` pattern for provider sign-in.

**DESIGN sketch** — new table `provider_auth_pending_flows`:

| Column | Purpose |
| --- | --- |
| `tenant_id`, `user_id` | tenant scoping / RLS |
| `attempt_id` (PK) | identity |
| `provider` | `codex` \| `claude` — one table, both flows |
| `state_hash` UNIQUE | SHA-256 of `state` (Claude); for Codex, of the device auth ID |
| `sealed_material` | AES-256-GCM sealed `{verifier, state}` / `{deviceAuthId, userCode}`, AAD-bound to tenant+user+provider+attempt+generation |
| `status` | `pending`/`exchanging`/`succeeded`/`failed`/`ambiguous`/`expired` |
| `attempt_generation` | fences an older attempt against a newer one for the same user |
| `expires_at` | DB-clock TTL (10 min Claude; provider `expires_in` for Codex) |
| `exchange_claim_id` | one-shot exchange fence |
| `poll_lease_owner`, `poll_lease_expires_at` | **Codex only** — single-poller lease |
| `created_at`/`updated_at`/`finished_at` | lifecycle + `maintain()` pruning |

- Reuse `sealMCPOAuthSecret()` / `openMCPOAuthSecret()` with a **new purpose
  domain** (e.g. `'provider-signin'`) so envelopes cannot be cross-used between
  MCP OAuth and provider sign-in.
- Claude exchange = the existing atomic claim: `UPDATE … SET status='exchanging',
  exchange_claim_id=? WHERE state_hash=? AND status='pending' AND expires_at >
  CURRENT_TIMESTAMP RETURNING *`. Loser does not exchange.
- Codex polling = a renewable lease (the `environment-health.ts:26-41` idiom).
  Each replica's ticker tries to claim expired leases; exactly one polls. On
  owner death another replica picks the lease up within one lease period and
  **resumes polling the same device code** — a genuine availability improvement
  over Option A, not just parity.
- Credential write on success goes through the existing, already-replica-agnostic
  executor path (§1.6). Requires `codexCredentialFiles` — i.e. a
  non-`replica-local` home — which is orthogonal and already enforced.
- Follow the MCP precedent on ambiguity: if a replica dies after the provider may
  have consumed the code, the row becomes `ambiguous` and **is never replayed**.

**Pros.** Works for **both** topologies including `external`. Survives replica
loss and rolling deploys. Matches the stated intent at
`process-affine-ha-support-matrix-2026-08-07.md:253` ("durable attempt generation
and a per-user poller lease/fence") and the house PostgreSQL-claims pattern. One
table serves both providers.

**Cons — and one must be called out explicitly.** This **breaks the current
in-process-only security contract for the PKCE verifier.** Today the verifier
exists only in one process's heap and is zeroed on completion
(`claude-oauth.ts:307-308`); afterwards it is a sealed row in a shared database.
Sealing with AAD binding makes that acceptable — it is precisely what MCP OAuth
already does for the same class of secret — but it is a real change in blast
radius and must be reviewed as one, not waved through by analogy. Also: requires
a migration and whole-cohort rollout; hard-depends on a fleet-shared
`AGOR_MASTER_SECRET`; and SQLite/standalone must retain the local Map, so the
service carries two code paths (again, as MCP OAuth already does).

### Option C — Redis-hosted attempt state

**Rejected.** §1.7: Redis exposes no key/value surface to application code, auth
paths are explicitly denied the relay, the matrix repeats "never go to Redis" for
device codes and authorization codes, and nothing else in the system coordinates
through Redis. Recorded here only so it is not re-proposed.

---

## 3. Blocker 2 — credential visibility: options

### Option A — shared / per-user executor credential home (RECOMMENDED)

Already implemented and already exercised (§1.6). Nothing to build for
`shared-local`. For Cloud (`external` + `required_from_auth`), the requirement is
already enforced at boot: `user_home: persistent-per-user`
(`deployment.ts:375-380`).

**Remaining work is not code:** an operator-facing storage contract stating that
`persistent-per-user` must be backed by storage that presents the same per-user
home to every replica (RWX PVC / NFS / per-user volume), mounted at the same
path. **UNVERIFIED / open:** the repo documents the *contract* but no concrete
Cloud provisioning of `persistent-per-user` was found — only the `shared` Compose
smoke stack. Cloud's actual backing store must be confirmed with whoever owns
that deployment before Phase 3 is scoped.

### Option B — credentials in encrypted DB, materialized per session

Store the provider credential (access + refresh token) sealed in PostgreSQL and
write it to the executor home at session start.

**Pros.** Removes the shared-filesystem requirement entirely; would let
`user_home: replica-local` work; centralizes revocation.

**Cons.** Substantially larger. The provider CLIs **own** these files — Claude
Code and Codex both refresh their tokens in place, so the DB copy goes stale and
Agor would need read-back/reconciliation, or would clobber a refreshed token.
Materializing a credential into a workspace on every session start widens
exposure rather than narrowing it. Today the DB deliberately stores only the
*method* identifier, never token material
(`packages/core/src/db/schema.sqlite.ts:1041`) — this reverses a standing design
decision.

**Verdict: not now.** Revisit only if a topology genuinely cannot provide a
consistent per-user home.

---

## 4. Enablement mechanism

The gates are already capability-driven, so enablement is mostly typing and
computation — plus deleting a misleading flag.

1. **Widen the literal types** in `ResolvedDeploymentConfig`
   (`deployment.ts:74-76`): `codexDeviceAuth: false` → `boolean`; add
   `claudeOAuth: boolean`.
2. **Generalize the credential-file capability name.** `codexCredentialFiles`
   already gates Claude in PR #2317 — `ha-support.ts` there maps *both*
   `codexAuth` and `claudeAuth` onto `capabilities.codexCredentialFiles`. That is
   correct behavior under a misleading name. Rename to
   `executorCredentialFiles` (keeping the same computation) so the next provider
   does not have to read Codex's name to understand its own gate.
3. **Resolve `processAffineAuth`.** It has no consumers (§1.3). Either give it a
   real definition and readers (Phase 1) or delete it. Do not leave an unread
   flag that looks like a control.
4. **Add the `claudeOAuth` feature key** to `HA_UNSUPPORTED_FEATURES` and the
   gate inventory — **already done by PR #2317**
   (`ha-support.ts` +`claudeAuth`/`claudeOAuth`; `register-hooks.ts`
   +`['claude-auth/oauth','claudeOAuth']`, `['claude-auth/logout','claudeAuth']`).
   This design **builds on that**; it does not redo it.
5. **Extend `isHaFeatureUnavailable()`** so `codexDeviceAuth` and `claudeOAuth`
   read their capabilities instead of falling through to `return true`.
6. **One implementation, both providers.** PR #2317 already de-duplicated the
   executor plumbing (`utils/executor-credential-auth.ts`,
   `packages/executor/src/commands/credential-file-io.ts`). The attempt store
   should likewise be one module with a `provider` discriminator, not two.

**Tests to update** (all currently pin the closed state):
`apps/agor-daemon/src/ha-support.test.ts:116-138` (asserts the exact
`HA_UNSUPPORTED_FEATURES` key list, and that `codexDeviceAuth` is unavailable);
`packages/core/src/config/deployment.test.ts:50-58` (asserts the exact resolved
capability object); `register-hooks.test.ts:386`. Add negative coverage: gates
must still close when the enabling condition is absent.

---

## 5. Security review checklist

Any implementation must satisfy all of these before enablement ships.

**Secret handling**
- [ ] PKCE verifier, `state`, device codes, authorization codes, and tokens are
      never logged, never returned to the client, and never enter an agent/LLM
      context (the current services already assert this — `claude-oauth.ts:29-30`).
- [ ] Under Option B, the verifier is sealed with AES-256-GCM under a **distinct
      purpose domain** from MCP OAuth, AAD-bound to tenant+user+provider+attempt+
      generation, so a row cannot be replayed under a different binding.
- [ ] Raw `state` is stored only as a SHA-256 hash in an indexed column; the
      unique index is on the hash.
- [ ] Sealed material is cleared on every terminal status.
- [ ] `state` comparison stays constant-time (`claude-oauth.ts:160`).
- [ ] Explicitly confirm these paths stay in `REDIS_FEATHERS_DENIED_PATHS`
      (`realtime-publish.ts:251-273`) — and **add `claude-auth/oauth` and
      `claude-auth/logout`, which are absent from that set on PR #2317.**

      *Gap found during this review, and worth fixing on #2317 rather than here.*
      `mayEnterRedisRelay()` (`realtime-publish.ts:275-282`) is **default-allow** —
      a path is relayed unless it is explicitly denied. All three Codex
      counterparts (`codex-auth/device`, `codex-auth/import`, `codex-auth/logout`)
      *are* denied (`:268-270`); the Claude equivalents were not added. This is a
      parity gap, not a confirmed leak: `claude-auth/logout` deliberately emits
      `patched` (`register-services.ts:742-743`) and the oauth service returns
      status metadata only — token material and the verifier are never in a
      response (`claude-oauth.ts:29-30`). But the denied set exists precisely as
      defense-in-depth "even if a future service accidentally enables publication
      for them" (`:249-250`), and enabling these endpoints in HA is exactly the
      change that makes the omission load-bearing.

**Tenant / user isolation**
- [ ] Every read and write goes through `runWithTenantDatabaseScope()`; no
      unscoped query on the attempt table.
- [ ] An attempt is bound to `(tenant_id, user_id)` and can only be found,
      claimed, or completed by that same identity — a replica must not complete
      an attempt for a different user because the row happened to be visible.
- [ ] Cross-tenant negative tests, per CLAUDE.md's multi-tenancy rule and
      mirroring `mcp-oauth-pending-flow-authority.postgres.test.ts:228-293`.
- [ ] Credential write still targets the caller's own resolved home; confirm
      `required_from_auth` + non-`persistent-per-user` remains refused at boot.

**Lifecycle**
- [ ] Short TTL on DB clock (`CURRENT_TIMESTAMP`), never application clock.
- [ ] `maintain()` sweep: expire overdue, mark abandoned exchanges `ambiguous`,
      delete terminal rows.
- [ ] One-shot exchange claim; an authorization/device code is **never replayed**
      after an ambiguous outcome.
- [ ] Codex poll lease is single-owner and fenced; two replicas never poll one
      device code concurrently.
- [ ] Newer attempt for a user fences older ones (`attempt_generation`).

**Revocation & rollout**
- [ ] Logout deletes the credential file *and* any live attempt rows.
- [ ] Local deletion is not provider-side revocation — document that, as MCP
      OAuth already does.
- [ ] Rollout requires a fleet-shared stable `AGOR_MASTER_SECRET`; a replica
      without it must fail closed, not fall back to plaintext.
- [ ] Rate limiting: the auth limiter is in-memory and per-replica
      (`process-affine-ha-support-matrix-2026-08-07.md`, "Auth/launch rate limit"
      row) — N replicas multiply allowed attempts. Enabling these endpoints in HA
      increases the value of edge/WAF quota enforcement; state this rather than
      implying the local limiter is fleet enforcement.

---

## 6. Recommendation

**Do Option B (durable PostgreSQL attempt state), but ship Option A first as a
narrow, honestly-scoped Phase 1.**

Rationale: Option A is cheap, is precedented by web terminals, keeps the verifier
in-process, and unblocks the `shared-local` topology this week — but it cannot
serve `external`, which is where Cloud is going, and it converts an honest 503
into a silent dependence on ingress configuration the daemon cannot verify.
Option B is the design the support matrix already asked for, reuses a shipped and
race-tested mechanism, and is the only one that survives replica loss and rolling
deploys. Phase 1 should therefore be gated on `shared-local` specifically, and
framed as a stopgap that Phase 2 subsumes — not as the destination.

If only one phase can be funded, **do Phase 2 and skip Phase 1.**

---

## 7. Phased implementation plan

### Phase 0 — land PR #2317 (prerequisite, already in flight)

Claude sign-in and its `claudeAuth`/`claudeOAuth` HA feature keys must be on
`main` before either phase. No HA behavior change: both features fail closed.

### Phase 1 — affinity-scoped enablement for `shared-local` (~2-3 days)

- Widen `codexDeviceAuth`/`claudeOAuth` to `boolean`; compute from
  `topology.execution === 'shared-local' && topology.ingressAffinity &&
  executorCredentialFiles`.
- Give `processAffineAuth` a real meaning and readers, or delete it.
- Boot-ID-stamp attempts; add an explicit `attempt_not_on_this_replica` status
  and the UI restart affordance; drain live attempts on `SIGTERM`.
- Rename `codexCredentialFiles` → `executorCredentialFiles`.
- Update `ha-support.test.ts`, `deployment.test.ts`, `register-hooks.test.ts`;
  add negative coverage for `external` (must stay 503).
- Docs: `daemon-ha.mdx` — state the affinity requirement, and that replica loss
  aborts an in-flight sign-in.

**Risk: medium.** Correctness depends on operator ingress config the daemon
cannot verify. Mitigate by scoping strictly to `shared-local` and documenting the
failure mode loudly.

### Phase 2 — durable attempt store + Codex poller lease (~1.5-2.5 weeks)

- Migration: `provider_auth_pending_flows` (+ RLS policy), modeled on migration
  `0078`'s table.
- `ProviderAuthPendingFlowRepository` (atomic claim, lease claim/renew/release,
  `maintain()`); `ProviderAuthPendingFlowAuthority` service, new seal purpose
  domain.
- Refactor both services onto it; **keep the local Map for SQLite/standalone**,
  as MCP OAuth does.
- Codex poll lease + resume-on-new-owner; ambiguous-outcome handling with no
  code replay.
- Enable `codexDeviceAuth`/`claudeOAuth` for **both** topologies when
  `executorCredentialFiles` and PostgreSQL are present.
- Tests: two-pool PostgreSQL race (mirroring
  `mcp-oauth-pending-flow-authority.postgres.test.ts:352-372`), lease handoff,
  cross-tenant negatives, TTL/prune, seal/open AAD-tamper rejection, kill-a-replica
  mid-flow integration on the Compose HA stack.

**Risk: medium-high** — migration, rollout ordering, and a real change to where a
PKCE verifier lives. Requires the §5 checklist signed off and a fleet-shared
`AGOR_MASTER_SECRET`.

### Phase 3 — `external` topology / Cloud (scoping blocked)

Confirm how Cloud actually backs `persistent-per-user`, then validate the
credential write path end-to-end there. **Cannot be scoped from this repo alone**
(§3 Option A).

### Rollout / flagging

Enablement is already a config-derived capability, so no new feature flag is
needed — a deployment opts in by declaring the storage and topology guarantees,
and the existing gates open. Roll out Phase 2 as a whole-cohort cutover after the
migration (the pattern used for `0078` and `0082`). Because gates are computed
per-replica, a partially-upgraded fleet can advertise different capabilities;
prefer an offline cutover over a rolling one.

---

## 8. Open questions / not determined

1. **Cloud's `persistent-per-user` backing store.** Only the `shared` Compose
   smoke stack exists in-repo. Needs the deployment owner. (§3)
2. **`processAffineAuth` original intent.** Zero consumers, absent from the
   matrix prose; whether it was a placeholder for this work or a leftover could
   not be established from the tree or history. (§1.3)
3. **Provider tolerance for a resumed device-code poll from a different source.**
   Whether OpenAI's device endpoint objects to a poll resuming from another
   replica IP was not tested; it is protocol-legal but should be verified before
   Phase 2's lease-handoff is relied upon.
4. **Whether `shared-local` should be a permanent supported topology for sign-in**
   or only a stopgap — affects whether Phase 1's code is kept or removed after
   Phase 2.

---

## Related

- `context/explorations/claude-code-oauth-signin.md` (on PR #2317) — the Claude
  flow's verified protocol details.
- `context/explorations/web-terminal-ownership-ha.md` — the affinity + owner
  fencing + visible reconnect precedent.
- `docs/internal/process-affine-ha-support-matrix-2026-08-07.md` — authoritative
  per-flow HA classification and stated intent.
- `docs/internal/daemon-ha-redis-realtime-2026-08-07.md` — Redis fanout contract
  and ingress affinity operational guidance.
- `apps/agor-docs/content/guide/daemon-ha.mdx` — operator-facing HA contract.
