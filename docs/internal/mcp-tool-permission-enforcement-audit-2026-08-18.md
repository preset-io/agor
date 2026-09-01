# MCP tool-permission enforcement: where it binds, and where it doesn't

**Date:** 2026-08-18
**Scope:** MANAGE-2 — "tool on/off toggles must be enforced at the layer that
brokers tool calls, not just hidden in the UI."
**Status:** superseded in part. The first revision concluded MANAGE-2 needed a
new MCP proxy and left it open on that basis. **That was wrong**, and a
fact-check caught it: three of six handlers already route every tool call back
through Agor. Enforcement has since been implemented on the two that were
withholding servers instead. The remaining gap is the write path, not the
enforcement path. Corrections are kept inline rather than deleted, because the
first revision's claims were repeated onward as fact.

## The one-sentence finding

Enforcement now binds on five of six handlers — but **no user-facing path ever
writes `tool_permissions`**, so for every server anyone connects from the
marketplace the map is empty and every tool is allowed. The
`permission_disclosure` a user acknowledges before connecting is still
unenforced — not because enforcement is missing, but because nothing populates
the field it reads. Everything else in this note is about making sure that when
something finally does populate it, the value binds.

That distinction matters for what to build next, so the rest of this note
separates the two halves.

## 1. There is no proxy, but there IS a call-time choke point on most handlers

**Correction.** The first revision said "Agor is never in the data path" and
called Claude "the one partial exception". Both were wrong, and the error
mattered: it priced MANAGE-2 as "stand up a per-session MCP proxy" and left the
requirement open on that basis.

Agor is not in the _data_ path — the agent process opens the MCP connection and
the bytes never pass through Agor. But it is in the _decision_ path on four of
six handlers, because their SDKs call back into the executor before a tool
runs. That is all enforcement needs. The table below is the handoff, not the
decision:

| Handler  | MCP servers reach the runtime as                                |
| -------- | --------------------------------------------------------------- |
| Claude   | `queryOptions.mcpServers` (`claude/query-builder.ts:541`)       |
| Codex    | `--config mcp_servers.<name>.*` (`codex/prompt-service.ts:664`) |
| Gemini   | `MCPServerConfig` (`gemini/prompt-service.ts:779`)              |
| Copilot  | `mcpServers` config object (`copilot/prompt-service.ts:209`)    |
| Cursor   | `mcpServers` config object (`handlers/sdk/cursor.ts:247`)       |
| OpenCode | resolved server list (`handlers/sdk/opencode.ts:97`)            |

Where a call-time decision is available:

| Handler  | Call-time hook                                     | Carries enough to identify the tool?                 |
| -------- | -------------------------------------------------- | ---------------------------------------------------- |
| Claude   | `PreToolUse` + `canUseTool`                        | Yes — `mcp__<server>__<tool>`                        |
| OpenCode | `createPermissionCallback` → the same `canUseTool` | Yes — permission type IS the tool key                |
| Copilot  | `onPermissionRequest`                              | Yes — `serverName` and `toolName` as separate fields |
| Codex    | none (headless; `disabled_tools` only)             | n/a                                                  |
| Gemini   | none (headless; `excludeTools` only)               | n/a                                                  |
| Cursor   | none                                               | n/a                                                  |

Only **Cursor** is genuinely hookless. And Agor already points an agent at its
own HTTP endpoint for the built-in `agor` server (`query-builder.ts:400-410`),
so even the proxy precedent exists in-tree.

Building a full proxy would still be a large change. It is also unnecessary:
per-call enforcement on the hooks above is equally binding and costs nothing at
the transport layer.

## 2. What `tool_permissions` does today — per handler

Enforcement is expressed per handler, and the capability is declared at the
resolution boundary rather than assumed. `HandlerPermissionCapabilities`
(`core/src/mcp/tool-permissions.ts:41`) has each caller state whether it can drop
a named tool (`exclude`) or has no per-tool control (`none`).

