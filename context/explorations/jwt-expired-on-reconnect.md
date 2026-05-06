# `Failed to load conversation: jwt expired` after disconnect/reconnect

**Status:** **implemented in this PR** (commits on `analyze-jwt-expired-on-reconnect`). The doc below was the analysis that motivated the fix; §9 records what shipped.

After the laptop sleeps, the network drops, or the tab is backgrounded long
enough for the access token to expire, the conversation panel sometimes
renders a sticky error banner:

> Failed to load conversation
> jwt expired

The conversation never recovers on its own — the user has to refresh the tab.
This document traces the failure end-to-end, explains why none of the existing
recovery paths catch it, and lays out solutions.

---

## TL;DR

1. The error string is `error.message` from a failed Feathers service call,
   surfaced through `ReactiveSessionState.error` and rendered as a static
   `<Alert>` at `apps/agor-ui/src/components/ConversationView/ConversationView.tsx:318-322`.
2. The failing calls are issued by `ReactiveSessionHandle.resync()` at
   `packages/client/src/reactive-session.ts:810-870`, which fires on every
   socket `connect` event (line 360-363).
3. There are **two unrelated** `client.io.on('connect', …)` listeners:
   `useAgorClient.ts:216` (re-authenticates the socket) and
   `reactive-session.ts:369` (calls `resync()`). The EventEmitter does **not**
   await async listeners, so `resync()` fires its REST/socket calls before
   the connect handler finishes refreshing tokens. The around-hook
   (`useAgorClient.ts:145-207`) is the safety net that catches 401s and
   retries — and that net mostly works.
4. The banner sticks when the safety net itself fails:
   - The around-hook catches `isDefiniteAuthFailure` only
     (`authErrors.ts:43-51`). A *transient* refresh failure (5xx, network
     timeout, dropped socket mid-refresh) re-throws the original 401
     (`useAgorClient.ts:169-174`) — `resync()` records that as `error`.
   - When the refresh token itself is dead (>30d, multi-tab rotation race,
     daemon restart that clears refresh-token table), `refreshTokensSingleFlight`
     latches `unrecoverable: true` (`singleFlightRefresh.ts:140-146`) and
     fast-fails forever. Every subsequent resync attempt sees the same 401
     and re-paints the banner.
   - Even after a successful auto-recovery in some other code path,
     `ReactiveSessionState.error` is only ever cleared by a *successful*
     `resync()` — and `resync()` only fires on socket `connect`, which has
     already happened. So the banner is sticky until the next physical
     disconnect/reconnect cycle.

The recommended fix is **C + D**: trigger a re-hydrate (`resync` + a token
refresh attempt) on socket reconnect *and* whenever the panel is mounted
with an existing error, plus a manual "Reload" affordance on the banner as a
deterministic escape hatch. Details in §6.

---

## 1. Where the error comes from

### 1.1 The component

`apps/agor-ui/src/components/ConversationView/ConversationView.tsx:200-322`:

```ts
const { handle: reactiveSession, state: reactiveState } = useSharedReactiveSession(
  client, sessionId, { enabled: isActive, reactiveOptions: { taskHydration: 'lazy' } }
);
…
const error = reactiveState?.error || null;
…
if (error) {
  return (
    <Alert type="error" message="Failed to load conversation" description={error} showIcon />
  );
}
```

The `description` (the literal `"jwt expired"`) is whatever string lives in
`reactiveState.error`. There is no Reload button, no retry, no auto-clear.

### 1.2 The hook

`apps/agor-ui/src/hooks/useSharedReactiveSession.ts:21-60` retains a shared
`ReactiveSessionHandle`, subscribes to its state, and fires `.ready()` once.
It does **not** retry on error and does **not** observe the socket
connection state directly.

### 1.3 The error producers

Two paths inside `packages/client/src/reactive-session.ts` write to
`state.error`:

