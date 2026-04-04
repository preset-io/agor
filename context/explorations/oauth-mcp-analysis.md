# OAuth Flow + MCP Authentication UX Analysis

> **Status:** Analysis complete, pending implementation decisions
> **Author:** Claude Code (oauth-flow-analysis branch)
> **Date:** 2026-04-04

---

## Table of Contents

1. [The "Paste Something" Modal at End of OAuth](#1-the-paste-something-modal-at-end-of-oauth)
2. [MCP Auth State in Session UI](#2-mcp-auth-state-in-session-ui)
3. [Channel Gateway + MCP Auth](#3-channel-gateway--mcp-auth)
4. [Gateway MCP Selection](#4-gateway-mcp-selection)
5. [Implementation Plan](#5-implementation-plan)
6. [Open Questions](#6-open-questions)

---

## 1. The "Paste Something" Modal at End of OAuth

### Current State

The OAuth flow is a two-phase system with an automatic path and a manual fallback:

**Phase 1 — Initiation:**
- UI calls `/mcp-servers/oauth-start` (`apps/agor-daemon/src/index.ts:1828-1947`)
- Daemon probes MCP server for `www-authenticate` header with `resource_metadata=` (line 1876-1889)
- Calls `startMCPOAuthFlow()` from `packages/core/src/tools/mcp/oauth-mcp-transport.ts:812-989`
- Flow: parse metadata → fetch Protected Resource Metadata (RFC 9728) → fetch AS Metadata (RFC 8414) → generate PKCE → optional Dynamic Client Registration (RFC 7591) → build authorization URL
- Stores pending flow in `pendingOAuthFlows` Map keyed by state (line 1912)
- Emits `oauth:open_browser` WebSocket event → UI opens browser tab
- **Returns `state` token to UI** → UI immediately shows the paste modal

**Phase 2a — Automatic callback (happy path):**
- OAuth provider redirects to `GET /mcp-servers/oauth-callback?code=...&state=...` (line 1230-1326)
- Handler: validate code/state → find pending flow → exchange code for token via `completeMCPOAuthFlow()` → save token (per-user or shared) → emit `oauth:completed` WebSocket event → return success HTML page
- UI receives `oauth:completed` → closes the paste modal automatically (`MCPServersTable.tsx:164-172`)

**Phase 2b — Manual paste (fallback):**
- User copies the callback URL from the browser address bar and pastes into the modal
- UI calls `/mcp-servers/oauth-complete` (line 1954) with `callback_url` → daemon parses code/state → same token exchange

### The Bug

**The paste modal (`MCPServersTable.tsx:885-940`) appears unconditionally** at line 160:

```typescript
if (data.success && data.state) {
  setOauthState(data.state);
  setOauthCallbackUrl('');
  setOauthCallbackModalVisible(true);  // ← ALWAYS shows
  showInfo('Browser opened. Complete authentication in the new tab.');
```

Even the return message from the daemon says `'After signing in, copy the callback URL and paste it below.'` (line 1937), treating manual paste as the primary flow.

The modal text explicitly says:
> "After signing in to the OAuth provider, you will be redirected to a page that may show an error (like 'This site can't be reached'). **This is expected.**"

This is the telltale sign: **the redirect URI (`/mcp-servers/oauth-callback`) is unreachable from the user's browser when the daemon runs on a different host** (e.g., a remote server). The `redirectUri` is computed from `getBaseUrl()` (line 1896-1897), which resolves `AGOR_BASE_URL` → `daemon.base_url` config → `localhost` fallback. If the daemon is at `https://my-server.example.com` and the user's browser can reach it, the callback works. If not (or if CORS/firewall blocks it), the redirect fails and the user sees "This site can't be reached."

### Root Cause

The OAuth callback works correctly when:
1. The daemon's `base_url` / `AGOR_BASE_URL` is properly configured
2. The user's browser can reach the daemon at that URL
3. No firewall/proxy strips the callback

The modal exists as a **legitimate fallback for remote daemons** where the callback redirect may not work. However, it should NOT be the primary UX — it should be hidden behind a timeout or explicit "having trouble?" link.

### Proposed Fix

**Replace the always-visible paste modal with a progressive disclosure approach:**

1. **On OAuth start:** Show a minimal status indicator (e.g., "Authenticating... waiting for callback") — NOT a modal
2. **Listen for `oauth:completed`** (already implemented at line 164-172) — auto-dismiss on success
3. **After 15-30 second timeout** (or if the redirect tab returns an error): Show a "Having trouble?" link that reveals the paste input
4. **Alternatively:** Detect if the daemon is local vs remote at flow start. If `getBaseUrl()` returns a `localhost` URL but the UI is loaded from a different host, show the paste modal immediately since the callback will definitely fail

**Specific changes needed:**
- `MCPServersTable.tsx:160` — Don't set `oauthCallbackModalVisible(true)` immediately
- Add a timeout-based fallback that reveals the paste input after N seconds
- Consider a small inline banner or toast instead of a blocking modal

**Also fix the session-header OAuth flow** (`SessionPanelContent.tsx:128-158`) which currently opens the auth URL in a new tab but has **no completion listener** — the pill stays orange even after the user authenticates because there's no `oauth:completed` listener attached. This is a separate bug.

---

## 2. MCP Auth State in Session UI

### Current State

**MCP pills in session header** — `SessionPanelContent.tsx:113-166`:
- Iterates `sessionMcpServerIds` → looks up each server in `mcpServerById` Map
- Auth detection: `needsAuth = server?.auth?.type === 'oauth' && !server?.auth?.oauth_access_token` (line 117-118)
- Orange pill with `LoginOutlined` icon when `needsAuth`, purple with `ApiOutlined` when authed
- Clicking orange pill initiates OAuth flow (opens browser tab)

**Prompt input** — `SessionPanel.tsx:584-613`:
- Uses `AutocompleteTextarea` component (`apps/agor-ui/src/components/AutocompleteTextarea/AutocompleteTextarea.tsx`)
- No awareness of MCP auth state — no warnings displayed

**Real-time updates** — `useAgorData.ts:560-591`:
- `handleMCPServerPatched` updates `mcpServerById` on WebSocket `patched` events
- This means pill colors update when the shared `oauth_access_token` changes on the server record

### Issues Found

#### Issue 2a: Per-user auth not reflected in pill color

The auth check (`!server?.auth?.oauth_access_token`) only checks the **shared** token on the MCP server record. When `oauth_mode: 'per_user'`, tokens are stored in `user_mcp_oauth_tokens` table (per-user), NOT on the server record. So:

- User A authenticates (per-user) → token saved to `user_mcp_oauth_tokens`
- Server record still has no `oauth_access_token`
- **Pill stays orange** for all users, even the one who authenticated

The UI has zero awareness of `user_mcp_oauth_tokens`. There's no API endpoint to check "does the current user have a token for this MCP server?" and no frontend code that references per-user tokens.

#### Issue 2b: No warning before prompting with unauthed MCPs

Users can send prompts to sessions with unauthed MCP servers attached. The agent receives no MCP tools for that server, but the user has no indication this will happen. They expect "Slack MCP is attached" to mean "the agent can use Slack."

#### Issue 2c: Session header OAuth click has no completion handler

`SessionPanelContent.tsx:128-158` starts the OAuth flow but never listens for `oauth:completed`. Even if the callback succeeds, the pill doesn't update until the next full data refresh (which happens when `mcp-servers` emits a `patched` event for shared mode — but in per-user mode, the server record isn't patched at all).

### Proposed Solutions

#### A) Per-user auth status endpoint

Add a new endpoint or extend the existing MCP servers response:

```
GET /mcp-servers?with_user_auth_status=true
```

Or a dedicated endpoint:

```
GET /mcp-servers/:id/auth-status → { authenticated: boolean, oauth_mode: 'per_user' | 'shared', expires_at?: string }
```

The UI would call this on load and after OAuth completion. The `needsAuth` check would incorporate per-user token status.

**Implementation location:**
- New service method in `apps/agor-daemon/src/services/mcp-servers.ts`
- Query `user_mcp_oauth_tokens` table for current user + server
- Return auth status alongside server data

#### B) Warning banner above prompt input

Inject a conditional `Alert` component in `SessionPanel.tsx` between line 578 (gradient overlay div) and line 584 (AutocompleteTextarea):

```tsx
{unauthedMcpServers.length > 0 && (
  <Alert
    type="warning"
    showIcon
    message={
      <>
        {unauthedMcpServers.map(s => s.display_name || s.name).join(', ')}
        {' '}not authenticated — invisible to the agent.{' '}
        <a onClick={() => /* trigger OAuth */}>Authenticate now</a>
      </>
    }
    style={{ marginBottom: 8 }}
  />
)}
```

**Data source:** Derive `unauthedMcpServers` from `sessionMcpServerIds` + `mcpServerById` + per-user auth status.

#### C) Pre-prompt OAuth gate

When user submits a prompt, check if any session MCPs need auth. If so, show a confirmation modal:

> "Slack MCP is not authenticated. The agent won't have access to Slack tools. Continue anyway or authenticate first?"

**Implementation:** In `SessionPanel.tsx` `handleSendPrompt()` (wherever that's defined), check auth status before dispatching.

**Recommendation:** Do B (warning banner) as the primary UX — it's non-blocking and always visible. Add C (pre-prompt gate) only for the first prompt in a session, to catch the most common case.

#### D) Fix MCP pill real-time updates

After OAuth completes (either via callback or paste):
1. Daemon should emit `mcp-servers` `patched` event (for shared mode, it already patches the record)
2. For per-user mode: emit a custom event like `mcp-servers:auth-status-changed` with `{ mcp_server_id, user_id, authenticated: true }`
3. UI should listen for this event and update the pill state

---

## 3. Channel Gateway + MCP Auth

### Current State

**Gateway session creation** — `apps/agor-daemon/src/services/gateway.ts:463-578`:

When a message comes in via Slack/Discord/GitHub:
1. Authenticate via `channel_key` (line 206-214)
2. Resolve user: alignment (Slack email → Agor user, GitHub login → Agor user) or channel's `agor_user_id` (lines 261-425)
3. Resolve agentic config: `channel.agentic_config` > `user.default_agentic_config` > system defaults (lines 430-438)
4. Create session via `sessionsService.create()` (line 497-525)
5. Send prompt via `/sessions/:id/prompt` (line 583+)

**Critical gap:** The gateway **does not attach MCP servers to created sessions**. Although `GatewayAgenticConfig` has `mcpServerIds?: string[]` (in `packages/core/src/types/gateway.ts:48`), the gateway's `create()` method never calls `setMCPServers()` or passes `mcpServerIds` to session creation. The `sessionsService.create()` method doesn't handle `mcpServerIds` — only `sessionsService.spawn()` does (line 386-396).

**So currently, gateway-created sessions have NO MCP servers attached**, even when the channel has `agentic_config.mcpServerIds` configured. This is a bug.

**Env var resolution** — `packages/core/src/config/env-resolver.ts:255-304`:
- `createUserProcessEnvironment(userId, db, additionalEnv, forImpersonation)`
- Builds allowlisted system env → merges user env vars from DB → merges `additionalEnv` (highest priority)
- Sets `AGOR_USER_ENV_KEYS` for MCP template scoping
- Used by executor when spawning agent processes

**MCP template resolution** — `packages/executor/src/sdk-handlers/base/mcp-scoping.ts:144-189`:
- Resolves `{{ user.env.VAR }}` templates in MCP server config using `process.env`
- Only exposes user-defined vars (scoped by `AGOR_USER_ENV_KEYS`)
- Servers with unresolved **required** templates are silently dropped (line 170-173)

### Issues Found

#### Issue 3a: MCP servers not attached to gateway sessions

`gateway.ts` calls `sessionsService.create()` without `mcpServerIds`. The `create()` method doesn't handle MCP attachment — that's only in `spawn()`. So gateway sessions get zero MCPs regardless of channel config.

**Fix:** After session creation in `gateway.ts` (around line 527), add MCP server attachment:

```typescript
// Attach MCP servers from channel agentic config
const mcpServerIds = agenticConfig?.mcpServerIds;
if (mcpServerIds && mcpServerIds.length > 0) {
  const sessionMcpService = this.app.service('session-mcp-servers');
  for (const serverId of mcpServerIds) {
    try {
      await sessionMcpService.create(
        { session_id: session.session_id, mcp_server_id: serverId },
        { provider: undefined } // internal call
      );
    } catch {
      console.warn(`[gateway] Failed to attach MCP server ${serverId}`);
    }
  }
}
```

Or refactor `sessionsService` to accept `mcpServerIds` in `create()`, not just `spawn()`.

#### Issue 3b: No system messages for unauthed MCPs in gateway sessions

When a gateway session has an MCP server attached but the resolved user hasn't authenticated, the agent silently has no access to those tools. The user (chatting via Slack) has no idea.

**Proposed solution — inject system context during session creation:**

In `gateway.ts`, after attaching MCP servers, check each server's auth status for the resolved user:

```typescript
// Check MCP auth status for resolved user
const unauthedMcps: string[] = [];
for (const serverId of mcpServerIds) {
  const server = await mcpServerRepo.findById(serverId);
  if (server?.auth?.type === 'oauth') {
    const oauthMode = server.auth.oauth_mode || 'per_user';
    let hasToken = false;
    if (oauthMode === 'shared') {
      hasToken = !!server.auth.oauth_access_token;
    } else {
      const userToken = await userTokenRepo.findToken(user.user_id, serverId);
      hasToken = !!userToken && !userToken.isExpired;
    }
    if (!hasToken) {
      unauthedMcps.push(server.display_name || server.name);
    }
  }
}
```

Then inject a system message into the session's `custom_context`:

```typescript
custom_context: {
  gateway_source: gatewaySource,
  mcp_auth_warnings: unauthedMcps.length > 0
    ? `The following MCP servers are not authenticated for user ${user.display_name}: ${unauthedMcps.join(', ')}. The agent will not have access to these tools.`
    : undefined,
}
```

The executor should include this in the system prompt or as a pre-prompt system message.

#### Issue 3c: No gateway-level env vars or service accounts

Currently there is **no mechanism** for gateway-level environment variables. The only env var sources are:
1. System allowlist (`env-resolver.ts:16-89`)
2. Per-user env vars from `users.data.env_vars` (line 277-285)
3. `additionalEnv` parameter (line 289-295) — not used by gateway

**Proposed design — env var inheritance chain:**

```
System (allowlist) → Gateway env vars → User env vars → Session env vars
```

Each layer overrides the previous. This means:

- **Gateway env vars** (new): Stored encrypted on `GatewayChannel`, applied to all sessions created via this gateway. Used for service account tokens (e.g., `SHORTCUT_API_TOKEN`).
- **User env vars** (existing): Per-user from `users.data.env_vars`. Applied when user alignment resolves a specific user.
- **Session env vars** (future): Per-session overrides, not implemented yet.

**Precedence decision needed:** Two reasonable options:

| | Option A: Gateway wins | Option B: User wins |
|---|---|---|
| **Behavior** | Gateway env var overrides user env var for same key | User env var overrides gateway env var for same key |
| **Use case** | Service account should be authoritative | Users should use their own tokens when available |
| **Risk** | Users can't use personal tokens | Service account unused when user has their own |

**Recommendation: Option B (user wins, gateway as fallback).** This gives users their own identity when available, with a service account fallback for users who haven't configured their own token. This aligns with the existing `per_user` / `shared` OAuth model.

**Implementation:**

1. Add `env_vars?: Record<string, string>` to `GatewayChannel` or `GatewayAgenticConfig`
2. Encrypt/decrypt like existing channel config fields (`gateway-channels.ts` already has encryption)
3. In gateway session creation, pass gateway env vars as `additionalEnv` to `createUserProcessEnvironment()` — but with **lower** priority than user vars (needs parameter reordering or a new merge strategy)
4. Update `createUserProcessEnvironment()` to accept a `gatewayEnv` parameter that slots between system and user:

```typescript
export async function createUserProcessEnvironment(
  userId?: UserID,
  db?: Database,
  additionalEnv?: Record<string, string>,
  forImpersonation = false,
  gatewayEnv?: Record<string, string>  // NEW: lower priority than user vars
): Promise<Record<string, string>> {
  const env = buildAllowlistedEnv();
  
  // Gateway env vars (low priority)
  if (gatewayEnv) {
    for (const [key, value] of Object.entries(gatewayEnv)) {
      if (value?.trim()) env[key] = value;
    }
  }
  
  // User env vars (medium priority — overrides gateway)
  if (userId && db) {
    const userEnv = await resolveUserEnvironment(userId, db);
    for (const [key, value] of Object.entries(userEnv)) {
      if (value?.trim()) env[key] = value;
    }
  }
  
  // Additional env vars (highest priority)
  if (additionalEnv) { /* ... */ }
  
  return env;
}
```

---

## 4. Gateway MCP Selection

### Current State

**Gateway channel configuration UI** — `apps/agor-ui/src/components/SettingsModal/GatewayChannelsTable.tsx`:
- MCP server selection uses `mcpServerIds` field (line 1095, 1172)
- Shows available MCP servers via `mcpServerById` Map (line 66, 153)
- Form field allows multi-select of MCP servers
- Channel edit form populates `mcpServerIds` from `channel.agentic_config?.mcpServerIds` (line 1172)

**Gateway type** — `packages/core/src/types/gateway.ts:43-52`:

```typescript
export interface GatewayAgenticConfig {
  agent: AgenticToolName;
  modelConfig?: ModelConfig;
  permissionMode?: PermissionMode;
  mcpServerIds?: string[];
  codexSandboxMode?: string;
  codexApprovalPolicy?: string;
  codexNetworkAccess?: string;
}
```

### Issues Found

#### Issue 4a: MCP server IDs stored but never applied

As noted in Section 3, `mcpServerIds` in `agentic_config` is stored but **never attached** to gateway-created sessions. The UI lets you select MCPs, but they have no effect.

#### Issue 4b: No distinction between "service account" and "per-user auth" MCPs

Gateway builders can select MCP servers that require OAuth, but there's no way to indicate:
- "This MCP should use a service account token (configured on the gateway)"
- "This MCP requires each user to authenticate individually"

All MCPs are treated the same, even though the auth requirements differ.

#### Issue 4c: No auth status feedback in gateway channel UI

The gateway config UI doesn't show whether selected MCP servers are authenticated. If a gateway builder selects "Shortcut MCP" but hasn't configured a service account token, there's no warning.

### Proposed Solutions

#### A) Fix MCP attachment (prerequisite)

See Issue 3a — this is the first thing to fix. Without it, none of the MCP-related gateway features work.

#### B) Gateway env vars UI

Add an "Environment Variables" section to the gateway channel edit form. This would show:
- Key/value pairs for service account tokens
- Indication of which MCP servers use templates referencing these vars
- Encryption at rest (same as existing channel config encryption)

#### C) MCP auth requirement indicators

In the gateway channel MCP selection UI, each selectable MCP server could show:
- Auth type badge: "OAuth (per-user)" / "OAuth (shared)" / "Token" / "None"
- Status: "Authenticated" / "Not configured" / "Requires user auth"
- For OAuth per-user MCPs: warning that each user will need to authenticate separately

#### D) Future: MCP auth mode override per gateway

Allow gateway builders to override the MCP server's default auth mode:
- "Use service account" → always use gateway-level env var token
- "Require per-user auth" → each aligned user must authenticate
- "Fallback" → use user token if available, fall back to service account

This is a more complex feature that builds on gateway env vars.

---

## 5. Implementation Plan

Ordered by dependency and impact:

### PR 1: Fix Gateway MCP Server Attachment (Bug Fix)

**Priority: Critical** — Without this, MCP servers configured on gateways do nothing.

**Files:**
- `apps/agor-daemon/src/services/gateway.ts` — After session creation (~line 527), attach MCP servers from `agenticConfig.mcpServerIds`
- `apps/agor-daemon/src/services/sessions.ts` — Consider adding `mcpServerIds` support to `create()` (not just `spawn()`)

**Scope:** Small, focused bug fix. ~30 lines of code.

### PR 2: Fix OAuth Paste Modal UX

**Priority: High** — This is the most visible UX issue.

**Files:**
- `apps/agor-ui/src/components/SettingsModal/MCPServersTable.tsx` — Replace immediate modal with timeout-based progressive disclosure
- Possibly add a small inline progress indicator component

**Scope:** Medium. UI changes only, no backend changes.

### PR 3: Fix Per-User Auth Status in MCP Pills

**Priority: High** — Pills show wrong state for `per_user` OAuth mode.

**Files:**
- `apps/agor-daemon/src/services/mcp-servers.ts` or new service — Add per-user auth status check
- `apps/agor-ui/src/components/SessionPanel/SessionPanelContent.tsx:117-118` — Update `needsAuth` logic
- `apps/agor-ui/src/hooks/useAgorData.ts` — Fetch per-user auth status

**Scope:** Medium. New API endpoint + UI update.

### PR 4: Fix Session Header OAuth Completion Handler

**Priority: High** — Clicking orange MCP pill starts OAuth but never updates on completion.

**Files:**
- `apps/agor-ui/src/components/SessionPanel/SessionPanelContent.tsx:128-158` — Add `oauth:completed` listener

**Scope:** Small. ~15 lines.

### PR 5: Add Warning Banner Above Prompt Input

**Priority: Medium** — Prevents users from wasting prompts on sessions with broken MCPs.

**Files:**
- `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx:~583` — Add conditional Alert
- Depends on PR 3 for accurate auth status

**Scope:** Small-medium. UI only.

### PR 6: Gateway MCP Auth System Messages

**Priority: Medium** — Gateway users need to know when MCPs are unavailable.

**Files:**
- `apps/agor-daemon/src/services/gateway.ts` — Check MCP auth status after session creation
- Inject `mcp_auth_warnings` into `custom_context`
- Executor needs to surface `custom_context.mcp_auth_warnings` in system prompt

**Scope:** Medium. Requires gateway + executor changes.

### PR 7: Gateway-Level Env Vars

**Priority: Medium-Low** — Enables service account pattern for gateway MCPs.

**Files:**
- `packages/core/src/types/gateway.ts` — Add `env_vars` to `GatewayAgenticConfig` or `GatewayChannel`
- `packages/core/src/db/repositories/gateway-channels.ts` — Encrypt/decrypt env vars
- `packages/core/src/config/env-resolver.ts` — Add `gatewayEnv` parameter
- `apps/agor-daemon/src/services/gateway.ts` — Pass gateway env vars to executor
- `apps/agor-ui/src/components/SettingsModal/GatewayChannelsTable.tsx` — Env vars form UI

**Scope:** Large. Cross-cutting change across core, daemon, executor, UI.

### PR 8: MCP Auth Indicators in Gateway Config UI

**Priority: Low** — Nice-to-have for gateway builders.

**Files:**
- `apps/agor-ui/src/components/SettingsModal/GatewayChannelsTable.tsx` — Auth badges on MCP server selection

**Scope:** Small. UI only.

---

## 6. Open Questions

### For Max

1. **Paste modal: remove or keep as fallback?**
   The paste modal exists for remote daemon scenarios where the OAuth callback redirect can't reach the daemon. Should we:
   - (a) Remove it entirely and require `AGOR_BASE_URL` to be reachable from the browser?
   - (b) Keep it but hide behind a "Having trouble? Paste callback URL" link after a timeout?
   - (c) Something else?

2. **Gateway env var precedence: user wins or gateway wins?**
   When both the gateway and the aligned user have the same env var key:
   - (a) User's value takes precedence (recommended — personal identity when available)
   - (b) Gateway's value takes precedence (service account is authoritative)

3. **Per-user OAuth in gateway context: is it useful?**
   With Slack user alignment, each aligned Agor user could have their own OAuth token. But:
   - Users can't easily authenticate from within Slack (no browser-based OAuth trigger)
   - Should gateway MCPs default to shared/service-account mode?
   - Or should we add a mechanism for gateway users to authenticate via a link sent in Slack?

4. **Should `sessionsService.create()` support `mcpServerIds`?**
   Currently only `spawn()` attaches MCPs. Should we:
   - (a) Add `mcpServerIds` to `create()` for consistency
   - (b) Keep gateway attachment as separate code after creation
   Option (a) is cleaner but changes the `create()` interface.

5. **Executor awareness of `custom_context.mcp_auth_warnings`?**
   How should gateway auth warnings reach the agent? Options:
   - (a) Inject as system message before the first prompt
   - (b) Include in `custom_context` and have the executor read it
   - (c) Add as a preamble to the user's first prompt text

6. **Scope of PR 1 (gateway MCP attachment)?**
   This is clearly a bug. Should it be hotfixed immediately on `main`, or bundled with the broader OAuth improvements?

---

## Appendix: Key File Reference

| Component | File | Key Lines |
|---|---|---|
| OAuth start endpoint | `apps/agor-daemon/src/index.ts` | 1828-1947 |
| OAuth callback handler | `apps/agor-daemon/src/index.ts` | 1230-1326 |
| OAuth complete endpoint | `apps/agor-daemon/src/index.ts` | 1954+ |
| Paste modal (Settings) | `apps/agor-ui/src/components/SettingsModal/MCPServersTable.tsx` | 885-940 (modal), 155-191 (trigger) |
| MCP pills (Session header) | `apps/agor-ui/src/components/SessionPanel/SessionPanelContent.tsx` | 113-166 |
| Prompt input area | `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx` | 579-613 |
| MCP data hook | `apps/agor-ui/src/hooks/useAgorData.ts` | 560-591 |
| Gateway session creation | `apps/agor-daemon/src/services/gateway.ts` | 463-578 |
| Gateway agentic config | `packages/core/src/types/gateway.ts` | 43-52 |
| Session MCP attachment | `apps/agor-daemon/src/services/sessions.ts` | 117-135 (setMCPServers), 386-396 (spawn) |
| Env var resolution | `packages/core/src/config/env-resolver.ts` | 255-304 |
| MCP template resolution | `packages/executor/src/sdk-handlers/base/mcp-scoping.ts` | 144-189 |
| Per-user OAuth tokens | `packages/core/src/db/repositories/user-mcp-oauth-tokens.ts` | 106-161 |
| OAuth flow core | `packages/core/src/tools/mcp/oauth-mcp-transport.ts` | 812-989 (start), 1002-1046 (complete) |
| MCP server types | `packages/core/src/types/mcp.ts` | 36-59 (MCPAuth), 122-165 (MCPServer) |
| Gateway channels UI | `apps/agor-ui/src/components/SettingsModal/GatewayChannelsTable.tsx` | 1095 (mcpServerIds save) |
| OAuth disconnect | `apps/agor-daemon/src/services/oauth-disconnect.ts` | 33-104 |
