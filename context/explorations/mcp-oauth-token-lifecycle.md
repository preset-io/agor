# MCP OAuth Token Lifecycle for Unattended / Scheduled Agents

> Research doc — no code changes proposed in this PR.
> Audience: agor maintainers thinking about cron / schedule-driven agents.
> Last reviewed: 2026-05-05.

## TL;DR

Agor's MCP OAuth implementation is **already in good shape** for the
interactive case: tokens live in `user_mcp_oauth_tokens` (per-user or shared),
JIT refresh is wired into both the read hook and the executor's auth-header
service, refreshes are mutexed per `(user, server)` to survive rotating refresh
tokens, and `invalid_grant` cleanly surfaces "please re-auth".

For **unattended / scheduled agents** there are four gaps, one of which is
a real bug:

0. **🔴 The 1-hour default lies to the DB on initial auth, then disappears on
   refresh.** `apps/agor-daemon/src/oauth-cache.ts:89` (`persistOAuthToken`)
   does `const expiresIn = tokenResponse.expires_in ?? 3600;` and writes that
   default into `user_mcp_oauth_tokens.oauth_token_expires_at`. The
   refresh-time persist (`refreshAndPersistToken` in
   `packages/core/src/tools/mcp/oauth-refresh.ts`) does **not** apply the
   same default — it passes `result.expires_in` (undefined for Notion) through
   to `saveToken`, which writes `expires_at = NULL`. Same row, same provider,
   two different defaults at two stages of the same lifecycle. Net effect for
   Notion: Agor declares the initial token expired at +1h *whether or not the
   MCP server would still accept it*, then after the auto-refresh forgets to
   set any expiry at all and `needsRefresh(null) === false` keeps the row
   stuck on whatever access_token was last written until something 401s. See
   "🔴 The 1-hour default bug" in the audit.
1. **No retry-on-401 at the MCP transport.** A token that expires *mid-call*
   (after the JIT preflight) just fails the tool call. Explicitly listed as a
   known follow-up in `packages/core/src/tools/mcp/oauth-refresh.ts`.
2. **No proactive refresh hook for scheduled triggers.** Cron fires → executor
   spawns → JIT refresh runs. Fine when refresh succeeds; silent failure when
   it doesn't (revoked grant, network blip).
3. **Provider-specific failure modes.** Notion's refresh response omits
   `expires_in` (compounds gap 0). Slack's MCP server requires user-token
   rotation (12h TTL) but the rotation toggle is one-way and easy to forget.
   Atlassian needs `offline_access` in scopes or no refresh_token is issued.

The 80/20 fix is **(a)** a retry-on-401 shim in the executor's MCP transport,
**(b)** a pre-cron refresh pass in the scheduler service, and **(c)** loud
"needs re-auth" notifications on scheduled-run failure. After that, declarative
per-provider lifecycle config papers over Notion-style quirks.

---

## Phase 1 — Audit of Agor's current OAuth lifecycle

### Storage

`user_mcp_oauth_tokens` (drizzle schema in `packages/core/src/db/schema.*`)
holds:

| column | purpose |
|---|---|
| `user_id` | Per-user token; `NULL` = shared-mode token for the server |
| `mcp_server_id` | FK to `mcp_servers` |
| `oauth_access_token` | Bearer to attach |
| `oauth_token_expires_at` | Absolute Date or NULL (when provider omits `expires_in`) |
| `oauth_refresh_token` | nullable — present iff provider issued one |
| `oauth_client_id` / `oauth_client_secret` | Bound to the grant (DCR-issued or admin-pre-registered) |
| `created_at` / `updated_at` | timestamps |

Co-locating client credentials with the refresh_token is correct: refreshing
requires the *exact* `client_id`/`client_secret` the grant was issued under,
because each DCR registration is its own client.

Repository: `packages/core/src/db/repositories/user-mcp-oauth-tokens.ts`.
Notable: `getValidToken` returns `undefined` when expired without refreshing —
the refresh decision is the caller's. Good separation; the daemon's
`oauth-auth-headers` service is the single integration point.

### Refresh path

`packages/core/src/tools/mcp/oauth-refresh.ts` is the canonical implementation.

- `refreshMCPToken(opts)` — pure HTTP `grant_type=refresh_token` call. Mirrors
  `exchangeCodeForToken` in transport: HTTP Basic when `client_secret` is
  present, body params for public clients.
- `refreshAndPersistToken(deps)` — wraps the HTTP call with:
  - **Per-`(user|shared, server)` mutex** (`_inFlightRefreshes` map) to collapse
    concurrent refreshes against the same refresh_token. Critical for
    providers that rotate (Linear / Atlassian) or treat replay as a compromise
    (Atlassian fires breach-detection if the 10-minute grace is exceeded).
  - **Atomic persist** of the new access_token + rotated refresh_token (per
    RFC 6749 §6, an absent `refresh_token` in the response means keep the
    old one).
  - **`invalid_grant` cleanup** — deletes the token row so the user is
    surfaced "please re-auth", with an optional `onInvalidGrant` hook.
  - **Transient errors are surfaced**, not swallowed. Callers fall back to the
    stale token rather than 500ing.
