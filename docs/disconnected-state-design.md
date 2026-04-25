# Disconnected-State UX Design

**Branch:** `disconnected-state-ux`
**Date:** 2026-04-25
**Author:** Working draft for review (Max + agent)
**Sister branch:** `fix-reconnect-loop` (token-refresh + reconnect state machine — does not overlap with this design)

---

## TL;DR

Agor already has a connection-state context (`ConnectionContext`) and a status pill
(`ConnectionStatus`), but **gating is inconsistent** — only ~6 components use
`useConnectionDisabled()` while there are ~80–120 mutation sites across the app.
This causes the bug Max called out: actions partially work when disconnected,
producing silent failures or out-of-sync local state.

**Recommendation:** **Approach D — Hybrid** (Mutation Gate context + slim banner).
Keep the existing `ConnectionContext` as the single source of truth, layer a
declarative `<MutateButton>` / `useMutationGate()` API on top of it, and add a
single non-blocking app-shell banner so the disconnected state is unmissable.
Pure-read interactions (panning the board, opening modals to inspect state)
stay alive; everything that mutates the daemon disables at render time with a
tooltip explaining why.

The session pane is an exception — it's stream-dependent — and gets a
thin `<SessionPaneShell>` overlay that locks composer + tool-call rendering
while preserving scrollback for read-only inspection.

POC commit ships the foundation + 1 wired site (NewWorktreeModal). The full
sweep (~80 sites) is mechanical and can land incrementally.

---

## 1. Current state (ground truth)

### 1.1 Connection state — already centralized

| Concern | Location |
|---|---|
| Context + hooks | `apps/agor-ui/src/contexts/ConnectionContext.tsx` (`useConnectionDisabled`, `useConnectionState`) |
| Provider mount | `apps/agor-ui/src/App.tsx:1283` (wraps the entire route tree) |
| Socket lifecycle | `apps/agor-ui/src/hooks/useAgorClient.ts:216-362` (`connect`, `disconnect` w/ 1500ms grace, `connect_error`, manual reconnect backoff 500ms→30s) |
| Feathers client setup | `packages/core/src/api/index.ts:708-781` |
| State fields exposed | `connected`, `connecting`, `outOfSync`, `capturedSha`, `currentSha` |

Good news: there is **one** canonical source of truth, it's already plumbed
through the app, and it already distinguishes connected / connecting /
out-of-sync. We don't need a new store. We just need to use it consistently.

### 1.2 What exists today

**Banner / pill:** `ConnectionStatus.tsx` — a small Ant Design `<Tag>`
rendered in the app shell. States: out-of-sync (amber, click to reload),
disconnected (red, click to retry), reconnecting (yellow spinner), connected
(green, auto-hides after 3s). It's discreet — easy to miss — and it sits
inline among other navbar elements.

**Disabled affordances today:**

| Component | File | What it gates |
|---|---|---|
| `NewSessionButton` | `apps/agor-ui/src/components/NewSessionButton/NewSessionButton.tsx:10` | Disables the FAB + tooltip "Disconnected from daemon" |
| `SessionPanel` | `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx:252` | Disables Send / Fork / Btw / Spawn / meta-prompt buttons |
| `WorktreeCard` | `apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx` | Inline action buttons |
| `SessionCard` | `apps/agor-ui/src/components/SessionCard/SessionCard.tsx` | Inline action buttons |

That's it. **6 files use the hook**, which is the heart of the bug — every
other mutation site (board create/update, worktree env start/stop, settings
modals, MCP servers table, owners, agentic-tools tab, comments, drag-drop,
etc.) **does not check connection state at all** and either silently fails or
mutates local React state that then drifts from the server.

### 1.3 Reconnect behavior

- 1500ms grace period on `disconnect` (suppresses transient flicker —
  `useAgorClient.ts:88`).
- `io server disconnect` triggers manual exponential backoff 500ms→30s.
- On reconnect, socket re-authenticates in place (refresh-token flow on the
  sister branch); subscriptions in `useMessages` are torn down and rebuilt by
  the hook's effect on the `client` instance.
- Sister branch `fix-reconnect-loop` is hardening this further (see
  `7482846d`, `b34d8336`, `a2b66ed1`, `cacb8130`). **Out of scope here.**

---

## 2. Action-mutation taxonomy

Every UI surface falls into one of four buckets. The taxonomy drives the
design — gate the third bucket aggressively, leave the first two alone, give
the fourth a graceful degradation.

