# Session ID placement — design

**Status:** Proposal, awaiting sign-off
**Date:** 2026-05-20
**Author:** Max (with Claude, designer hat)
**Scope:** UI only (`apps/agor-ui`) — no schema, no API
**Related in-flight work:**
- `callback-toggle-and-target-in-footer` (commit `56d96510`) — also redesigning footer real estate
- `centralize-shortid-and-avoid-collisions` — established `SHORT_ID_LENGTH = 24` as the canonical display width

---

## TL;DR

The footer's session-ID pill is currently a `~20-char hex string + copy icon + tag chrome`, which dominates a row that should be reserved for **action-oriented** controls (model, permission mode, callback, effort, send/stop). The pill is also one of the lowest-frequency controls in the footer — users almost never act on the session ID per turn.

**Recommendation (decided):**

1. **Replace the wide pill with a tiny info-icon button** (`<Button type="text" icon={<InfoCircleOutlined />} />`) in the **same footer slot**. Click (not hover) opens the **same popover** that exists today (both Agor + SDK IDs with copy buttons). The popover content stays; only the trigger shrinks from ~140px to ~28px.
2. **Add a read-only "Session IDs" field to the main body of Session Settings modal** (not Advanced) — canonical, discoverable home for users who don't notice the footer icon.
3. **Do NOT introduce a 4–6-char glance handle.** It contradicts the `centralize-shortid-and-avoid-collisions` principle ("if every site picks its own length, we get back the collision bug") and serves a use case (live log correlation by eye) the team isn't optimizing for.

Net change: footer loses ~110px of low-value horizontal real estate; users keep one hover/click → both full IDs + copy; debugging-friendly readers also find them in Settings.

---

## Current state

### Footer pill (`apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx:798–803`)

```tsx
<SessionIdPill
  sessionId={session.session_id}
  sdkSessionId={session.sdk_session_id}
  agenticTool={session.agentic_tool}
  showCopy={true}
/>
```

Sits in the footer's left cluster, between `TimerPill` and `ModelPill`:

```
[ Timer ] [ 01933e4a7b897c35a8f3…  📋 ] [ claude-opus-4-7 ] [ 14.2k tok ] [ 23% ctx ]
```

### What's shown

- **Tag chrome:** session-color background, padding, `CopyOutlined` icon.
- **Body:** `shortId(sdkSessionId || sessionId)` — currently `SHORT_ID_LENGTH = 24` hex chars (`packages/core/src/types/id.ts:107`). JSDoc example shows 20 chars and is stale; the constant is the source of truth.
- **Hover popover** (`Pill.tsx:573–663`) reveals **both** IDs:
  - Agor Session ID (short + full, monospace, Copy button)
  - SDK Session ID (Claude Agent SDK / Codex thread / Gemini — label uses `agenticTool`)
  - 400px wide, single click on either Copy button writes the **full** UUID to clipboard

### What's NOT shown anywhere else

- Session Settings modal (`SessionSettingsModal.tsx:340–369`): **no** session ID field, anywhere. Primary zone is Title / Model / MCP / Permission; secondary `Collapse` has Codex / Env Vars / Callbacks / Advanced. None of these surface IDs.
- Conversation header (`SessionPanel.tsx:950–1020`): title + status badge + CreatedByTag, then a right-aligned button cluster (Terminal, Settings ⚙, Delete, Close). No ID.
- URL: yes, the route already encodes the session short ID — deep-linking is already solved.

### What got us here

The "centralize shortId and avoid collisions" work made the canonical display ID 24 hex chars (up from earlier shorter / inconsistent forms). That's the right call for **collision safety** in logs and CLI, but it makes the *pill* — which has tag chrome around it — visually heavy in a footer that's getting denser as we add controls (callback toggle, effort, etc.).

---

## Use-case analysis

Decide first, place second. What's the session ID actually used for?

| # | Use case | Frequency | Who | What they need |
|---|---|---|---|---|
| 1 | Pasting into a support ticket / bug report | rare per session | mostly devs/ops | full ID, copy-able in one click |
| 2 | Cross-referencing daemon / executor logs | medium for power users, rare for others | devs operating Agor instance | full ID, copy-able; short form for visual match |
| 3 | Deep-linking to a session | rare | anyone sharing | already solved via URL |
| 4 | Reference in transcript ("Child session 019e372a has completed") | passive | agents reading other agents | already solved by `shortId()` in message text |
| 5 | "Is this the same session I'm watching in the log?" — live glance | rare and only for power users | devs tailing logs | a stable short handle visible without interaction |