- `needsRefresh(expiresAt)` — `true` when token is absent, expired, or within
  `REFRESH_BUFFER_MS` (60s) of expiry. Returns **`false`** when `expiresAt` is
  null/undefined. **This is a quiet correctness gap for Notion** (see Phase 3).

### Daemon wiring

Refresh is invoked from three places:

1. **`apps/agor-daemon/src/register-hooks.ts:825-856`** — the
   `injectPerUserOAuthTokens` hook on MCP server reads. JIT-refreshes when the
   user/socket reads MCP server records (e.g., session-start), so the
   executor receives a fresh token in the server payload. Fall-through on
   transient error keeps the response from blocking session boot.
2. **`apps/agor-daemon/src/register-services.ts:1931-2018`** — the
   `/mcp-servers/oauth-auth-headers` Feathers service. Executor calls it
   before each MCP request burst with a list of in-scope server IDs; daemon
   returns either `{ authorization: 'Bearer …' }` or `{ error: 'needs_reauth' }`.
   This is the **authoritative** path during an active session: the executor
   never holds raw refresh tokens, can never request someone else's row
   (no `forUserId` override), and shared-mode rows are returned only to
   callers who can already see the server.
3. **`apps/agor-daemon/src/register-services.ts:2034-2094`** —
   `/mcp-servers/oauth-refresh`, the manual "refresh now" UI affordance.

### Two-phase OAuth flow (initial auth)

