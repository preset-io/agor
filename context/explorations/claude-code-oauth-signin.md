# Claude Code OAuth Sign-In

Lets a user sign in with their Claude subscription (Pro/Max/Team/Enterprise) from
the Agor UI — the same capability Agor ships for Codex via `/codex-auth/device` —
instead of running `claude setup-token` on a machine with a browser and pasting a
long-lived token into Agor. This documents the verified auth mechanism and the
design rationale of the shipped feature.

The Codex module is the template it mirrors:

- `apps/agor-daemon/src/services/codex-device-auth.ts`
- `apps/agor-daemon/src/services/codex-auth-shared.ts`
- `apps/agor-daemon/src/utils/executor-codex-auth.ts`
- `packages/executor/src/commands/codex-auth-file.ts`
- `apps/agor-ui/src/components/CodexAuth/CodexDeviceSignIn.tsx`

---

## VERIFIED vs UNVERIFIED

Split into what was independently verified against the pinned Claude binary and
what remains unconfirmed.

### VERIFIED

Sources: the pinned SDK is **`@anthropic-ai/claude-agent-sdk@0.3.259`** (in
every workspace `package.json`; loaded via `loadManagedAgenticToolSdk`). That
SDK no longer ships a `cli.js` — its `manifest.json` bundles the **native
`claude` CLI v2.1.259** (commit `9b549c8d`) which it extracts and spawns. The
OAuth constants and flow below were **re-checked in the installed v2.1.259
native binary** for this upgrade (the original audit used v2.1.211), and
cross-checked against Anthropic's official docs
(<https://code.claude.com/docs/en/authentication>).

1. **There is NO device-authorization (RFC 8628) endpoint for Claude Code.**
   The claim "no device endpoint" was treated as something to disprove, not
   assume. The native binary's login flow uses only a loopback-or-manual
   authorization-code redirect (original v2.1.211 login-builder audit); its Anthropic OAuth
   config exposes no device-grant endpoint, and the official auth doc describes
   only the browser + paste-back flow. The one `device_code` string in the binary
   lives in the bundled `@azure/msal-common` generic OAuth param enum (the
   Console/Foundry path), not the Anthropic login flow — a false positive, not a
   device endpoint. This is the **one structural difference from Codex** — see
   below.
2. **Claude Code uses OAuth 2.0 authorization-code + PKCE (S256) with a
   paste-back code.** These are the production OAuth config plus the login
   authorize builder and token exchange. The values the service uses:
   - authorize URL (subscription / Claude Pro-Max):
     **`https://claude.com/cai/oauth/authorize`** (`yol.CLAUDE_AI_AUTHORIZE_URL`).
     The Console/API-billing login instead uses `yol.CONSOLE_AUTHORIZE_URL` =
     `https://platform.claude.com/oauth/authorize`. Note this is **not** the
     historical `claude.ai/oauth/authorize`.
   - token URL: **`https://platform.claude.com/v1/oauth/token`** (`yol.TOKEN_URL`).
     `console.anthropic.com` was the pre-rename host and is gone in prod.
   - redirect_uri (paste-back): **`https://platform.claude.com/oauth/code/callback`**
     (`yol.MANUAL_REDIRECT_URL`). The CLI's own browser flow can instead use a
     loopback `http://localhost:{port}/callback`; the daemon has no loopback
     server so it uses the manual redirect.
   - client_id: **`9d1c250a-e61b-44d9-88ed-5944d1962f5e`** (`yol.CLIENT_ID`) — a
     single fixed public id. (The other id in the binary,
     `22422756-60c9-4084-8eb7-27705fd5cf9a`, is the **local-dev** config
     `-local-oauth`/`localhost:8205`, not prod.)
   - authorize query params (re-checked in v2.1.259): `code=true`, `client_id`,
     `response_type=code`, `redirect_uri`, `scope`, `code_challenge`,
     `code_challenge_method=S256`, `state`. `code=true` selects the code-display
     (paste-back) page — required since we have no loopback server.
   - scope string: **`user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`**.
     `user:file_upload` is present in the v2.1.259 subscription-login scope set
     and was added to Agor's URL as part of this SDK upgrade.
   - token exchange: **`POST` with `Content-Type: application/json`**,
     `grant_type=authorization_code`; **no** `oauth-2025-04-20` beta header on the
     exchange call. `refresh_token` grant also present (renewal).
   - the authorize page returns the code as **`CODE#STATE`** which the user
     copies back (the `Paste code here if prompted` path the docs describe for
     WSL2/SSH/containers).
3. **On-disk credential format read by the SDK/CLI on Linux:**
   `~/.claude/.credentials.json`, mode `0600` (macOS uses the Keychain; if
   `CLAUDE_CONFIG_DIR` is set the file lives under that dir instead). Shape
   (keys verified present in the SDK: `claudeAiOauth`, `subscriptionType`,
   `rateLimitTier`):
   ```json
   {
     "claudeAiOauth": {
       "accessToken": "sk-ant-oat01-...",
       "refreshToken": "sk-ant-ort01-...",
       "expiresAt": 1748276587173,
       "scopes": ["user:inference", "user:profile"],
       "subscriptionType": null,
       "rateLimitTier": null
     }
   }
   ```
   `expiresAt` is a **Unix epoch in milliseconds**. The token response returns
   `expires_in` (seconds, e.g. `28800` = 8h), `access_token` (`sk-ant-oat01-`),
   `refresh_token` (`sk-ant-ort01-`), and `account`/`organization` objects.

### UNVERIFIED

- **`subscriptionType` field name in the token response.** The service reads
  `subscription_type` opportunistically for a display hint; the response's exact
  field for plan tier wasn't isolated in the binary. It only affects a success
  hint, never auth. `expiresAt` in the written file is computed from
  `expires_in`, so this gap is cosmetic.
- **claude.com/cai vs a redirect chain.** `CLAUDE_AI_AUTHORIZE_URL` is
  `https://claude.com/cai/oauth/authorize` in prod; whether that 3xx-redirects
  to a claude.ai origin mid-flow doesn't change what we send, but confirm the
  first live run lands on the code-display page.

### RESOLVED: env-var vs `.credentials.json` precedence (was the open contradiction)

**Definitive answer: the env var `CLAUDE_CODE_OAUTH_TOKEN` out-ranks the
`.credentials.json` (`/login`) credential.** Three independent sources agree:

- Anthropic's documented precedence: env `CLAUDE_CODE_OAUTH_TOKEN` is rank 5,
  the subscription `/login` credential is rank 7
  (<https://code.claude.com/docs/en/authentication#authentication-precedence>).
- The CLI binary's own credential-source enum (offset ~101603500) lists the
  sources in that same relative order — `CLAUDE_CODE_OAUTH_TOKEN` above
  `profile` above `claude.ai` (the `.credentials.json` login) — corroborating
  env-over-file. (The exact tie-break is a compiled branch that could not be
  disassembled from strings alone, but both the docs and the enum ordering point
  the same way, so this is treated as settled.)
- `packages/executor/scripts/claude-auth-precedence-smoke.mjs` executes the
  exact CLI bundled by the pinned SDK against a loopback Messages endpoint. It
  observes the env token in the first authenticated request despite a
  deliberately wrong canonical file, proves that file's bytes and mtime are
  unchanged, and repeats successfully with the file masked by `/dev/null` and
  with it absent.

The 2026-07-15/16 field observation (a stale `.credentials.json` + a fresh
pasted env token still 401'd) is therefore **not** "the file wins". It is more
consistent with the fresh env token not actually reaching the SDK subprocess in
that run, or that token itself being stale/expired — env-over-file rules out
"the file shadowed a good env token". Either way, the fix is to guarantee exactly
one credential source per user.

Because env out-ranks the file, injecting a `CLAUDE_CODE_OAUTH_TOKEN` for an
OAuth-flow user would shadow the managed, refreshing `.credentials.json` —
stranding the session on a non-renewable token (and 401'ing outright if that env
token is stale). See "Non-breaking credential handling" below.

---

## The one structural difference: paste-back, not polling

Codex has a device-authorization endpoint, so `codex-device-auth.ts` can issue a
user code and then **poll OpenAI daemon-side** until the user approves — the UI
never handles the credential or a code coming back.

Claude has no such endpoint. The flow is:

1. Daemon generates a PKCE `verifier`/`challenge` and a `state`, builds the
   `https://claude.com/cai/oauth/authorize` URL, and returns it to the UI.
2. User opens the URL, signs in to Claude, approves, and the Anthropic callback
   page shows a `CODE#STATE` string.
3. **User copies that string back into Agor** (the reverse of Codex: the code
   travels user→Agor, not Agor→user).
4. Daemon splits `CODE#STATE`, checks `state` and the client-supplied attempt id
   match the durable attempt, exchanges
   `code` + `verifier` at the token endpoint, and writes the credential.

So the service is a **two-call `create`**: first call (no `code`) starts and
returns the authorize URL plus `attemptId`; second call
(`{ attemptId, code }`) finishes. `find()` reports
status, mirroring Codex's `create`+`find`. There is no daemon poll loop and no
15-minute server-side code lifetime to track — the only clock is our own
`verifier`/`state` freshness window.

```mermaid
sequenceDiagram
  participant UI
  participant Daemon as Daemon (/claude-auth/oauth)
  participant Anthropic
  participant Home as Exact user credential home
  UI->>Daemon: create({}) — start
  Daemon->>Daemon: gen PKCE verifier/challenge + state
  Daemon-->>UI: {phase: awaiting_code, attemptId, verificationUrl}
  UI->>Anthropic: open authorize URL, user approves
  Anthropic-->>UI: shows CODE#STATE (user copies)
  UI->>Daemon: create({ attemptId, code: "CODE#STATE" }) — submit
  Daemon->>Anthropic: POST /v1/oauth/token (code + verifier)
  Anthropic-->>Daemon: access/refresh/expires
  Daemon->>Home: generation-fenced write ~/.claude/.credentials.json 0600
  Daemon->>Daemon: auth method = subscription; credential source = managed_file
  Daemon-->>UI: {phase: success}
```

---

## Mapping onto the Codex module structure

| Codex                                            | Claude equivalent                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `codex-device-auth.ts` service (`create`+`find`) | `claude-oauth.ts` service (two-call `create` + `find`)                                                                |
| device usercode + daemon poll loop               | authorize URL + user paste-back (no poll)                                                                             |
| server-issued PKCE (returned by poll)            | **daemon-generated PKCE** (we own verifier/challenge/state)                                                           |
| `buildDeviceAuthJson` → Codex `auth.json`        | `buildClaudeCredentialsJson` → `.credentials.json`                                                                    |
| durable Codex mutation authority                 | Claude attempt authority + the shared tenant/user advisory-lock and credential-file primitives                        |
| `resolveCodexCredentialRoute`                    | **reused as-is** (routing is provider-neutral despite the legacy name)                                                |
| `writeCodexAuthViaExecutor` / `codex.auth-file`  | `writeClaudeAuthViaExecutor` / `claude.auth-file`                                                                     |
| `agentic_auth_methods.codex = 'subscription'`    | `agentic_auth_methods['claude-code'] = 'subscription'` + `agentic_credential_sources['claude-code'] = 'managed_file'` |
| `CodexDeviceAuthStatus` type                     | `ClaudeOAuthStatus` type                                                                                              |

Reused: `resolveCodexCredentialRoute` (execution-home resolution plus hosted
tenant-safe home checks), the #2521 tenant/user advisory-lock primitive, the
hardened `@agor/core/codex/credential-file` primitive (directory capability,
`O_NOFOLLOW`, cross-replica `flock`, fsync, and generations), and the
`isTenantAgenticToolEnabled` gate. In constrained HA, Claude is admitted only
for the exact tenant/user sandbox route with `persistent-per-user` storage and
the operator-verified `cross-replica-flock` contract; delegated and home-
override routes remain gated.

---

## Why keep `.credentials.json` as a daemon-owned store

Agor already supports pasting a `CLAUDE_CODE_OAUTH_TOKEN` (`check-auth.ts`),
which the executor injects as an env var (`spawn-executor.ts`). Writing the
real `.credentials.json` is still the canonical store:

1. **Refresh.** `.credentials.json` carries the `refreshToken`. The daemon
   refreshes near expiry before a task launch and injects only the resulting
   short-lived access token. The provider runtime never receives the refresh
   token and cannot rotate or clear the canonical store.
2. **Identical to a real `/login`.** The daemon-written file is byte-compatible
   with what interactive `/login` produces, so downstream behavior is the same.
3. **Avoids two writers.** A local per-user sandbox makes the real `~/.claude`
   directory a writable but immutable mountpoint, then masks the canonical
   credential plus its generation and lock sidecars while leaving ordinary
   Claude state writable. The daemon is therefore the sole refresh/authority
   writer, and the runtime has exactly one usable source:
   `CLAUDE_CODE_OAUTH_TOKEN`.

---

## Non-breaking credential handling (env token vs managed file)

Constraint: existing accounts that authenticate via a pasted
`CLAUDE_CODE_OAUTH_TOKEN` must keep working exactly as today; the new OAuth flow
writes a managed `.credentials.json`. Because env out-ranks the file (resolved
above), the two must not coexist for one user.

**The authority lives in the credential resolver, not in `spawn-executor.ts`.**
`agentic_credential_sources['claude-code']` explicitly selects `api_key`,
`subscription_token`, `managed_file`, or the durable opt-out `none`.
`managed_file` first selects the daemon-owned resolution path:

```ts
if (tool === 'claude-code' && claudeSource === 'managed_file') {
  return daemonResolveAndRefreshAccessToken();
}
```

Why this is correct and non-breaking:

- **OAuth-flow user** (`managed_file`): the daemon reads the canonical file. A
  fresh token takes a lock-free/network-free fast path. A near-expiry token is
  refreshed with provider I/O outside database/file locks, then source and
  route are re-read under credential authority and the new canonical bytes are
  generation-CASed. The existing sensitive executor-env channel forwards only
  `CLAUDE_CODE_OAUTH_TOKEN`; `useNativeAuth` is false.
- **Pasted-token user** (`subscription_token`): fails the
  guard → falls through to the existing env-injection path, byte-for-byte
  unchanged. No regression.
- Before spawn, Agor safely materializes the real `.claude` directory and the
  credential/generation/lock leaves. The local per-user sandbox required-binds
  that directory at every reachable home/physical alias, making the parent an
  immutable mountpoint, then masks all three authority leaves. Claude authority
  mutations retain those pre-created inodes under the cross-process lock (and
  authority readers take the same lock), because host-side atomic replacement
  would detach a live sandbox's leaf mounts. Deletion is an empty tombstone. It does not
  redirect `CLAUDE_CONFIG_DIR`; settings, plugins, projects, and path-keyed
  fork/resume transcripts keep working. Shared/simple, delegated,
  disabled-sandbox, and any HA topology missing an exact-user home,
  cross-replica locking, or this concrete containment boundary fail closed
  before provider exchange.

**One-source invariant:** a user who _both_ pasted a token earlier _and_ runs the
OAuth flow would otherwise have `stored.CLAUDE_CODE_OAUTH_TOKEN` present, so the
resolver would inject it and shadow the fresh file. `claude-oauth.ts#persist`
therefore clears the stored pasted token on OAuth success (patches
`agentic_tools['claude-code'].CLAUDE_CODE_OAUTH_TOKEN` to `null`) in the same
users-service call that flips the method — so the managed file is the single
source. `claude-auth/logout` clears it the same way on disconnect.

---

## Credential-write path (executor)

Uses the same hardened credential-file primitive as `codex.auth-file`, without
regressing Codex, so ownership, symlink resistance, durability, and fencing
hold in sandbox/delegated modes:

- Executor command `claude.auth-file` (`inspect` / `write` / `delete`), handled by
  `packages/executor/src/commands/claude-auth-file.ts`. `inspect` backs the
  connection probe (confirms the file exists without returning token bytes);
  `delete` backs `claude-auth/logout`.
- The daemon carries the provider-neutral routed home through executor launch as
  `CLAUDE_CONFIG_DIR`; inspect, write, and delete all target exactly
  `${CLAUDE_CONFIG_DIR || ~/.claude}/.credentials.json`.
- Write/delete use `mutateCredentialFile`: locked directory capability,
  `O_NOFOLLOW`, fsynced stable-inode rewrites, an empty logout tombstone, and
  monotonic generation fencing. Keeping the pre-created credential/generation
  inodes is required so host mutations cannot detach a live sandbox mask. A
  delayed stale writer/deleter returns `AUTH_FILE_STALE` rather than winning.
- The daemon resolves the target unix identity from the **authenticated user**
  (never from request data) via `resolveCodexCredentialRoute` and invokes the
  executor with the resulting delegated home key and Claude config directory.

Standalone Claude OAuth start/replacement/final persistence, Codex device final
persistence, logout, credential-source patches, per-user route changes, and
removal share one process-local credential mutation coordinator. Route changes
cancel pending standalone Codex attempts while holding that queue. In constrained HA, PostgreSQL
stores a SHA-256 state fingerprint plus an AES-GCM sealed PKCE/route envelope,
and one transaction-scoped tenant/user advisory lock serializes OAuth
finalization, logout, replacement starts, and external Claude method/API-key/
token patches, execution-home changes, and user removal. Provider exchange happens before that lock. The winning daemon
then marks the attempt `persisting`, re-resolves the exact tenant/user route,
holds the database authority through the bounded daemon-contained file write,
read-back validation, users-service mutation, and terminal CAS, and uses the
attempt generation as the file tombstone. A Linux kernel `flock` remains held
by the live writer even if database authority is lost. Failures after provider
exchange are terminally ambiguous and are never replayed; they also never
path-delete a possible newer winner. External auth-source patches advance only
the tombstone, preserving existing credential bytes while fencing a delayed
OAuth writer.

Route mutation and removal use the same credential-before-user ordering as
logout: after authorization and bounded patch preparation, but before changing
or deleting the users row, Agor invalidates attempts and generation-deletes the
Claude and Codex credentials from the still-resolvable old canonical route.
Both durable attempt authorities share the tenant/user lock, so a pending Codex
attempt holding a sealed old route is invalidated in the same transaction and
cannot write after the route moves. Only then can
the SQL mutation publish a new route or release a reusable home key. The HA
writer never targets `filesystem_home` overrides because those paths are not
schema-proven unique across tenants/users; cleanup likewise refuses to turn an
already-present override into ambient daemon filesystem authority. A canonical
route is cleaned when it changes into an override, and canonical homes remain
tenant/user-ID keyed even when a delegated `unix_username` is later reused.

Standalone does not write generation tombstones: its Claude/Codex writers and
route mutations share one process-global queue, so it has no detached stale
writer to fence. PostgreSQL HA remains the sole durable generation domain.
Across an **offline** HA → standalone → HA transition, standalone writes bypass
but do not erase the retained tombstone, and the retained PostgreSQL sequences
resume above their prior HA generations. A fresh HA database starts without a
tombstone. This avoids any unsafe dependency on daemon/database wall-clock
alignment. It does not make mixed standalone/HA or old/new cohorts safe;
migration `0095` remains an offline, protocol-incompatible cutover.

This also fixes the known strict-impersonation gap where subscription auth had
no daemon-driven on-disk path at all (only env injection).

Task-time refresh uses the same authority. Concurrent launches for a tenant/user
single-flight in process. After provider I/O, source/route revalidation plus the
generation/file CAS makes login, logout, route change, or another refresh win;
the loser adopts usable winner bytes rather than overwriting them. Provider 4xx
(`invalid_grant`) is rejected, while network/5xx/malformed success is ambiguous;
neither class clears the canonical file or persisted source.

---

## Credential-source transition

`agentic_auth_methods['claude-code']` remains the coarse UI choice. OAuth
success atomically persists `managed_file` and clears a pasted token. Generic
credential saves and clears transition the source inside the users service's
existing atomic row update, including for older clients that send only the
credential patch.

The resolver never infers native-file authority from `subscription` plus an
absent token. Therefore managed-file → pasted-token → clear persists `none` and
cannot silently reactivate an older `.credentials.json`. Source switches retain
inactive credentials but never combine or fall back to them; logout deletes the
file and persists `none`.

---

## Security contract (mirrors the Codex SECURITY CONTRACT)

- The target unix identity is **always derived from the authenticated user**,
  never from request data — callers act only on their own credentials.
- The browser carries only the short-lived authorization **code** and `state`
  back to the daemon. The refresh token flows Anthropic → daemon → target user's
  filesystem only. The current short-lived access token additionally travels
  over the task-scoped sensitive `config/resolve-api-key` channel into the
  executor environment. Neither is returned to the UI, logged, echoed, or
  placed in any agent/LLM context. Failures log an error **class**, never token
  bytes.
- Status responses (`ClaudeOAuthStatus`) carry only non-secret metadata: the
  attempt id, phase, authorize URL (only in the initiating response), expiry,
  and an optional plan/subscription hint.
- The pasted `CODE#STATE` is a short-lived, single-use authorization code, not a
  credential; it is exchanged immediately and never persisted.
- `state` is verified against the attempt before exchange (CSRF / mix-up
  defense); the PKCE `verifier` never leaves the daemon.
- Writes happen in the execution home the daemon routes to (content over the
  hardened executor command), so 0600 ownership holds. New managed sign-ins and
  managed task resolution are admitted only for the contained local per-user
  sandbox profile without an executor command template or arbitrary
  `extra_allow_write` escape hatch. Every such entry fails closed: a final
  writable re-bind can otherwise re-expose a physical owner store that was
  hidden during the initial alias analysis. The sandbox resolves configured
  symlink aliases and also re-applies the
  parent/leaf containment at that newly reachable physical alias for all tasks,
  protecting dormant/existing grants even though new managed launches are
  rejected. HA additionally
  requires the `shared-local` topology, durable attempt ownership, and a proven
  cross-replica home lock. Delegated/template execution remains fail-closed
  until its substrate provides an equivalent reviewed containment and writer
  protocol.
- Multi-tenancy: `.credentials.json` and its generation/lock sidecars are
  tenant-owned, per-user derived resources. Identity resolution goes through
  `resolveCodexCredentialRoute`, which fails closed without an **exact**
  per-user executor home plus the concrete bubblewrap parent/leaf boundary.
  Sandbox coverage proves distinct tenants/users route to their owner home
  rather than the daemon's shared `~/.claude`, and covers every reachable home
  and physical-store alias.
- Frozen tenants are rejected with 503 before executor/provider I/O. The
  credential control-plane services are non-realtime and denied from the Redis
  Feathers relay.
- Claude OAuth/logout and native subscription resolution are enabled in
  constrained HA only when `claudeOAuth`/`claudeAuth` capability checks prove
  the local non-template exact-user sandbox route, cross-replica lock, and
  concrete bubblewrap mask that prevents the provider runtime from reaching
  the canonical file.
  The default-off policy flag remains an independent endpoint/UI gate even
  when those topology capabilities are true. PostgreSQL attempt rows
  are tenant-owned under forced RLS; only the narrow maintenance capability may
  age due attempts across tenants. Redis never carries attempt or credential
  material.

---

## UI

Mirrors the Codex settings pane (AntD only, design tokens, no raw CSS), split
across two components under `apps/agor-ui/src/components/ClaudeAuth/`:

- **`ClaudeAuthSettings.tsx`** — the management pane, mirroring
  `CodexAuthSettings.tsx`. A view-only method selector with three tabs — **API
  key**, **Sign in with Claude**, **Subscription token** — where selecting a tab
  only changes which pane shows; the persisted method follows the credential
  actually configured (saving a key / completing OAuth / saving a token /
  disconnecting), never a mere tab switch. It runs a `check-auth`
  (`validateNative: true`) probe for the connection banner (connected / login not
  found / key not working) and offers a **Disconnect** (`claude-auth/logout`)
  only while the persisted method is `subscription`; after disconnect it stays on
  the sign-in view rather than jumping tabs. Wired into `UserSettingsModal` the
  same way as `CodexAuthSettings`.
- **`ClaudeOAuthSignIn.tsx`** — the paste-back pane the "Sign in with Claude" tab
  renders: `create({})` surfaces `verificationUrl` as a link, an `Input` +
  `Button` submits the `CODE#STATE` string via `create({ attemptId, code })`, and
  success/expired/error states render inline. There is no provider-approval poll
  loop or server-code countdown (unlike Codex's device pane). A remount adopts an existing
  `exchanging` attempt instead of replacing it, then briefly polls its private
  status until the owner request reaches a terminal phase.

`check-auth` treats an out-of-band missing/malformed managed file as
disconnected when the user or UI performs the native-auth recheck; it does not
silently mutate account metadata in a background read.

---

## Follow-ups

1. **`resolveCodexCredentialRoute` rename**: it is used by a non-Codex flow.
   Rename to `resolveAgenticCredentialRoute` (and generalize its Codex-specific error
   strings), left as a separate change to keep this diff focused.
2. **`subscriptionType` response field** (cosmetic; see UNVERIFIED).
3. **Provider authorization / acceptable use** (see below). The product
   boundary is implemented; the policy decision remains external.
4. **Codex runtime containment.** Codex native auth has the same general risk:
   its provider runtime can currently mutate the canonical refreshable file.
   This Claude mask deliberately does not cover `.codex/auth.json`; daemon-owned
   Codex refresh/token injection requires a separate design and rollout.

---

## ToS / acceptable-use considerations (NOT cleared)

**Status: NOT cleared. The endpoint and UI are disabled by default.**

The deployment operator must set
`agentic_tools.claude_subscription_oauth: true` only after confirming an
authorized provider/client contract. Absence or `false` returns the stable
`CLAUDE_SUBSCRIPTION_OAUTH_DISABLED` error and hides the OAuth tab. This flag is
an operator attestation, not a legal-policy decision made by Agor. API keys,
pasted `claude setup-token` credentials, ordinary Claude execution, and logout
are not gated by it. HA support remains an independent topology boundary: the
constrained profile exposes the capability only when it also proves durable
attempts, an exact per-user credential home, and cross-replica home locking.
Other HA topologies remain unavailable even when the operator authorizes the
provider flow.

- The flow drives the **fixed public Claude Code client id** programmatically.
  The user authenticates with **their own** browser + credentials, and tokens
  are stored **per-user** on that user's own unix home — this is the user
  signing into their own subscription, not account sharing. That is materially
  different from one account's token being reused across users.
- Consumer subscription (Pro/Max) tokens driving **automated / high-volume**
  agent work may trip Anthropic's rate-limit or abuse heuristics; that risk
  exists today with pasted `setup-token`s too, but a smoother sign-in may
  increase volume.
- In **hosted multi-tenant** mode, storing another user's subscription tokens
  requires the strict per-user isolation guarantees (the
  `hasContainedClaudeRuntimeCredentials` gate). Do not enable this path in modes
  that can't guarantee per-user credential homes.
- Recommendation: obtain the provider/client clearance before enabling the
  flag, and keep API-key and pasted-token paths as first-class alternatives.