- `bootstrap()` — runs once when the handle is created
  (lines 305-353; catch at 346-351).
- `resync()` — runs on every socket `connect` event
  (lines 810-870; catch at 864-868).

Both call `client.service('sessions').get(...)`,
`client.service('tasks').findAll(...)`, optionally
`client.service('messages').findAll(...)`, and the per-session queue
sub-service. Any one of these failing puts the resulting `error.message`
into state. JWT expiration surfaces as a Feathers `NotAuthenticated` error
(daemon side), whose `message` is the underlying JWT library string
`"jwt expired"`.

---

## 2. JWT / auth flow today

### 2.1 Server side

`apps/agor-daemon/src/register-routes.ts:247-254`:

- Access token TTL: **15 minutes**
- Refresh token TTL: **30 days**
- Refresh token rotates on every successful `/authentication/refresh`

### 2.2 Client side

Tokens live in `localStorage` under `agor-access-token` and
`agor-refresh-token` (`apps/agor-ui/src/utils/tokenRefresh.ts:10-11`).

There are **four** distinct refresh paths, layered for resilience:

| # | Trigger | File | Notes |
|---|---|---|---|
| 1 | Proactive timer | `apps/agor-ui/src/hooks/useAuth.ts:241-286` | Decodes JWT `exp` claim, schedules a refresh `60s` before expiry |
| 2 | Tab regains focus | `apps/agor-ui/src/hooks/useAuth.ts:169-214` | Calls `reAuthenticate()` if unauthenticated; refreshes if `exp` within 60s |
| 3 | Socket reconnect | `apps/agor-ui/src/hooks/useAgorClient.ts:216-303` | Tries `authenticate({jwt})` first, falls back to `refreshAndReauthenticate` |
| 4 | Per-call 401 retry | `apps/agor-ui/src/hooks/useAgorClient.ts:145-207` | `client.hooks({ around: { all: [...] } })` — catches `isDefiniteAuthFailure`, refreshes, retries the original call once via `_refreshRetried` guard |

Refresh is single-flight via `refreshTokensSingleFlight`
(`singleFlightRefresh.ts:100-154`) so concurrent 401s collapse into one POST.
On a definite-auth failure of `/authentication/refresh` itself, the helper
**latches** `unrecoverable: true`, dispatches
`TOKENS_REFRESH_UNRECOVERABLE_EVENT`, and rejects subsequent calls with
`RefreshUnrecoverableError` until the next successful login
(`singleFlightRefresh.ts:52-148`).

### 2.3 What's missing

- The **REST client** (`packages/core/src/api/index.ts:699-735`) does **not**
  install the around-hook. Only the socket client does. This is fine for the
  conversation panel (it uses the socket), but worth noting.
- Path #4 catches `NotAuthenticated` only. **Transient** failures of the
  refresh call itself — 5xx, network drop, refresh response dropped because
  the socket renegotiated mid-flight — fall into the `catch` at
  `useAgorClient.ts:169-174`, which re-throws the *original* 401:

  ```ts
  try {
    const result = await refreshAndReauthenticate(client);
    if (!result) throw err; // no refresh token stored
  } catch {
    // Refresh or re-authenticate failed — surface the original
    // auth error so upstream code … can decide …
    throw err;
  }
  ```

  That's by design — the comment is clear about it — but the upstream
  *consumer* in this case is `resync()`, which has nowhere to escalate to.
  It just writes "jwt expired" into state and waits.

---

## 3. Why it doesn't self-heal

### 3.1 The race during reconnect

When the socket reconnects, **two listeners fire on the same `connect` event**:

- `useAgorClient.ts:216` registers `client.io.on('connect', async () => {…})`
  at app boot. It awaits `client.authenticate({ jwt })` and falls back to
  `refreshAndReauthenticate` if needed.
- `reactive-session.ts:369` registers a second `client.io.on('connect', …)`
  every time a `ReactiveSessionHandle` is created. It synchronously assigns
  `this.readyPromise = this.resync();` — kicking off three to five service
  calls **immediately**.

