# Enabling Codex and Claude subscription OAuth sign-in in HA

Status: **design proposal, not implemented.** August 2026.
Revision 4 — **both preconditions now resolved**: A by infra (shared EFS), B by
empirical probe (the device poll is re-fetchable). See
[Revision history](#revision-history).

Scope: make the two provider subscription sign-in flows — Codex device auth
(`codex-auth/device`) and Claude subscription OAuth (`claude-auth/oauth`, added
by PR #2317) — actually work under `deployment.mode: ha` /
`support_profile: constrained-active-active`, instead of returning
`503 HA_FEATURE_UNSUPPORTED`.

Non-goals: MCP OAuth (`mcp-servers/oauth-*`), OpenCode auth, and provider API-key
paste flows.

Throughout, **VERIFIED** means read from the tree at this commit with a
`file:line` citation. **DESIGN** means proposed and not yet built.
**PRECONDITION** means an external fact this design depends on which the repo
alone cannot settle. Both preconditions raised by earlier revisions — A
(credential substrate) and B (device-poll semantics) — are now **resolved**;
see §1.6 and §1.12. Their residuals are tracked in §9.

---

## TL;DR

1. The blocking mechanism is the **in-memory `attempts` map** that holds
   per-attempt secret material between requests
   (`codex-device-auth.ts:263`; `claude-oauth.ts:292` on #2317).
2. Credential-file visibility is **solved in both topologies**. PRECONDITION A is
   **RESOLVED**: prod HA runs a shared-EFS RWX PVC with
   `user_home: persistent-per-user` and per-tenant/per-user `subPath` isolation
   (§1.6). Consequence: **Claude subscription OAuth in HA is not limited to an
   affinity-scoped stopgap** — the only remaining blocker for Claude is durable
   attempt state (Phase 2), in the general topology.
   Two new EFS-derived requirements apply (§1.10): persistent identity on both
   the credential-write and session-run paths, and fsync-before-rename.
3. `processAffineAuth` has **zero consumers** — declared, assigned `false`, one
   test fixture. It is not a switch. **Delete it**; do not rehabilitate it.
4. Redis is fanout-only and auth paths are explicitly denied the relay.
   PostgreSQL claims/leases are the house pattern. Redis is not a candidate.
5. Agor's MCP OAuth authority provides reusable **primitives** — sealed envelope,
   atomic one-shot claim, tenant scope, TTL/prune. Reuse the primitives.
   **Do not** assume one generic table serves both providers: Codex's flow has a
   materially different external-call shape and needs its own state machine (§2.3).
6. **Recommended: go straight to Phase 2 — durable PostgreSQL attempt state,
   serving the general topology.** With A resolved, Phase 1's affinity-scoped
   stopgap buys only a few days of earlier `shared-local` availability and is now
   optional. **PRECONDITION B is also resolved** (§1.12): the device-token poll
   was measured re-fetchable, so Codex poll-lease resumption is unblocked and
   owner death before the exchange is recoverable. Exactly-once lives entirely at
   the exchange claim.

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
heap until something durably records it.

Revision 2 treated this as potentially *consumptive* — that observing approval
might itself burn the code. **That worst case has been empirically refuted**
(§1.12): re-polling after approval returns the same `authorization_code` and
`code_verifier`. The poll is re-fetchable; the single-use step is the exchange
alone. §2.3 is built on that measured behavior.

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
| `external` / Cloud (`persistent-per-user`) | **PRECONDITION A — RESOLVED.** See below. `AgorExecutorStorageSettings` is a *"Declarative execution-substrate storage contract"* (`packages/core/src/config/types.ts:728-739`); infra has now confirmed the substrate that satisfies it. |

#### PRECONDITION A — resolved (infra, both prod Cells)

Reported by the infra owners. **These facts are external to this repo and were
not independently verified here** — `apps/manager-api/` does not exist in this
tree (`apps/` holds only `agor-cli`, `agor-daemon`, `agor-docs`, `agor-ui`), so
the `runtimeInternal.ts` line references below are recorded as supplied.

| Property | Confirmed state |
| --- | --- |
| Shared filesystem | One RWX PVC on StorageClass `efs-sc` (provisioner `efs.csi.aws.com`), mounted as `agor-home` on **every** executor pod — same filesystem on any node/replica, **not** replica-local (`runtimeInternal.ts:1341`) |
| Consistency | AWS EFS read-after-write — **guaranteed on `write()`+`close()`/fsync, not per buffered write**. Drives §1.10 R2. |
| Durability | PersistentVolume, StorageClass reclaim policy `Retain`, decoupled from pod lifecycle; survives reschedule, termination, autoscale |
| Config | `executor_storage.user_home: persistent-per-user`, `branch_workspace: persistent-per-branch`; `multi_tenancy: { mode: required_from_auth, filesystem_isolation_enabled: true }` |
| Isolation | `subPath: tenants/<tenantId>/home/<userSegment>` mounted at `/home/<userSegment>` (`runtimeInternal.ts:1310-1313`) — satisfies `hasTenantSafeExecutorCredentialHome()` (`executor-credential-storage.ts:8-15`), which requires exactly `user_home === 'persistent-per-user'` under `required_from_auth` |
| Eviction | None on the homes. Only `ttlSecondsAfterFinished: 3600` on the executor Job (`runtimeInternal.ts:1358`) and `uploads.max_age_days` on uploads. Volume 20Gi, `ALLOWVOLUMEEXPANSION=false` → the risk is **exhaustion (write failure), not deletion** |

**Consequence.** The credential home is replica-consistent in the *general*
topology, not only under affinity. So:

- **Claude subscription OAuth in HA is no longer stopgap-shaped.** Its only
  remaining blocker is durable attempt state (§2.4). Once that lands it works on
  `external` with no affinity dependency.
- **Codex** likewise gets its credential side unblocked. Its approval-window
  question (PRECONDITION B) has since also been resolved favorably (§1.12), so
  Codex has no remaining precondition either — durable attempt state is the only
  blocker for both providers.
- Phase 3 as originally written (a blocked scoping exercise) **collapses into
  Phase 2** for the credential side; see §8.

**Attempt state does not touch this volume.** The durable attempt record lives in
PostgreSQL (§2.2), so the 20Gi/no-expansion exhaustion risk applies only to the
credential files and workspaces, not to sign-in state. Worth stating because it
means a full volume degrades the *final write*, not the OAuth handshake — the
failure surfaces as a persist error the user can retry after cleanup, not as a
corrupted or half-committed attempt.

**Revision 1's "already solved" was still too strong at the time** — it was true
of the smoke stack and merely asserted of Cloud. It is now true of both, on
evidence.

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

### 1.10 Two requirements the EFS substrate imposes (VERIFIED against our code)

Resolving A introduces two hard requirements. Both were traced through this
repo; results below.

#### R1 — Persistent identity is mandatory on *both* paths

Infra gates persistence on `hasPersistentIdentity` (`runtimeInternal.ts:1199`,
as supplied): a run with no `userId` / `runtimeUserId` / sanitized unix user
lands on `anonymous-home`, an **emptyDir that dies with the pod**
(`runtimeInternal.ts:1343`). So the sign-in **credential write** and the later
**session runs** must *both* carry a resolved persistent identity, or the
credential is written somewhere that evaporates — or, worse, written to a real
home and then read from a different one.

**Verification result: both paths carry identity, and `delegated` mode fails
closed. One divergence hazard found.**

*Credential-write path — SAFE.*
- `resolveCodexCredentialRoute()` returns `ok: false, reason: 'resolve-failed'`
  when `userId` is absent: *"Codex credential routing requires an authenticated
  user identity."* (`apps/agor-daemon/src/services/codex-auth-shared.ts:153-159`).
- Under `delegated` it additionally requires a `unix_username`, returning
  `missing-username` otherwise (`:124-143`), resolved from the **caller's** user
  row (`UsersRepository.findById(userId)`, `:131-135`).
- `credentialExecutorOptions()` always forwards `user_id: routing.userId` and
  `unix_user: routing.reportedUnixUser ?? undefined`
  (`apps/agor-daemon/src/utils/executor-credential-auth.ts`, and on `main`
  `utils/executor-codex-auth.ts:27-30`).

*Session-run path — SAFE in `delegated`, softer elsewhere.*
- `register-services.ts:1215-1219` forwards `session_id`, `task_id`,
  `branch_id`, and `user_id: userId`.
- But `userId` is typed optional — `(params as AuthenticatedParams).user?.user_id
  as UserID | undefined` (`register-services.ts:930`).
- `resolveDelegatedHomeKey()` **throws** in `delegated` mode when the home key is
  missing (`packages/core/src/unix/delegated-home-key.ts:60-65`) and again on a
  malformed key (`:66-68`). Since prod is `required_from_auth` + delegated-style
  external execution, a missing identity is a hard failure, **not** a silent
  drop to `anonymous-home`. That is the reassuring result.
- Residual sharp edge: `substituteTemplateVariables()` only substitutes defined
  values (`utils/spawn-executor.ts:271-282`). An `undefined` `user_id` therefore
  leaves the **literal `{user_id}` in the rendered command** rather than failing
  or emptying it. Validation only runs when the value is defined
  (`:249-255`). In any topology whose template consumes `{user_id}` without
  `{unix_user}`, that is precisely the anonymous-home path.

**HAZARD — identity source divergence (flag for the implementation phase).**
The two paths resolve the home key from **different rows**:

| Path | Home-key source |
| --- | --- |
| Credential write | the **caller's** `users.unix_username` (`codex-auth-shared.ts:131-135`) |
| Session run | the **session's** `session.unix_username` (`register-services.ts:1064,1066-1069`) |

Both are non-empty in `delegated` mode, but nothing constrains them to be the
**same value**. When they diverge, the credential is written into user A's home
and the session reads user B's — a silent "signed in, but the agent still says
unauthenticated". This is not hypothetical: `dangerously_allow_session_sharing`
exists precisely so a child session can inherit `parent.created_by` rather than
the caller (see CLAUDE.md), and a session's `unix_username` is stamped at
creation and can drift from the user's current value.

**Required for HA (design):** before enabling, assert that the credential-write
home key and the run home key resolve to the same value for the target user, and
fail closed with an actionable message when they don't. Do not paper over it by
writing to both.

#### R2 — fsync/close before rename (EFS close-consistency)

EFS cross-client visibility holds on `write()`+`close()`, not per buffered
write. Our credential write is temp-file → rename.

**Verification result: `close()` happens; `fsync()` does not.**

The shared helper introduced by #2317
(`packages/executor/src/commands/credential-file-io.ts`, and the equivalent
inline sequence on `main` at `packages/executor/src/commands/codex-auth-file.ts:79-86`):

```ts
await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
await chmod(temporary, 0o600);
await rename(temporary, target);
```

- `fs/promises.writeFile` opens, writes, and **closes** the descriptor, so the
  EFS close-to-open *visibility* contract is satisfied for the temp file before
  the rename. This is the good news and it is why the current code mostly works.
- There is **no `fsync` on the temp file** and **no `fsync` on the containing
  directory** after the rename. So the bytes and the new directory entry are not
  forced durable. A pod killed (or a node lost) between the rename and the
  server-side flush can leave the credential file absent or truncated *after the
  daemon has already reported success and flipped the user's auth method* — the
  exact split-brain the §2.5 fencing is otherwise designed to prevent.
- The code already anticipates this class of problem: the helper's own doc
  comment says the read-back *"is retried once because some networked/overlay
  filesystems briefly surface a rename before the new bytes are visible"*, and it
  re-reads the target and compares against what it wrote
  (`codex-auth-file.ts:88-100` on `main`). That read-back is a real mitigation
  for visibility, but it is a **same-client** read and does not establish
  durability.

**Required change for HA on EFS (implementation phase, not now):** open the temp
file explicitly, `write` → `fsync(fd)` → `close(fd)`, then `rename`, then
`fsync` the containing directory. Keep the existing read-back verification.
Because both providers now share `writeCredentialFileAtomically()`, this is
**one fix in one function** covering Codex and Claude.

### 1.11 Ingress affinity is already mandatory

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

### 1.12 PRECONDITION B — measured: the device-token poll is re-fetchable

**Probe run 2026-08-18** against the live OpenAI device endpoints with a real
Codex subscription account, client_id `app_EMoamEEZ73f0CkXaXp7hrann`.
`POST https://auth.openai.com/api/accounts/deviceauth/token` with
`{device_auth_id, user_code}` — the exact request our `pollDeviceToken()` issues
(`codex-device-auth.ts:141-147`):

| Step | Result |
| --- | --- |
| Polls #1–#5 (before approval) | HTTP **403**, body key `error` |
| Poll #6 (after in-browser approval) | HTTP **200**, body keys `{authorization_code, code_challenge, code_verifier, status, user_code, user_code_expiration}` |
| **Re-polls #1, #2, #3 (after approval)** | **HTTP 200, all returning the SAME `authorization_code` and `code_verifier`** |

Secrets redacted; the exchange was deliberately **not** performed, so no token
was minted and the authorization code was never consumed.

**Three findings.**

1. **Observing approval is NOT consumptive.** The worst-case assumption behind
   revision 2's `ambiguous`-on-owner-death default is **disproven**. A replica
   that takes over a lease can re-poll the same `device_auth_id` / `user_code`
   and receive the same code and verifier back.
2. **Exactly-once lives entirely at the exchange.** The single-use step is
   `POST /oauth/token` (`codex-device-auth.ts:165-191`); the poll is freely
   repeatable. So the **atomic one-shot exchange claim is the correct and
   sufficient exactly-once mechanism**, and poll-resume is safe alongside it.
   This is a cleaner separation than r2 assumed: the lease governs *who polls*
   (an efficiency and rate-limit concern), while the claim governs *who
   exchanges* (the correctness concern).
3. **`403` as "pending" is confirmed** — matching the existing comment *"403/404
   are the server's 'authorization pending' signals for this endpoint"*
   (`codex-device-auth.ts:136`), and the provider-supplied `code_verifier` in the
   200 body confirms §1.5's reading of `:151`.

**Residual, stated honestly.** The probe ran from a **single egress IP**. It
proves *idempotency*; it does **not** prove *cross-replica-IP tolerance*. The
assessment is that this is very likely fine — RFC 8628 device flow is designed
for a *separate* device to poll, the request carries only `device_auth_id` +
`user_code`, and no cookie or IP binding was observed — but it is unproven.

**Design stance:** assume re-fetchable (proven) and **keep `ambiguous → restart`
as the fallback** if a cross-replica re-poll ever fails in practice. A clean
cross-IP test needs a second egress host; it is a nice-to-have, not a blocker.

**Noted but out of scope:** the 200 body carries `user_code_expiration`, a real
provider-supplied expiry. Our poll parses only `authorization_code` and
`code_verifier` (`codex-device-auth.ts:148-156`) and the lifetime stays the fixed
15-minute local constant (§1.5). Adopting the provider's value would be an
accuracy improvement, but it is a separate change and does not affect this
design — §1.5's point stands, since it was about the *usercode* response, which
still has no expiry field (`:115-128`).

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
| 3 | `pending` → `approval_observed` | `UPDATE … SET status='approval_observed', sealed_material=? WHERE attempt_id=? AND status='pending' AND attempt_generation=? AND poll_lease_owner=? AND poll_lease_expires_at > now()` | + `authorizationCode`, `codeVerifier` (both provider-supplied) | **Recoverable** — a new lease owner re-polls and gets the same code back (§1.12) | **Yes — the poll is re-fetchable** |
| 4 | `approval_observed` → `exchanging` | one-shot: `UPDATE … SET status='exchanging', claim_id=? WHERE attempt_id=? AND status='approval_observed' AND is_current AND attempt_generation=?` | unchanged | Abandoned `exchanging` → `ambiguous` after timeout | **No** — authorization codes are single-use |
| 5 | `exchanging` → `persisting` | `UPDATE … SET status='persisting', sealed_material=? WHERE attempt_id=? AND status='exchanging' AND claim_id=?` | tokens sealed (separate purpose domain), code cleared | Crash before commit → `ambiguous`; tokens lost, user restarts | **No** |
| 6 | `persisting` → `succeeded` | re-validate `(attempt_generation, claim_id, status='persisting', is_current)` **immediately before** the credential write **and again before** the user-method mutation; then `UPDATE … SET status='succeeded', sealed_material=NULL` | cleared | See §2.5 filesystem gap | Write is idempotent (same tokens, same path) |

**Transition 3 was the feared one; the probe defused it.** The provider returns
the authorization code in the poll response, and re-polling after approval
returns the *same* code and verifier (§1.12). So:

- **Lease takeover of a `pending` attempt whose lease expired resumes polling.**
  The new owner re-polls the same `device_auth_id` / `user_code`. If the user has
  already approved, the very first re-poll returns the code and the attempt
  proceeds to transition 4 — owner death before the exchange is **recoverable**,
  not a restart.
- **`ambiguous → restart` is retained as the FALLBACK**, not the default. A
  re-poll that returns a terminal provider error, or that keeps returning
  `pending` past `expires_at`, resolves the attempt to `ambiguous`/`expired` and
  the user restarts. This is what covers the unproven cross-IP case (§1.12) — if
  a different egress IP is in fact rejected, the failure is a clean restart, not
  a hang or a double-spend.
- **Double-polling is now a non-issue for correctness.** If a slow owner and a
  new lease owner briefly both poll, both simply receive the same code. Only one
  can win transition 4's one-shot claim, and only that winner exchanges. The
  lease remains worthwhile for rate-limit hygiene and to keep one clear owner,
  but it is no longer load-bearing for exactly-once.
- Still make lease expiry rare rather than relying on takeover: short renew
  interval (~15 s) against a generous lease (~60 s), well inside the 15-minute
  window.

**Where exactly-once actually lives.** The authorization code is single-use at
`POST /oauth/token` only. Transition 4's atomic claim is therefore the complete
exactly-once mechanism: freely repeatable poll, exactly-once exchange. Transitions
4–6 are unchanged by the probe — a crash *during or after* the exchange is still
`ambiguous` and is still never replayed.

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

Nothing to build for `shared-local` (§1.6, VERIFIED). For `external`, the
requirement is enforced at boot (`deployment.ts:375-380`) **and the backing store
is now confirmed** — shared-EFS RWX PVC, `persistent-per-user`, per-tenant/user
`subPath` isolation (§1.6, PRECONDITION A resolved).

Two implementation obligations follow from that substrate rather than from the
config contract, both detailed in §1.10: **R1** identity must resolve on the
credential-write *and* session-run paths (with the divergence assertion), and
**R2** the atomic write must `fsync` before rename.

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
- [ ] **R1** — both the credential write and the session run resolve a persistent
      identity, and the two home keys are asserted equal before enabling
      (§1.10 R1). A run that cannot resolve one fails closed rather than
      rendering an unsubstituted `{user_id}` (`spawn-executor.ts:271-282`).
- [ ] **R2** — `fsync` the temp file before `rename` and `fsync` the directory
      after, in `writeCredentialFileAtomically()` (§1.10 R2). Keep the read-back
      verification.
- [ ] Credential-home volume exhaustion (20Gi, no expansion) surfaces as an
      explicit persist failure the user can retry, never as a partial write that
      is reported as success. Attempt state is in PostgreSQL and is unaffected.

### 5.4 Lifecycle, revocation, rollout

- [ ] TTL on DB clock (`CURRENT_TIMESTAMP`), never application clock. Codex uses
      the fixed 15-minute constant (§1.5) — no invented `expires_in`.
- [ ] `maintain()`: expire overdue, mark abandoned claims `ambiguous`, delete
      terminal rows, enqueue the §2.5 delete pass.
- [ ] One-shot claim on every unreplayable step; codes never replayed after
      `ambiguous`.
- [ ] Codex poll lease single-owner. Resumption is **enabled** (§1.12), with
      `ambiguous → restart` retained as the fallback when a re-poll fails.
      Exactly-once is enforced by the exchange claim, not by the lease.
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
      commit → a new lease owner **re-polls and recovers the same code** (§1.12),
      and the attempt completes. Assert the exchange still happens exactly once.
- [ ] Re-poll fallback: stub the provider to reject or keep returning `pending`
      after approval → the attempt resolves `ambiguous`/`expired` and the user
      restarts, with no hang and no second exchange. This is the cross-IP
      safety net (§1.12 residual).
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

**Shared credential home (EFS)**
- [ ] Sign in on replica A, run a session on replica B → the session sees the
      credential. This is the test that PRECONDITION A actually buys the general
      topology, and it must run on the real substrate, not Compose.
- [ ] Credential-write home key and session-run home key diverge → fails closed
      with an actionable message, not a silent "still unauthenticated" (§1.10 R1).
- [ ] A run with no resolvable user identity fails closed; assert no rendered
      command ever contains a literal `{user_id}` or `{unix_user}`.
- [ ] Kill the pod between `rename` and read-back → the credential is either
      fully present or absent, never truncated, and the user's auth method is not
      flipped on a write that did not survive (§1.10 R2).
- [ ] Full volume (simulated ENOSPC) → explicit persist failure, retryable; the
      attempt row is unaffected.

**Integration**
- [ ] Kill a replica mid-flow on the Compose HA stack for each crash window.
- [ ] Phase 1 only: reconnect to a replica holding a stale attempt for the same
      user → `attempt_id` mismatch yields "start over", not "wrong state" (§2.1).

---

## 7. Recommendation

**Go to Phase 2 — durable PostgreSQL attempt state — and treat Phase 1 as
optional. Both preconditions are now resolved, so Codex's resumable lease folds
into Phase 2 rather than trailing it.**

Resolving PRECONDITION A changed the calculus. Previously Phase 1 was the only
thing that could ship soon, because `external` was blocked on an unknown
credential substrate. Now the credential home is confirmed replica-consistent in
the general topology, so **durable attempt state is the single remaining blocker
for Claude**, and it unblocks `external` directly. Phase 1 would buy a few days
of earlier `shared-local` availability at the cost of code that Phase 2 deletes,
plus a documented dependence on ingress config the daemon cannot verify. Ship it
only if `shared-local` availability is independently urgent.

Phase 2 reuses shipped, race-tested primitives, survives replica loss and rolling
deploys, and now needs no topology caveat. Its cost is the blast-radius change
(§5.2), a migration/rollout, and the two §1.10 obligations — of which R2 is one
fix in one shared function.

Codex is no longer held back on either side. The credential home is confirmed
(§1.6) and the approval-window worst case is refuted (§1.12), so its resumable
lease is buildable now — with the exchange claim carrying exactly-once and
`ambiguous → restart` as the fallback.

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

### Phase 1 — affinity-scoped `shared-local` (~1-2 days) — **OPTIONAL**
Superseded in value by PRECONDITION A's resolution; ship only if early
`shared-local` availability is independently urgent. Phase 2 deletes most of it.

Capability widening + computation; delete `processAffineAuth`; rename to
`executorCredentialFiles`; `attempt_id` echo; "start over" UX; update
`ha-support.test.ts` / `deployment.test.ts` / `register-hooks.test.ts`; negative
coverage that `external` stays 503. Docs: `daemon-ha.mdx` — affinity requirement
and that replica loss aborts an in-flight sign-in.
**Risk: medium** (unverifiable operator dependency).

### Phase 2 — durable attempt state (~2-3 weeks)
Migration + RLS; repository with atomic claim, lease, `maintain()`; authority
service with the new seal purpose domain; Claude state machine (§2.4); Codex
state machine (§2.3) with resumption **enabled** (§1.12) and the re-poll failure
fallback; durable logout/replacement
fencing incl. the filesystem-gap delete passes (§2.5); keep the local Map for
SQLite/standalone as MCP OAuth does; §6 test matrix.
**Risk: medium-high** — migration, rollout ordering, blast-radius change.
Requires §5 signed off and a fleet-shared `AGOR_MASTER_SECRET`.

### Phase 3 — `external` / Cloud — **collapsed into Phase 2**
PRECONDITION A is resolved (§1.6), so this is no longer a separate blocked
scoping exercise. What remains are the two §1.10 obligations, which belong inside
Phase 2:
- **R2 fsync-before-rename** in `writeCredentialFileAtomically()` — one function,
  covers both providers. Do this first; it is small and independently correct.
- **R1 identity assertion** — credential-write and session-run home keys must
  resolve equal, failing closed otherwise.
- End-to-end validation on the real EFS substrate (sign in on replica A, run on
  replica B), which Compose cannot exercise.

### Phase 4 — Codex resumable polling — **unblocked; folded into Phase 2**
PRECONDITION B is resolved (§1.12): the poll is re-fetchable, so resumption is
safe to build alongside the state machine rather than as a follow-on. It is no
longer a separate phase. Ship it with the `ambiguous → restart` fallback, which
also covers the unproven cross-egress-IP case.

Optional follow-up (not a blocker): re-run the §1.12 probe from a **second
egress host** to close the cross-IP question directly. If it ever fails in
production, the fallback already degrades to a clean restart.

### Rollout / flagging
Enablement is config-derived; no new feature flag. A deployment opts in by
declaring topology and storage guarantees and the existing gates open. Because
capabilities are computed per-replica, a partially-upgraded fleet can advertise
different capabilities — prefer an offline cutover to a rolling one.

---

## 9. Preconditions and open questions

- **PRECONDITION A — RESOLVED.** Prod HA (both Cells) runs a shared-EFS RWX PVC,
  `user_home: persistent-per-user`, per-tenant/user `subPath` isolation, `Retain`
  reclaim, no home eviction. Supplied by infra and recorded in §1.6; the
  `manager-api` line references were **not** independently verified here because
  that repo is not in this tree. Two obligations follow (§1.10 R1/R2).
- **Residual from A — volume headroom.** 20Gi with
  `ALLOWVOLUMEEXPANSION=false` means the failure mode is exhaustion, not
  deletion. Credential writes must fail loudly on ENOSPC rather than reporting
  success. Attempt state is in PostgreSQL and is not exposed to this.
- **New — identity-source divergence.** The credential write resolves the home
  key from the caller's `users.unix_username`; the session run resolves it from
  `session.unix_username`. Nothing constrains them to match, and
  `dangerously_allow_session_sharing` makes divergence reachable. Needs the
  equality assertion in §1.10 R1. (Design flag; no code change now.)
- **PRECONDITION B — RESOLVED (2026-08-18).** Measured against the live OpenAI
  device endpoints: re-polling after approval returns the **same**
  `authorization_code` and `code_verifier`, so observing approval is **not**
  consumptive and owner death before the exchange is recoverable. Exactly-once is
  carried by the exchange claim alone. (§1.12, §2.3)
- **Residual from B — cross-egress-IP tolerance.** The probe ran from a single
  egress IP, so it proves idempotency, not that a *different* replica's IP is
  accepted. Assessed low-risk (device flow is designed for a separate polling
  device; the request carries only `device_auth_id` + `user_code`; no cookie/IP
  binding observed) and covered by the `ambiguous → restart` fallback. A
  second-egress-host probe would close it; nice-to-have, not a blocker.
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

- **r4** (this revision) — **PRECONDITION B resolved** by empirical probe against
  the live OpenAI device endpoints (2026-08-18, §1.12): re-polling after approval
  returns the **same** `authorization_code` and `code_verifier`, refuting r2's
  worst-case assumption that observing approval might consume the code. Codex
  transition 3 changes from "DANGEROUS / `ambiguous`" to **recoverable via
  re-poll**, with `ambiguous → restart` retained as the fallback covering the
  unproven cross-egress-IP case. Recorded the clean separation this buys: the
  **lease governs who polls; the exchange claim governs who exchanges and is the
  complete exactly-once mechanism.** Phase 4 is unblocked and folds into Phase 2.
  Both preconditions are now closed. Also noted the poll response carries
  `user_code_expiration`, which our code does not parse (out of scope).
- **r3** — **PRECONDITION A resolved** by infra: prod HA runs a
  shared-EFS RWX PVC with `persistent-per-user` and per-tenant/user `subPath`
  isolation (§1.6). Consequence: Claude sign-in in HA is no longer stopgap-shaped
  — durable attempt state is its only remaining blocker, in the general topology.
  Phase 3 collapses into Phase 2; Phase 1 becomes optional; the recommendation
  changes to "go straight to Phase 2". Added §1.10 with two EFS-derived
  requirements **verified against our code**: R1 persistent identity on both the
  credential-write and session-run paths (both carry it; `delegated` fails closed;
  found an identity-source **divergence hazard** between `users.unix_username` and
  `session.unix_username`), and R2 fsync-before-rename (**`close()` happens via
  `writeFile`, `fsync` does not** — required change for EFS durability). Added
  shared-credential-home test cases and the volume-exhaustion note.
- **r2** — Corrected the refuted MCP/DCR claim (§1.9): the durable
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
