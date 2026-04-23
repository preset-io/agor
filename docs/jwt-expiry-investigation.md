# JWT Expiry Investigation

**Branch:** `investigate-jwt-expiry`
**Date:** 2026-04-23
**Symptom:** UI throws "jwt expired" intermittently; refreshing the page fixes it. Started being reported "recently."

---

## TL;DR

On **2026-04-17** the daemon's access-token TTL was hardened from **7 days → 15 minutes**
(commit `43dfe6b4`, follow-up `e49815b0`). The UI's **auto-refresh timer was never updated**
— it still fires every **6 days** (`apps/agor-ui/src/hooks/useAuth.ts:241`) on the assumption
that the token lives for 7 days. The refresh token (30d) and the `/authentication/refresh`
endpoint are both healthy, so a full page reload (which calls `reAuthenticate()` and falls
back to the refresh token) mints a fresh 15-minute token and everything works — until it
expires again 15 minutes later.

There is also **no 401-retry interceptor** on REST calls, so once the access token goes
stale, every subsequent request fails with "jwt expired" until the page is reloaded or the
socket disconnects and reconnects.

---

## Current state

### JWT issuance

| Aspect | Value | Source |
|---|---|---|
| Issuer | Daemon (FeathersJS `AuthenticationService` + manual `jwt.sign` in refresh route) | `apps/agor-daemon/src/register-routes.ts:262`, `:412` |
| Library | `jsonwebtoken` v9.0.3 (direct); `@feathersjs/authentication` v5.0.44 (framework) | `apps/agor-daemon/package.json:37`, `packages/core` |
| Algorithm | HS256, `iss: "agor"`, `aud: "https://agor.dev"`, `typ: "access"` | `apps/agor-daemon/src/register-routes.ts:248-254` |
| **Access TTL** | **`15m`** (hardcoded constant `ACCESS_TOKEN_TTL`) | `apps/agor-daemon/src/register-routes.ts:239` |
| Refresh TTL | `30d` (hardcoded constant `REFRESH_TOKEN_TTL`) | `apps/agor-daemon/src/register-routes.ts:240` |
| Secret | `jwtSecret` resolved at daemon boot; not user-configurable via `~/.agor/config.yaml` | `apps/agor-daemon/src/register-routes.ts:243` |
| Refresh endpoint | `POST /authentication/refresh` — accepts `{refreshToken}`, returns fresh access + new refresh tokens | `apps/agor-daemon/src/register-routes.ts:392-442` |

> Note: `session_token_expiration_ms` (default 24h) and `mcp_token_expiration_ms` (default 24h)
> in `~/.agor/config.yaml` are **separate** token systems (executor tokens and the daemon↔MCP
> channel). Neither affects the user-auth JWT that the UI uses.

### Client-side storage and transport

| Aspect | Value | Source |
|---|---|---|
| Access token storage | `localStorage['agor-access-token']` | `apps/agor-ui/src/utils/tokenRefresh.ts:10` |
| Refresh token storage | `localStorage['agor-refresh-token']` | `apps/agor-ui/src/utils/tokenRefresh.ts:11` |
| HTTP transport | `Authorization: Bearer <token>` (via Feathers auth-client) | `packages/core/src/api/index.ts:708-781` |
| Socket transport | Socket.io handshake auth after connect (`client.authenticate({strategy:"jwt", accessToken})`) | `apps/agor-ui/src/hooks/useAgorClient.ts:81-84` |
| 401 interceptor | **None.** Feathers' REST client does not auto-retry on 401. | grep for `interceptor`/`401` in `packages/core/src/api/` returns no matches |

### Refresh mechanism — what exists

1. **Proactive timer — BROKEN.** `apps/agor-ui/src/hooks/useAuth.ts:236-281`:
   ```ts
   // Access token expires in 7 days, refresh after 6 days (conservative approach)
   const REFRESH_INTERVAL = 6 * 24 * 60 * 60 * 1000; // 6 days in milliseconds
   ```
   This comment/constant was correct when TTL was 7d; it has been stale since `43dfe6b4`.
2. **Visibility-change poll.** `useAuth.ts:208-234`: when the tab becomes visible, poll
   `reAuthenticate()` every 3s until it succeeds. This re-reads `localStorage` and hands
   the (possibly expired) access token to Feathers — it does NOT call `/authentication/refresh`.
3. **Socket reconnect fallback.** `apps/agor-ui/src/hooks/useAgorClient.ts:72-138`: on
   socket `connect` event, try access token first, if that fails fall back to
   `refreshAndStoreTokens(client, refreshToken)`. **This is the only automatic
   access→refresh fallback.** It fires on socket (re)connects, not on regular API 401s.
4. **Manual page reload.** On boot, the app calls `reAuthenticate()` which retries with the
   stored access token; when that fails the user-facing code paths eventually land on the
   socket-reconnect path above and recover via refresh token.

