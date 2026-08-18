# MCP tool-permission enforcement: where it binds, and where it doesn't

**Date:** 2026-08-18
**Scope:** MANAGE-2 — "tool on/off toggles must be enforced at the layer that
brokers tool calls, not just hidden in the UI."
**Status:** audit. One test gap closed (Codex); the headline gap is left open
deliberately, and named below.

## The one-sentence finding

The enforcement machinery is real, per-handler, and fail-closed — but **no
user-facing path ever writes `tool_permissions`**, so for every server anyone
connects from the marketplace the map is empty and every tool is allowed. The
`permission_disclosure` a user acknowledges before connecting is, today,
unenforced — not because enforcement is missing, but because nothing populates
the field it reads.

That distinction matters for what to build next, so the rest of this note
separates the two halves.

## 1. There is no gateway, and there cannot easily be one

There is no choke point. Each handler writes the MCP server into the config it
hands its own agent runtime, and the agent process opens the MCP connection
itself. Agor is never in the data path of a tool call:

| Handler  | MCP servers reach the runtime as                                |
| -------- | --------------------------------------------------------------- |
| Claude   | `queryOptions.mcpServers` (`claude/query-builder.ts:541`)       |
| Codex    | `--config mcp_servers.<name>.*` (`codex/prompt-service.ts:664`) |
| Gemini   | `MCPServerConfig` (`gemini/prompt-service.ts:779`)              |
| Copilot  | `mcpServers` config object (`copilot/prompt-service.ts:209`)    |
| Cursor   | `mcpServers` config object (`handlers/sdk/cursor.ts:247`)       |
| OpenCode | resolved server list (`handlers/sdk/opencode.ts:97`)            |

So "enforce at the gateway" has no addressee. Building one would mean Agor
standing up an MCP proxy per session, re-terminating each server's transport and
auth, and pointing every handler at itself — a large change that also puts Agor
in the path of every tool call's latency and failure modes.

**The one partial exception is Claude**, and it is worth being precise about why:
its SDK invokes JS callbacks back into the executor process, so Agor gets a
`PreToolUse` hook and `canUseTool` and can refuse a call at runtime. That is
interception, not proxying — the bytes still flow directly — but it is the only
handler where Agor can decide about a call it did not pre-declare.

## 2. What `tool_permissions` does today — per handler

Enforcement is expressed per handler, and the capability is declared at the
resolution boundary rather than assumed. `HandlerPermissionCapabilities`
(`core/src/mcp/tool-permissions.ts:41`) has each caller state whether it can drop
a named tool (`exclude`) or has no per-tool control (`none`).

| Handler  | Declares                            | What actually happens                                                                                                                         |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `exclude` (`query-builder.ts:444`)  | Three layers: `disallowedTools` (`:558`), a `PreToolUse` hook (`:575`), and `canUseTool` (`base/permission-hooks.ts:73`). Genuinely enforced. |
| Codex    | `exclude` (`prompt-service.ts:673`) | `disabled_tools` (`:105`), applied on both the stdio and HTTP branches. Genuinely enforced.                                                   |
| Gemini   | `exclude` (`prompt-service.ts:756`) | `excludeTools` on all three transports (`:779`, `:788`, `:796`). Genuinely enforced.                                                          |
| Copilot  | `none` (`prompt-service.ts:194`)    | Server withheld whole.                                                                                                                        |
| Cursor   | `none` (`cursor.ts:232`)            | Server withheld whole.                                                                                                                        |
| OpenCode | `none` (`opencode.ts:110`)          | Server withheld whole.                                                                                                                        |

Withholding happens in one place — `core/src/mcp/scoping.ts:297-307` — which
drops any server whose `deny`/`ask` entries the handler cannot honour, and
reports it to the user rather than letting it vanish silently. This is the
established fail-closed pattern and it is correct: attaching the server anyway
would hand over exactly the tools someone switched off.

Three details worth recording, because each is a place this could have been fake
and isn't:

- **The SDK keys are real.** Gemini's `excludeTools` is the 14th positional
  constructor argument and lands on the right field (pinned by
  `gemini/mcp-server-config.test.ts`). Codex's `disabled_tools` appears in the
  shipped `codex` binary. Neither is an invented key that would no-op.
