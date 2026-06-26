# PLAN: Wire `ultracode` Boolean Through Agor

**Branch:** `wire-ultracode-setting`  
**Phase:** A — investigation complete, awaiting Joegor approval for Phase B (implementation)

---

## 1. What ultracode is (SDK definition, verified)

From `@anthropic-ai/claude-agent-sdk@0.3.183` (`sdk.d.ts` line 5779–5781):

```typescript
// Settings interface
effortLevel?: 'low' | 'medium' | 'high' | 'xhigh';
/** Enable ultracode for the session: xhigh effort plus standing dynamic-workflow
 *  orchestration. Session-scoped — typically provided via --settings or the
 *  apply_flag_settings control request; interactive toggles never persist it.
 *  Requires workflows to be enabled and an xhigh-capable model. */
ultracode?: boolean;
```

`ultracode` lives on the SDK's `Settings` interface (not `Options`). The two delivery paths
the SDK itself documents are: `--settings <file>` and `applyFlagSettings()` control request.

---

## 2. advisorModel Touch-Point Map → ultracode change list

File order matches the data-flow path: canonical types → resolver → DB schema → daemon layer
(MCP tools, CLI integration) → executor → UI.

### Layer 1 — Canonical types

| File | Line(s) | What changes |
|---|---|---|
| `packages/core/src/types/session.ts` | 260, 258-266 | Add `ultracode?: boolean` to `Session['model_config']` inline shape |
| `packages/core/src/types/session.ts` | 716-718 | Same for `DefaultModelConfig` / user-pref shape |
| `packages/core/src/types/user.ts` | 96 | Add `ultracode?: boolean` to user model-config pref shape |

### Layer 2 — Resolver (`resolve-config.ts`)

| File | Line(s) | What changes |
|---|---|---|
| `packages/core/src/models/resolve-config.ts` | 38 | `ModelConfigInput` — add `ultracode?: boolean` |
| `packages/core/src/models/resolve-config.ts` | 70 | `resolveModelConfig` spread — add `...(input.ultracode !== undefined && { ultracode: input.ultracode })` |
| `packages/core/src/models/resolve-config.ts` | 125–126 | `getModelLessFallbackOverrides` — add `if (input?.ultracode !== undefined) overrides.ultracode = input.ultracode` |

### Layer 3 — DB schema (inline JSON type annotations)

| File | Line(s) | What changes |
|---|---|---|
| `packages/core/src/db/schema.sqlite.ts` | 1001, 1011 | Add `ultracode?: boolean` to both inline `model_config` JSON shapes |
| `packages/core/src/db/schema.postgres.ts` | 979, 989 | Same |

### Layer 4 — Subsession template

| File | Line(s) | What changes |
|---|---|---|
| `packages/core/src/templates/spawn-subsession-template.ts` | 26 | Add `ultracode?: boolean` to template context type |
| `packages/core/src/templates/spawn-subsession-template.ts` | 63–65, 117–118, 161–162 | Add `{{#if modelConfig.ultracode}}…{{/if}}` blocks alongside existing `advisorModel` blocks |

### Layer 5 — Daemon MCP tools (Zod schemas)

| File | Line(s) | What changes |
|---|---|---|
| `apps/agor-daemon/src/mcp/tools/sessions.ts` | 84–104 | Add `ultracode: z.boolean().optional().describe('...')` to `modelConfigObjectSchema` |
| `apps/agor-daemon/src/mcp/tools/sessions.ts` | 116 | Update description string to mention `ultracode` |
| `apps/agor-daemon/src/mcp/tools/schedules.ts` | 38–45 | Mirror sessions.ts: add `ultracode` optional boolean field |

### Layer 6 — Daemon CLI integration (claude-code-cli path)

| File | Line(s) | What changes |
|---|---|---|
| `packages/core/src/claude-cli/spawn-config.ts` | 98 | Add `ultracode?: boolean` to `ClaudeCliSpawnConfig` |
| `packages/core/src/claude-cli/spawn-config.ts` | 207–215 | Add settings-file block (see §3 below for mechanism detail) |
| `apps/agor-daemon/src/services/claude-cli-integration.ts` | 1038 | Add `ultracode: session.model_config?.ultracode` to the config object |

### Layer 7 — Executor (claude-code SDK path)