| Handler  | Declares                              | What actually happens                                                                                                                         |
| -------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `exclude` (`query-builder.ts:444`)    | Three layers: `disallowedTools` (`:558`), a `PreToolUse` hook (`:575`), and `canUseTool` (`base/permission-hooks.ts:73`). Genuinely enforced. |
| Codex    | `exclude` (`prompt-service.ts:673`)   | `disabled_tools` (`:105`), applied on both the stdio and HTTP branches. Genuinely enforced.                                                   |
| Gemini   | `exclude` (`prompt-service.ts:756`)   | `excludeTools` on all three transports (`:779`, `:788`, `:796`). Genuinely enforced.                                                          |
| Copilot  | `intercept` (`prompt-service.ts:202`) | Refused at call time in `permission-mapper.ts`, ahead of every mode shortcut. **Changed in this PR** (was `none`/withheld).                   |
| OpenCode | `intercept` (`opencode.ts:113`)       | Refused at call time in `applyPermissionEffect`. **Changed in this PR** (was `none`/withheld).                                                |
| Cursor   | `none` (`cursor.ts:232`)              | Server withheld whole. Genuinely the only option — no hook of any kind.                                                                       |

Withholding still happens in one place — `core/src/mcp/scoping.ts:297-307` —
and is still correct for Cursor. But it is a last resort, not the goal: a
withheld server costs the user the whole integration to enforce one tool. Where
a call-time hook exists, `intercept` gives them the server _and_ the
restriction.

`intercept` carries an obligation the type cannot express: the check must run
BEFORE any permission-mode shortcut. Both handlers that claim it have one
(`bypassPermissions` / `allow-all` / `yolo`) that auto-approves without ever
consulting Agor, so a gate placed after it would be skipped in exactly the
modes where nothing else is watching. Both are tested for that specifically.

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

### Correction: there never was an OpenCode "fail-closed throw"

An earlier revision described a deliberate throw guarding `tool_permissions` on
OpenCode. **No such throw ever existed.** Gated servers were dropped by
`scoping.ts`, exactly like Copilot and Cursor. The throws in `opencode-tool.ts`
cover a missing dependency, malformed or unauthenticated config, and a failed
permission round-trip; none is about `tool_permissions`.

The claim was inherited from the task framing and restated without checking. It
is recorded rather than deleted because it was repeated onward as fact.

### What OpenCode actually does, established from the shipped binary

Worth writing down, because the naive fix here would have been worse than
nothing:

- OpenCode composes MCP tool keys as `CP(server) + "_" + CP(tool)`, where
  `CP = s => s.replace(/[^a-zA-Z0-9_-]/g, "_")` — a **single** underscore.
- The tool-execute path calls `ask({permission: <that key>})`, so the
  permission _type_ is the tool key. This is why the `'*': 'ask'` rule Agor
  installs does reach MCP tools; OpenCode's own default ruleset uses the same
  wildcard key, which had been assumed rather than verified.
- Agor mints the server half itself when registering the server, so the whole
  key is determined on our side. Nothing needs parsing back out.

The shared index is keyed `mcp__server__tool`. Passing it to OpenCode — the
obvious reading of "pass the real index" — would have matched **nothing**, and
a miss reads as unconfigured, i.e. allow. So OpenCode gets a flat exact-match
map built from the same helper that mints the config key, and the shared index
is left empty with a comment saying why.

### A live fail-open found and fixed: `claude.ai ` connector names

The Claude CLI sanitizes a server name as Agor does, then — only for names
beginning `claude.ai ` — squeezes runs of underscores and trims them:

```js
let t = e.replace(/[^a-zA-Z0-9_-]/g, '_');
if (e.startsWith('claude.ai ')) t = t.replace(/_+/g, '_').replace(/^_|_$/g, '');
```

Agor did not model that. For a connector called `claude.ai Gmail (Beta)` it
emitted `mcp__claude_ai_Gmail__Beta___delete_email` while the CLI presents
`mcp__claude_ai_Gmail_Beta__delete_email`. The rule matched nothing, so **a
deny on a claude.ai connector silently did nothing.** Same root cause: the CLI
resolves a namespaced name by `split("__")` taking the first segment as the
server, so any alias containing `__` fragments and is unaddressable.

Fixed by emitting a collapsed alias. This was the single most dangerous thing
found, and it was on the handler that otherwise looked strongest.

## 3. The actual gap: nothing writes `tool_permissions`

Searched every write path. The wire is open — `tool_permissions` is part of
`UpdateMCPServerInput`, the Feathers service patches with that type, and the
repository spreads it through with no field allowlist, so **any user authorised
to edit the server can set it over REST or socket today**. What is missing is
anything that _offers_ to.

The only caller that does is:

- `apps/agor-daemon/src/mcp/tools/mcp-servers.ts:871` — the
  `agor_mcp_servers_update` MCP admin tool, i.e. an agent calling Agor's own API.

That the transport already works is good news for §5: the remaining gap is a
form control, not a new API.

