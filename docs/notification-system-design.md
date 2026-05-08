# Agor Notification System — Design Doc (DRAFT)

**Status:** Design / awaiting Max's review before implementation
**Author:** Claude (design pass)
**Date:** 2026-05-08
**Branch:** `design-notification-system`

---

## TL;DR

Agor has good *toasts* (Ant Design `message` API at `apps/agor-ui/src/utils/message.tsx`) and a strong real-time push pipe (`app.io.to(userRoomName(userId))` in `apps/agor-daemon/src/setup/socketio.ts:193,379`), but **no durable inbox**. Today, when an agent completes a task while you're on another board — or a teammate `@`-mentions you in a comment — there's no centralized record of "things that happened while you were away." The `unreadCommentsCount` badge on the navbar's comments button (`AppHeader.tsx:277-293`) only reflects the *current* board.

This doc proposes a `notifications` table, a per-user real-time push, a bell-icon panel in the navbar, and a clear toast-vs-notification rule. It takes positions on the open questions Max raised. It explicitly **scopes out** the navbar message ticker for v1 (and defends that cut), recommends **server-driven unread counts** (not the client-derived pattern used for comments today), and proposes a **collapse-per-(session,type)** model so a chatty agent doesn't fan out into a 50-row panel.

**Not in this doc:** code. This is design + open questions. Implementation lands in a follow-up.

---

## 1. Goals + Non-goals

### 1.1 Goals

- **One bell, one panel, one counter** — every "something you should know" surfaces here.
- **Durable across sessions and devices** — notifications survive page reload and follow the user, not the tab.
- **Real-time delivery** — uses the existing socket pipe; new notifs animate in without a refresh.
- **Clear rule for toast vs notification** — so future contributors don't have to ask.
- **Cheap to extend** — adding a new notification type later is a schema enum + a producer call site.

### 1.2 Non-goals (v1)

- **Email / push / SMS** — out of scope; web-only delivery.
- **Digest / batching** — no "you have 7 unread" emails.
- **Per-event subscription UI** — opt-out lives at the *session* level (archive = unsub). No per-type granular subscription panel.
- **Rich-content notifs** — no embedded video, no rendered code blocks. Title + 1-line preview + link.
- **Slack/Discord parity** — gateway integrations stay in the gateway layer (`apps/agor-daemon/src/services/gateway-channels.ts`); the in-app notification system doesn't try to be a chat app.
- **Navbar message ticker** — see §3.5; explicit scope cut.

---

## 2. Current state inventory

What exists today, citation-heavy so the implementer can plug in:

| Capability | Today | File pointer |
|---|---|---|
| **Toast / message API** | Ant Design `message`, wrapped via `useThemedMessage()` (`showSuccess`/`showError`/etc.) | `apps/agor-ui/src/utils/message.tsx` |
| **Per-user socket push** | `app.io.to(userRoomName(userId)).emit(event, payload)`. Sockets join `user/{user_id}` on auth | `apps/agor-daemon/src/setup/socketio.ts:193, 379` |
| **Authenticated broadcast** | `app.channel('authenticated')` — joined on login, left on logout | `apps/agor-daemon/src/setup/socketio.ts:735-765` |
| **Service-event push** | `app.service(name).emit(event, data)` — Feathers fans out to subscribed clients | `register-routes.ts` (many sites, e.g. `:585, :2271, :2297`) |
| **Comments unread badge** | Client-side derived from `commentById` map filtered to current board. **Not durable, single-board only.** | `apps/agor-ui/src/components/App/App.tsx:672-689` |
| **Mentions** | `comment.data.mentions: string[]` (Phase 4). Detection is **substring match on `@username` / `@email`** in comment content | `apps/agor-ui/src/components/App/App.tsx:678-689`; schema at `schema.sqlite.ts:1260-1262` |
| **"Session needs attention"** | `session.ready_for_prompt: bool`. Set true on task COMPLETED/FAILED; cleared when user opens conversation drawer | `packages/core/src/types/session.ts:314`; `apps/agor-daemon/src/services/tasks.ts` |
| **"Worktree needs attention"** | `worktree.needs_attention: bool` — cumulative over sessions in the worktree | `packages/core/src/types/worktree.ts:252` |
| **Archive state** | `session.archived` + `worktree.archived` + `worktree.archived_at` | `schema.sqlite.ts:97, worktree fields` |
| **Parent-callback queueing** | When a *child* session completes, parent gets a queued system message. **This is agent↔agent, not user↔agent** | `context/explorations/parent-session-callbacks.md` |
| **Favicon unread indicator** | `useFaviconStatus.ts` already swaps the favicon based on `ready_for_prompt` aggregate | `apps/agor-ui/src/hooks/useFaviconStatus.ts` |
| **Audio chime** | `user.preferences.audio.enabled` — already plays on session ready | `packages/core/src/types/user.ts:329-337` |