For remote daemons, `startMCPOAuthFlow` / `completeMCPOAuthFlow` in
`oauth-mcp-transport.ts` split the auth-code flow so the daemon's public
callback URL receives the redirect (the legacy CLI `performMCPOAuthFlow`
spins up a `127.0.0.1:0` listener — unsuitable for any deployed daemon, and
the file's docstring is explicit about that). PR #1078 extended discovery to
walk the full RFC 9728 → RFC 8414 → OIDC cascade with RFC 7591 DCR for
client registration. Notable consequence: the `client_id` / `client_secret`
persisted on the token row are DCR-issued and **scoped to that grant**, not
reusable across users.

### What the audit confirms works

- ✅ Per-user isolation in storage and at the auth-headers service boundary.
- ✅ Mutexed refresh — race-safe under rotating refresh tokens.
- ✅ Correct semantics on absent `refresh_token` in refresh response (keep
  old).
- ✅ `invalid_grant` → delete row → UI shows re-auth prompt.
- ✅ Transient refresh failures fall through to stale token (better than
  hard-failing the agent).
- ✅ 60s safety buffer in `needsRefresh`.

### 🔴 The 1-hour default bug (asymmetric defaulting between persist paths)

Two callsites write to `user_mcp_oauth_tokens.oauth_token_expires_at` and they
disagree on what to do when the provider omits `expires_in`:

**Initial-auth path** — `apps/agor-daemon/src/oauth-cache.ts:73-118`
(`persistOAuthToken`, called from the OAuth callback handlers in
`register-services.ts`):

```ts
const expiresIn = tokenResponse.expires_in ?? 3600;   // ← defaults to 1h
cacheOAuth21Token(cacheKey, tokenResponse.access_token, expiresIn);
...
await userTokenRepo.saveToken(tokenUserId, ..., {
  accessToken: tokenResponse.access_token,
  expiresInSeconds: expiresIn,                        // ← 3600 lands in DB
  ...
});
```

**Refresh path** — `packages/core/src/tools/mcp/oauth-refresh.ts:300-306`
(`refreshAndPersistToken`):

```ts
await userTokenRepo.saveToken(deps.userId, deps.mcpServerId, {
  accessToken: result.access_token,
  expiresInSeconds: result.expires_in,                // ← undefined → NULL in DB
  refreshToken: result.refresh_token,
});
```

Repository (`saveToken`,
`packages/core/src/db/repositories/user-mcp-oauth-tokens.ts:146-148`):

```ts
const expiresAt = input.expiresInSeconds
  ? new Date(Date.now() + input.expiresInSeconds * 1000)
  : undefined;                                        // ← becomes NULL
```

For a provider like **Notion** (which returns no `expires_in` on either grant
or refresh) the resulting row evolves as:

| Phase | `expires_at` | `needsRefresh()` returns | Net behavior |
|---|---|---|---|
| Right after first auth | `now + 1h` (fake) | `false` (until 1h elapses) | Agor *thinks* token is good for 1h regardless of provider truth |
| ~59 min later | `now + 1h` minus ~59 min | `true` (within 60s buffer) | JIT refresh fires |
| Right after first refresh | `NULL` | **`false` forever** | Stale token returned indefinitely until 401 — and there's no retry-on-401 |

So your suspicion is exactly right: the 1H comes from
`oauth-cache.ts:89` and **Agor may incorrectly mark the token as expired
even though the MCP server would still accept it**. Notion in particular
suffers because the asymmetry between the two persist paths means the row
oscillates between a fake-1h expiry and a NULL expiry, never matching the
provider's actual lifetime.

Two follow-ups suggested (out of scope here):

- Move both persist sites to a single helper that applies one consistent
  policy. Two reasonable choices:
  - **Always store NULL when the provider omits `expires_in`**, and treat
    NULL as "trust the token until the provider says otherwise" (i.e. rely
    on retry-on-401 for these). Faithful to provider truth; needs gap (1)
    fixed first.
  - **Always default to a per-provider hint** (config-driven, see option G)
    rather than the hardcoded 3600. Lets us encode "Notion ≈ 1h" without
    lying about Slack non-rotating tokens.
- Adopt a per-provider `default_access_ttl_seconds` config (option G).

### Other audit flags

- ⚠️ **No retry-on-401 shim** at the MCP HTTP transport. Listed in
  `oauth-refresh.ts` header as known follow-up. Combined with the 1-hour
  default bug above, the failure mode for Notion is silent stale-token use
  until the provider rejects.
- ⚠️ **In-memory `authCodeTokenCache`** in `oauth-mcp-transport.ts` is
  vestigial in daemon mode (the DB-backed path is authoritative). Worth
  pruning to one cache to avoid drift. `getCachedOAuth21Token` is referenced
  from `apps/agor-daemon/src/oauth-cache.ts` and `services/gateway.ts`, and
  this in-memory map is what backs it.
- ⚠️ **Token endpoint inference on refresh.** `refreshAndPersistToken` falls
  back to `inferOAuthTokenUrl(server.url)` when `oauth_token_url` isn't
  persisted on the server config. We should persist the *discovered* token
  endpoint at DCR time so refresh never depends on heuristics.
- ⚠️ **No notification on unattended refresh failure.** A scheduled trigger
  hitting `invalid_grant` deletes the row but emits only a console warn —
  the user finds out when they wake up to a missed run.

---

## Phase 2 — Provider research

Each subsection cites the upstream docs inline. All summaries are based on
public docs as of 2026-05-05.

### Slack — `https://mcp.slack.com/mcp`

- **Two regimes.** With **Token Rotation OFF** (legacy default for many apps),
  bot/user tokens are non-expiring. With **Token Rotation ON**, access tokens
  expire after exactly **12 hours / `expires_in: 43200`** — fixed by Slack,
  not configurable per-app. Rotated tokens carry the `xoxe.` prefix.
  ([docs.slack.dev/authentication/using-token-rotation](https://docs.slack.dev/authentication/using-token-rotation))
- **Refresh tokens** are issued **only** when rotation is enabled (`xoxe-1-`
  prefix). Rotation cannot be turned off once enabled. No documented refresh
  TTL — but refresh tokens are **single-use** with a short grace, and Slack
  enforces a **2-active-token limit** if refreshed repeatedly within 12h.
- **Refresh endpoint**: `POST https://slack.com/api/oauth.v2.access` with
  `grant_type=refresh_token`. Response shape is RFC 6749-compliant; deviation
  is the rotated/single-use refresh token. HTTP 200 with `{"ok": false,
  "error": "..."}` is a possible failure mode (already handled in
  `oauth-mcp-transport.ts`).
  ([docs.slack.dev/reference/methods/oauth.v2.access](https://docs.slack.dev/reference/methods/oauth.v2.access))
- **Slack's MCP server** uses **user tokens (`xoxp-`)**, with distinct OAuth
  endpoints (`/oauth/v2_user/authorize`, `/api/oauth.v2.user.access`). Whether
  rotation is *required* for the MCP variant isn't explicitly stated in the
  MCP docs, but the user's empirical "~1 hour" observation suggests an
  even-shorter MCP-specific TTL or a 1h rotation policy worth confirming
  empirically. ([docs.slack.dev/ai/slack-mcp-server/](https://docs.slack.dev/ai/slack-mcp-server/))
- **Implication**: turn rotation on, store the refresh token, refresh ~30 min
  before the 12h boundary. Don't burn through the 2-token grace window with
  bursts of refreshes.

### Notion — `https://mcp.notion.com/mcp`

- **Access token TTL is undocumented.** The published OAuth/auth docs do not
  state an expiration. The introspection endpoint exposes `active`, `scope`,
  `iat`, `request_id` — **no `exp` field**.
  ([developers.notion.com/reference/introspect-token](https://developers.notion.com/reference/introspect-token))
- **Refresh tokens** are issued for public OAuth integrations and the refresh
  call **rotates both** (access + refresh). The refresh endpoint is `POST
  https://api.notion.com/v1/oauth/token` (HTTP Basic with `client_id:client_secret`).
  ([developers.notion.com/reference/refresh-a-token](https://developers.notion.com/reference/refresh-a-token))
- **Refresh response omits `expires_in`.** Returns `access_token`, `token_type`,
  `refresh_token`, plus workspace metadata — no TTL field. This is the
  single biggest correctness hazard: clients that key off `expires_in` will
  store `expires_at = NULL`, and any `needsRefresh(null) === false`-style
  check (Agor's current behavior) will never proactively refresh.
- **Internal-integration bearer tokens** (created in admin's own workspace)
  appear to remain long-lived / non-expiring per the docs — useful for
  schedule-only workspaces.
  ([developers.notion.com/docs/authorization](https://developers.notion.com/docs/authorization))
- **Implication**: for Notion, either (a) treat tokens as ~1h by convention
  and force a refresh at that cadence, or (b) rely on retry-on-401, or (c)
  use Internal Integration tokens via a skill for unattended cases.

### Linear — `https://mcp.linear.app/mcp`

- **Access token TTL: 24h (`expires_in: 86399`).** Refresh tokens issued and
  **rotated on every use**. **30-minute grace window** allows retrying a
  failed refresh with the original refresh_token — the friendliest of all
  providers in the matrix. As of 2026-04-01, all OAuth2 apps were migrated to
  the rotating system.
  ([linear.app/developers/oauth-2-0-authentication](https://linear.app/developers/oauth-2-0-authentication))
- Refresh endpoint: `POST https://api.linear.app/oauth/token`. RFC 6749-clean.
- The MCP server appears to share OAuth with Linear's REST/GraphQL — no
  separate auth doc page. The older `/sse` endpoint was deprecated; current
  MCP is on the streamable-HTTP `/mcp` URL.
- **Implication**: Linear is the easy case. Current Agor code handles it
  correctly out of the box.

### Atlassian — `https://mcp.atlassian.com/v1/mcp/authv2` (legacy `/v1/sse` deprecated 2026-06-30)

- **Access token TTL: 1h (`expires_in: 3600`).** Fixed. Not user-configurable.
  ([developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/))
- **Rotating refresh tokens** with a **90-day inactivity sliding window**.
  No documented absolute cap — a healthy daily refresh keeps the grant alive
  indefinitely. **10-minute reuse grace** for network/concurrency retries.
- Requires the **`offline_access`** scope on initial auth or no refresh
  token is issued — *easy to miss during DCR*. Worth a guardrail in Agor's
  scope auto-population path.
- Refresh endpoint: `POST https://auth.atlassian.com/oauth/token`. Standard
  shape.
- **MCP server** supports OAuth 2.1 with **DCR** (no manual app creation
  needed). Optional API-token auth path exists but requires admin approval.
- **Implication**: Atlassian is well-specified and Agor handles it; the only
  pitfall is the `offline_access` scope. Document it.

### GitHub — `https://api.githubcopilot.com/mcp/`

Three distinct token types — pick deliberately for unattended:

- **OAuth Apps (legacy):** non-expiring by default unless the "Expire user
  authorization tokens" toggle is on (default on for newly-created apps).
  When non-expiring, auto-revoked after 1 year of non-use.
- **GitHub App user-to-server tokens (`ghu_`):** **8h access** + **6mo
  refresh** (`ghr_`), refresh tokens rotate. Endpoint: `POST
  https://github.com/login/oauth/access_token` with `grant_type=refresh_token`.
  Response includes both `expires_in` and `refresh_token_expires_in`.
  ([docs.github.com/.../refreshing-user-access-tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens))
- **GitHub App installation tokens:** **1h, no refresh token.** Re-minted by
  `POST /app/installations/{id}/access_tokens` authenticated with a 10-min
  RS256 JWT signed by the App's private key.
  ([docs.github.com/.../generating-an-installation-access-token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app))
- **Implication**: for unattended/scheduled agents, **installation tokens
  are the right primitive** — no human refresh-token to babysit, no UI
  re-auth flow needed, the only secret is the App's private key sitting in
  config. Worth a dedicated skill or an MCP-server config option that says
  "this server uses GitHub App installation auth" and the daemon mints a
  fresh 1h token on each request burst.

### MCP spec / OAuth 2.1 / DPoP

- **MCP Authorization spec** delegates lifetime entirely to the AS. No
  MCP-mandated TTL. Refresh tokens are **permitted, not required**: clients
  *MUST NOT* assume refresh tokens will be issued; ASes *SHOULD* issue
  short-lived access tokens; **public clients MUST rotate refresh tokens**
  (inherited from OAuth 2.1 §4.3.1).
  ([modelcontextprotocol.io/specification/draft/basic/authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization))
- **Mid-call expiry**: spec says only that 401 *MUST* be returned and
  clients *MUST* parse `WWW-Authenticate`. Retry-with-refresh is **not
  specified** — it's a client concern.
- **DPoP (RFC 9449)** is *SHOULD* in OAuth 2.1 (sender-constrained tokens),
  not a current MCP requirement. **None of Slack/Notion/Linear/Atlassian/
  GitHub publicly support DPoP** in their OAuth flows. Out of scope for now.

### Provider matrix (cheat sheet)

| Provider | Access TTL | Refresh TTL | Refresh rotates? | Quirk |
|---|---|---|---|---|
| Slack (rotation on) | 12h | none documented | Yes, single-use | 2-token limit; rotation one-way |
| Slack (rotation off) | ∞ | n/a | n/a | Legacy; long-lived bot/user token |
| Notion | **undocumented** | undocumented | Yes | No `expires_in` in response |
| Linear | 24h | undocumented | Yes | 30-min grace window — best-in-class |
| Atlassian | 1h | 90-day sliding | Yes | Needs `offline_access` scope |
| GitHub OAuth App | ∞ or 8h | (n/a or 6mo) | If expiring, yes | App-level toggle |
| GitHub App user-to-server | 8h | 6mo | Yes | `ghu_`/`ghr_` prefix |
| GitHub App installation | 1h | **no refresh token** | re-mint via JWT | Best for unattended |

---

## Phase 3 — Gap analysis (Agor vs providers)

### Coverage matrix

| Capability needed | Agor implements? | Notes |
|---|---|---|
| Refresh token storage | ✅ | `user_mcp_oauth_tokens.oauth_refresh_token` |
| Rotated refresh on persist | ✅ | `refreshAndPersistToken` saves new value atomically |
| Per-(user, server) mutex | ✅ | `_inFlightRefreshes` map |
| `invalid_grant` cleanup | ✅ | Row deleted; UI surfaces re-auth |
| Transient error fallback | ✅ | Use stale token, emit warn |
| Proactive refresh near expiry | ⚠️ Partial | Works only when `expires_at` is set; **silent on Notion** |
| Retry-on-401 mid-call | ❌ | Listed as known follow-up |
| Pre-cron / scheduled refresh hook | ❌ | Scheduler doesn't pre-warm tokens |
| Notification on unattended re-auth | ❌ | Console warn only |
| `offline_access` scope guardrail | ❌ | DCR scope auto-pop won't add it for Atlassian |
| Persisted token endpoint | ⚠️ Partial | Falls back to `inferOAuthTokenUrl` heuristic |
| DPoP / sender-constrained tokens | ❌ | Not needed yet — no provider supports it |
| API-key fallback path | ✅ | env vars + per-tool credential storage (PR #1077) |

### Specific gaps & their consequence

1. **Mid-call expiry kills the tool call.** A 1h Atlassian token retrieved at
   minute 0 still fails at minute 65 if the agent never returns to the auth-
   headers service in between. The MCP HTTP transport should retry once on
   401 with a fresh-from-refresh Bearer.

2. **Notion silently breaks at provider rotation.** Without `expires_in`,
   `needsRefresh` is permanently false; refresh only happens on manual UI
   click or via the gap-1 retry-on-401 (which doesn't exist). Two-step fix:
   add a per-server "default access token TTL" hint *and* implement
   retry-on-401.

3. **Scheduled triggers can fire into a near-expired token.** A trigger
   scheduled for 03:00 UTC with a Slack token that expires at 03:15 will
   refresh fine on first request but then expire mid-run. Pre-cron refresh
   would warm the cache to the full window before spawn.

4. **Failures in unattended refresh are invisible.** No durable signal on
   `invalid_grant` during a cron run — the next interactive session gets a
   "please re-auth" pill, the missed run goes unnoticed.

5. **Slack rotation is one-way and easy to forget.** If an admin sets up an
   MCP server with a Slack app that has rotation OFF, tokens are non-expiring
   and Agor's code is correct (no refresh needed). But the user *thinks*
   they're using a 12h-rotating setup. We can detect by inspecting
   `expires_in` on first issuance.

6. **Atlassian without `offline_access` leaves no refresh_token.** First
   tool call after 1h returns 401, Agor sees no refresh_token, falls to
   `needs_reauth`. DCR scope auto-population should include
   `offline_access` for any AS that advertises it in `scopes_supported`.

---

## Phase 3.5 — Empirical probing & a TTL-discovery precedence cascade

This section was added after the rest of Phase 3 to act on the audit. Before
designing remediation, we curl-probed the actual MCP servers to confirm what
discovery paths are realistically available.

### Empirical findings (curl probes, 2026-05-05)

Probed each MCP server's RFC 8414 / RFC 9728 metadata + bearer-challenge:

| Server | `authorization_endpoint` | `token_endpoint` | `registration_endpoint` (DCR) | `introspection_endpoint` | `revocation_endpoint` |
|---|---|---|---|---|---|
| `mcp.slack.com` | ✅ | ✅ (`/api/oauth.v2.user.access`) | ✅ | ❌ **not advertised** | ❌ |
| `mcp.notion.com` | ✅ | ✅ (`/v1/oauth/token`) | ✅ | ❌ **not advertised** | ✅ |
| `mcp.linear.app` | ✅ | ✅ | ✅ | ❌ **not advertised** | ✅ |
| `api.githubcopilot.com/mcp` | ✅ (via `WWW-Authenticate: resource_metadata=`) | ✅ | varies | ❌ | varies |

**Decisive finding**: **none of the MCP servers we care about advertise an
`introspection_endpoint`** in their AS metadata. RFC 7662 token introspection
is therefore not a viable runtime discovery path for our actual targets.
(Notion does expose a private `/v1/oauth/introspect` endpoint, but it requires
HTTP Basic with `client_id:client_secret` and — per upstream docs — returns
no `exp` field anyway. So even if we hit it, it doesn't tell us when the
token expires.)

This kills "introspect on every refresh to learn the real TTL" as a strategy.
We're stuck with whatever the token-endpoint response gives us, plus whatever
we can read off the access token if it happens to be a JWT.

### Precedence cascade for resolving `expires_in`

Replace the current `tokenResponse.expires_in ?? 3600` with a small resolver
that walks a deterministic list, returning the first hit (or `null` =
"unknown"):

```
resolveTokenExpiry(tokenResponse, accessToken, serverConfig) → seconds | null
```

Order, with rationale for each:

| # | Source | Rationale |
|---|---|---|
| 1 | `tokenResponse.expires_in` | RFC 6749 §5.1 standard — the canonical answer when present. |
| 2 | `tokenResponse.expires_at` (absolute → relative) | Some Auth0 / Spotify configs return absolute Unix timestamps instead. Convert to relative. |
| 3 | `tokenResponse.exp` (top-level, JWT-style) | A handful of providers leak a top-level `exp` claim. Cheap to check. |
| 4 | `tokenResponse.ext_expires_in` | Microsoft / Azure AD's "extended expiry" field used during outages. Better than nothing. |
| 5 | JWT-decode `accessToken` and read `exp` claim | Only if the token has the JWT shape (`header.payload.sig` with valid base64url segments). Skip for opaque tokens. **No signature verification needed** — we're reading our own token, not validating it. |
| 6 | `serverConfig.auth.lifecycle.default_access_ttl_seconds` | Per-server config hint (option G). Lets an admin encode "Notion ≈ 1h" without lying about other providers. |
| 7 | **`null`** ("unknown") | Surface as "expires in: unknown" in the UI tooltip; rely on retry-on-401 (gap 1) for actual lifecycle handling. |

Notes on the cascade:

- **No hardcoded global default** anywhere in the chain. `?? 3600` was the
  bug; we don't reintroduce it under a different name.
- **Symmetric**: same resolver runs at `persistOAuthToken` (initial auth) and
  `refreshAndPersistToken` (refresh persist). One source of truth.
- **JWT decode is shape-gated**: we never attempt to decode opaque tokens
  (Slack `xoxe.`, Notion `secret_`, etc.) — the JWT step is a fast `if
  isJwtShape(token) { peek payload }` and is a no-op otherwise.
- **Step 6 is config-only, not provider-detection**. We resist the urge to
  hardcode `if (origin === 'mcp.notion.com') return 3600` — that's a
  maintenance hazard. Either the server config carries a hint or it doesn't.
- **`null` is a first-class state**, not an error. `needsRefresh(null)`
  remains `false` (we don't speculate); the UI shows "unknown"; the
  retry-on-401 shim from gap 1 catches actual expiry.

### What "expires in: unknown" looks like in the UI

The tooltip text already lives near `apps/agor-ui/src/components/MCPServerPill.tsx`
(token expiry display) and `apps/agor-ui/src/utils/mcpAuth.ts`
(`describeOAuthExpiry` / equivalent). When `oauth_token_expires_at` is null,
swap the existing "expires in 47 min" copy for "expires in: unknown — relies
on retry-on-401" (or similar). Keeps the green pill green; the explanatory
hover is what changes.

### Why not introspection?

Worth being explicit about the rejected option, so a future contributor
doesn't re-litigate it:

- **None of our target MCP providers advertise it** (table above).
- **Even where it exists privately (Notion)**, the response omits `exp`.
- **It doubles every refresh cost** (token call + introspect call) without a
  payoff, and serializes us behind a second provider RTT on the JIT path.
- **DPoP would obviate the need** (sender-constrained tokens carry their own
  proof), but no provider in our matrix supports DPoP.

If a future MCP provider *does* advertise introspection AND returns `exp`, it
slots in as step 1.5 of the cascade as a per-server opt-in (config flag
`auth.lifecycle.use_introspection: true`). Don't enable it by default.

---

## Phase 4 — Options

### A. Improve the existing JIT refresh path *(recommended baseline)*

Status: most of this is shipped. The remaining work is:

- **Retry-on-401 shim** in the executor's MCP HTTP transport. On 401 with a
  Bearer challenge, call `oauth-auth-headers` to get a fresh token and
  retry the original request **once**. Hard-fail the second time.
- **Persist the discovered token endpoint** at DCR time so refresh never
  depends on `inferOAuthTokenUrl`.
- **`offline_access` auto-include** when AS advertises it.

Trade-offs: smallest blast radius; provider-agnostic; closes gaps (1) and
partially (2) and (6). Doesn't address (3) or (4).

### B. Background daemon refresher

Status: explicitly rejected in `oauth-refresh.ts` ("JIT is simpler, avoids
wasted refreshes on idle users").

Re-evaluating for the unattended case: a background sweep that refreshes any
token within ~30 min of expiry would close gap (2) for Notion (treat
no-`expires_in` as a configurable "assume X hours" default) and pre-warm
cron runs. Cost: a write-heavy idle workload on rotating providers, plus
the operational hazard that a refresh-during-sweep can race with an
in-flight tool call (`refreshAndPersistToken` mutex protects correctness,
but the sweep wastes provider quota).

Trade-offs: heavier; only justified once we see real cron-driven failures
that A and F don't catch.

### C. Skills with API-key wrappers (per provider)

Status: Agor already supports per-tool credential storage (PR #1077) and
env var injection. A skill like `slack-bot` or `notion-internal` can wrap a
provider's REST API with a long-lived PAT/internal token.

Trade-offs:
- ➕ No expiry, no refresh, no UI loop. Survives any token-lifecycle
  weirdness.
- ➖ Loses the MCP UX wins: server-side tool definitions, scope-narrowing,
  per-user attribution, OAuth-style consent screen.
- ➖ Multiplayer story is awkward: whose PAT is the "shared" credential?
  PR #1077 stores per-user tool credentials but doesn't filter spawn env
  per SDK at runtime (logged in `project_credential_scoping_gap.md`).
- ➖ Not all providers offer scoped long-lived tokens (Slack PATs are
  limited, Atlassian admin API tokens are coarse, GitHub PATs are very
  coarse).

### D. Hybrid — MCP for interactive, API-key skill for unattended

Status: complementary to A. Recommended **only** for providers where MCP
refresh is empirically unreliable (currently Notion, possibly Slack-with-
rotation-off).

Trade-offs:
- ➕ Always-on path for cron without giving up MCP for humans.
- ➖ Two code paths to maintain per provider; users have to set both up.
- ➖ Risk of behavioral drift (a cron agent calls a Slack channel via a
  skill, an interactive agent calls it via MCP, and the same prompt
  produces slightly different tool surfaces).

### E. Provider-specific service-account tokens

Where the provider offers a long-lived service-account/installation token
that doesn't depend on a human user:

- **GitHub App installation tokens** (1h, JWT-derived) — best in class for
  unattended.
- **Atlassian "OAuth 2.0 credentials for service accounts"** — admin-issued,
  long-lived, scope-controlled.
- **Notion Internal Integration tokens** — non-expiring, scoped to a single
  workspace.
- **Slack non-rotating bot tokens** — only available if rotation has never
  been enabled on the app.

Trade-offs: requires per-provider plumbing in the MCP server config (e.g., a
`auth.type === 'github_app_installation'` variant that mints tokens
on-demand), but the payoff is "scheduled agents just work, forever".

### F. Pre-cron refresh hook

Status: not implemented.

When a scheduled trigger fires, the daemon's scheduler service walks the
in-scope MCP servers, refreshes any token within ~30 min of expiry, *then*
spawns the executor. Single integration point; handles gap (3) cleanly.

Trade-offs:
- ➕ Bounded work — only fires when a cron actually runs.
- ➕ Fails loudly: refresh failure happens *before* the agent spawns, so we
  can route it to a "trigger failed" notification path.
- ➖ Doesn't help for in-session expiry (gap 1) or Notion's missing TTL
  (gap 2). Pair with A.

### G. Declarative per-provider lifecycle hints

Status: not implemented.

Add an optional `auth.lifecycle` block on `mcp_servers.data`:

```yaml
lifecycle:
  default_access_ttl_seconds: 3600   # for providers that omit expires_in
  require_offline_access_scope: true # auto-add to DCR scopes
  refresh_strategy: rotated_single_use | non_rotating | none
```

Trade-offs: small data-only change; lets us encode the matrix in this doc as
config rather than provider-detection logic. Pair with A and F.

---

## Phase 5 — Sequenced recommendation

### Ship first (the 80/20)

**0. Replace `?? 3600` with the TTL precedence cascade (Phase 3.5).**
Smallest possible diff with the largest correctness payoff: kill the
asymmetric defaulting that makes Notion oscillate between fake-1h and NULL,
and make "unknown" a real state surfaced as such in the UI. Pairs naturally
with item 1 below — once the cascade can return `null`, retry-on-401 becomes
the safety net for the unknown case.

**1. Retry-on-401 shim in MCP transport.** Single biggest leverage. Closes
the mid-call expiry race for every provider in the matrix. Implementation
is small: detect 401 + Bearer challenge in the executor's MCP HTTP client,
call `oauth-auth-headers` to get a fresh Bearer, retry once, give up
otherwise. Already listed as a known follow-up — promote it.

**2. Pre-cron refresh hook in the scheduler.** Adds a single
`refreshAndPersistToken`-loop call before the trigger spawns its agent.
Resolves "scheduled run expires mid-flight" cleanly and, when refresh
fails, gives us a hook to surface a trigger-level failure (no more
silent misses).

**3. Loud notifications on unattended `invalid_grant`.** Wire a
`onInvalidGrant` hook from `refreshAndPersistToken` through the scheduler
to (a) the trigger's run record (mark it failed) and (b) the user's
notification channel. Costs almost nothing to add and dramatically improves
trust in cron agents.

These three items together cover the unattended case for Linear (already
fine), Atlassian, Slack (rotation on), and most GitHub configurations.

### Ship next

**4. Declarative per-provider lifecycle hints (option G).** Closes the
Notion gap by letting the server config carry `default_access_ttl_seconds`,
which `needsRefresh` consults when `expires_at` is null. Also lets us
auto-include `offline_access` for ASes that advertise it.

**5. Persist the discovered token endpoint.** One-line schema follow-up:
write `auth.oauth_token_url` at DCR completion so refresh stops depending
on `inferOAuthTokenUrl` heuristics.

**6. Documentation page.** A guide-page section on "Which MCP servers play
well with scheduled agents", with the provider matrix and the per-provider
gotchas (Slack rotation, Atlassian `offline_access`, GitHub App
installation route).

### Defer / consider carefully

**7. Background refresher (option B).** Only if real workloads show A+F
isn't enough. The current code's stance against this still seems right.

**8. GitHub App installation auth path (option E for GitHub).** High
leverage for power users who want bulletproof scheduled GitHub agents —
but non-trivial plumbing. Worth a dedicated design doc when prioritized.

**9. API-key fallback skills for problematic providers (option D).** Only
once we know a specific provider's MCP path is genuinely too unreliable.
Don't build it speculatively — the maintenance cost is double.

### Not recommended

- **Background sweep without retry-on-401.** Doesn't address mid-call
  expiry; trades real latency on the cron path for the same failure mode.
- **Mass-removing the in-memory `authCodeTokenCache`**. Vestigial but works.
  Cleanup is a chore, not a fix.

---

## Quick wins / follow-up bugs noted (not to be fixed in this PR)

- 🔴 **The 1-hour default in `persistOAuthToken` (`oauth-cache.ts:89`) is the
  source of "Agor thinks this token expired after exactly 1 hour" reports.**
  And it's asymmetric — `refreshAndPersistToken` doesn't apply the same
  default, so the row oscillates between fake-1h expiry and NULL expiry over
  the lifetime of a single grant. Prescribed fix: the precedence cascade in
  Phase 3.5 (resolver shared by both persist sites; `null` becomes a
  first-class state surfaced as "expires in: unknown" in the UI).
- `inferOAuthTokenUrl` is a fallback used by `refreshAndPersistToken` — should
  be replaced by a persisted `oauth_token_url` written at DCR completion.
- `needsRefresh(undefined) === false` — quietly correct in spirit (we don't
  know when to refresh) but creates the Notion silent-break failure mode
  when paired with no retry-on-401. Document the contract.
- `authCodeTokenCache` (in-memory, in `oauth-mcp-transport.ts`) is vestigial
  in daemon mode. Worth auditing whether `getCachedOAuth21Token` callsites
  in `apps/agor-daemon/src/oauth-cache.ts` and `services/gateway.ts` can
  read directly from `user_mcp_oauth_tokens` instead.
- DCR scope auto-population strips scopes when `client_id` is pre-registered
  (intentional). When DCR is used, we should **add** `offline_access` if
  advertised by the AS — currently we just join `scopes_supported`.
- Atlassian's 10-min refresh-token reuse grace window is friendlier than the
  current mutex-only approach assumes. Worth confirming our mutex doesn't
  drop a refresh request and leave us reuse-blocked.

---

## Appendix — Where to look in the codebase

| Topic | Path |
|---|---|
| OAuth transport (discovery, two-phase auth, in-mem cache) | `packages/core/src/tools/mcp/oauth-mcp-transport.ts` |
| Refresh logic (HTTP call + persist + mutex) | `packages/core/src/tools/mcp/oauth-refresh.ts` |
| Token storage repo | `packages/core/src/db/repositories/user-mcp-oauth-tokens.ts` |
| JIT refresh hook (server reads) | `apps/agor-daemon/src/register-hooks.ts` (`injectPerUserOAuthTokens`) |
| Auth-headers service (executor JIT) | `apps/agor-daemon/src/register-services.ts` (`/mcp-servers/oauth-auth-headers`) |
| Manual refresh endpoint | `apps/agor-daemon/src/register-services.ts` (`/mcp-servers/oauth-refresh`) |
| OAuth-status (UI green-pill) | `apps/agor-daemon/src/register-services.ts` (`/mcp-servers/oauth-status`) |
| OAuth 2.1 discovery upgrade | PR #1078 (`feat(mcp): support full OAuth 2.1 discovery`) |
| Recent UI fixes around expired-token state | PRs #1084, #1086 |