### Refresh mechanism — what does NOT exist

- No REST interceptor that catches 401, calls `/authentication/refresh`, and retries the
  original request.
- No WebSocket event handler that reacts to mid-stream `NotAuthenticated` / `jwt expired`
  errors on a *connected* socket (we only recover on reconnect).
- No server-driven TTL discovery — the 15m value is hardcoded on the server, and the client
  has no way to learn it.

### Recent relevant commits

| SHA | Date | Summary |
|---|---|---|
| **`43dfe6b4`** | 2026-04-17 | **sec(daemon): trust-proxy/JWT/rate-limit/body-limit hardening.** Dropped access-token TTL from `7d` → `15m`. This is the root-cause commit. |
| **`e49815b0`** | 2026-04-17 | **sec(daemon): align refresh-token TTL.** Fixed `/authentication/refresh` to use the same `ACCESS_TOKEN_TTL` constant (it had been minting 7d tokens, silently undoing 43dfe6b4). |
| `f5dabed2` | 2026-04-17 | Web hardening pack (CORS/CSP/uploads/JWT/proxy). Context for the security work. |
| `fcd78b2b` | 2026-04-13 | Auth/route hardening: GitHub setup state-nonce, MCP header-only auth. Not the cause but adjacent. |
| `06bf5594` | 2026-03-31 | UI auth + reactive-session review findings. Last pre-hardening UI auth change. |
| `7f5c820a` | 2026-03-31 | Shared reactive-session leasing and REST auth flows in the client. |

No commit since `43dfe6b4` has touched `apps/agor-ui/src/hooks/useAuth.ts`'s refresh interval.

---

## Root cause hypothesis (ranked)

### 1. (MOST LIKELY) UI refresh timer was never updated after the TTL hardening
**Evidence:**
- `apps/agor-ui/src/hooks/useAuth.ts:241` — `REFRESH_INTERVAL = 6 * 24 * 60 * 60 * 1000` (6 days).
- Server TTL = 15 minutes.
- Commit `43dfe6b4` on 2026-04-17 (6 days ago from 2026-04-23) introduced the 15m TTL; that
  matches "new/recent" perfectly.
- "Refresh fixes it" matches the actual recovery path: reload → `reAuthenticate()` → on
  failure the socket reconnect path uses the stored refresh token to mint a new access
  token. State that lives in React (and in an already-connected socket session) keeps the
  stale access token until reload.

**Reproduction:** Log in, stay idle / browse for >15 minutes, then trigger any REST call
that isn't served by an already-authenticated socket. 401 "jwt expired."

### 2. (CONTRIBUTING) No REST 401-retry interceptor
Even if the proactive timer were correct, any clock skew, suspended laptop, or long-running
tab would occasionally outrun it. A 401 interceptor that transparently calls
`/authentication/refresh` and retries the original request would turn transient expiry into
a silent no-op. Its absence is why the bug is *visible* to users instead of being quietly
recovered.

### 3. (CONTRIBUTING, SMALLER) Mid-stream socket expiry is not handled
The socket reconnect path has the only automatic refresh fallback. If the socket stays
connected but the daemon starts rejecting messages on it (e.g. because an auth-required
hook re-verifies JWT on each call), we don't currently recover without a disconnect. Less
likely to be the primary driver here, but worth verifying.

### 4. (UNLIKELY) Clock skew / JWT secret rotation / refresh endpoint bug
The refresh endpoint was audited by `e49815b0` and is using the shared constants. JWT
secret is stable across a daemon run. These don't fit the "refresh the page fixes it"
symptom — if the secret rotated or the refresh endpoint was broken, reload wouldn't help.

---

## Proposed solutions (ranked)

### Option A — Minimal fix (recommended short-term)
**Change:** In `apps/agor-ui/src/hooks/useAuth.ts:241`, replace the 6-day interval with a
value aligned to the 15-minute TTL (e.g. refresh every 10 minutes — leaves a 5-minute safety
margin). Update the stale comment on line 240.

**Effort:** ~5 minutes + a manual test (log in, wait 10+ minutes, confirm timer fires
and no "jwt expired" surfaces).

**Tradeoffs:**
- **Pros:** One-line change, ships same day, fixes the user-visible symptom.
- **Cons:** Still brittle — if the server constant changes again, drift returns. Doesn't
  help if a laptop sleeps longer than 15 minutes between timer ticks (the timer is paused
  while the tab is backgrounded/suspended). Doesn't help if a REST call 401s due to clock
  skew or a missed tick.
- **Residual risk:** Laptop sleep scenario. `useAuth.ts` already has a visibility-change
  handler at `:208-234` but it calls `reAuthenticate()` (which uses the stored, possibly
  expired access token), not the refresh endpoint. That handler should additionally trigger
  `refreshAndStoreTokens()` to close the suspend-gap.

