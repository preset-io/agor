# Session Settings Modal — Redesign Proposal

## 1. Current State Audit

### Structure

The modal is a **600px-wide Ant Design Modal** with a `Form` wrapping 4 collapsible `Collapse` sections (ghost style). Sections 1–2 are expanded by default; 3–4 are collapsed.

```
┌─────────────────────────────────────────────────────┐
│ Session Settings                              [X]   │
├─────────────────────────────────────────────────────┤
│                                                     │
│ ▾ Session Metadata                                  │
│   Title: [________________________]                 │
│                                                     │
│ ▾ Agentic Tool Configuration                        │
│   Claude Model: [claude-sonnet-4-5-latest ▾]        │
│   Permission Mode:                                  │
│     ◉ Default — Prompt for each tool use            │
│     ○ Accept Edits — Auto-accept file edits         │
│     ○ Bypass — Allow all operations                 │
│     ○ Plan — Generate plan without executing        │
│   (Codex only: Sandbox Mode, Approval Policy,       │
│    Network Access toggle + security warning)        │
│   MCP Servers: [multi-select dropdown]              │
│                                                     │
│ ▸ Callback Configuration                            │
│   Enable Callbacks [toggle]                         │
│   Include Child's Final Answer [toggle]             │
│   Custom Template [textarea]                        │
│                                                     │
│ ▸ Advanced                                          │
│   Custom Context (JSON) [textarea]                  │
│                                                     │
├─────────────────────────────────────────────────────┤
│                              [Cancel]      [Save]   │
└─────────────────────────────────────────────────────┘
```

### Field Inventory (10–13 fields depending on agent type)

| # | Field | Section | Agent | Type |
|---|-------|---------|-------|------|
| 1 | Title | Metadata | All | Input |
| 2 | Model | Tool Config | All | Select / Input |
| 3 | Permission Mode | Tool Config | All | Radio Group (4 options) |
| 4 | Sandbox Mode | Tool Config | Codex | Select |
| 5 | Approval Policy | Tool Config | Codex | Select |
| 6 | Network Access | Tool Config | Codex | Switch + Alert |
| 7 | MCP Servers | Tool Config | All | Multi-select |
| 8 | Enable Callbacks | Callbacks | All | Switch |
| 9 | Include Last Message | Callbacks | All | Switch |
| 10 | Custom Template | Callbacks | All | Textarea |
| 11 | Custom Context JSON | Advanced | All | Textarea |

### Components

- **SessionSettingsModal** — outer shell
- **SessionMetadataForm** — title field
- **AgenticToolConfigForm** — model, permissions, MCP
- **PermissionModeSelector** — full radio group (has a `compact` prop for Select mode)
- **ModelSelector** — alias vs. exact toggle + dropdown
- **MCPServerSelect** — multi-select with transport badges
- **CallbackConfigForm** — 3 callback fields
- **AdvancedSettingsForm** — custom context JSON
- **CodexNetworkAccessToggle** — switch with security warning

---

## 2. UX Problems

### P1: "Session Metadata" section is wasteful

A collapsible section header wrapping **a single text field** is pure overhead. Click to expand, see one input, wonder why it needed a section. The title should just *be there*.

### P2: "Agentic Tool Configuration" is an overloaded grab bag

This section mixes three unrelated concerns under one umbrella:
- **Model selection** — what brain to use
- **Permission/security configuration** — how much autonomy to grant
- **MCP server integrations** — what tools to attach

These are conceptually different. Grouping them creates a wall of settings where users can't quickly scan to what they need.

### P3: Permission Mode radio group dominates the modal

The full radio group with 4 options, each with icon + label + description, takes ~120px of vertical space. It's the visually heaviest element in the modal, yet most users set it once and never change it. It commands disproportionate attention.

### P4: Codex users get a much worse experience

Codex sessions add 3 more fields (sandbox, approval, network) to the already-large Tool Config section, making it 6+ fields. The network access toggle also conditionally shows a multi-line security warning. For Codex users, the Tool Config section alone can be 400px+ tall.

### P5: Callbacks get undeserved prominence

Callback configuration is relevant **only** for parent sessions that spawn children — a power-user workflow. Giving it equal visual weight (its own collapsible section, same level as model/permissions) is a hierarchy problem. Most users will never touch these settings.

