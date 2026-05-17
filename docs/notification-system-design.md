# Agor Notification System — Design Doc (DRAFT)

**Status:** Design / awaiting Max's review before implementation
**Author:** Claude (design pass)
**Date:** 2026-05-08
**Branch:** `design-notification-system`

---

## TL;DR

Agor has good _toasts_ (Ant Design `message` API at `apps/agor-ui/src/utils/message.tsx`) and a strong real-time push pipe (`app.io.to(userRoomName(userId))` in `apps/agor-daemon/src/setup/socketio.ts:193,379`), but **no durable inbox**. Today, when an agent completes a task while you're on another board — or a teammate `@`-mentions you in a comment — there's no centralized record of "things that happened while you were away." The `unreadCommentsCount` badge on the navbar's comments button (`AppHeader.tsx:277-293`) only reflects the _current_ board.

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
- **Per-event subscription UI** — opt-out lives at the _session_ level (archive = unsub). No per-type granular subscription panel.
- **Rich-content notifs** — no embedded video, no rendered code blocks. Title + 1-line preview + link.
- **Slack/Discord parity** — gateway integrations stay in the gateway layer (`apps/agor-daemon/src/services/gateway-channels.ts`); the in-app notification system doesn't try to be a chat app.
- **Navbar message ticker** — see §3.5; explicit scope cut.

---

## 2. Current state inventory

What exists today, citation-heavy so the implementer can plug in:

| Capability                     | Today                                                                                                                      | File pointer                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Toast / message API**        | Ant Design `message`, wrapped via `useThemedMessage()` (`showSuccess`/`showError`/etc.)                                    | `apps/agor-ui/src/utils/message.tsx`                                                      |
| **Per-user socket push**       | `app.io.to(userRoomName(userId)).emit(event, payload)`. Sockets join `user/{user_id}` on auth                              | `apps/agor-daemon/src/setup/socketio.ts:193, 379`                                         |
| **Authenticated broadcast**    | `app.channel('authenticated')` — joined on login, left on logout                                                           | `apps/agor-daemon/src/setup/socketio.ts:735-765`                                          |
| **Service-event push**         | `app.service(name).emit(event, data)` — Feathers fans out to subscribed clients                                            | `register-routes.ts` (many sites, e.g. `:585, :2271, :2297`)                              |
| **Comments unread badge**      | Client-side derived from `commentById` map filtered to current board. **Not durable, single-board only.**                  | `apps/agor-ui/src/components/App/App.tsx:672-689`                                         |
| **Mentions**                   | `comment.data.mentions: string[]` (Phase 4). Detection is **substring match on `@username` / `@email`** in comment content | `apps/agor-ui/src/components/App/App.tsx:678-689`; schema at `schema.sqlite.ts:1260-1262` |
| **"Session needs attention"**  | `session.ready_for_prompt: bool`. Set true on task COMPLETED/FAILED; cleared when user opens conversation drawer           | `packages/core/src/types/session.ts:314`; `apps/agor-daemon/src/services/tasks.ts`        |
| **"Worktree needs attention"** | `worktree.needs_attention: bool` — cumulative over sessions in the worktree                                                | `packages/core/src/types/worktree.ts:252`                                                 |
| **Archive state**              | `session.archived` + `worktree.archived` + `worktree.archived_at`                                                          | `schema.sqlite.ts:97, worktree fields`                                                    |
| **Parent-callback queueing**   | When a _child_ session completes, parent gets a queued system message. **This is agent↔agent, not user↔agent**             | `context/explorations/parent-session-callbacks.md`                                        |
| **Favicon unread indicator**   | `useFaviconStatus.ts` already swaps the favicon based on `ready_for_prompt` aggregate                                      | `apps/agor-ui/src/hooks/useFaviconStatus.ts`                                              |
| **Audio chime**                | `user.preferences.audio.enabled` — already plays on session ready                                                          | `packages/core/src/types/user.ts:329-337`                                                 |

**Key takeaway:** the building blocks are already there. The missing piece is a _recipient-addressed durable record_ — i.e., a row that says "user X should be told about event Y, here's the link, marked unread." Today the system has plenty of _events_, no _inbox_.

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

**Why right side, not left next to comments?** Comments live on the left because they're _board-scoped_. Notifications are _user-scoped, cross-board_ — they belong on the right rail with the user-identity affordances (facepile, settings, user menu). This also avoids stacking two separate badges next to each other.

### 3.2 Panel layout

A `<Popover>` (consistent with the existing `instanceDescription` popover at `AppHeader.tsx:222-235`), opened on bell click. **Not a drawer** — drawers are heavy and we already have one (the session list). Popovers are right for read-mostly lists.