| File | Line(s) | What changes |
|---|---|---|
| `packages/executor/src/sdk-handlers/claude/query-builder.ts` | 337–344 | Add ultracode delivery block (see §3 below for mechanism) |
| `packages/executor/src/sdk-handlers/claude/query-builder.ts` | 145–156 | `InterruptibleQuery` interface — no change needed (settings file approach) |

### Layer 8 — UI

| File | Line(s) | What changes |
|---|---|---|
| `apps/agor-ui/src/components/ModelSelector/ModelSelector.tsx` | 22–29 | Add `ultracode?: boolean` to local `ModelConfig` interface |
| `apps/agor-ui/src/components/ModelSelector/ModelSelector.tsx` | 332–341 | Add `handleUltracodeChange` handler (checkbox, not select) |
| `apps/agor-ui/src/components/ModelSelector/ModelSelector.tsx` | 369–391 | Add `<Checkbox>` inside the `claude-code`/`claude-code-cli` guard block |
| `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx` | 793–797 | Add ultracode clear/set logic alongside advisorModel |
| `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx` | 823–830 | Include `ultracode` in the `modelConfig` object passed to `ModelSelector` |

---

## 3. Delivery Mechanism — The Hard Problem

### Why `settings: Settings` (inline object) is ruled out

`query()` accepts `options.settings?: string | Settings`.  
When it's a `Settings` **object**, the Agent SDK emits `--settings '<inline JSON>'` to the Claude
CLI subprocess. The Claude CLI materializes this into a **content-addressed** temp file:
`${os.tmpdir()}/claude-settings-<sha-of-content>.json`

In the daemon's process, `os.tmpdir()` resolves to the shared, sticky-bit `/tmp`. Any two
sessions whose ultracode-only settings JSON hashes identically will race for the same file path.
The first writer owns it mode `0600`; later sessions (or other Unix users in `insulated`/`strict`
mode) hit `EACCES … claude-settings-*.json` and crash before the first message. This is exactly
the collision documented at `query-builder.ts:322–336`.

### Why `applyFlagSettings` (control request) is NOT the primary choice

`applyFlagSettings` is documented as "applies mid-session" and is the sibling to the `settings`
object path. It is available on the `Query` object returned by `query()` in streaming-input mode
(which Agor already uses — the `asUserMessageIterable` wrapper at `query-builder.ts:693–700`).

The concern: the SDK docs say `ultracode` is "session-scoped — typically provided via --settings
**or** the apply_flag_settings control request", and `applyFlagSettings` is described as
"equivalent to the inline settings option of query(), but applies mid-session." The phrase
"mid-session" is ambiguous — it may mean "applied to the next turn forward" rather than "applied
before the first turn." If ultracode missed the first turn, session behavior would be inconsistent.

`applyFlagSettings` is a valid path for **mid-session toggle** (if Joegor ever wants that), but
not the recommended path for initial session setup.

### Recommended delivery: unique per-session settings file (Option A) ✅

Both the SDK path (`query-builder.ts`) and the CLI path (`spawn-config.ts`) can pass
`--settings <path>` where the path contains the session UUID, making it globally unique and
collision-free.

**Mechanism for the SDK path (`query-builder.ts`):**

```typescript
// In setupQuery(), after effort is configured (around line 320):
if (session.model_config?.ultracode) {
  const settingsDir = path.join(os.homedir(), '.agor', 'session-flags');
  await fs.mkdir(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, `${sessionId}.json`);
  await fs.writeFile(settingsPath, JSON.stringify({ ultracode: true }), { mode: 0o600 });
  queryOptions.settings = settingsPath;
  console.log(`⚡ ultracode: true (settings file: ${settingsPath})`);
  // Cleanup: delete the file after the query generator is exhausted.
  // The caller (executor) already tears down after the session ends;
  // cleanup hook can use a try/finally around the query iteration.
}
```

The path `~/.agor/session-flags/<session-id>.json` uses the Agor session UUID (not a content
hash), so two sessions with identical settings write to DIFFERENT files. No collision.

**Mechanism for the CLI path (`spawn-config.ts`):**

```typescript
// In buildClaudeCliSpawn(), after the --advisor block:
if (cfg.ultracode) {
  // Write unique settings file for this spawn. Path uses session ID embedded
  // in cfg (add settingsDir as a config field, or derive from mcpConfigPath dir).
  args.push('--settings', cfg.ultracocdeSettingsPath); 
  // Caller writes the file before calling buildClaudeCliSpawn and is
  // responsible for cleanup.
}
```