### P6: "Advanced" is a single-field dumping ground

One JSON textarea in its own section. This signals "we didn't know where to put this." It also invites future sprawl — every miscellaneous setting gets thrown in here.

### P7: No visual hierarchy between "essential" and "optional"

All 4 sections have identical visual treatment. There's no signal to users about which settings matter most vs. which are niche. A first-time user sees 4 equal sections and thinks "I need to understand all of this."

### P8: Section headers consume vertical space without adding value

The ghost Collapse headers with expand icons create visual noise. For a modal with ~10 fields, the section chrome (headers, padding, expand animations) adds ~80px of non-functional vertical space.

---

## 3. Design Options Explored

### Option A: Tabs

```
┌─────────────────────────────────────────┐
│ Session Settings                  [X]   │
├─────────────────────────────────────────┤
│ [General] [Permissions] [Advanced]      │
├─────────────────────────────────────────┤
│                                         │
│  (tab content here)                     │
│                                         │
└─────────────────────────────────────────┘
```

**Pros:** Familiar pattern, clear separation, fixed viewport height.
**Cons:**
- With only ~10 fields, most tab panels would have 2–3 fields each — feels empty and over-navigated.
- Hides settings. Users can't scan everything at a glance. "Where was the MCP servers thing? Was it in General or Advanced?"
- Adds clicks. Changing model AND permissions AND MCP servers = 2 tab switches.
- Tabs work well for 20+ settings. We don't have that many.

**Verdict: Not recommended.** Over-engineered for the setting count.

### Option B: Better Collapsible Sections (iterate on current)

Keep Collapse but fix the groupings and defaults.

**Pros:** Minimal code change, preserves familiarity.
**Cons:**
- Doesn't fix the core problem — section headers still add overhead for small groups.
- The "Session Metadata" wrapper for a single field is still silly.
- Permission Mode radio group still dominates.

**Verdict: Incremental improvement, not a redesign.**

### Option C: Sidebar Navigation (VS Code style)

```
┌─────────────────────────────────────────┐
│ Session Settings                  [X]   │
├────────────┬────────────────────────────┤
│ General    │  Title                     │
│ Model      │  [___________________]     │
│ Permissions│                            │
│ MCP        │  Description               │
│ Callbacks  │  [___________________]     │
│ Advanced   │                            │
└────────────┴────────────────────────────┘
```

**Pros:** Great for large setting sets, easy to navigate.
**Cons:**
- Massive overkill. 10 fields doesn't need a sidebar nav.
- Splits the 600px modal into two narrow columns — each feels cramped.
- Implies VS Code-level complexity that doesn't exist.

**Verdict: Not recommended.** We'd be building a settings page, not a settings modal.

### Option D: Progressive Disclosure (flat layout + collapsed advanced)

```
┌─────────────────────────────────────────┐
│ Session Settings                  [X]   │
├─────────────────────────────────────────┤
│                                         │
│ Title                                   │
│ [My session______________________]      │
│                                         │
│ Model                                   │
│ [claude-sonnet-4-5-latest     ▾]        │
│                                         │
│ Permission Mode                         │
│ [Accept Edits                 ▾]        │
│                                         │
│ MCP Servers                             │
│ [agor-tools, github    ▾]              │
│                                         │
│ ─────────────────────────────────────── │
│                                         │
│ ▸ Codex Settings  (only for Codex)      │
│ ▸ Callbacks                             │
│ ▸ Advanced                              │
│                                         │
├─────────────────────────────────────────┤
│                        [Cancel] [Save]  │
└─────────────────────────────────────────┘
```

**Pros:**
- Essential settings (title, model, permissions, MCP) are immediately visible — no clicking required.
- Niche settings (callbacks, custom context) are collapsed but discoverable.
- Flat layout eliminates section header overhead.
- Visual hierarchy is clear: top = important, bottom = optional.
- Permission Mode uses compact Select instead of radio group — huge space savings.
- Codex-specific settings get their own collapsed group instead of cluttering the main view.

**Cons:**
- Permission Mode loses the detailed descriptions from radio group (mitigated by tooltip or help text).
- Users familiar with current layout may need a moment to adjust.