And specifically **not**:

- **The catalog.** `mcp-catalog-connect.ts` never sets `tool_permissions`. A
  server installed from the marketplace gets an empty map.
- **The UI.** There is no reference to `tool_permissions` anywhere in
  `apps/agor-ui/src`. No per-tool toggles exist. (The one `Switch` in the MCP
  form is the server-level `enabled` flag.)

Consequences, stated plainly:

1. For all 48 marketplace entries, `tool_permissions` is empty, so
   `canEnforceMcpToolPermissions` returns `true` trivially, nothing is withheld,
   nothing is excluded, and **every tool the server exposes is callable** —
   including the destructive ones the disclosure describes.
2. The disclosure is therefore prose the user acknowledges and nothing acts on.
   It is accurate about what the server _can_ do; it is not a control.
3. The real narrowings available today are `mcp_member_policy`, `owner_user_id`
   privacy, and the per-session attachment `enabled` flag. None is per-tool.
   (`others_can` is branch RBAC and is not consulted anywhere on the MCP paths;
   an earlier revision listed it here in error.)

## 4. What was changed in this PR, and what wasn't

**Enforcement, on the two handlers that were withholding servers.** Copilot and
OpenCode moved from `toolFiltering: 'none'` to a new `intercept` capability and
now refuse a denied tool at call time. A gated server is no longer withheld
from either, so users get the server _and_ the restriction rather than neither.
Both gates run ahead of the permission-mode shortcut that would otherwise
auto-approve without consulting Agor.

**A live fail-open on Claude**, described above: `claude.ai ` connector names
produced `disallowedTools` rules that could never match.

**A pin that did not pin.** `gemini/mcp-server-config.test.ts` declared its own
mirror of the SDK constructor and asserted the builder agreed with _that_, so
it passed under all three mutations that matter — a parameter inserted before
`excludeTools`, the field renamed, the field removed. Its header also claimed
`tsc` covered arity and position; it does not, because the constructor is typed
`new (...args: never[]) => T` and cast to `unknown[]`. The consequence fails
open: slot 13 is `includeTools`, an allowlist, so an inserted parameter turns
Agor's deny list into "permit only the tools the user switched off". Now read
from the SDK's shipped `config.d.ts`. Mutation-verified both ways; the old test
passed the SDK-side mutation 3/3 while the new one fails it 4/4.

**Test coverage for enforcement that had none.** Codex's `disabled_tools` (the
suite stubs `buildMcpServersConfig` out everywhere else), and the case where a
server's permissions are all `allow` — a gate keyed on "has any
`tool_permissions`" would withhold every permission-bearing server from the
handlers that cannot filter and still pass every other test.

**A leak found by the new tests:** OpenCode's permission map was reaching
`OPENCODE_CONFIG_CONTENT`, which the OpenCode process parses. Stripped.

**Not changed, deliberately:**

- **No per-tool UI toggles**, and no catalog seeding. Both run through
  `mcp-catalog-connect.ts`, owned by other in-flight work. Flagged, not edited.
- **Cursor stays withheld-whole.** It has no hook of any kind; withholding is
  genuinely the only option there.

## 5. What it would take to close the real gap

Roughly in order of value:

1. **A write path.** Per-tool toggles in the MCP server drawer, persisting to
   `tool_permissions`. This is now the _whole_ remaining gap, and it binds
   immediately on five of six handlers. The wire already works (§3), so this is
   a form control rather than a new API. The one caveat left to surface in that
   UI: switching a tool off on a **Cursor** session withholds the entire server
   rather than one tool.
2. **A tool inventory to toggle against.** `server.tools` is a cached discovery
   snapshot that nothing proves is current — `tool-permissions.ts:44-51` refuses
   to enforce from it for exactly that reason. A UI can offer it as a picker
   (with free-text fallback), but a _default-deny_ posture would need a
   refresh-on-connect guarantee that does not exist yet.
3. **Catalog-seeded defaults.** `permission_disclosure` is prose, not a tool
   list, so it cannot be mechanically turned into permissions. Making the
   disclosure enforceable would mean adding a structured field to
   `curated.yaml` — e.g. `default_denied_tools` — and seeding from it at connect
   time. That is a curation cost across every catalog entry and a change to the
   connect path; worth it only if the product intends the disclosure to be a
   contract rather than a description.

Until at least (1) lands, the disclosure remains a description of what a
connected server may do, and the enforcement machinery stays a correct engine
with nothing feeding it.