**Key takeaway:** the building blocks are already there. The missing piece is a *recipient-addressed durable record* — i.e., a row that says "user X should be told about event Y, here's the link, marked unread." Today the system has plenty of *events*, no *inbox*.

---

## 3. User-facing experience

### 3.1 Bell + counter

A new bell button on `AppHeader.tsx`, on the **right side**, between the Facepile/divider and the Live Event Stream button. It uses the same `<Badge>` pattern as the existing comments button:

```tsx
<Badge count={unreadCount} offset={[-2, 2]}>
  <Button type="text" icon={<BellOutlined />} onClick={togglePanel} />
</Badge>
```

**Counter semantics:**

- Counter = `notifications WHERE recipient = me AND read_at IS NULL AND dismissed_at IS NULL`.
- Capped at `99+` for display sanity.
- Red when there's a mention (matching the `colorError` precedent at `AppHeader.tsx:281`).

**Why right side, not left next to comments?** Comments live on the left because they're *board-scoped*. Notifications are *user-scoped, cross-board* — they belong on the right rail with the user-identity affordances (facepile, settings, user menu). This also avoids stacking two separate badges next to each other.

### 3.2 Panel layout

A `<Popover>` (consistent with the existing `instanceDescription` popover at `AppHeader.tsx:222-235`), opened on bell click. **Not a drawer** — drawers are heavy and we already have one (the session list). Popovers are right for read-mostly lists.

```
┌─ Notifications ─────────────────────────── [✓ Mark all read] ─┐
│                                                                │
│  ⚠️  Deploying around noon PST today  ──────────── 2h ago  [×] │  ← global admin
│      Max · sticks until expiry                                 │
│  ─────────────────────────────────────────────────────────────│
│  💬  Alice mentioned you in a comment ──────────── 12m ago [×]│  ← mention
│      "@you can you look at this?"                              │
│      auth-rewrite (fix-jwt) · my-board                         │
│  ─────────────────────────────────────────────────────────────│
│  🌳  Session returned: "Refactor login flow"  ──── 34m ago [×]│  ← session-returned (worktree)
│      auth-rewrite · 3 messages, 4 tools · ⬢ claude-code        │
│  ─────────────────────────────────────────────────────────────│
│  🤖  research-bot finished its run  ─────────────── 1h ago [×]│  ← session-returned (assistant)
│      "Found 12 candidate libraries…"                           │
│  ─────────────────────────────────────────────────────────────│
│                                                                │
│                       View all (12)                            │  ← only if >10 unread+read shown
└────────────────────────────────────────────────────────────────┘
```