Node's EventEmitter (and socket.io's emitter) does **not** await async
listeners. Listener execution order matches registration order, but each
listener returns synchronously at its first `await`. So the sequence is:

1. socket.io fires `connect`.
2. `useAgorClient` listener runs synchronously, hits `await client.authenticate(...)`, suspends.
3. `reactive-session` listener runs synchronously, calls `this.resync()` — three service calls launched.
4. Those service calls hit the daemon while the connection's auth state may
   still be the *previous* (now-stale) session, or unset. They 401.
5. The around-hook catches them, single-flights into the same refresh as
   step 2, retries each call once.

In the happy path this works. The retry succeeds, `resync()` fulfills, no
error surfaces. The around-hook is exactly the safety net that closes this
race for normal sessions.

### 3.2 When the safety net fails

The banner appears whenever step 5 fails for any reason:

- **Refresh token genuinely dead.** TTL is 30 days, but it can also be
  invalidated by:
  - Multi-tab rotation race. Both tabs wake up, both POST to
    `/authentication/refresh` with the same refresh token. The server
    rotates and issues a new one; the loser holds a stale token. Single-
    flight is *per-tab*, not cross-tab, so it doesn't help here. The
    loser's refresh latches `unrecoverable`, every retry fast-fails
    with `RefreshUnrecoverableError`, the around-hook re-throws the
    original 401, the banner sticks.
  - Daemon restart that clears the refresh-token store.
  - Server-side rotation invalidation logic.
- **Transient refresh failure.** Daemon hits a 5xx during
  `/authentication/refresh`, the websocket itself drops mid-refresh,
  `client.authenticate` after refresh fails because the socket renegotiated
  again, etc. The around-hook's `catch` re-throws the original 401; the
  banner sticks.
- **Retry succeeds for two of three calls; one still 401s.**
  `Promise.all` in `resync()` (line 813-825) rejects on the first failure.
  One unlucky call (e.g. the queue sub-service `/sessions/:id/tasks/queue`)
  failing leaves the panel in an error state even though the others
  succeeded.
- **`loadedTaskIds` loop.** When `taskHydration` is `'lazy'` and the user
  has previously expanded any tasks, `resync()` serially refetches messages
  for each one (`reactive-session.ts:839-852`). Any single failure in that
  loop throws and aborts the entire resync, leaving `state.error` set even
  if the other fetches succeeded.

### 3.3 Why the error doesn't clear afterwards

`state.error` is only ever cleared inside the success branch of `resync()`
(`reactive-session.ts:854-862`). And `resync()` only runs on a socket
`connect` event. Once the socket has reconnected and resync has failed,
**nothing** in the current code re-runs resync until the next physical
disconnect — which, on a stable network, never happens. Even if Path #1
(proactive timer) refreshes the JWT successfully a minute later, the
conversation panel doesn't notice.

The visibility-change recovery in `useAuth.ts:169-214` *does* refresh
tokens when the tab regains focus, but it doesn't poke the reactive
session — there's no signal between `useAuth` and `ReactiveSessionHandle`
to retry hydration.

### 3.4 Page-load vs reconnect bootstrap

| | Page load | Reconnect |
|---|---|---|
| Tokens read | `localStorage` → `useAuth` initialization | Already in `accessTokenRef` |
| Auth | `client.authenticate({ jwt })` from `useAgorClient` initial connect | Same, in connect handler |
| Reactive session | New handle created → `bootstrap()` runs once | Existing handle → `resync()` runs |
| Error path | `bootstrap()` failure surfaces same way | `resync()` failure surfaces same way |
| State scope | Many independent fetches via reactive sessions per panel | Same |