**Read of the use cases:**

- Cases 3 and 4 are already covered (URL, `shortId()` in text).
- Case 1 is **one copy-click, infrequent**. Doesn't need a permanent footer slot — needs to be **findable**, not **glanceable**.
- Case 2 splits: the *copy* sub-need = same as case 1. The *visual match* sub-need = case 5.
- Case 5 is the only argument for a glanceable handle in the footer. It applies to a minority of users a minority of the time, and they can hover/click in to confirm. Doesn't justify ~140px of always-visible space.

**Conclusion:** Session ID is a **findable debug surface, not an action surface**. Footer slots are precious because they're always visible during the user's primary task (prompting). Anything that's not acted on per-turn should yield to things that are.

---

## Options evaluated

### A. Read-only field in Session Settings → main body
**Cost:** one click (open Settings) to see IDs. **Benefit:** canonical, discoverable, supports copy, doesn't compete with footer controls. Pairs well with C.
**Verdict:** ✅ Adopt as secondary placement.

### B. Read-only field in Session Settings → Advanced
**Cost:** two clicks (open Settings, expand Advanced). **Benefit:** out of the way.
**Verdict:** ❌ Reject. Max's hard rule: don't bury debug info. IDs are useful for support — Settings main body, not Advanced.

### C. Tiny `ⓘ` info-icon in the footer slot (replace pill)
**Cost:** trigger is iconographic, not text — slightly less self-evident than a pill with a hex string. Mitigated by tooltip "Session IDs / metadata".
**Benefit:** ~110px reclaimed; same hover popover keeps working; the popover is already the right surface for "show both IDs with copy"; sits where eyes already look (the existing pill location).
**Verdict:** ✅ **Adopt as primary placement.** Same popover, smaller trigger.

### D. Right-click on session card in drawer / canvas
**Cost:** discoverability — not all users right-click; mobile non-starter.
**Benefit:** zero chrome.
**Verdict:** ❌ Reject as primary. Acceptable later as a *supplement* (right-click → Copy Session ID), but not a placement.

### E. Keyboard shortcut + command palette ("Session Info")
**Cost:** zero discoverability without help docs. Agor doesn't have a command palette today, so this is a larger build than the doc implies.
**Verdict:** ❌ Reject for this design. Revisit when/if a command palette ships.

### F. Footer with super-short 4–6-char handle + click for full
**Cost:** Reintroduces per-site length picking — exactly the foot-gun `centralize-shortid-and-avoid-collisions` eliminated (collision math at `SHORT_ID_LENGTH = 24` in `id.ts:97–107`). Two visual conventions for "the session ID" in the same UI (24-char in popover, 4-char on the pill) confuses users and re-opens "wait, is this the same one?" questions.
**Benefit:** glanceable; smallest footprint that still shows hex.
**Verdict:** ❌ Reject. The only use case it serves (live log glance for power users) does not justify breaking the canonical-shape invariant the team just paid to establish. If glance-correlation becomes a real recurring pain point, the right fix is **CLI/log output to use the same 24-char form** as the UI — not the other way around.

### G. Hide entirely (rely on Settings + URL)
**Cost:** removes the one-hover-and-copy convenience.
**Benefit:** most aggressive footer cleanup.
**Verdict:** ❌ Reject. The popover affordance is genuinely useful for case 1 (copy for tickets); a 28px icon button preserves it almost for free.

---

## Recommendation

**Adopt C + A.**

### Primary: `ⓘ` icon in the footer, opens the existing popover

Replace `SessionIdPill` in the footer's left cluster with a 28px icon-only button:

```tsx
<Tooltip title="Session info & IDs">
  <Popover
    content={<SessionInfoPopoverContent session={session} />}
    trigger="click"
    placement="topLeft"
  >
    <Button type="text" size="small" icon={<InfoCircleOutlined />} />
  </Popover>
</Tooltip>
```

Key choices:

- **`trigger="click"`** (not hover). The current hover trigger fires the popover during normal mouse traversal of the footer, which is mildly annoying for a low-value surface. Click is more intentional and matches users' mental model ("I want session info → I click info").
- **Same popover content** as today (`SessionIdPopoverContent`) — both IDs, copy buttons, identical layout. No regression for case 1.
- **Tooltip** on the icon so the affordance is discoverable on hover without firing the heavier popover.
- **Renamed slightly** to `SessionInfoPopover` if we add the metadata extras below — otherwise leave as-is.

### Secondary: Session Settings modal — main body field