The `ClaudeCliSpawnConfig` would gain `ultracode?: boolean` and the caller (in
`claude-cli-integration.ts`) would handle writing/cleanup, mirroring how `mcpConfigPath` is
managed today (the CLI integration already writes a temp MCP config file per session at line
1040).

**Evidence the `settings: string` path works without collision:**
- `Options.settings: string` passes `--settings <path>` literally to the CLI
- The path is set by us (not content-addressed), so we control uniqueness
- SDK docs confirm it: "Accepts either a path to a settings JSON file or a settings object"
  (sdk.d.ts line 1771–1787)

---

## 4. Compatibility Guards

### Guard A — Wrong agentic_tool

`ultracode` is a Claude Code SDK setting. It is meaningless (and potentially harmful) for
`codex`, `gemini`, `opencode`, `copilot`, `cursor`.

**Plan:** Validate at session-create in the daemon:
- If `model_config.ultracode === true` and `agentic_tool !== 'claude-code'`: reject with
  `BadRequest("ultracode is only valid for claude-code sessions")`
- `claude-code-cli` is a sub-case of claude-code and should also allow it (the CLI also
  supports `--settings`)

**Where to add:** In the session creation service, alongside any existing model_config
normalization. The Zod schema (`modelConfigObjectSchema` in `sessions.ts`) can add a
`.refine()` at the handler level, or it can be a plain `if` check in the handler body.

### Guard B — Workflows disabled

The SDK requires workflows to be enabled. Agor doesn't explicitly disable workflows, but
the user's environment may have `CLAUDE_CODE_DISABLE_WORKFLOWS=1`.

**Plan:** Log a startup warning (not a hard error — we don't own the user's environment):
```typescript
if (session.model_config?.ultracode && process.env.CLAUDE_CODE_DISABLE_WORKFLOWS) {
  console.warn('⚠️  ultracode is set but CLAUDE_CODE_DISABLE_WORKFLOWS is set — ultracode will have no effect');
}
```

This is a no-op guard, not a rejection. The SDK will just ignore ultracode if workflows are
disabled. We surface the warning to logs; Joegor can decide whether it should bubble to the
UI or task error.

### Guard C — Model capability

The SDK says ultracode "requires … an xhigh-capable model." All current `claude-code` models
(Opus 4.x, Sonnet 4.x, Haiku 4.5) support xhigh. There is no SDK-level capability query
available to validate this at session-create time, so Agor cannot pre-validate.

**Plan:** No hard guard for now — if an incapable model is used, the SDK/CLI will emit an
error that surfaces through the normal stderr path. Joegor can decide whether to add a
model-allowlist guard in a follow-up.

### Guard D — Effort level interaction

`ultracode` internally sets xhigh effort. If `session.model_config.effort` is also set to
something lower (e.g., `'medium'`), the SDK's own ultracode logic overrides it. We do NOT
need to enforce effort=xhigh in Agor; the SDK handles this.