There is no global "rehydrate everything" function. State is scattered
across `ReactiveSessionHandle` instances (one per open conversation),
React Query is **not** in use, and component-level fetches happen
ad hoc. The closest thing to a bootstrap is `bootstrap()` itself —
which on reconnect we already fire as `resync()`. The mechanism is
present; it's the failure handling that's incomplete.

---

## 4. Multiplayer / Unix-isolation considerations

Any fix has to preserve:

- **Token isolation per tab session.** Tokens are in `localStorage` —
  that's already per-origin, but anything that reads/refreshes tokens has
  to keep using the same single-flight + unrecoverable-latch helpers so
  multi-tab races don't cross-pollinate.
- **No cross-user session leakage.** Reconnect must not re-fetch with a
  different user's token, e.g. if a user logged out and back in as someone
  else while the panel was idle. The current code re-reads `accessTokenRef`
  on each connect handler call — fine — but a "reload everything"
  command must do the same and must not retain stale `created_by`
  filters in queries.
- **`session` permission tier (default).** Resync uses the panel viewer's
  identity — that's already correct today and any fix must keep it that
  way. No changes to `created_by` filtering.

These are all preserved by the recommended approach below; flagging them
explicitly because "reload state on reconnect" is the kind of thing that
is easy to write in a way that violates them.

---

## 5. Solution space

### A — Manual reload button banner

**Sketch.** Replace the inert `<Alert>` at `ConversationView.tsx:318-322`
with one that has a "Reload" action. Clicking it calls a new
`reactiveSession.resync()` (currently private — would need to be exposed
as a public method on `ReactiveSessionHandle`). On click:

```ts
const handleReload = async () => {
  // Best-effort token refresh first; ignore failures, resync's around-hook
  // will catch any remaining 401.
  await refreshTokensSingleFlight(client, getStoredRefreshToken() ?? '').catch(() => {});
  await reactiveSession.resync();
};
```

**Pros**
- Tiny diff. Bounded blast radius.
- Deterministic: the user clicks, something happens, the user sees the
  result. No "did the auto-recovery fire?" mystery.
- Doesn't introduce new failure modes.

**Cons**
- Manual. The user is told "reload" instead of "this just works."
- Ignores that the reactive session model already has a perfectly good
  `resync()` mechanism — this just adds a button.

### B — Auto-refresh on 401 (already implemented, harden it)

**Sketch.** The around-hook in `useAgorClient.ts:145-207` already does
this. To close the gaps:

1. In the around-hook's inner `catch` at `useAgorClient.ts:169-174`,
   distinguish `RefreshUnrecoverableError` (terminal — re-throw original
   401, useAuth will sign out) from transient refresh failures (retry the
   refresh once with a small delay before giving up).
2. Add the same around-hook to the REST client at
   `packages/core/src/api/index.ts:722` (currently socket-only).

**Pros**
- The infrastructure is already there. Just a couple of targeted edits.
- Standard pattern. Easy to test.

**Cons**
- Doesn't address the race in §3.1 (the around-hook is the safety net
  that catches that race; we already have it; the bug happens when *that*
  net itself fails).
- Doesn't address the post-reconnect-failure stickiness (§3.3). Once
  `state.error` is set, no future 401 will fire because `resync()` won't
  run again.

### C — Re-hydrate on reconnect (and on focus, when stale)

**Sketch.** Two parts:

1. **Make `resync()` self-retrying** under defined conditions. After the
   single-flight retry inside the around-hook fails, `resync()`'s
   `catch` already runs once. Add a guarded short-delay retry (one
   attempt, ~500ms, only if `isTransientConnectionError(err)` —
   we have that helper at `authErrors.ts:59-85`). If the retry still
   fails, surface error normally.
2. **Re-trigger `resync()` from `useSharedReactiveSession`** when:
   - the socket transitions from disconnected → connected, **or**
   - the document `visibilitychange` event fires `visible` and
     `state.error` is non-null, **or**
   - the `TOKENS_REFRESHED_EVENT` fires while `state.error` is non-null.

Implementation outline:

```ts
// useSharedReactiveSession.ts (illustrative)
useEffect(() => {
  if (!handle) return;
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (handle.state.error) handle.resync();
  };
  const onRefreshed = () => {
    if (handle.state.error) handle.resync();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener(TOKENS_REFRESHED_EVENT, onRefreshed);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener(TOKENS_REFRESHED_EVENT, onRefreshed);
  };
}, [handle]);
```

`resync()` would need to be exposed as a public method on the handle.

**Pros**
- Heals automatically without any user action in the common case
  (transient daemon hiccup, brief network drop, tab background).
- Reuses the existing reactive-session bootstrap mechanism — no new
  state-loading code paths.
- The `TOKENS_REFRESHED_EVENT` listener closes the gap where Path #1
  (proactive timer) refreshes successfully but the panel's `error`
  doesn't clear.
- Multi-tab safe: refresh stays single-flight; resync is per-tab; no
  cross-user leakage.

**Cons**
- More moving parts than A. Three new edges to test
  (reconnect / visibility / refreshed).
- If `resync()` itself is buggy (e.g. one of the calls always 401s),
  this loop could fire repeatedly on every focus. Mitigation:
  cap retries by counting consecutive failures and stop if
  `RefreshUnrecoverableError` is the cause (which already
  routes through `useAuth` → forced logout, so the panel will
  unmount before the next attempt).

### D — Hybrid (B + A as fallback)

**Sketch.** Keep B (the around-hook is already there). When `resync()`
still surfaces an error, render a banner with a Reload button (A) instead
of an inert Alert.

**Pros**
- Belt-and-suspenders. Auto-recovery handles the common case; the button
  handles the long tail.
- Bounded scope: even if all the auto-recovery layers fail, the user can
  always click reload.

**Cons**
- Doesn't fix the stickiness — the auto-recovery doesn't get a second
  chance on its own; the user is the second chance.

### E — What the codebase architecture suggests: option C + manual fallback

The reactive-session layer already encodes "rehydrate everything for one
session" as `resync()`. The problem is that it only runs once per
`connect` event and has no clear-error path. Wiring it up to the
existing `TOKENS_REFRESHED_EVENT` and `visibilitychange` is a small,
local change that fits the existing model. Combining that with a manual
Reload button on the banner is the smallest change that closes both the
race window and the stickiness.

---

## 6. Recommendation

**Implement C with A as a UX fallback. Skip B's REST extension for now —
the conversation panel is socket-only and that work isn't on the
critical path.**

Concretely, in priority order:

1. **Expose `resync()` as a public method on `ReactiveSessionHandle`.**
   Currently `private async resync()` at
   `packages/client/src/reactive-session.ts:810`. Make it public so
   external consumers can re-trigger it without spoofing a socket event.
2. **Re-trigger `resync()` from `useSharedReactiveSession` on:**
   - `TOKENS_REFRESHED_EVENT` (Path #1's refresh succeeded — clear any
     stale error).
   - `visibilitychange` to `visible` when `state.error` is non-null.
   - Cap to one attempt per event; debounce so back-to-back events don't
     stampede.
3. **Add a "Reload" button to the error banner** at
   `ConversationView.tsx:318-322`. On click, fire
   `refreshTokensSingleFlight` (best-effort) followed by
   `reactiveSession.resync()`. This is the deterministic escape hatch
   when auto-recovery doesn't fire (e.g. the user opens the tab and the
   socket was already reconnected an hour ago with a stale error).
4. **Inside `resync()`'s catch**, distinguish transient from definite:
   on `isTransientConnectionError`, retry once after ~500ms before
   surfacing. This catches the dropped-mid-refresh race.

Total surface: one new public method, one `useEffect` block in the hook,
one button on the banner, one small retry inside `resync()`. No new
dependencies, no new state machines, no token-refresh logic changes.

---

## 7. Quick-win follow-ups (not for this PR)