Add a read-only "Session IDs" `Form.Item` to the **primary zone** of `SessionSettingsModal` (above the existing `SessionMetadataForm` / `AgenticToolConfigForm`, or just below `Title` — pick whichever feels least like clutter; suggest just below Title, since both are identity-of-the-session info):

```
Session IDs
┌──────────────────────────────────────────────┐
│ Agor      01933e4a7b897c35a8f39d2e1c4b5a6f 📋 │
│ Claude    sess_abc123…                     📋 │  (only if sdk_session_id set)
└──────────────────────────────────────────────┘
```

- Reuse `shortId()` for the display form (one source of truth — no per-site length).
- Each row's copy button writes the **full** UUID, matching popover behavior.
- Section is `Form.Item` styled, read-only, no edit affordance — same visual weight as "Created by".

### Footer pill: remove

Delete `<SessionIdPill ... />` from `SessionPanel.tsx:798–803`. The component itself (`Pill.tsx:665–709`) stays exported so it can still be used elsewhere (e.g., session cards in the drawer if useful later) — only the *footer placement* is removed.

---

## Popover scope

If we extend the popover to a "Session info" card (worthwhile — keeps the icon a useful surface), include:

**In scope (read-only, cheap):**
- Both session IDs with short + full + copy (existing)
- `created_at` and `last_activity_at` (already on session)
- `agentic_tool` + `model_config.model` (already on session, dedupes with ModelPill — fine to repeat in a debug-flavored context)
- Status badge

**Explicitly out of scope (don't turn this into Settings):**
- Token totals — the dedicated `TokenCountPill` already shows this in the footer with its own popover; don't duplicate.
- Context window — same as above (`ContextWindowPill`).
- Edit affordances — this is read-only. Editing goes through Settings.
- Cost — already in `TokenCountPill`'s popover.

Footer link at the bottom: `Open Session Settings →` (closes popover, opens modal).

---

## Phased implementation plan

Small, single-PR scope. Should be one short worktree, no schema work.

**Phase 1 — Footer trigger swap** (~30 lines)
- Replace `<SessionIdPill ... />` at `SessionPanel.tsx:798–803` with the new `<SessionInfoButton session={session} />`.
- New component lives at `apps/agor-ui/src/components/SessionInfoButton/` (or co-located with `Pill.tsx` if we choose to keep it close to the popover content).
- Reuse `SessionIdPopoverContent` verbatim — wrap it in a `Popover` with `trigger="click"`, icon-only `Button` as the trigger.

**Phase 2 — Settings modal field** (~20 lines)
- Add `SessionIdsReadOnlyField` component (renders short + full + copy for each ID, monospace).
- Mount it in `SessionSettingsModal.tsx` just under the title, **above** the `<SessionMetadataForm />` invocation. Or, equivalently, below `SessionMetadataForm`. Pick whichever the user prefers — both are "primary zone".

**Phase 3 — Optional popover extensions** (defer; can be a follow-up)
- Add the timestamps + tool + status to the popover content.
- Add the "Open Session Settings →" footer link.

**Phase 4 — Cleanup**
- Decide whether `SessionIdPill` (the component) has remaining callers. If not, mark it `@deprecated` and remove in the next PR. If it does, leave it; only the footer placement changes here.
- Update any screenshots in `apps/agor-docs/` that show the footer.

**Out of scope for this PR:**
- Right-click menus
- Command palette / keyboard shortcuts
- Changes to `shortId()` or `SHORT_ID_LENGTH`
- CLI / log output formatting

---

## Coordination

- **`callback-toggle-and-target-in-footer`** is concurrently editing the footer's right cluster. This work edits the left cluster only — no merge conflict expected at the component-tree level, but both branches touch `SessionPanel.tsx`. Whichever lands second should rebase, not auto-merge — the diffs are nearby.
- **`centralize-shortid-and-avoid-collisions`** is the basis for using `shortId()` everywhere. This design **reinforces** that work; option F (which would have broken it) is explicitly rejected.
- **`improve-session-drawer`** — no overlap; the drawer doesn't render the pill.

---

## Hard rules check

- ❌ No code from this worktree — doc only. ✅
- ❌ Don't equivocate — recommendation is C + A, not a menu. ✅
- ❌ Don't bury in Advanced — primary placement is footer icon; secondary is **main body** of Settings. ✅
- ❌ Don't argue for long pill — we're removing it. ✅
- ✅ Use-case-driven — case 1 / 5 split drives the choice. ✅
- ✅ Two affordances designed — popover + Settings field. ✅
- ✅ Coordinates with footer-callback and shortId work. ✅