| Bucket | Examples | Disconnected behavior |
|---|---|---|
| **A. Pure read** | Pan/zoom canvas, hover cards, open inspect modals, read scrollback, open settings tabs to view values, switch boards/tabs, navigate routes | **Leave alone.** Local data is still useful; users should be able to browse. |
| **B. Local-only mutations** | Toggle dark mode, expand/collapse sidebar, open/close modal, change selected card, type in a textarea (without sending) | **Leave alone.** Pure UI state — never hits the daemon. |
| **C. Server mutations** | New session, prompt session, fork/spawn, create worktree, drag card, change zone, edit worktree config, env start/stop/restart, edit settings, owners, MCP servers, comments, reactions, file ops | **BLOCK.** This is the "main course." Disable button + tooltip "Disconnected from daemon". |
| **D. Stream-dependent** | Live message stream in `SessionPanel`, live comments stream, presence/cursor broadcast | **Degrade.** Show a "connection lost" overlay on the live region; freeze last-known state; do not unmount (preserve scrollback). |

**Approximate counts** (grep `\.create\(|\.patch\(|\.update\(|\.remove\(` and
`client\.service\(`): ~177 raw matches across 39 files. After excluding
read-side `findAll`-equivalents and false positives, the actual mutation sites
are roughly **80–120**, concentrated in:

- `useSessionActions.ts` (7 sites: prompt, fork, spawn, create, etc.)
- `useBoardActions.ts` (5 sites: create/update/delete board, zones)
- `useAgorData.ts` (24 sites: a hub for many CRUD operations)
- `SessionCanvas.tsx` and `useBoardObjects.ts` (drag/drop, position updates)
- Settings tabs: `MCPServersTable`, `AgenticToolsSection`, `BoardsTable`,
  `CardsTable`, `PersonalApiKeysTab`, `GatewayChannelsTable`
- Worktree modal tabs: `OwnersSection`, `EnvironmentTab`, `GeneralTab`,
  `FilesTab`, `AssistantTab`

Most of these are **buttons or form-submit handlers**. Drag-drop on the canvas
is the trickiest case (no button to disable — see §6).

---

## 3. Architectural approaches

### A. Top-level overlay + click-shield

A single `<DisconnectedOverlay />` at App root that intercepts pointer events
on a translucent layer with a "Reconnecting…" banner.

- ✅ Zero changes to component code. One place to maintain.
- ❌ Heavy-handed. Blocks **all** interactions including pure reads (panning
     the board, scrolling, opening modals). Bad UX for the most common case
     (briefly disconnected during a deploy/wifi blip while the user is just
     reviewing something).
- ❌ Doesn't tell the user *why* a specific button is disabled — the entire
     screen is blocked, which is a worse signal than "this button is grayed
     out and tooltip says: disconnected".

**Verdict:** rejected.

### B. Mutation-layer interception

Patch the Feathers client wrapper so any `.create/.patch/.update/.remove` call
throws `DisconnectedError` when `!connected`. Every consumer surfaces it via a
toast.

- ✅ Precise — only blocks mutations.
- ✅ Doesn't touch presentational components.
- ❌ User finds out **after** clicking. Click → spinner → toast = bad UX.
- ❌ Optimistic-update consumers will have to roll back local state on every
     failure, increasing complexity.
- ❌ Doesn't address drag-drop (which mutates state in `onDragEnd`, not
     through a button).

**Verdict:** keep this as a **defense-in-depth backstop**, not the primary UX.
Even with §C/D in place, a stray mutation slipping through should fail clean
rather than corrupt local state.

### C. `<MutationGate>` boundary / disabled context

Provide `useMutationGate(): { canMutate, reason }` and a `<MutateButton>`
wrapper that auto-disables and shows a tooltip. Form fields use the hook to
set their own `disabled`.

- ✅ Declarative, granular, allows per-action affordances.
- ✅ Pure-read UI stays fully interactive.
- ✅ Easy to extend later (e.g., `reason: 'rbac' | 'env-stopped'`).
- ❌ Requires touching mutation sites once. But: only once, and the work is
     mechanical — replace `<Button>` with `<MutateButton>` or add
     `disabled={...}`.

**Verdict:** This is the right primitive. It's also already half-built — we
have `useConnectionDisabled()`. The work is naming + consistency + a wrapper
component.

### D. Hybrid: A (lite) + C — **RECOMMENDED**

Combine three things:

1. **Slim app-shell banner** (not an overlay): a 28px-tall horizontal stripe
   at the very top of the screen, red/amber, "Disconnected — read-only mode"
   with an inline retry button. Shifts the entire layout down 28px, so it's
   physically impossible to miss but doesn't block anything. Hides itself on
   reconnect.