These were noticed during investigation but are out of scope:

- **Cross-tab single-flight.** `singleFlightRefresh.ts` is per-tab. On
  multi-tab wake-up the loser of the rotation race holds a dead refresh
  token. A `BroadcastChannel('agor-auth')` to coordinate refreshes
  cross-tab would close that gap. Non-trivial; track separately.
- **REST client around-hook.** The 401-retry hook lives only on the
  socket client (`useAgorClient.ts:145-207`). Any REST consumer (CLI,
  exports, etc.) gets a hard 401. If REST grows beyond its current
  scope, port the hook to `packages/core/src/api/index.ts:722`.
- **`Promise.all` in `resync()` and `bootstrap()`** is fail-fast. The
  queue sub-service failing kills the whole resync. Consider
  `Promise.allSettled` and per-field error tracking, so a partial
  failure doesn't blank the panel.
- **`useSharedReactiveSession` doesn't `enabled`-gate on token
  presence.** If `accessTokenRef` is null on first mount, `bootstrap()`
  runs anyway and 401s. Probably safe today (panel is gated on auth
  upstream), but worth verifying with an `enabled: !!token` predicate.

---

## 9. What shipped in this PR

The recommendation in §6 was implemented along with a parallel fix for the
*global* byId state (the `useAgorData` hub), which had the same kind of
"events fired while disconnected are gone" problem at app scope.

### Conversation panel (the original symptom)