- **Sort:** strict `created_at DESC`. No grouping by type, no priority lanes — that's a category-error path that adds modes without adding clarity.
- **Read state on open:** opening the panel does **not** auto-mark-read. Hovering an item for 1.5s, *or* clicking it, marks it read. (Pattern stolen from Linear.) This avoids the "blink and you lose your place" problem where opening to peek wipes the badge.
- **Dismiss:** the `[×]` is explicit. Dismissed notifs disappear immediately.
- **Mark all read:** affordance in the header (resolves Max's open question — yes, ship it).
- **Limit:** show the most recent 20 in the popover. "View all" link goes to `/notifications` if we want a full inbox view later (out of v1).

### 3.3 Notification card anatomy

Three visual variants, distinguished by an icon glyph + a left accent stripe. Layouts use the same height (~56px) so the list is uniform.

```
USER MESSAGE (mention)         WORKTREE SESSION RETURNED        ASSISTANT RETURNED
┌────────────────────────┐     ┌────────────────────────┐      ┌────────────────────────┐
│ 💬 Alice mentioned you │     │ 🌳 Session returned    │      │ 🤖 research-bot done   │
│    "look at this?"     │     │    auth-rewrite        │      │    "Found 12 libs…"    │
│    fix-jwt · my-board  │     │    ⬢ claude-code · 3m  │      │    daily-audit · 1h    │
└────────────────────────┘     └────────────────────────┘      └────────────────────────┘
   ▲                              ▲                                ▲
   blue accent stripe              green accent stripe              purple accent stripe
   colorPrimary                    colorSuccess                     colorInfo (or assistant theme)
```

**Differentiation strategy:**

- **Glyph in front:** 💬 (mention), 🌳 (worktree session — matches the existing `🌳 my-worktree` line in the session drawer per `WorktreeListDrawer.tsx`), 🤖 (assistant), ⚠️/ℹ️ (admin).
- **Color stripe:** uses Ant Design tokens (`colorPrimary`, `colorSuccess`, `colorInfo`, `colorWarning`) so it picks up theme correctly.
- **Tool icon (`<ToolIcon>`)** on session-returned variants — already exists, used in the session drawer. Tells you at a glance whether Claude, Codex, or Gemini returned.

**Open question — assistant vs worktree session:** today there's no `is_assistant` flag on a session in the schema (I checked `schema.sqlite.ts:43-182`). For v1, treat all session-returned notifs as the worktree variant. Add a follow-up to materialize an "assistant session" marker when persistent assistants land — at that point we can switch the icon/color. This is a **scope cut** disguised as a follow-up; flagged in §10.

### 3.4 Sticky banner (global admin messages)

Some admin messages should be more in-your-face than a panel item. For those, render a sticky banner **in the navbar's currently-empty center slot** (between `RecentBoardPills` and the right-side controls). Triggered by `notification.scope = 'global'` AND `notification.data.banner = true`.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [logo] Agor [board] [pills] | ⚠️ Deploying around noon PST [×] | [users]│
└──────────────────────────────────────────────────────────────────────────┘
```

Rules:

- Only **one** banner shown at a time. If two are active, the most recent wins; older ones live in the panel only.
- Banner is dismissible (per-user `dismissed_at` on the notification row). Dismissing kills the banner *and* the corresponding panel item.
- Banner respects an optional `expires_at` on the notification — auto-removed when expired.
- **Cap on length:** ~80 chars in the navbar. Longer content lives in the panel.

### 3.5 Navbar message ticker — scope-cut for v1

Max's brief floats a "🌳 {worktree}: {truncated agent response}" ticker that fades messages in and out in unused navbar space. It's a fun idea. **I'm cutting it from v1.** Reasons:

1. **Distraction-to-utility ratio is poor.** A ticker drawing the eye every few seconds in a tool you stare at all day is a focus tax. Slack tried this with "currently typing in #channel" tickers and walked it back.
2. **Display real-estate is contested.** The navbar center is also where the sticky admin banner wants to live. Time-sharing two animated UIs in the same slot is messy.
3. **It's a separate problem from "notifications."** A ticker is *ambient awareness* — closer to the Facepile or live cursor presence than to an inbox. Conflating it with notifications muddies both.
4. **Easy to add later.** The data is already in `app.service('messages').emit('message …')`. A ticker is a thin client-side component subscribing to that stream. We can ship it post-v1 if Max wants the experiment.

**Recommendation:** revisit ticker as a separate `--feature` flag-gated experiment after v1 lands. If it's compelling, it gets its own design pass.

### 3.6 Toast vs notification — the rule

Codify in `apps/agor-ui/src/utils/message.tsx` doc-comment + a guide page. Proposed rule:

> **Use a toast (Ant Design `message`) when:**
> - The user just took an action and you're confirming it ("Saved", "Copied").
> - There's an error tied to the user's *current* action that won't be retried automatically.
> - The information has no value 5 minutes from now.
>
> **Use a notification when:**
> - The event happened *to* the user, not *because of* the user (an agent finished, a teammate tagged them).
> - The user might miss it because they're on another board / tab / device.
> - It needs to be actionable later, not just acknowledged now.

Concrete examples:

| Event | Toast or Notification? |
|---|---|
| "Worktree saved" | Toast |
| "Failed to connect to daemon" (current request) | Toast |
| "Session 'X' returned with PR" | Notification |
| "Alice mentioned you in a comment" | Notification |
| "Deploying at noon PST" (admin broadcast) | Notification (+ banner) |
| "Copied to clipboard" | Toast |
| "OAuth flow completed in another tab" | Toast (already handled by `oauth:completed` socket event) |
| "MCP server disconnected" | Toast in the moment + Notification if the user owns that server's session |

When both apply (e.g. the user kicked off a long-running task and it returned hours later) — emit **both**. The toast confirms the moment-of-return if you're looking; the notification is the durable record for if you weren't.

---

## 4. Notification types — v1 taxonomy

Hold the line on a small set. Each one needs a clear trigger, recipient set, and link target.

| Type | Trigger | Recipient(s) | Link target | Default subscription |
|---|---|---|---|---|
| **`mention`** | `board_comments.created` or `.patched` where `data.mentions[]` includes a user_id (or content matches `@username` / `@email` per existing detection) | Each mentioned user | Board, comments panel open, scrolled to comment | Always (mentions are always opt-in by definition) |
| **`session_returned`** | `tasks.patch` sets `status` to `COMPLETED` or `FAILED` AND parent session's `worktree.archived = false` AND `session.archived = false` | Subscribers of the session (see §6) | Session detail panel open in the right board | Subscribed automatically (see §6) |
| **`global_admin`** | Admin authors a global message (see §7) | All users (fanout) | Optionally a URL; otherwise just the panel | Always (one slot, dismissible) |

**Out of v1, listed for completeness:**

| Type | Why deferred |
|---|---|
| `worktree_created` | Too noisy. In a multi-user instance, every teammate creating a worktree would trigger one. The board itself is the surface for this. |
| `session_created` | Same as above. |
| `environment_started` / `environment_failed` | Ephemeral. Toast in the moment is sufficient. |
| `schedule_fired` | If a scheduled prompt produces a session that returns, the *return* notif covers it. The fire itself isn't actionable. |
| `child_session_completed` (parent callback) | Already handled by the queued-system-message pipe in `parent-session-callbacks.md`. That's an agent↔agent channel, not a user-addressed inbox. Don't double-deliver. |
| `oauth_disconnected` | Toast on the active session is enough. Future: notification if the disconnect happens while the user is on another board. |
| `comment_reply` (you commented, someone replied) | v2. Requires a thread-participation tracker. |

---

## 5. Data model

### 5.1 Schema sketch (sqlite + postgres parallel)

Following the conventions at `schema.sqlite.ts` (hybrid materialize + JSON, branded IDs, indexed by access pattern).

```typescript
// packages/core/src/db/schema.sqlite.ts
export const notifications = sqliteTable(
  'notifications',
  {
    notification_id: text('notification_id', { length: 36 }).primaryKey(),
    created_at: t.timestamp('created_at').notNull(),

    // Recipient — every notification is per-user. Global admin messages fan out
    // (one row per user) for query simplicity. With ~10–100 users typical,
    // fanout cost is negligible vs the join-on-broadcast-table alternative.
    recipient_user_id: text('recipient_user_id', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),

    // Type discriminator — kept tight. Adding a value is a migration.
    type: text('type', {
      enum: ['mention', 'session_returned', 'global_admin'],
    }).notNull(),

    // Display fields (materialized so the panel renders without joins)
    title: text('title').notNull(),                // ~80 chars
    preview: text('preview'),                      // ~160 chars, optional
    link_url: text('link_url'),                    // optional override; otherwise computed from source_*

    // Source pointers — all optional, depend on type. set null on cascade so
    // a deleted session/worktree leaves the notif row visible (with a "this
    // session was deleted" fallback in the UI) rather than yanking history.
    source_session_id: text('source_session_id', { length: 36 })
      .references(() => sessions.session_id, { onDelete: 'set null' }),
    source_worktree_id: text('source_worktree_id', { length: 36 })
      .references(() => worktrees.worktree_id, { onDelete: 'set null' }),
    source_board_id: text('source_board_id', { length: 36 })
      .references(() => boards.board_id, { onDelete: 'set null' }),
    source_comment_id: text('source_comment_id', { length: 36 })
      .references(() => boardComments.comment_id, { onDelete: 'set null' }),
    source_task_id: text('source_task_id', { length: 36 }), // no FK; tasks can be ephemeral
    source_user_id: text('source_user_id', { length: 36 })  // who triggered (e.g. who tagged me)
      .references(() => users.user_id, { onDelete: 'set null' }),

    // State
    read_at: t.timestamp('read_at'),               // null = unread
    dismissed_at: t.timestamp('dismissed_at'),     // null = not dismissed
    expires_at: t.timestamp('expires_at'),         // optional auto-expiry (admin banners)

    // Scope — 'user' = recipient-only, 'global' = part of an admin broadcast
    // (still stored per-row, marker for UI styling + grouping).
    scope: text('scope', { enum: ['user', 'global'] }).notNull().default('user'),

    // Type-specific extras: { banner?: bool, agentic_tool?: string,
    //   message_count?: number, mention_excerpt?: string, ... }
    data: t.json<NotificationData>('data').notNull().default(sql`'{}'`),
  },
  (table) => ({
    // Primary read pattern: "give me this user's unread notifs, newest first"
    recipientUnreadIdx: index('notifications_recipient_unread_idx')
      .on(table.recipient_user_id, table.dismissed_at, table.created_at),
    // For collapse-by-source (see §5.2)
    recipientSourceIdx: index('notifications_recipient_source_idx')
      .on(table.recipient_user_id, table.source_session_id, table.type),
    // For mark-all-read sweeps
    readIdx: index('notifications_read_idx').on(table.recipient_user_id, table.read_at),
  })
);
```

### 5.2 Collapse policy

Open question Max raised: "if a session has 5 events in a row, do we get 5 notifs or 1?" **Position: 1, collapsed.**

- For `type = session_returned`, the producer (the tasks patch hook) does a **conditional upsert** keyed on `(recipient_user_id, source_session_id, type) WHERE dismissed_at IS NULL`:
  - If a non-dismissed row exists, **bump** `created_at` to now, refresh `title`/`preview`/`source_task_id`, set `read_at = NULL`. The existing row floats to the top, badge re-increments.
  - Otherwise, INSERT.
- For `type = mention`, **don't collapse**. Each mention is a distinct fact; a teammate tagging you twice in the same comment thread is two separate things you want to see.
- For `type = global_admin`, no collapse — distinct broadcasts are distinct.

### 5.3 Read vs dismissed

Max's guess in the brief: read = seen in panel, dismissed = explicitly cleared. **Confirmed.** They're separate columns:

| State | `read_at` | `dismissed_at` | Counter? | Visible in panel? |
|---|---|---|---|---|
| New | NULL | NULL | yes (counted) | yes |
| Read | set | NULL | no | yes |
| Dismissed | (any) | set | no | no |

Counter = `COUNT(*) WHERE recipient = me AND read_at IS NULL AND dismissed_at IS NULL`.

Dismissing is implicitly "I'm done with this" — we don't need a `read_at` for dismissed rows.

### 5.4 Indexes

Three indexes cover all v1 access patterns (panel list, unread count, collapse upsert, mark-all-read). All are recipient-leading because every read scopes by user. Index sizes are bounded by *active* notifications per user — if growth is a concern long-term, add a retention sweep (see §10).

---

## 6. Subscription model

Max's framing: "safe to assume every session, until archived, is expecting people to go back to it. So default to opt-out, archive = unsub."

I want to **refine** that, because in a multi-user instance "every session" is too broad. If 5 teammates each have 3 active sessions, every user gets pinged for 15 sessions worth of events. That's the spam path that kills notification systems.

**Proposed refinement: subscribe on *interaction*, not on *visibility*.**

You're auto-subscribed to a session iff one of these is true:

1. **You created it** (`session.created_by = you`).
2. **You prompted it** (any task in the session has `created_by = you`).
3. **You were @-mentioned in a comment attached to that session.** (Stretch — defer if implementation cost is real; covers shared-debug scenarios.)

You stay subscribed until any of:

- The session is archived.
- The worktree is archived.
- You explicitly mute the session (v1.5 feature; see §10).

**Why this works:**

- Matches the "did I touch this?" mental model. Walking past someone's session in the board doesn't subscribe you.
- Doesn't require any new `subscriptions` table — it's a query over `sessions.created_by` and `tasks.created_by`. Cheap.
- Handles the shared-team case naturally: if you've never prompted Alice's session, you don't get pinged when her agent returns.
- Covers Max's "no per-session config burden" — you don't toggle anything; you just *do* things, and that subscribes you.

**Implementation note:** the session_returned producer hook (in `tasks.ts` patch handler, alongside the existing `ready_for_prompt = true` set at line ~93–124) needs to compute the recipient set:

```
recipients = DISTINCT (
  SELECT created_by FROM sessions WHERE session_id = $sid
  UNION
  SELECT created_by FROM tasks    WHERE session_id = $sid
)
```

…filtered to users that still exist. One row inserted (or upserted-collapsed) per recipient.

### 6.1 Cross-device sync

Notifications follow the user, not the browser tab. Two open tabs = same panel state because both subscribe to the same `user/{user_id}` socket room and both query the same backing table. No additional sync logic.

### 6.2 Archive semantics

- `worktree.archived = true` → no future `session_returned` notifs for any session in that worktree.
- `session.archived = true` → no future `session_returned` notifs for that session.
- **Pre-existing notifs** for the now-archived session: leave them. The user might still want to dismiss/click them. They just won't get new ones.

---

## 7. Admin flow for global messages

**Who can author:** users with `role >= admin` (consistent with the existing `WEB_TERMINAL_MIN_ROLE` and other privileged-feature gates per `App.tsx:719`). Authoring requires admin role; *authenticated* recipients receive (joined to the `'authenticated'` channel).

**Where to author:** new tab in `SettingsModal` called "Announcements". Listed alongside `UsersTable.tsx`, `BoardsTable.tsx`, etc. (already the pattern at `apps/agor-ui/src/components/SettingsModal/`).

**Authoring UI sketch:**

```
┌─ Settings → Announcements ──────────────────────────────────────┐
│                                                                  │
│  [+ New announcement]                                            │
│                                                                  │
│  ── Active ────────────────────────────────────────────────────  │
│                                                                  │
│  ⚠️ Deploying around noon PST today                              │
│     Banner: yes · Expires: in 4h · Recipients: all (12)          │
│     [Edit] [Expire now]                                          │
│                                                                  │
│  ── Past (last 30d) ───────────────────────────────────────────  │
│  ℹ️  Welcome to v0.18 — see the changelog                        │
│     Sent 2026-04-30 · Expired 2026-05-02                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Compose modal:**

```
┌─ New announcement ──────────────────────────────────────────────┐
│                                                                  │
│  Title:    [⚠️] [ Deploying around noon PST today           ]   │
│            (icon picker · 80 char cap)                          │
│                                                                  │
│  Preview:  [ The daemon will be down for ~10 minutes…         ] │
│            (160 char cap, optional)                              │
│                                                                  │
│  [ ] Show as sticky banner in the navbar                         │
│  [ ] Auto-expire after [4] [hours ▼]                             │
│                                                                  │
│                                       [Cancel]  [Send to all]   │
└──────────────────────────────────────────────────────────────────┘
```

**Backend mechanics:**

- New service method `notifications.broadcast()` (admin-gated by Feathers hook, similar to the `register-services.ts` pattern that branches on RBAC mode).
- The service inserts one notification row per active user via a single SQL `INSERT … SELECT` from `users`, then emits `app.io.to(userRoomName(user.user_id)).emit('notification:created', row)` for each, OR — simpler — `app.channel('authenticated').publish(...)` for a single broadcast event clients filter by `recipient_user_id`. Either works; the per-room emit is more bandwidth-efficient at scale.
- Admin can **expire** an active broadcast: bumps `expires_at` to now for all rows in the broadcast group. Banner disappears in real time via socket update.

**Open question:** do we want a *broadcast group* concept (one logical broadcast → many notification rows, joined by a `broadcast_id`), so editing/expiring one updates all? **Yes for v1 if it's cheap.** Add `data.broadcast_group_id: string` to all rows in a broadcast — that's the hook for bulk operations. No separate table needed.

---

## 8. Delivery + sync

### 8.1 Push (primary)

On notification create:

```typescript
// daemon-side
const row = await notificationsRepo.upsertCollapsed({...});
app.io.to(userRoomName(row.recipient_user_id)).emit('notification:created', row);
```

Client subscribes once on app boot in `useAgorData.ts` (alongside the existing service subscriptions):

```typescript
client.io.on('notification:created', (row) => store.upsert(row));
client.io.on('notification:patched', (row) => store.upsert(row));
client.io.on('notification:removed', (row) => store.remove(row.notification_id));
```

This piggybacks on the `user/{user_id}` socket room joined at `socketio.ts:379`. **No new auth or channel infra.**

### 8.2 Initial fetch (panel open)

On panel open, fetch the latest 50 unread + read-not-dismissed:

```
GET /notifications?
  recipient_user_id=me
  &dismissed_at[$eq]=null
  &$sort[created_at]=-1
  &$limit=50
```

Standard Feathers paginated find. Hooks enforce `recipient_user_id = authenticated user_id` — a user cannot fetch someone else's notifications.

### 8.3 Polling fallback

If the socket is disconnected for >30s and reconnects, the client refetches. This handles laptop-sleep scenarios where the socket dies silently. Otherwise no polling.

### 8.4 Counter delta

The `<Badge>` component subscribes to a derived `unreadCount` selector over the local store. New notif → store.upsert → counter recomputes. No extra round-trip for the count.

---

## 9. Visual mocks

### 9.1 Bell + counter (navbar right side)

```
…[facepile]│ [API] 🔔₃ [?] [☀] [⚙] [👤]
                  ▲
                  bell with red dot when count includes a mention,
                  primary-bg dot otherwise (mirrors comments badge)
```

### 9.2 Panel — full

See §3.2 above.

### 9.3 Notification card — three variants

See §3.3 above. Compact form, ~56px tall, uniform across types.

### 9.4 Sticky admin banner (navbar center)

```
┌─────────────────────────────────────────────────────────────────────┐
│ [logo] Agor [board:auth-rewrite] [⌂ ⌂ ⌂] │  ⚠️ Deploying noon PST [×] │ [users] [API] 🔔 [?] [☀] [⚙] [👤]│
└─────────────────────────────────────────────────────────────────────┘
```

When no active banner, the center collapses; the existing layout doesn't shift (right-justified items stay anchored).

### 9.5 Empty state

```
┌─ Notifications ──────────────────────────────────────────┐
│                                                           │
│                          🔔                               │
│                                                           │
│              You're all caught up.                        │
│       Notifications about sessions you're working         │
│       on, mentions, and announcements appear here.        │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### 9.6 UI primitives we already have — reach for these

- **`<Badge>`** (Ant Design) — counter on bell. Same usage as `AppHeader.tsx:277`.
- **`<Popover>`** (Ant Design) — panel container. Same usage as `AppHeader.tsx:222`.
- **`<List>`** — *don't* use. Recently deprecated in this codebase per commit `a5accb91 chore(ui): migrate off deprecated AntD <List>`. Use a flex column of cards instead.
- **`<ToolIcon>`** — already exists, used in the session drawer. Drop it on session-returned cards.
- **`formatRelativeTime`** (`apps/agor-ui/src/utils/time.ts`) — for "12m ago" timestamps. Tooltip with `formatAbsoluteTime` for hover. Same as the session-drawer-improvements doc proposes.
- **`<MarkdownRenderer>`** — for the optional admin banner description, if we want it richer than plain text in the banner popover-on-hover. Same as `AppHeader.tsx:225`.

---

## 10. Open questions / decisions deferred

Numbered to match the brief's open questions where applicable.

| # | Question | Position |
|---|---|---|
| 1 | Notification entity schema | §5 — schema sketched, recipient-leading indexes |
| 2 | Persistent table vs in-memory | **Persistent.** Durability across reload + cross-device sync requires it |
| 3 | Delivery channel | **Socket primary, fetch on bell-open, refetch-on-reconnect fallback.** No polling steady-state |
| 4 | Read vs dismissed | **Different states.** §5.3. Counter = unread-and-not-dismissed |
| 5 | Click-through dismiss | **Don't auto-dismiss on click.** Click marks read, dismiss is explicit. Matches Max's lean |
| 6 | Session vs task linking | **`source_session_id` is the link target. `source_task_id` is metadata.** Tasks are the unit of work; sessions are the place you go back to |
| 7 | De-dup / collapse | **Collapse `session_returned` per `(user, session, type)`. Don't collapse `mention` or `global_admin`.** §5.2 |
| 8 | Mute / snooze per session | **v1.5.** Add a `data.muted_at` flag at the session level, exclude muted sessions from producer logic |
| 9 | Cross-device sync | **Free** — same backing table, same socket room, two tabs see the same state |
| 10 | Permissions on global messages | **Admin role.** Authored from a new `SettingsModal` tab. §7 |
| 11 | Ticker / streamer rules | **Cut from v1.** §3.5 |
| 12 | Notification taxonomy | **§4.** Three types in v1: mention, session_returned, global_admin |

**Genuinely deferred (need Max's call before implementation):**

- **Q-A:** Is the *interaction-based* subscription model (§6) acceptable, or does Max want literal "every session you can see, until archived"? My read: literal-everyone is too noisy in multi-user instances. But this is a product call.
- **Q-B:** Mention detection today is **substring matching** in `App.tsx:678-689` — `@username` or `@email` in raw content. Phase 4 of board-comments adds an explicit `data.mentions: string[]`. Should the notification producer use the explicit field (more precise, requires the comment editor to populate it correctly) or fall back to substring (matches current detection, ships sooner)? **My recommendation: explicit field, populated by the comment editor at write time, which is a small additional task on the comments side.** But if we want notifications to ship before that lands, substring detection is fine as a stop-gap.
- **Q-C:** "Assistant session" vs "worktree session" visual differentiation requires an `is_assistant` marker we don't have. v1 ships with one variant ("worktree session"); the assistant variant ships when persistent assistants get a schema marker. Confirm this is OK as a follow-up rather than a v1 prereq.
- **Q-D:** Retention. Should old dismissed notifs be hard-deleted (e.g., `dismissed_at < now() - 30d`)? **Recommendation: yes, retention sweep at 30 days for dismissed, 90 days for read-not-dismissed.** Cheap cron job. Defer to v1.5 unless table size becomes a concern.
- **Q-E:** Should `session_returned` fire on `FAILED` as well as `COMPLETED`? **Yes** — failures are exactly the kind of "you should look at this" event a notification system exists for. Mirrors the parent-callback design (`parent-session-callbacks.md` §1.2).

---

## 11. Phased delivery plan

### v1 — the core inbox

- Schema migration (`notifications` table, indexes).
- `NotificationsService` (Feathers, `find`/`get`/`patch`/`remove` + custom `broadcast`).
- Producers in `tasks.ts` (session_returned) and `board-comments.ts` (mention).
- Bell + counter on `AppHeader` right side.
- Panel with the three card variants, mark-read-on-click/hover, explicit dismiss, mark-all-read.
- Sticky admin banner in navbar center.
- Settings → Announcements admin tab (compose, list, expire).
- Socket push wired through existing `user/{user_id}` rooms.
- Toast-vs-notification rule documented in `apps/agor-docs/pages/guide/` and as a JSDoc on `useThemedMessage`.

### v1.5 — quality of life

- **Mute per session** — surface in the session settings panel.
- **Snooze for N hours** — per-notification action.
- **Retention sweep** — delete dismissed notifs older than 30d.
- **Full inbox view** at `/notifications` — uses the same backing query, paginated, no popover.
- **Assistant-session variant** — once persistent assistants land with a flag.

### v2 — channels beyond the app

- Email digests (opt-in, daily).
- Push notifications via service worker.
- Slack/Discord delivery via `gateway-channels`.
- Integration with `gateway` so a notification can be authored in a Slack message and arrive in-app.

---

## 12. Effort estimate (rough)

For a single engineer familiar with the codebase. Timeboxes are *rough order of magnitude*, not commitments.

| Area | Effort |
|---|---|
| **Schema + migration** (sqlite + postgres + types) | 0.5d |
| **Repository + service** (`NotificationsRepository`, `NotificationsService`, broadcast method, hooks) | 1d |
| **Producer wiring** (tasks.ts patch hook, board-comments hooks for mention detection) | 1d |
| **Socket push + client subscription** (piggyback on existing rooms) | 0.5d |
| **Bell + counter** (AppHeader integration, `<Badge>`) | 0.5d |
| **Panel UI** (popover, card variants, mark-read, dismiss, mark-all-read) | 1.5d |
| **Sticky admin banner** (navbar center slot, dismiss, expiry) | 0.5d |
| **Admin authoring UI** (SettingsModal tab, compose modal, list view) | 1d |
| **Toast-vs-notification doc + guide page** | 0.25d |
| **Tests + Storybook** (panel + cards + counter) | 1d |
| **Smoke test + screenshot pass** | 0.25d |

**Total ballpark:** ~7–8 engineering days for a single contributor end-to-end. Closer to ~10 once code review, schema migration coordination across sqlite+postgres, and the inevitable scope creep are factored in.

**Easy parallelization split:**
- Backend (schema, service, producers, push) — ~3.5d
- Frontend (bell, panel, banner, admin UI) — ~3.5d

---

## 13. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Spam from over-subscription** | High if §6 is wrong | Medium | Interaction-based subscription (§6), per-session mute in v1.5 |
| **Counter desync** (badge says 3, panel shows 0) | Medium | Low | Server-driven counter from the same table the panel reads. Single source of truth |
| **Mention detection misses or false-positives** | Medium | Low | Switch to explicit `data.mentions[]` once comment editor populates it (Q-B) |
| **Admin-banner abuse** (spammy broadcasts) | Low | Medium | Admin-only authoring, expiry required, single banner slot |
| **Table growth** | Low (small instances) → Medium (large instances) | Low | Retention sweep in v1.5 |
| **Socket-disconnect window** missing notifs | Medium | Low | Fetch-on-reconnect fallback (§8.3) |

---

## 14. What this doc explicitly does NOT propose

To avoid scope creep:

- **No notification preference UI.** Subscription is interaction-based; mute is per-session in v1.5. No global per-type settings page.
- **No browser-native `Notification` API.** Web push is v2.
- **No webhook/external delivery.** v2.
- **No notification grouping by session in the panel.** Flat sort by recency. Grouping adds modes without adding clarity in a 20-row list.
- **No "important" / priority lanes.** Type already implies priority (admin > mention > session_returned in the eye, but not in the sort).
- **No read-receipts on mentions.** Outside the inbox model.

---

## 15. Where to put what

For the implementer:

| Concern | Location |
|---|---|
| Schema | `packages/core/src/db/schema.{sqlite,postgres}.ts` (new `notifications` table) |
| Drizzle migration | `packages/core/drizzle/sqlite/0042_add_notifications.sql` + matching postgres `0032_add_notifications.sql` |
| Type | `packages/core/src/types/notification.ts` (new) |
| Repository | `packages/core/src/db/repositories/notifications.ts` (new) |
| Service | `apps/agor-daemon/src/services/notifications.ts` (new) |
| Service registration | `apps/agor-daemon/src/register-services.ts` |
| Producer (session_returned) | `apps/agor-daemon/src/services/tasks.ts` patch hook (alongside existing `ready_for_prompt = true`) |
| Producer (mention) | `apps/agor-daemon/src/services/board-comments.ts` create/patch hook |
| Producer (admin broadcast) | `apps/agor-daemon/src/services/notifications.ts` `broadcast()` method |
| UI store / hook | `apps/agor-ui/src/hooks/useNotifications.ts` (new) |
| Bell + Panel component | `apps/agor-ui/src/components/NotificationBell/` (new) |
| Banner component | `apps/agor-ui/src/components/AppHeader/AnnouncementBanner.tsx` (new) |
| Admin authoring | `apps/agor-ui/src/components/SettingsModal/AnnouncementsTab.tsx` (new) |
| Toast-vs-notification rule | JSDoc on `apps/agor-ui/src/utils/message.tsx` + new guide page `apps/agor-docs/pages/guide/notifications.mdx` |

---

_This doc lives at `docs/notification-system-design.md` per the precedent set by `docs/never-lose-prompt-design.md` for cross-cutting design proposals not yet referenced from code._