2. **`<MutationGate>` + `useMutationGate()` + `<MutateButton>`** as the
   declarative primitive for every server-mutating affordance.
3. **`<SessionPaneShell>` degradation** — when the stream is dead, the
   composer is replaced with a "Connection lost — reconnecting…" empty state,
   but scrollback stays visible.

Plus mutation-layer interception (Approach B) **as a backstop**, not as the
primary UX — so a missed gate fails cleanly with a toast instead of corrupting
local state.

- ✅ Banner is unmissable; granular gates preserve read-only browsing; pane
     degrades gracefully.
- ✅ Builds on the abstraction we already have (`ConnectionContext`).
- ✅ Disabled buttons explain *why* they're disabled (tooltip), which the
     overlay-based approach can't.
- ❌ Requires categorizing components (~80 sites) — but this is mechanical
     and incremental.

**Justification over the alternatives:** Approach D matches Max's framing
("clearly show the app is disconnected and limit actions throughout") and his
constraint ("don't want to thread connection state through every component").
The threading happens once, in the `<MutateButton>` wrapper; all subsequent
sites just import the wrapper. Approach A blocks too much (kills pure-read
UX). Approach B doesn't visually communicate the disconnect at the affordance
level, which causes the silent-failure feel.

### E. Service-worker / IndexedDB outbox — out of scope

Real offline-first with mutation queueing is great in theory but: many
mutations aren't safely retryable (prompt sessions, drag-drop ordering),
collaborative state would diverge, and it's a 6-month project. **Mention only
as future direction.** Hybrid (D) is the right scope for now.

---

## 4. Concrete skeleton (mini-POC)

The shape of the abstraction. Field types match the existing context so we
can extend without breaking consumers.

### 4.1 Extend `ConnectionContext` → `MutationGate`

`useConnectionDisabled()` returns a boolean today. We rename/wrap it as a
richer `useMutationGate()` that returns a structured reason — so future
extensions (RBAC, env-not-running, read-only viewer mode) plug in without
breaking call sites.

```ts
// apps/agor-ui/src/contexts/ConnectionContext.tsx (extended)

export type MutationBlockReason =
  | 'disconnected'
  | 'reconnecting'
  | 'out-of-sync';

export interface MutationGate {
  canMutate: boolean;
  reason: MutationBlockReason | null;
  message: string | null; // user-facing text for tooltip / toast
}

export function useMutationGate(): MutationGate {
  const { connected, connecting, outOfSync } = useContext(ConnectionContext);
  if (outOfSync) {
    return {
      canMutate: false,
      reason: 'out-of-sync',
      message: 'Daemon was upgraded — refresh the page to continue.',
    };
  }
  if (!connected && connecting) {
    return {
      canMutate: false,
      reason: 'reconnecting',
      message: 'Reconnecting to daemon…',
    };
  }
  if (!connected) {
    return {
      canMutate: false,
      reason: 'disconnected',
      message: 'Disconnected from daemon. Action unavailable.',
    };
  }
  return { canMutate: true, reason: null, message: null };
}

// Keep the existing boolean helper for back-compat during rollout
export function useConnectionDisabled(): boolean {
  return !useMutationGate().canMutate;
}
```

### 4.2 `<MutateButton>` — the wrapper

A drop-in replacement for `<Button>` that auto-disables and shows a tooltip
when the gate is closed. ~20 lines.

```tsx
// apps/agor-ui/src/components/MutateButton/MutateButton.tsx

import { Button, Tooltip } from 'antd';
import type { ButtonProps } from 'antd';
import { useMutationGate } from '../../contexts/ConnectionContext';

export interface MutateButtonProps extends ButtonProps {
  /** Override tooltip when enabled (default: no tooltip). */
  tooltip?: React.ReactNode;
}

export const MutateButton: React.FC<MutateButtonProps> = ({
  tooltip,
  disabled,
  children,
  ...rest
}) => {
  const gate = useMutationGate();
  const finalDisabled = disabled || !gate.canMutate;
  const finalTooltip = !gate.canMutate ? gate.message : tooltip;

  const button = (
    <Button {...rest} disabled={finalDisabled}>
      {children}
    </Button>
  );

  return finalTooltip ? <Tooltip title={finalTooltip}>{button}</Tooltip> : button;
};
```

For non-button mutation sites (form `onValuesChange`, drag handlers, modals
that mutate on submit), use the hook directly:

```tsx
const gate = useMutationGate();
const handleDragEnd = (e) => {
  if (!gate.canMutate) return; // silently no-op; banner already explains
  /* ... existing mutation ... */
};
```

### 4.3 Top-of-screen banner

Slim, replaces nothing. Renders above the existing app shell; takes ~28px of
vertical space when active.

```tsx
// apps/agor-ui/src/components/DisconnectedBanner/DisconnectedBanner.tsx

import { Alert, Button } from 'antd';
import { useMutationGate } from '../../contexts/ConnectionContext';

interface Props {
  onRetry?: () => void;
}

export const DisconnectedBanner: React.FC<Props> = ({ onRetry }) => {
  const gate = useMutationGate();
  if (gate.canMutate) return null;

  const isReconnecting = gate.reason === 'reconnecting';
  const isOutOfSync = gate.reason === 'out-of-sync';

  return (
    <Alert
      type={isOutOfSync ? 'warning' : 'error'}
      banner
      showIcon
      message={
        isOutOfSync
          ? 'Daemon was upgraded — refresh to continue.'
          : isReconnecting
            ? 'Reconnecting to daemon… read-only mode.'
            : 'Disconnected from daemon — read-only mode.'
      }
      action={
        isOutOfSync ? (
          <Button size="small" onClick={() => window.location.reload()}>
            Refresh
          </Button>
        ) : !isReconnecting ? (
          <Button size="small" onClick={onRetry}>
            Retry
          </Button>
        ) : null
      }
    />
  );
};
```

Mount it once, immediately above the app shell route tree (inside
`ConnectionProvider`, outside everything else). The existing `ConnectionStatus`
pill in the navbar can stay — it provides the green "just reconnected"
confirmation that the banner doesn't.

### 4.4 Session pane degradation

`SessionPanel` already gates Send/Fork/Btw via `useConnectionDisabled()`
(`SessionPanel.tsx:907,924,932,940,956`). What it **doesn't** do:

- Show *why* the composer is disabled (no inline message in the composer
  area).
- Visually freeze the message stream area to communicate "you may be missing
  new messages."

Proposal: a small `<SessionPaneShell>` wrapper around the composer that
swaps it for a `<DisconnectedComposerState>` empty state when disconnected.
Scrollback stays visible (read-only inspection still works) and the
`useMessages` subscription handles re-attachment on reconnect (already does
this — see `useMessages.ts:101-112`).

```tsx
// Inside SessionPanel, replace:
//   <ComposerArea ... disabled={connectionDisabled} />
// with:
{gate.canMutate ? (
  <ComposerArea ... />
) : (
  <DisconnectedComposerState reason={gate.reason} />
)}
```

The empty state is a simple panel: "Composer disabled — reconnecting…" with
the same retry button as the banner. Total addition: ~30 lines.

### 4.5 Mutation-layer backstop

A thin wrapper over the Feathers client that throws `DisconnectedError` if
called when `!connected`. Logs only — doesn't pop a toast (the banner already
communicates state). Catches the long tail of "we forgot to gate this site"
bugs.

```ts
// packages/core/src/api/withMutationGuard.ts (sketch — not in POC commit)

export function withMutationGuard<T extends FeathersClient>(
  client: T,
  isConnected: () => boolean,
): T {
  return new Proxy(client, {
    get(target, prop) {
      const orig = target[prop];
      // wrap .create / .patch / .update / .remove on services
      // throwing DisconnectedError when !isConnected()
      return /* ... */;
    },
  });
}
```

This is a defense-in-depth net, **not** the primary UX. Add after the
`<MutateButton>` rollout is mostly complete. It replaces a sprawling
try/catch obligation with one boundary.

---

## 5. Migration plan

Foundation first; sweep second. Work is mechanical and parallelizable.

### Phase 1 — Foundation (this PR / next 1-2 PRs)

1. ✅ Extend `ConnectionContext.tsx` with `useMutationGate()` (keep
   `useConnectionDisabled` as a back-compat alias).
2. ✅ Add `<MutateButton>` and `<DisconnectedBanner>` components.
3. ✅ Mount `<DisconnectedBanner>` in `App.tsx` immediately above the route tree.
4. ✅ POC: convert one mutation site (`NewWorktreeModal` "Create" button) as
   the first wired example.

### Phase 2 — Mechanical sweep (split into small PRs by domain)

Order by user-impact-of-silent-failure:

1. **Session actions** (`useSessionActions.ts` callers — 7 sites). Highest
   stakes: prompting a dead session.