**Verdict: Recommended.** Best balance of simplicity, discoverability, and information hierarchy.

### Option E: Drawer Instead of Modal

Replace the centered modal with a right-side Drawer.

**Pros:** More vertical space, doesn't block the canvas, can stay open while working.
**Cons:**
- Agor already uses drawers heavily (session list, session detail). Another drawer creates confusion about what's a "drawer" vs a "modal."
- Settings are a focused, commit-or-cancel interaction — modal semantics are correct.
- Would need significant refactoring of all modal callers.

**Verdict: Not recommended for settings.** (Though worth considering for a future "session inspector" that shows settings alongside live session data.)

---

## 4. Recommendation: Progressive Disclosure (Option D)

### Design Specification

#### Layout: Flat top section + collapsed bottom section

The modal splits into two visual zones separated by a subtle divider:

1. **Primary Settings** (always visible, no wrappers)
2. **Secondary Settings** (collapsed groups, below divider)

#### Primary Settings Zone

These fields render as plain `Form.Item` components — no Collapse wrapper:

```
Title
[_________________________________]

Model                                    ← label adapts to agent type
[claude-sonnet-4-5-latest          ▾]    ← ModelSelector (unchanged)

Permission Mode                          ← compact Select instead of radio
[● Accept Edits — Auto-accept edits ▾]  ← shows colored dot + label

MCP Servers
[agor-tools, github              ▾]     ← MCPServerSelect (unchanged)
```

**Key change: Permission Mode switches to compact mode.** The `PermissionModeSelector` already has a `compact` prop that renders a `Select` dropdown instead of a radio group. We use this. The detailed descriptions are still visible in the dropdown options.

#### Secondary Settings Zone

Below a `Divider`, collapsible sections for niche settings:

```
──────────────────────────────────────

▸ Codex Settings                         ← only shown for Codex sessions
    Sandbox Mode: [workspace-write  ▾]
    Approval Policy: [on-request    ▾]
    Network Access: [toggle] ⚠️ warning

▸ Callbacks
    Enable Callbacks: [toggle]
    Include Final Answer: [toggle]
    Custom Template: [textarea]

▸ Advanced
    Custom Context (JSON): [textarea]
```

**Default state:** All secondary sections collapsed. Users who need them know they need them.

#### Mockup (full)

```
┌──────────────────────────────────────────────────┐
│ Session Settings                           [X]   │
├──────────────────────────────────────────────────┤
│                                                  │
│  Title                                           │
│  ┌──────────────────────────────────────────┐    │
│  │ Implement dark mode toggle               │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  Claude Model                                    │
│  ┌──────────────────────────────────────────┐    │
│  │ ● Alias │ claude-sonnet-4-5-latest    ▾  │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  Permission Mode                                 │
│  ┌──────────────────────────────────────────┐    │
│  │ 🟢 Accept Edits                       ▾  │    │
│  └──────────────────────────────────────────┘    │
│  Auto-accept file edits, prompt for others       │
│                                                  │
│  MCP Servers                                     │
│  ┌──────────────────────────────────────────┐    │
│  │ agor-tools (stdio) × github (http) ×  ▾  │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│                                                  │
│  ▸ Callbacks                                     │
│  ▸ Advanced                                      │
│                                                  │
├──────────────────────────────────────────────────┤
│                              [Cancel]    [Save]  │
└──────────────────────────────────────────────────┘
```

For Codex sessions:

```
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│                                                  │
│  ▸ Codex Sandbox & Policies                      │
│  ▸ Callbacks                                     │
│  ▸ Advanced                                      │
```

### Rationale

1. **80/20 rule**: Title + Model + Permissions + MCP covers 80% of settings interactions. These are always visible without a single click.

2. **No wasted chrome**: Eliminating the Collapse wrapper for primary settings saves ~80px of vertical space (section headers, padding, expand icons).

3. **Compact permission selector**: Switching from radio group to Select dropdown saves ~80px more. The `PermissionModeSelector` already supports this via its `compact` prop — zero new component work.

4. **Codex settings isolated**: Codex-specific fields (sandbox, approval, network) move to their own collapsed section. This prevents non-Codex users from ever seeing them AND prevents Codex users from being overwhelmed in the main view.