- `packages/client/src/reactive-session.ts` —
  - `resync()` made public so the UI can re-trigger hydration without
    spoofing a socket event.
  - Now **single-flighted** inside the handle: overlapping callers (socket
    `connect`, visibilitychange, manual Reload) join the same in-flight
    promise, so a slow failure cannot land after a faster success and
    re-stamp a stale error. Internal `disposed` checks before the post-
    fetch state writes.
  - New `state.terminal: boolean` discriminates non-recoverable errors
    from transient ones. Set when the server emits `removed` for this
    session, OR when **either** the initial `bootstrap()` **or** a later
    `resync()` fails with HTTP **403**/**404** (an inline
    `errorStatusCode()` helper inside the package handles this without
    taking a UI cross-package dependency on `apps/agor-ui`'s
    `authErrors.ts`). 401 stays non-terminal so the around-hook + token
    refresh can heal. Auto-retry callers MUST skip when `terminal === true`.
- `apps/agor-ui/src/hooks/useSharedReactiveSession.ts` — added a second
  `useEffect` that, while `state.error` is non-null **and not terminal**,
  calls `handle.resync()` in response to:
  - `document` `visibilitychange` → `visible` (tab refocus after long
    background)
  - `window` `TOKENS_REFRESHED_EVENT` (proactive refresh in `useAuth`
    succeeded — clear any stale error that a prior `resync()` had latched)

  No local inflight ref needed — single-flight lives in the handle.
- `apps/agor-ui/src/components/ConversationView/ConversationView.tsx` —
  the static error `<Alert>` now exposes a "Reload" action button that
  calls `reactiveSession.resync()`. Hidden when `state.terminal` so the
  user isn't offered a useless retry on a deleted session. Deterministic
  escape hatch for cases where automatic recovery doesn't fire (e.g. user
  returns hours later and the only signal we'd otherwise act on was the
  `connect` event that already happened with stale auth).

### Global byId state (parallel fix in the same PR)

`useAgorData` was the obvious "global state" surface the user identified —
15 byId Maps centralized in one hook, exposed via `AppDataContext`. It had
an explicit comment (`// WebSocket events keep data synchronized in
real-time`) that was wrong on reconnect: events fired while disconnected
are not replayable.

- `apps/agor-ui/src/hooks/useAgorData.ts` —
  - Added a `client.io.on('connect', handleReconnect)` inside the existing
    event-listener `useEffect`. After the initial fetch, every reconnect
    re-runs `fetchData()` (the same 14-service `Promise.all` page-load
    uses). Single-flighted via a ref so a flapping socket doesn't
    stampede.
  - `fetchData()` now accepts `{ silent }`; the reconnect path uses
    `silent: true` so a transient failure (e.g. racing the re-auth handler
    in `useAgorClient`, hitting a 401 once before the around-hook refresh
    lands) doesn't escalate to App.tsx's fullscreen "Failed to load data"
    overlay.
  - Silent failures latch a `lastSilentFetchFailedRef` flag. A
    `TOKENS_REFRESHED_EVENT` listener retries the silent refetch only when
    the latch is set, so byId state recovers as soon as the next access-
    token refresh lands — without forcing a wasted 14-service refetch on
    every routine token rotation. The latch clears on a successful silent
    refetch.

### Pitfalls flagged but deliberately not addressed

- `Promise.all` in `fetchData()` and `resync()` is fail-fast. If one
  service genuinely fails (auth-retry exhausted, daemon partial failure)
  the whole rehydrate is aborted and existing maps are preserved. This
  matches today's *page-load* failure mode, so we're not regressing —
  but a partial failure on reconnect is more likely than at page load.
  `Promise.allSettled` + per-Map error handling is a worthwhile follow-up
  if it becomes painful in practice.
- Cross-tab refresh-token rotation race in `singleFlightRefresh.ts`
  (per-tab single-flight, not cross-tab) is unchanged. Use a
  `BroadcastChannel('agor-auth')` if multi-tab users start hitting it.
- The transient-error retry inside `resync()` was *not* added — doing so
  would have required moving `isTransientConnectionError` from
  `apps/agor-ui` into `packages/client`, a cross-layer dependency we'd
  rather not introduce. The visibility / tokens-refreshed listeners
  cover most of the same cases without that import.
- REST-client around-hook is still socket-only. Acceptable; the
  conversation panel and `useAgorData` both use the socket client.

---

## 8. File reference index

| What | File | Lines |
|---|---|---|
| Banner render | `apps/agor-ui/src/components/ConversationView/ConversationView.tsx` | 318-322 |
| Hook → handle wire-up | `apps/agor-ui/src/hooks/useSharedReactiveSession.ts` | 21-60 |
| `bootstrap()` | `packages/client/src/reactive-session.ts` | 305-353 |
| `resync()` | `packages/client/src/reactive-session.ts` | 810-870 |
| `connect` listener (resync trigger) | `packages/client/src/reactive-session.ts` | 360-371 |
| `connect` listener (re-auth) | `apps/agor-ui/src/hooks/useAgorClient.ts` | 216-303 |
| 401 around-hook | `apps/agor-ui/src/hooks/useAgorClient.ts` | 145-207 |
| `isDefiniteAuthFailure` | `apps/agor-ui/src/utils/authErrors.ts` | 43-51 |
| `isTransientConnectionError` | `apps/agor-ui/src/utils/authErrors.ts` | 59-85 |
| Single-flight refresh + unrecoverable latch | `apps/agor-ui/src/utils/singleFlightRefresh.ts` | 52-154 |
| `refreshAndReauthenticate` | `apps/agor-ui/src/utils/singleFlightRefresh.ts` | 165-175 |
| `TOKENS_REFRESHED_EVENT` | `apps/agor-ui/src/utils/singleFlightRefresh.ts` | 43, 121-125 |
| Proactive refresh timer | `apps/agor-ui/src/hooks/useAuth.ts` | 241-286 |
| Visibility-change recovery | `apps/agor-ui/src/hooks/useAuth.ts` | 169-214 |
| Token storage (localStorage keys) | `apps/agor-ui/src/utils/tokenRefresh.ts` | 10-11 |
| Server JWT TTLs | `apps/agor-daemon/src/register-routes.ts` | 247-254 |
| Feathers client setup | `packages/core/src/api/index.ts` | 699-810 |