2. **Board actions** (`useBoardActions.ts`, `SessionCanvas`, `useBoardObjects`
   drag handlers — ~25+ sites). Drag-drop is the trickiest because it has no
   button to disable; gate inside the `onDragEnd` handler with the hook.
3. **Worktree env controls** (start/stop/restart in `WorktreeHeaderPill`,
   `EnvironmentTab`).
4. **Settings modals** (`SettingsModal/*`, `WorktreeModal/tabs/*`) — highest
   site count, lowest stakes (settings rarely change during a disconnect).
5. **Comments, reactions, presence broadcast** — these are stream-dependent
   too; consider gating at the hook level (`useComments`, `usePresence`).

### Phase 3 — Mutation-layer backstop

Add `withMutationGuard` proxy. Audit any remaining failures by grepping logs
for `DisconnectedError`. By the end of Phase 2 this should be a no-op safety
net.

### Phase 4 — Polish

- `<SessionPaneShell>` empty state for the composer.
- Optional: queue pending prompts in `localStorage` while disconnected and
  restore-on-reconnect (Approach E lite — only safe for prompts the user
  explicitly opted to "queue").
- Sister-branch `fix-reconnect-loop` will land in parallel; nothing here
  conflicts.

**Estimate of sites to gate:** ~80–120 (~177 raw `.create/.patch/.update/.remove`
matches across 39 files, minus reads and false positives). Most can be done by
find-and-replace at the import + JSX level.

---

## 6. Open questions

1. **Drag-drop on the canvas while disconnected.** Three options:
   (a) make cards undraggable when disconnected (visually cleanest);
   (b) allow drag, snap back on drop with a toast (worst UX);
   (c) allow drag, no-op on drop (quiet UX, but local state would briefly lie
   about the new position before snapping back). Recommendation: **(a)**, set
   `draggable={gate.canMutate}` on the React Flow nodes.

2. **Session pane: collapse, freeze snapshot, or show degraded shell?**
   Max floated "close it." My recommendation is **degraded shell**: keep the
   pane open, freeze the composer with an empty state, leave scrollback
   visible. Closing is jarring (loses user's context); a snapshot-only view
   preserves the read-only spirit of the broader design.

3. **Should typing in the composer be allowed while disconnected?**
   Yes — let the user draft a prompt; just gate Send. (The composer is
   already a controlled local state machine.) But: clear it on a long
   disconnect (>30s)? Probably no — user expectation is that a draft is safe.

4. **Out-of-sync = blocking?** Today the pill is amber and click-to-reload.
   Should mutations be hard-blocked while out-of-sync, or just soft-warned?
   Recommendation: **hard-block via the same `useMutationGate` reason
   ('out-of-sync')** — daemon schema has changed under the UI, mutating is
   asking for trouble.

5. **Banner placement on mobile.** Mobile already has a separate route tree
   (`apps/agor-ui/src/components/mobile/*`). The same `<DisconnectedBanner>`
   can mount above mobile shell, but it'll need a smaller variant or to
   collapse the existing top bar. Defer to mobile-aware design pass.

6. **Toast vs. silent no-op for mutation-layer backstop?** If the gate proxy
   throws and a consumer doesn't catch, do we render a global toast? Probably
   yes — but only one toast at a time (debounced), since the banner already
   provides primary signal.

---

## Appendix: file pointers

**Existing infrastructure:**

- `apps/agor-ui/src/contexts/ConnectionContext.tsx` — context + `useConnectionDisabled`
- `apps/agor-ui/src/App.tsx:1283` — `<ConnectionProvider>` mount
- `apps/agor-ui/src/hooks/useAgorClient.ts:216-362` — socket lifecycle, grace period, retry backoff
- `apps/agor-ui/src/components/ConnectionStatus/ConnectionStatus.tsx` — existing pill
- `packages/core/src/api/index.ts:708-781` — Feathers + Socket.io client setup

**Existing gates (the working examples to follow):**

- `apps/agor-ui/src/components/NewSessionButton/NewSessionButton.tsx:10`
- `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx:252,907,924,932,940,956`
- `apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx`
- `apps/agor-ui/src/components/SessionCard/SessionCard.tsx`

**High-priority mutation hubs (Phase 2):**

- `apps/agor-ui/src/hooks/useSessionActions.ts` — prompt/fork/spawn/create
- `apps/agor-ui/src/hooks/useBoardActions.ts` — board CRUD
- `apps/agor-ui/src/hooks/useAgorData.ts` — data layer (24 mutation sites)
- `apps/agor-ui/src/components/SessionCanvas/canvas/useBoardObjects.ts` — drag/drop