However, the UI should ideally reflect that enabling ultracode implies xhigh effort. Whether
to auto-set effort or just show a tooltip is a **Joegor decision** (Open Question #3 below).

---

## 5. What is NOT in this plan (deliberate exclusions)

- **`effortLevel` (Settings field) vs `effort` (Options field):** The SDK has both an
  `Options.effort` field (top-level query option, used by Agor today) AND a
  `Settings.effortLevel` field (in the settings file/flag layer). Ultracode internals use the
  settings layer. Agor continues to use `Options.effort` for standalone effort control; no
  change needed there.
- **Persist ultracode across sessions:** The SDK docs say "interactive toggles never persist
  it." Agor persists it in `model_config` like any other session config, which is intentional
  (the user explicitly set it in Agor, not interactively in the CLI).
- **`model_config` vs a new `session_flags` field:** ultracode belongs on `model_config` as a
  sibling to `advisorModel` (same delivery layer, same Claude-only scope). If Joegor prefers
  a different location, see Open Question #1.

---

## 6. Test Plan

### Unit tests

1. **`resolve-config.test.ts`** — mirror existing `advisorModel` tests:
   - `resolveModelConfig({ model: 'x', ultracode: true })` includes `ultracode: true`
   - `resolveModelConfig({ model: 'x' })` does NOT include `ultracode` key
   - `resolveModelConfigWithFallback`: ultracode from higher-priority source is preserved;
     lower-priority source's ultracode is not carried when higher source provides model

2. **`query-builder.test.ts`** — mirror existing `advisorModel` tests:
   - When `session.model_config.ultracode = true`: `queryOptions.settings` is a string path
     (not an object), the path contains the session ID, and the file exists with
     `{ ultracode: true }`
   - When `session.model_config.ultracode` is falsy: `queryOptions.settings` is NOT set
   - No collision: two sessions with `ultracode: true` write to DIFFERENT paths

3. **`spawn-config.test.ts`** — mirror `advisorModel` tests:
   - `buildClaudeCliSpawn({ ultracode: true, ultracocdeSettingsPath: '/path' })` includes
     `--settings /path` in args
   - `buildClaudeCliSpawn({})` does NOT include `--settings`

### Integration / e2e

4. Create a claude-code session via MCP with `modelConfig: { model: 'claude-opus-4-6', ultracode: true }`.
   Verify `session.model_config.ultracode === true` in the DB.

5. Verify the settings file is written and cleaned up (check `~/.agor/session-flags/` before
   and after a session run).

6. Verify Guard A: creating a session with `modelConfig: { model: 'gpt-4o', ultracode: true }`
   on a `codex` session returns a `BadRequest`.

---

## 7. Open Questions for Joegor

**Q1 — Field location:** Should `ultracode` live on `model_config` (the advisorModel precedent) or
should it live as a standalone `session.ultracode` boolean outside `model_config`? Arguments
for standalone: ultracode isn't strictly "model config" — it's a mode flag. Arguments for
`model_config`: it's Claude-only, it's session-scoped, and it follows the established pattern.
**Recommendation: keep on `model_config`.**

**Q2 — Incompatible agentic_tool behavior:** Should Agor hard-reject `ultracode: true` on
non-claude-code sessions, or silently no-op and log? Given it's a user-visible config field,
a hard reject with a clear error message is friendlier than silent no-op. **Recommendation:
hard reject with `BadRequest`.**

**Q3 — UI: effort coupling:** When the user enables ultracode in the UI, should Agor
automatically set `effort: 'xhigh'`? Or show a tooltip saying "implies xhigh effort"? Or
do nothing (let the SDK handle it)? **Recommendation: show informational tooltip, do not
auto-set effort — they're independently controllable.**

**Q4 — Settings file cleanup:** The unique settings file at `~/.agor/session-flags/<id>.json`
needs to be deleted after the session ends. The SDK-path cleanup should hook into wherever
the executor tears down the query. Where exactly does the executor do teardown? (This needs
a scan of the executor's session runner to find the right lifecycle hook.) Is there an
existing per-session temp file cleanup pattern we can mirror (like `mcpConfigPath`)?

**Q5 — `applyFlagSettings` for mid-session toggle:** Future feature — should Agor support
toggling ultracode on/off on a running session via `applyFlagSettings`? This is possible
(Agor already uses streaming input mode), but adds complexity. Out of scope for this PR,
but worth noting.

---

## Appendix: SDK evidence excerpts

### `sdk.d.ts` line 1771–1787 (`Options.settings`)
```typescript
/**
 * Additional settings to apply. Accepts either a path to a settings JSON file
 * or a settings object. These are loaded into the "flag settings" layer,
 * which has the highest priority among user-controlled settings.
 *
 * Equivalent to the `--settings` CLI flag.
 *
 * @example Inline settings object
 * settings: { model: 'claude-sonnet-4-6', permissions: { allow: ['Bash(*)'] } }
 *
 * @example Path to settings file
 * settings: '/path/to/settings.json'
 */
settings?: string | Settings;
```

### `sdk.d.ts` line 2182–2192 (`Query` interface)
```typescript
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    // Control Requests — only supported when streaming input/output is used.
    interrupt(): Promise<void>;
    // ...
    applyFlagSettings(settings: { [K in keyof Settings]?: Settings[K] | null }): Promise<void>;
}
```

### `sdk.d.ts` line 2437–2440 (`query()` return type)
```typescript
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

### `sdk.d.ts` line 5777–5781 (`Settings.ultracode`)
```typescript
effortLevel?: 'low' | 'medium' | 'high' | 'xhigh';
/** Enable ultracode for the session: xhigh effort plus standing dynamic-workflow
 *  orchestration. Session-scoped — typically provided via --settings or the
 *  apply_flag_settings control request; interactive toggles never persist it.
 *  Requires workflows to be enabled and an xhigh-capable model. */
ultracode?: boolean;
```