- **`ask` fails closed where nobody can be asked.** Codex and Gemini are
  headless, and Claude under `bypassPermissions` or with no task to attribute a
  request to has no channel either; in all three cases `ask` collapses onto
  `deny` rather than degrading to `allow`
  (`PERMISSIONS_BLOCKED_WITHOUT_PROMPT`, `tool-permissions.ts:31`).
- **Codex auto-approves everything else.** Every Codex server config carries
  `default_tools_approval_mode: "approve"`, so `disabled_tools` is the _only_
  thing between the model and a switched-off tool there. There is no prompt to
  fall back on and no `canUseTool` equivalent.

### OpenCode's throw is deliberate — leave it

OpenCode's declarative config _is_ its enforcement boundary; there is no
call-time hook to fall back on. The fail-closed throw is what keeps a `deny`
meaningful there, and it should not be relaxed to make anything else easier.

## 3. The actual gap: nothing writes `tool_permissions`

Searched every write path. The field has exactly one writer:

- `apps/agor-daemon/src/mcp/tools/mcp-servers.ts:871` — the
  `agor_mcp_servers_update` MCP admin tool, i.e. an agent calling Agor's own API.

And specifically **not**:

- **The catalog.** `mcp-catalog-connect.ts` never sets `tool_permissions`. A
  server installed from the marketplace gets an empty map.
- **The UI.** There is no reference to `tool_permissions` anywhere in
  `apps/agor-ui/src`. No per-tool toggles exist. (The one `Switch` in the MCP
  form is the server-level `enabled` flag.)

Consequences, stated plainly:

1. For all 47 marketplace entries, `tool_permissions` is empty, so
   `canEnforceMcpToolPermissions` returns `true` trivially, nothing is withheld,
   nothing is excluded, and **every tool the server exposes is callable** —
   including the destructive ones the disclosure describes.
2. The disclosure is therefore prose the user acknowledges and nothing acts on.
   It is accurate about what the server _can_ do; it is not a control.
3. `others_can`, OAuth scope, and server-level `enabled` are the only real
   narrowing available today. None of them is per-tool.

## 4. What was changed in this PR, and what wasn't

**Changed:** Codex's enforcement had no test. Every other case in
`codex/prompt-service.test.ts` stubs `buildMcpServersConfig` out, so
`disabled_tools` was never driven. Added coverage that runs the real builder per
transport and asserts the denied tool is filtered while an allowed one survives.

Mutation-verified: deleting `applyMcpToolPermissions` from the HTTP branch alone
fails the three remote-transport cases and leaves stdio green. That is the
realistic regression — the catalog is remote endpoints, so an omission there
would carry nearly every marketplace server while looking covered.

**Not changed, deliberately:**

- No per-tool UI toggles. Enforcement exists, so a toggle would now bind — but
  the write path runs through catalog connect, which is owned by other in-flight
  work. Flagging rather than editing.
- No seeding of `tool_permissions` from catalog `permission_disclosure`. Same
  reason, plus a design question below.
- No weakening of OpenCode's throw.

## 5. What it would take to close the real gap

Roughly in order of value:

1. **A write path.** Per-tool toggles in the MCP server drawer, persisting to
   `tool_permissions`. This is the whole gap for users who want to narrow a
   server by hand, and it binds immediately on Claude/Codex/Gemini. The honest
   caveat to surface in that UI: switching a tool off on a Copilot/Cursor/
   OpenCode session withholds the entire server rather than one tool.
2. **A tool inventory to toggle against.** `server.tools` is a cached discovery
   snapshot that nothing proves is current — `tool-permissions.ts:44-51` refuses
   to enforce from it for exactly that reason. A UI can offer it as a picker
   (with free-text fallback), but a _default-deny_ posture would need a
   refresh-on-connect guarantee that does not exist yet.
3. **Catalog-seeded defaults.** `permission_disclosure` is prose, not a tool
   list, so it cannot be mechanically turned into permissions. Making the
   disclosure enforceable would mean adding a structured field to
   `curated.yaml` — e.g. `default_denied_tools` — and seeding from it at connect
   time. That is a curation cost across 47 entries and a change to the connect
   path; worth it only if the product intends the disclosure to be a contract
   rather than a description.

Until at least (1) lands, the disclosure remains a description of what a
connected server may do, and the enforcement machinery stays a correct engine
with nothing feeding it.