```
┌─ Notifications ─────────────────────────────────── [Clear] ───┐
│                                                                │
│  ⚠️  Deploying around noon PST today  ──────────── 2h ago  [×] │  ← global admin
│  💬  Alice mentioned you in a comment ──────────── 12m ago [×]│  ← mention
│      "@you can you look at this?"                              │
│  🤖  Session returned: "Refactor login flow"  ──── 34m ago [×]│  ← session_returned
│      "I refactored the login flow into a state machine…"      │
│  🤖  research-bot finished its run  ─────────────── 1h ago [×]│  ← session_returned
│      "Found 12 candidate libraries…"                           │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

- **Sort:** strict `created_at DESC`. No grouping by type, no priority lanes — that's a category-error path that adds modes without adding clarity.
- **Open = mark all read.** Opening the panel batches a single `markAllRead` call — every unread row gets stamped with `read_at = now`. The counter zeroes. Cross-tab sync via the existing `notification:all_read` event.
- **Per-item click navigates** (no extra state change — already read).
- **Dismiss:** the `[×]` is explicit and **hard-deletes the row**. No soft-delete state. Rationale in §5.3.
- **Header button is "Clear"**, not "Mark all read". It hard-deletes everything currently in the panel (matches Slack/Discord; per-row dismiss is already irreversible). No confirm — friction without payoff.
- **Read items stay in the panel** (slightly dimmed) until cleared or individually dismissed. The panel becomes a recent-activity log you can scroll back through.
- **Limit:** show the most recent 50 in the popover (server-side `$limit`). "View all" full inbox view is v1.5.

**Why this model (and not Linear-style hover-to-read):** In a notification panel — not an email inbox — the user flow is _open → scan → act-or-close_. Nobody comes back to "still-unread items I half-saw earlier." Open ≈ seen ≈ read. The hover-1.5s timer was overthinking it; an earlier draft proposed it and we cut it.

### 3.3 Notification card anatomy

**One card layout for every type.** An earlier draft proposed three visual variants with colored accent stripes; cut that — the icon already differentiates, and three variants is overhead without payoff for a 20-row scannable list.

```
┌──────────────────────────────────────────────────────────────────────┐
│ {icon}  {title}                                          {age}   [×] │
│         {preview}                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

- **Icon (left, ~18px):**
  - 💬 / `CommentOutlined` — mention
  - 🤖 / `RobotOutlined` — session_returned
  - ⚠️ / `WarningOutlined` — global_admin
- **Title:** session display name (for `session_returned`), or "Alice mentioned you" (for `mention`), or admin title (for `global_admin`).
- **Preview:** for `session_returned`, truncated last assistant message of the completing task (§4.1). For `mention`, the comment content. For `global_admin`, the broadcast preview body.
- **Age:** relative time on the right (`formatRelativeTime`); absolute time in a tooltip.
- **`[×]`:** dismiss = hard-delete (§5.3).
- **Unread row state:** subtle background tint (`token.colorPrimaryBg`) and bold title until the panel opens; then read state dims it.

**No colored accent stripe, no per-variant layout.** The icon is the type signifier. Color is reserved for unread-vs-read state.

**Assistant vs worktree session** — there's still no `is_assistant` marker on `sessions` (I checked `schema.sqlite.ts`). v1 doesn't differentiate; when the marker lands, the same card can pick a different icon. No new card variant needed.

### 3.4 Sticky banner (global admin messages)