### Option B — Proper fix (recommended as the real fix)
**Change:** Combine three things:

1. **Align the timer dynamically.** Decode the access token's `exp` claim on login/refresh
   (or have the server return TTL in the auth response) and schedule the refresh at
   `exp - 60s`. This removes the hardcoded-drift failure mode permanently.
2. **Add a REST 401 interceptor.** Wrap the Feathers REST client (or the underlying
   fetch/axios) so that any 401 with a `NotAuthenticated`/`TokenExpiredError` body:
   - calls `/authentication/refresh` with the stored refresh token (single-flight — dedupe
     concurrent calls),
   - stores the new tokens,
   - retries the original request once.
3. **Handle visibility + suspend.** When the tab regains focus after >TTL, trigger a
   refresh before the next API call rather than waiting for the next interval tick.

**Effort:** Medium — roughly a day's work including tests. Most of the scaffolding
(`refreshAndStoreTokens`, `getStoredRefreshToken`) already exists.

**Tradeoffs:**
- **Pros:** Robust against drift, clock skew, laptop sleep, and future TTL changes. Makes
  the UX invisible to the user.
- **Cons:** Interceptor logic needs to be careful about infinite loops (401 during a
  refresh call itself) and request concurrency (N parallel 401s should result in 1 refresh,
  not N). Feathers' auth-client does not expose a first-class interceptor; we'd wrap the
  transport or use a hook.

### Option C — Architectural fix
**Change:** Move the access token out of `localStorage` into an **HttpOnly, SameSite=Lax,
Secure cookie** issued by the daemon; keep the refresh flow server-side (Set-Cookie on
`/authentication/refresh`). Keep the short access TTL, and add the interceptor from
Option B.

**Effort:** Large — touches daemon middleware, CORS, CSRF, multi-origin dev, CLI auth
helpers, and tests.

**Tradeoffs:**
- **Pros:** Token is no longer reachable from JS (XSS can't exfiltrate it); aligns with
  OWASP guidance; simplifies transport (no manual Authorization header). Combined with
  short TTL, it materially raises the security bar.
- **Cons:** Requires CSRF protection (double-submit or SameSite + custom header check),
  breaks the current "paste a bearer token into curl" developer workflow, and conflicts
  with Agor's multi-process topology (daemon, executors, MCP server) where Bearer is
  simpler. Probably overkill for dev/local/solo modes; may be appropriate for `team` mode.
  This is the same flag-gated-by-deployment-mode pattern described in the security posture
  memory.

---

## Questions for Max

1. **Is the 15m access-token TTL the permanent target?** If yes, Option A is a stopgap and
   we should commit to Option B. If you're open to 1h (still short, cheaper for the UI), a
   simple bump + Option A might be enough for now.
2. **Is laptop-sleep / long-idle a supported scenario?** If users are expected to leave the
   tab open overnight and come back, Option A alone won't be enough — Option B's
   interceptor is the real fix.
3. **Do you want the TTL to be configurable via `~/.agor/config.yaml`?** Right now it's
   hardcoded in `register-routes.ts`. Making it a config value (with the 15m default)
   would let `team`-mode operators pin it differently from `solo`/`local`, and would give
   the UI a way to fetch the effective value instead of hardcoding.
4. **Socket mid-stream expiry:** do we care today, or is reconnect-recovery good enough?
   If the daemon re-verifies JWT on every service call over the socket, mid-stream 401s
   can happen on long-lived connections without a disconnect; worth a 10-minute check.
5. **Architectural Option C:** worth it for `team` mode, or out of scope? (Related: this
   intersects with the "security behind flags" posture — cookie-based auth could be
   gated on `deployment.mode: team` with Bearer-in-localStorage as default elsewhere.)

---

## Appendix: exact pointers

- Server TTL: `apps/agor-daemon/src/register-routes.ts:239-240` (`ACCESS_TOKEN_TTL = '15m'`,
  `REFRESH_TOKEN_TTL = '30d'`).
- Auth config block: `apps/agor-daemon/src/register-routes.ts:242-259`.
- Refresh endpoint: `apps/agor-daemon/src/register-routes.ts:392-442`.
- UI auto-refresh timer (broken): `apps/agor-ui/src/hooks/useAuth.ts:236-281`; interval
  defined on line 241.
- UI tab-visibility re-auth poll: `apps/agor-ui/src/hooks/useAuth.ts:208-234`.
- Socket reconnect → refresh-token fallback: `apps/agor-ui/src/hooks/useAgorClient.ts:72-138`
  (fallback at `:92-114`).
- Token storage helpers: `apps/agor-ui/src/utils/tokenRefresh.ts:10-11, 49-80`.
- REST client wiring: `packages/core/src/api/index.ts:708-781`.
- Smoking-gun commits: `43dfe6b4` (TTL 7d→15m, 2026-04-17), `e49815b0` (refresh-endpoint
  alignment, same day).