5. **Callbacks demoted correctly**: As a collapsed section below the divider, callbacks are discoverable but don't compete for attention with model/permissions.

6. **Extensible**: Future settings go into either the primary zone (if essential) or a new/existing collapsed section (if niche). The pattern scales to ~20 fields before we'd need tabs.

---

## 5. Implementation Plan

### Changes Required

#### File 1: `SessionSettingsModal.tsx` (main restructure)

**Effort: Medium**

- Remove the outer `<Collapse>` that wraps all 4 sections
- Render `SessionMetadataForm` and `AgenticToolConfigForm` as flat form items (primary zone)
- Add an `<Divider />` between primary and secondary zones
- Wrap `CallbackConfigForm` and `AdvancedSettingsForm` in a new `<Collapse>` (secondary zone)
- For Codex sessions, add a "Codex Settings" collapsed section with sandbox/approval/network fields

```tsx
// BEFORE: Everything in one Collapse
<Collapse ghost defaultActiveKey={['metadata', 'agentic-tool-config']} items={[...]} />

// AFTER: Flat primary + collapsed secondary
<>
  {/* Primary — always visible */}
  <SessionMetadataForm ... />
  <AgenticToolConfigForm ... compact />

  <Divider dashed style={{ margin: '16px 0' }} />

  {/* Secondary — collapsed by default */}
  <Collapse ghost items={[
    // Codex Settings (conditional)
    // Callbacks
    // Advanced
  ]} />
</>
```

#### File 2: `AgenticToolConfigForm.tsx` (extract Codex fields)

**Effort: Small**

- Add a `compact` or `hideCodexFields` prop
- When true, skip rendering the Codex-specific fields (sandbox, approval, network)
- These fields will be rendered separately in a "Codex Settings" collapse panel in the parent modal
- Pass `compact` to `PermissionModeSelector` to use Select instead of Radio Group

Alternatively, create a new `CodexSettingsForm` component that renders just the 3 Codex fields. This is cleaner and follows the existing pattern of small focused form components.

#### File 3: `PermissionModeSelector.tsx` (no changes needed)

Already has `compact` prop that renders a `Select` dropdown. Just need to pass `compact={true}` from the settings modal context.

#### New File: `CodexSettingsForm/CodexSettingsForm.tsx` (optional)

**Effort: Small**

Extract the 3 Codex-specific fields into their own form component:
- Sandbox Mode (Select)
- Approval Policy (Select)
- Network Access (CodexNetworkAccessToggle)

This mirrors the pattern of `CallbackConfigForm` and `AdvancedSettingsForm`.

#### No changes needed:

- `SessionMetadataForm` — used as-is
- `ModelSelector` — used as-is
- `MCPServerSelect` — used as-is
- `CallbackConfigForm` — used as-is, just moved to secondary zone
- `AdvancedSettingsForm` — used as-is, stays in secondary zone
- `CodexNetworkAccessToggle` — used as-is

### Migration Path

This is a **non-breaking visual refactor**. The form field names, data shape, and save logic remain identical. Only the layout wrapper changes.

1. Restructure `SessionSettingsModal.tsx` layout
2. Pass `compact={true}` to `PermissionModeSelector`
3. Extract Codex fields to secondary zone (new collapse panel or `CodexSettingsForm`)
4. Remove "Session Metadata" section header (title becomes a flat field)
5. Test with all agent types (Claude, Codex, Gemini, Copilot, OpenCode)

### Estimated Scope

- **~150 lines changed** across 2–3 files
- **1 optional new file** (CodexSettingsForm, ~50 lines)
- **0 new dependencies**
- **0 API changes**
- **0 type changes**

---

## 6. Future Considerations

### If settings count grows to 20+

Revisit tabs at that point. The progressive disclosure pattern works for up to ~20 fields. Beyond that, a tabbed interface or sidebar nav becomes justified.

### "Quick Settings" from session card

Consider a lightweight popover (not the full modal) for the 2 most common changes: model and permission mode. Accessible via a gear icon on the session card. This would make quick tweaks possible without opening any modal.

### Settings presets

"Save as default" / "Load from preset" buttons in the modal footer. Users configure their preferred model + permissions + MCP servers once, then apply to new sessions. This pairs well with the existing `default_agentic_config` on the user object.