Some admin messages should be more in-your-face than a panel item. For those, render a sticky banner **in the navbar's currently-empty center slot** (between `RecentBoardPills` and the right-side controls). Triggered by `notification.type === 'global_admin'` AND `notification.data.banner === true`.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [logo] Agor [board] [pills] | ⚠️ Deploying around noon PST [×] | [users]│
└──────────────────────────────────────────────────────────────────────────┘
```

Rules:

- Only **one** banner shown at a time. If two are active, the most recent wins; older ones live in the panel only.
- Banner is dismissible per-user — hard-deletes that user's row, killing both the banner and the panel item in one go.
- Banner respects an optional `expires_at` on the notification — admin can "Expire now" from the Announcements tab; rows past expiry are filtered client-side. **No auto-expire-after-N-hours UI knob in the compose form** — admins don't know in advance when the deploy will be done; they click "Expire now" when reality dictates.
- **Cap on length:** ~80 chars in the navbar. Longer content lives in the panel.

### 3.5 Navbar message ticker — scope-cut for v1

Max's brief floats a "🌳 {worktree}: {truncated agent response}" ticker that fades messages in and out in unused navbar space. It's a fun idea. **I'm cutting it from v1.** Reasons:

1. **Distraction-to-utility ratio is poor.** A ticker drawing the eye every few seconds in a tool you stare at all day is a focus tax. Slack tried this with "currently typing in #channel" tickers and walked it back.
2. **Display real-estate is contested.** The navbar center is also where the sticky admin banner wants to live. Time-sharing two animated UIs in the same slot is messy.
3. **It's a separate problem from "notifications."** A ticker is _ambient awareness_ — closer to the Facepile or live cursor presence than to an inbox. Conflating it with notifications muddies both.
4. **Easy to add later.** The data is already in `app.service('messages').emit('message …')`. A ticker is a thin client-side component subscribing to that stream. We can ship it post-v1 if Max wants the experiment.

**Recommendation:** revisit ticker as a separate `--feature` flag-gated experiment after v1 lands. If it's compelling, it gets its own design pass.

### 3.6 Toast vs notification — the rule

Codify as a JSDoc on `useThemedMessage` in `apps/agor-ui/src/utils/message.tsx`. No separate guide page — the rule is internal contributor guidance, not user-facing documentation. Proposed rule:

> **Use a toast (Ant Design `message`) when:**
>
> - The user just took an action and you're confirming it ("Saved", "Copied").
> - There's an error tied to the user's _current_ action that won't be retried automatically.
> - The information has no value 5 minutes from now.
>
> **Use a notification when:**
>
> - The event happened _to_ the user, not _because of_ the user (an agent finished, a teammate tagged them).
> - The user might miss it because they're on another board / tab / device.
> - It needs to be actionable later, not just acknowledged now.

Concrete examples:

| Event                                           | Toast or Notification?                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| "Worktree saved"                                | Toast                                                                     |
| "Failed to connect to daemon" (current request) | Toast                                                                     |
| "Session 'X' returned with PR"                  | Notification                                                              |
| "Alice mentioned you in a comment"              | Notification                                                              |
| "Deploying at noon PST" (admin broadcast)       | Notification (+ banner)                                                   |
| "Copied to clipboard"                           | Toast                                                                     |
| "OAuth flow completed in another tab"           | Toast (already handled by `oauth:completed` socket event)                 |
| "MCP server disconnected"                       | Toast in the moment + Notification if the user owns that server's session |

When both apply (e.g. the user kicked off a long-running task and it returned hours later) — emit **both**. The toast confirms the moment-of-return if you're looking; the notification is the durable record for if you weren't.

**Caveat — context-aware toast suppression.** If the notification's source page is the user's _current_ page (they're already looking at the session detail panel when its task returns), the **client suppresses the toast** to avoid double-signal. The notification is still created server-side (durable record); the local toast is what gets skipped. Implementation: client receives `notification:created`, compares `source_session_id` / `source_board_id` against current route, fires toast only if mismatched.

---

## 4. Notification types — v1 taxonomy

Hold the line on a small set. Each one needs a clear trigger, recipient set, and link target.

| Type                   | Trigger                                                                                                                                                                | Recipient(s)                        | Link target                                         | Default subscription                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| **`mention`**          | A `board_comments` row is **created** (or patched to add a new mention) and `data.mentions[]` contains a user_id. Excludes self-mentions (`recipient ≠ author`).       | Each mentioned user                 | Board with comments panel open, scrolled to comment | Always (mentions are inherently directed) |
| **`session_returned`** | `tasks.patch` sets `status` to `COMPLETED` or `FAILED` AND `session.archived = false` AND `worktree.archived = false`. **Fires per task completion, not per message.** | Subscribers of the session (see §6) | Session detail panel open in the right board        | Auto-subscribed via interaction (see §6)  |
| **`global_admin`**     | Admin authors a global message (see §7)                                                                                                                                | All users (fanout)                  | Panel only (no per-row click target)                | Always (one slot, dismissible)            |

**v1 coverage gap — flagged.** The `mention` type fires only when `data.mentions[]` adds a new user_id. It does **not** track thread participation: if Alice tags Bob, then Alice replies in the thread without re-tagging Bob, Bob hears nothing. Same if Bob replies to a thread and gets no follow-up pings. This is `comment_reply` territory, slotted for **v1.5 alongside the polymorphic mute table** (see §6.3). For v1, threads are single-shot ping surfaces.

### 4.1 What carries through to the notification

For `session_returned` specifically — because the producer wires into the task lifecycle, not the message stream — there's a clean rule for what the rendered card shows:

| Card slot         | Source                                                                                              | Notes                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Title**         | `getSessionDisplayTitle(session)`                                                                   | The session's display name; falls back to first prompt. Same helper the session drawer uses.                |
| **Preview**       | The **last assistant message** of the completed task, plain-text-extracted, truncated to ~160 chars | NOT the prompt. The prompt lives in the session if you click through. The preview answers "what came back." |
| **Metadata line** | Worktree name, agentic_tool icon, relative time                                                     | Reuses `<ToolIcon>` and `formatRelativeTime`.                                                               |

The producer fetches the last assistant message using the same query already implemented for parent-session callbacks (`context/explorations/parent-session-callbacks.md` §3, decision #3) — `MAX(index)` assistant-role message in the completing task. Reuse that logic; don't reinvent.

**Importantly:** individual `messages` rows (assistant chunks, tool calls, tool results) **never** trigger notifications. The unit is the **task**, fired once when its terminal status is reached. A task that produces 50 messages = 1 notification (or 0, if collapsed onto an existing un-read row).

**Out of v1, listed for completeness:**

| Type                                             | Why deferred                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree_created`                               | Too noisy. In a multi-user instance, every teammate creating a worktree would trigger one. The board itself is the surface for this.                                 |
| `session_created`                                | Same as above.                                                                                                                                                       |
| `environment_started` / `environment_failed`     | Ephemeral. Toast in the moment is sufficient.                                                                                                                        |
| `schedule_fired`                                 | If a scheduled prompt produces a session that returns, the _return_ notif covers it. The fire itself isn't actionable.                                               |
| `child_session_completed` (parent callback)      | Already handled by the queued-system-message pipe in `parent-session-callbacks.md`. That's an agent↔agent channel, not a user-addressed inbox. Don't double-deliver. |
| `oauth_disconnected`                             | Toast on the active session is enough. Future: notification if the disconnect happens while the user is on another board.                                            |
| `comment_reply` (you commented, someone replied) | **v1.5** (promoted from v2 after recognizing the v1 thread coverage gap). Pairs with polymorphic mute table — shipping replies without mute is the spam path.        |

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

    // Display fields (materialized so the panel renders without joins).
    // For session_returned: title = session display name, preview = last
    // assistant message of the completed task (see §4.1).
    title: text('title').notNull(), // ~80 chars
    preview: text('preview'), // ~160 chars, optional

    // Source pointers — all optional, depend on type. SET NULL on cascade so
    // a deleted session/worktree leaves the notif row with a "this session
    // was deleted" fallback in the UI rather than yanking history mid-render.
    // (Archive is a separate sweep — see §6.2.)
    source_session_id: text('source_session_id', { length: 36 }).references(
      () => sessions.session_id,
      { onDelete: 'set null' }
    ),
    source_worktree_id: text('source_worktree_id', { length: 36 }).references(
      () => worktrees.worktree_id,
      { onDelete: 'set null' }
    ),
    source_board_id: text('source_board_id', { length: 36 }).references(() => boards.board_id, {
      onDelete: 'set null',
    }),
    source_comment_id: text('source_comment_id', { length: 36 }).references(
      () => boardComments.comment_id,
      { onDelete: 'set null' }
    ),
    source_task_id: text('source_task_id', { length: 36 }), // no FK; tasks can be ephemeral
    source_user_id: text('source_user_id', { length: 36 }) // who triggered (e.g. who tagged me)
      .references(() => users.user_id, { onDelete: 'set null' }),

    // State — only two: unread (read_at IS NULL) or read (read_at IS NOT NULL).
    // Dismiss = hard-delete the row, no soft-delete column. See §5.3.
    read_at: t.timestamp('read_at'), // null = unread
    expires_at: t.timestamp('expires_at'), // admin-set on "Expire now"; client filters

    // Type-specific extras. Producers stamp the fields they care about; the
    // consumer reads defensively. Kept minimal: { banner?: bool,
    // agentic_tool?: string, broadcast_group_id?: string }.
    //
    // NOT included (we considered and cut): `message_count`, `mention_excerpt`
    // — never rendered in v1 cards, easier to add later than rip out now.
    data: t
      .json<NotificationData>('data')
      .notNull()
      .default(sql`'{}'`),
  },
  table => ({
    // Panel-list query: "give me this user's notifs, newest first"
    recipientCreatedIdx: index('notifications_recipient_created_idx').on(
      table.recipient_user_id,
      table.created_at
    ),
    // Unread count + mark-all-read sweep
    recipientReadIdx: index('notifications_recipient_read_idx').on(
      table.recipient_user_id,
      table.read_at
    ),
    // Collapse upsert lookup (see §5.2). NOT unique — mentions on the same
    // session must coexist; collapse for `session_returned` is enforced in the
    // repository in a SELECT-then-INSERT-or-UPDATE transaction.
    recipientSourceTypeIdx: index('notifications_recipient_source_type_idx').on(
      table.recipient_user_id,
      table.source_session_id,
      table.type
    ),
    // Archive cleanup: DELETE WHERE source_session_id = ?
    sourceSessionIdx: index('notifications_source_session_idx').on(table.source_session_id),
    // Archive cleanup: DELETE WHERE source_worktree_id = ?
    sourceWorktreeIdx: index('notifications_source_worktree_idx').on(table.source_worktree_id),
  })
);
```

### 5.2 Collapse policy

Open question Max raised: "if a session has 5 events in a row, do we get 5 notifs or 1?" **Position: 1, collapsed.**

- For `type = session_returned`, the producer (the tasks patch hook) does a **conditional upsert** keyed on `(recipient_user_id, source_session_id, type)`:
  - If a row exists, **bump** `created_at` to now, refresh `title`/`preview`/`source_task_id`, set `read_at = NULL`. The existing row floats to the top, badge re-increments.
  - Otherwise, INSERT.
- For `type = mention`, **don't collapse**. Each mention is a distinct fact; a teammate tagging you twice in the same comment thread is two separate things you want to see.
- For `type = global_admin`, no collapse — distinct broadcasts are distinct.

Note: there's no "non-dismissed" filter on the upsert because dismissed rows don't exist (§5.3). Once a user dismisses, the row is gone — and the next collapsed event will INSERT a fresh row.

**Latest-task-only semantics.** A consequence of the collapse: if a session emits 5 task completions while you're away, you see _one_ notification reflecting only the _latest_ state. The previous 4 completions are not surfaced individually. This is intentional — the notification is an _invitation back to the session_, not a log of what happened. The session detail panel is the log. (Same constraint and same justification as `parent-session-callbacks.md`.)

### 5.3 Read vs dismissed — two states + delete

Earlier draft had `read_at` and `dismissed_at` as separate columns. Simplified after Max's pushback: **dismiss is a hard-delete**. There's no use case for keeping dismissed rows (no "undo," no "show dismissed" affordance), and a soft-delete column adds queries-with-filters everywhere for no payoff.

| State     | `read_at`     | Counter?      | Visible in panel? |
| --------- | ------------- | ------------- | ----------------- |
| New       | NULL          | yes (counted) | yes               |
| Read      | set           | no            | yes               |
| Dismissed | (row deleted) | no            | no                |

Counter = `COUNT(*) WHERE recipient = me AND read_at IS NULL`.

### 5.4 Indexes

Five indexes cover all v1 access patterns:

- **`notifications_recipient_created_idx`** — panel list ("newest notifs for this user").
- **`notifications_recipient_read_idx`** — unread count + mark-all-read sweep.
- **`notifications_recipient_source_type_idx`** — collapse upsert lookup for `session_returned`.
- **`notifications_source_session_idx`** — archive cleanup (DELETE WHERE source_session_id = ?).
- **`notifications_source_worktree_idx`** — archive cleanup (DELETE WHERE source_worktree_id = ?).

The first three are recipient-leading; the last two support the bulk-delete sweeps fired when a session or worktree is archived. Index sizes are bounded by _active_ notifications per user — and dismiss-as-hard-delete keeps the tail short. Retention sweep for aged read rows in v1.5 (§10 Q-D).

---

## 6. Subscription model

Max's framing: "safe to assume every session, until archived, is expecting people to go back to it. So default to opt-out, archive = unsub."

I want to **refine** that, because in a multi-user instance "every session" is too broad. If 5 teammates each have 3 active sessions, every user gets pinged for 15 sessions worth of events. That's the spam path that kills notification systems.

**Proposed refinement: subscribe on _interaction_, not on _visibility_.**

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
- Covers Max's "no per-session config burden" — you don't toggle anything; you just _do_ things, and that subscribes you.

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
- **Pre-existing notifs and mutes are swept on archive.** Two `DELETE` statements run inside the existing archive hook:
  - `DELETE FROM notifications WHERE source_session_id = $sid` (or `source_worktree_id = $wid`). They're stale invitations — clicking one goes to a session the user has explicitly retired. Better to clear them than leave dead links.
  - `DELETE FROM notification_mutes WHERE scope_type = 'session' AND scope_id = $sid` (v1.5). Mute is moot once archived; avoids zombie-mute rows.

### 6.3 Three layers of subscription — and which ones we ship

Subscription has three plausible shapes; v1 ships layer 1 only, v1.5 adds layer 2, layer 3 is deferred indefinitely.

| Layer                              | What it is                                                                                                                                                                   | New schema?                                                                        | When to ship                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **1. Implicit**                    | Derived from `sessions.created_by` ∪ `tasks.created_by` (+ mention recipients). Zero new state. Archive = unsub.                                                             | None                                                                               | **v1**                                                                                  |
| **2. Explicit mute (polymorphic)** | A tiny _opt-out_ table — `notification_mutes(recipient_user_id, scope_type, scope_id, muted_at)`. Producer subtracts users who muted any scope the event falls under.        | `notification_mutes` (composite PK on `(recipient_user_id, scope_type, scope_id)`) | **v1.5**                                                                                |
| **3. Full subscription primitive** | First-class entity: every (user, scope) pair has an explicit `subscribed`/`muted` row. Lets you positively subscribe to things you never touched ("watch a teammate's run"). | `notification_subscribers` table + producer hooks on every interaction event       | **v2 or never** — only worth building if "watch-without-interacting" becomes a real ask |

The layer-2 shape is **negative-only state** — only people who _bother_ to mute show up — which keeps the table small and avoids layer-3 fanout cost.

#### 6.3.1 Polymorphic scope — handles sessions AND comment threads

Naming the table `session_notification_mutes` was too narrow (caught by Max). Different notification types fall under different scopes:

| Notification type                       | Scopes the producer checks                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `session_returned`                      | `session_id`, `worktree_id`                                                       |
| `mention` on a board-level comment      | `board_id`                                                                        |
| `mention` on a session-attached comment | `session_id`, `worktree_id`, `board_id`                                           |
| `mention` on a threaded reply           | `comment_thread` (= root `parent_comment_id`), + whatever the root is attached to |
| `comment_reply` (v1.5)                  | `comment_thread`, + attached scope                                                |

A user who has muted **any** scope an event falls under suppresses the notification.

**Mute UI surface — what to expose in v1.5:**

| Scope            | Affordance                                                                              | Notes                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `session`        | Toggle in session footer + "Mute this session" on `session_returned` notification cards | The most common case — handles "I created this 3 weeks ago, still alive, don't care anymore"                           |
| `comment_thread` | "Mute thread" on the thread root's overflow menu + on mention notification cards        | Lights up properly when v2's `comment_reply` notif type lands; for v1.5 it suppresses _future mentions_ on that thread |
| `worktree`       | Toggle in worktree settings                                                             | "Don't care about this worktree at all"                                                                                |
| `board`          | **Skip.** Boards are too coarse — if you don't care about a board, you stop visiting it |                                                                                                                        |

**Context can change.** Mute is reversible (just `DELETE` the row). When a thread pivots and you re-engage, unmute. The negative-only-state property means unmuting leaves no trace — which is what you want.

#### 6.3.2 Thread participation — v1.5 alongside `comment_reply`

Once `comment_reply` ships, the producer needs to know who's in a thread. Rule:

> **You're a participant in a thread iff** you've been @-mentioned in any comment in the thread OR you've posted any comment in the thread (via `comment.parent_comment_id` chain to the root).
> A new reply in a thread → notification to every distinct participant ≠ author of the new reply, minus anyone who muted the `comment_thread` scope.

Implementation note: walking the `parent_comment_id` chain to find the root is N+1; **denormalize a `thread_root_id` column on `board_comments`** (set on insert, immutable thereafter) so participation lookups are a single indexed scan. That's a small comments-table migration that pairs with the v1.5 work.

Self-replies are filtered the same way as self-mentions (Q-G).

---

## 7. Admin flow for global messages

**Who can author:** users with `role >= admin` (consistent with the existing `WEB_TERMINAL_MIN_ROLE` and other privileged-feature gates per `App.tsx:719`). Authoring requires admin role; _authenticated_ recipients receive (joined to the `'authenticated'` channel).

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

**Open question:** do we want a _broadcast group_ concept (one logical broadcast → many notification rows, joined by a `broadcast_id`), so editing/expiring one updates all? **Yes for v1 if it's cheap.** Add `data.broadcast_group_id: string` to all rows in a broadcast — that's the hook for bulk operations. No separate table needed.

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
client.io.on('notification:created', row => store.upsert(row));
client.io.on('notification:patched', row => store.upsert(row));
client.io.on('notification:removed', row => store.remove(row.notification_id));
```

This piggybacks on the `user/{user_id}` socket room joined at `socketio.ts:379`. **No new auth or channel infra.**

### 8.2 Initial fetch (panel open)

On panel open, fetch the latest 50 unread + read-not-dismissed:

```
GET /notifications?
  &$sort[created_at]=-1
  &$limit=50
```

(`recipient_user_id` is forced server-side from the auth context; not a client-supplied filter. No `dismissed_at` filter since there's no such column — dismissal is hard-delete.)

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

### 9.3 Notification card — single layout

See §3.3 above. One card layout for every type; icon is the type signifier. ~56px tall.

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
- **`<List>`** — _don't_ use. Recently deprecated in this codebase per commit `a5accb91 chore(ui): migrate off deprecated AntD <List>`. Use a flex column of cards instead.
- **`<ToolIcon>`** — already exists, used in the session drawer. Drop it on session-returned cards.
- **`formatRelativeTime`** (`apps/agor-ui/src/utils/time.ts`) — for "12m ago" timestamps. Tooltip with `formatAbsoluteTime` for hover. Same as the session-drawer-improvements doc proposes.
- **`<MarkdownRenderer>`** — for the optional admin banner description, if we want it richer than plain text in the banner popover-on-hover. Same as `AppHeader.tsx:225`.

---

## 10. Open questions / decisions deferred

Numbered to match the brief's open questions where applicable.

| #   | Question                       | Position                                                                                                                                                        |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Notification entity schema     | §5 — schema sketched, recipient-leading indexes                                                                                                                 |
| 2   | Persistent table vs in-memory  | **Persistent.** Durability across reload + cross-device sync requires it                                                                                        |
| 3   | Delivery channel               | **Socket primary, fetch on bell-open, refetch-on-reconnect fallback.** No polling steady-state                                                                  |
| 4   | Read vs dismissed              | **Two states, no soft-delete.** §5.3. `read_at` is the only state column; dismiss hard-deletes the row                                                          |
| 5   | Click-through dismiss          | **Don't auto-dismiss on click.** Click navigates only. Open-panel marks all read. Dismiss is explicit per-row. Header button = "Clear" (hard-deletes all). §3.2 |
| 6   | Session vs task linking        | **`source_session_id` is the link target. `source_task_id` is metadata.** Tasks are the unit of work; sessions are the place you go back to                     |
| 7   | De-dup / collapse              | **Collapse `session_returned` per `(user, session, type)`. Don't collapse `mention` or `global_admin`.** §5.2                                                   |
| 8   | Mute / snooze per session      | **v1.5.** Polymorphic `notification_mutes(recipient_user_id, scope_type, scope_id, muted_at)` table covering sessions, threads, worktrees. See §6.3             |
| 9   | Cross-device sync              | **Free** — same backing table, same socket room, two tabs see the same state                                                                                    |
| 10  | Permissions on global messages | **Admin role.** Authored from a new `SettingsModal` tab. §7                                                                                                     |
| 11  | Ticker / streamer rules        | **Cut from v1.** §3.5                                                                                                                                           |
| 12  | Notification taxonomy          | **§4.** Three types in v1: mention, session_returned, global_admin                                                                                              |

### 10.1 Decisions made (after iteration with Max)

These were originally flagged as "deferred" but have been resolved:

- **Q-A — Subscription model: interaction-based (DECIDED).** Auto-subscribe via `created_by` ∪ `prompted` ∪ mention-recipients (§6). Literal "every visible session" was rejected as the multi-user spam path.
- **Q-B — Mention detection: explicit field, substring as stop-gap (DECIDED).** v1 ships with whichever lands first — if board-comments Phase 4 (`data.mentions[]`) ships before notifications, use it; otherwise substring detection per `App.tsx:678-689` is acceptable as a temporary fallback. Either way, the notification producer reads the comment row at fire time; the _source of truth_ for mention identity is on the comment, not the notification.
- **Q-C — Assistant-session visual variant: deferred until `is_assistant` marker exists (DECIDED).** v1 ships one session-returned variant. Switch to two variants when persistent assistants get a schema flag (post-v1.5).
- **Q-D — Retention: promoted to v1 (DECIDED).** Nightly sweep deletes read notifs older than 90 days. ~30 lines of code; means table size is a non-thought from day one. Reflected in the v1 plan (§11).
- **Q-E — Fire on FAILED: yes (DECIDED).** Failures are exactly the events a notification system exists for. Mirrors parent-callback design.
- **Q-F — Toast suppression on relevant page: yes, client-side (DECIDED).** When a `notification:created` event arrives and `source_session_id`/`source_board_id` matches the user's current route, the toast is suppressed. Notification still created server-side. Documented in §3.6.
- **Q-G — Self-mention: skip the notification (DECIDED).** Producer enforces `recipient_user_id ≠ source_user_id`. `@me TODO check this` doesn't ping you.
- **Q-H — Panel open = mark all read; header button is "Clear" not "Mark all read" (DECIDED).** Open ≈ seen ≈ read in a notification panel (unlike an email inbox). The "Clear" button hard-deletes everything currently in the panel; no confirm. Hover-1.5s mark-read was overthinking it and is removed. §3.2.
- **Q-I — Single card layout, no colored accent stripes (DECIDED).** Icon is the type signifier; stripes were variant-creep. §3.3.
- **Q-J — Drop `scope`, `link_url` columns; drop `data.message_count` and `data.mention_excerpt` (DECIDED).** `scope` is redundant with `type`; `link_url` is always derivable from `source_*`; the two `data` fields were never rendered. §5.1.
- **Q-K — Drop the toast-vs-notification guide page; keep only the JSDoc on `useThemedMessage` (DECIDED).** Rule is contributor guidance, not user docs. §3.6.
- **Q-L — Drop the auto-expire-after-N-hours UI knob in the announcement compose form (DECIDED).** Admins don't know in advance; "Expire now" handles reality. The `expires_at` column stays for the "Expire now" action. §3.4.
- **Q-M — Promote `comment_reply` to v1.5 with thread participation (DECIDED).** v1 has a real gap: thread replies after the first @-mention produce silence. Ships with the polymorphic mute table — replies without mute is the spam path. §4, §6.3.2.

### 10.2 Still open (not blocking v1)

- **Mute UI exact placement (v1.5).** Session footer is decided; "mute thread" surface depends on where comment-overflow menus live, which the comments team will pick. Not a v1 question.
- **Layer-3 full subscription primitive.** Whether "watch-without-interacting" ever becomes a real ask. Defer indefinitely; revisit only if requested.
- **`thread_root_id` denormalization on `board_comments`.** Needed for cheap thread-participation lookups in v1.5. Small comments-table migration; coordinate with whoever owns the comments work.

---

## 11. Phased delivery plan

### v1 — the core inbox

- Schema migration (`notifications` table, 5 indexes per §5.4). No `scope`, no `link_url`.
- `NotificationsService` (Feathers, `find`/`get`/`patch`/`remove` + custom `broadcast` + `expireBroadcast` + `clearAll`).
- Producers in `tasks.ts` (session_returned, fires per task completion) and `board-comments.ts` (mention; skip self-mentions).
- **Archive-time cleanup hook** — on `session.archived = true` or `worktree.archived = true`, run `DELETE FROM notifications WHERE source_session_id = …` (and worktree variant).
- **Retention sweep** — nightly cron, `DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < now() - 90 days`.
- Bell + counter on `AppHeader` right side.
- Panel: **single card layout** (icon-by-type), open-marks-all-read, click-navigates, per-item `[×]` hard-deletes, header **"Clear"** button hard-deletes all.
- **Context-aware toast suppression** — client compares `source_session_id` / `source_board_id` against current route before firing the toast.
- Sticky admin banner in navbar center (kept — Max likes it).
- Settings → Announcements admin tab (compose, list, "Expire now"). **No auto-expire-after-N-hours knob in compose.**
- Socket push wired through existing `user/{user_id}` rooms.
- Toast-vs-notification rule as **JSDoc on `useThemedMessage`** only — no separate guide page.

### v1.5 — quality of life + thread participation

- **Polymorphic mute table** — new `notification_mutes(recipient_user_id, scope_type, scope_id, muted_at)` table (§6.3). Producer subtracts users who muted any scope the event falls under.
- **`comment_reply` notification type** — fires on a comment created with `parent_comment_id` set; recipients = thread participants (mentioned-in OR posted-in) ≠ new comment author, minus muters. Pairs with mute table (shipping replies without mute is the spam path). §6.3.2.
- **`thread_root_id` denormalization on `board_comments`** — small comments-table migration so thread-participation lookups are cheap.
- **Mute affordances** — session footer, "Mute this session" / "Mute thread" actions on notification cards, worktree settings tab.
- Archive-time hook extended to also delete mute rows for the archived entity.
- **Snooze for N hours** — per-notification action.
- **Full inbox view** at `/notifications` — uses the same backing query, paginated, no popover.
- **Assistant-session variant** — once persistent assistants land with a flag.

### v2 — channels beyond the app

- Email digests (opt-in, daily).
- Push notifications via service worker.
- Slack/Discord delivery via `gateway-channels`.
- Integration with `gateway` so a notification can be authored in a Slack message and arrive in-app.

---

## 12. Effort estimate (rough)

For a single engineer familiar with the codebase. Timeboxes are _rough order of magnitude_, not commitments.

| Area                                                                                                                          | Effort |
| ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Schema + migration** (sqlite + postgres + types)                                                                            | 0.5d   |
| **Repository + service** (`NotificationsRepository`, `NotificationsService`, broadcast method, hooks)                         | 1d     |
| **Producer wiring** (tasks.ts patch hook fetching last-assistant-message, board-comments mention hook with self-mention skip) | 1d     |
| **Archive cleanup + retention sweep** (delete on archive, nightly cron for 90d aged read rows)                                | 0.25d  |
| **Socket push + client subscription** (piggyback on existing rooms)                                                           | 0.5d   |
| **Bell + counter** (AppHeader integration, `<Badge>`)                                                                         | 0.5d   |
| **Panel UI** (popover, single card layout, open-marks-read, dismiss, "Clear")                                                 | 1d     |
| **Context-aware toast suppression** (route-match check before firing toast)                                                   | 0.25d  |
| **Sticky admin banner** (navbar center slot, dismiss, expiry)                                                                 | 0.5d   |
| **Admin authoring UI** (SettingsModal tab, compose modal, list view)                                                          | 1d     |
| **Toast-vs-notification JSDoc** (no guide page)                                                                               | 0.1d   |
| **Tests + Storybook** (panel + cards + counter)                                                                               | 1d     |
| **Smoke test + screenshot pass**                                                                                              | 0.25d  |

**Total ballpark:** ~8 engineering days for a single contributor end-to-end. Closer to ~10–11 once code review, schema migration coordination across sqlite+postgres, and the inevitable scope creep are factored in.

**Easy parallelization split:**

- Backend (schema, service, producers, archive/retention sweeps, push) — ~4d
- Frontend (bell, panel, banner, toast suppression, admin UI) — ~4d

---

## 13. Risks + mitigations

| Risk                                                       | Likelihood                                       | Impact | Mitigation                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------- |
| **Spam from over-subscription**                            | High if §6 is wrong                              | Medium | Interaction-based subscription (§6), polymorphic mute table in v1.5 covering session/thread/worktree |
| **Counter desync** (badge says 3, panel shows 0)           | Medium                                           | Low    | Server-driven counter from the same table the panel reads. Single source of truth                    |
| **Mention detection misses or false-positives**            | Medium                                           | Low    | Q-B: explicit `data.mentions[]` is preferred; substring fallback is acceptable stop-gap              |
| **Admin-banner abuse** (spammy broadcasts)                 | Low                                              | Medium | Admin-only authoring, expiry required, single banner slot                                            |
| **Table growth**                                           | Low (small instances) → Medium (large instances) | Low    | Retention sweep promoted to v1 (90-day aged-read sweep)                                              |
| **Socket-disconnect window** missing notifs                | Medium                                           | Low    | Fetch-on-reconnect fallback (§8.3)                                                                   |
| **Double-signal** (toast + notification + already-on-page) | Medium                                           | Low    | Context-aware toast suppression on the client (§3.6, Q-F)                                            |

---

## 14. What this doc explicitly does NOT propose

To avoid scope creep:

- **No notification preference UI.** Subscription is interaction-based; mute is polymorphic per-scope in v1.5. No global per-type settings page.
- **No browser-native `Notification` API.** Web push is v2.
- **No webhook/external delivery.** v2.
- **No notification grouping by session in the panel.** Flat sort by recency. Grouping adds modes without adding clarity in a 20-row list.
- **No "important" / priority lanes.** Type already implies priority (admin > mention > session_returned in the eye, but not in the sort).
- **No read-receipts on mentions.** Outside the inbox model.

---

## 15. Where to put what

For the implementer:

| Concern                     | Location                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                      | `packages/core/src/db/schema.{sqlite,postgres}.ts` (new `notifications` table). **Update both files.** Only 3 column types differ across dialects (timestamp / bool / json) per [`context/guides/creating-database-migrations.md`](../context/guides/creating-database-migrations.md).                                                                                                                                                                                    |
| Drizzle migration           | `packages/core/drizzle/sqlite/0044_add_notifications.sql` + matching postgres `0035_add_notifications.sql` (numbers may shift again with rebases — pick the next free index in each dialect's journal). **Generate inside Docker** (`docker exec … pnpm db:generate:sqlite` and `…:postgres`), then `docker cp` files + `meta/` directories back. Full workflow in [`context/guides/creating-database-migrations.md`](../context/guides/creating-database-migrations.md). |
| Type                        | `packages/core/src/types/notification.ts` (new)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Repository                  | `packages/core/src/db/repositories/notifications.ts` (new)                                                                                                                                                                                                                                                                                                                                                                                                                |
| Service                     | `apps/agor-daemon/src/services/notifications.ts` (new)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Service registration        | `apps/agor-daemon/src/register-services.ts`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Producer (session_returned) | `apps/agor-daemon/src/services/tasks.ts` patch hook (alongside existing `ready_for_prompt = true`)                                                                                                                                                                                                                                                                                                                                                                        |
| Producer (mention)          | `apps/agor-daemon/src/services/board-comments.ts` create/patch hook                                                                                                                                                                                                                                                                                                                                                                                                       |
| Producer (admin broadcast)  | `apps/agor-daemon/src/services/notifications.ts` `broadcast()` method                                                                                                                                                                                                                                                                                                                                                                                                     |
| Archive cleanup hook        | `apps/agor-daemon/src/services/sessions.ts` and `worktrees.ts` archive paths — `DELETE` notifications (and v1.5 mutes) for the archived entity                                                                                                                                                                                                                                                                                                                            |
| UI store / hook             | `apps/agor-ui/src/hooks/useNotifications.ts` (new)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Bell + Panel component      | `apps/agor-ui/src/components/NotificationBell/` (new)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Banner component            | `apps/agor-ui/src/components/AppHeader/AnnouncementBanner.tsx` (new)                                                                                                                                                                                                                                                                                                                                                                                                      |
| Admin authoring             | `apps/agor-ui/src/components/SettingsModal/AnnouncementsTab.tsx` (new)                                                                                                                                                                                                                                                                                                                                                                                                    |
| Toast-vs-notification rule  | JSDoc on `apps/agor-ui/src/utils/message.tsx`. **No separate guide page** — the rule is contributor-facing guidance, not user docs.                                                                                                                                                                                                                                                                                                                                       |

---

_This doc lives at `docs/notification-system-design.md` per the precedent set by `docs/never-lose-prompt-design.md` for cross-cutting design proposals not yet referenced from code._
