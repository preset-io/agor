# User Comments and Conversation

**Status:** ✅ Phase 2 Complete (Threading + Reactions)
**Related:** [multiplayer.md](../concepts/multiplayer.md), [websockets.md](../concepts/websockets.md), [auth.md](../concepts/auth.md)

---

## Overview

This document explores adding **human-to-human conversations and comments** to Agor. The goal is to enable team collaboration through contextual discussions—without cluttering the AI conversation interface.

**Key Question:** What should comments be attached to?

After studying Figma's implementation, we discovered that Figma comments are **spatial annotations** pinned to canvas coordinates (x, y), not just chronological threads. This raises important design questions for Agor.

### Design Question: Attachment Strategy

We need to decide what comments are attached to:

1. **Spatial (Figma-style)** - Positioned at (x, y) coordinates on board canvas
2. **Object-level** - Attached to sessions, tasks, or messages
3. **Board-level** - Chronological conversation thread (channel-style)
4. **Hybrid** - Combination of approaches

Each has significant UX and technical tradeoffs (explored below).

### Key Design Principles

1. **Contextual** - Comments should relate to specific work
2. **Non-invasive** - Toggle on/off, doesn't interfere with AI workflows
3. **Multiplayer-first** - Real-time updates via existing WebSocket infrastructure
4. **Anonymous-compatible** - Works in both authenticated and anonymous modes

---

## Use Case Examples: What Will People Actually Say?

Before designing the technical implementation, let's imagine concrete scenarios of how teams might use comments in Agor:

### Project Milestone Discussions (Worktree/Project-Level)

```
👤 Alice: "I think we're done with the auth system! All sessions completed successfully."
👤 Bob: "Agreed, but we should document the OAuth flow before marking this complete."
👤 Charlie: "I can write up the docs tomorrow. Consider it done!"
```

**Characteristics:**

- High-level, strategic discussions
- About completion/progress of work streams
- Not attached to specific sessions
- Resolution: ✅ Makes sense ("milestone reached" → resolved)

### Session Analysis & Debugging (Object-Level)

```
👤 Alice: "@bob Look at session #a3f4c2 - the agent went completely off-track here. Why did it choose Redux instead of Zustand?"
👤 Bob: "Oh I see it. The context file had outdated info about our state management preferences."
👤 Alice: "Fixed the context in #e7b9d4. Let's re-run this session with correct context."
```

**Characteristics:**

- Specific to a session/task
- Diagnostic, investigative
- References concrete work
- Resolution: ❓ Maybe ("issue identified" → resolved, but conversation might continue)

### Workflow Coordination (Spatial/Organizational)

```
👤 Charlie: "Let's organize all the database migration sessions in the top-left zone."
👤 Alice: "Good idea. I'll move the Prisma sessions there too."
👤 Bob: "Can we color-code them? Red for failed, green for completed?"
```

**Characteristics:**

- About canvas organization
- Spatial references ("top-left", "this area")
- Workflow/process discussion
- Resolution: ❌ Doesn't really apply (ongoing organizational choices)

### Code Review & Quality Feedback (Message-Level)

```
👤 Bob: [on specific assistant message] "This implementation won't scale - it's O(n²). Agent should have used a hash map."
👤 Alice: "Agreed. Should we fork this session and retry with better context?"
👤 Charlie: "Or we could spawn a refactoring session from this point."
```

**Characteristics:**

- Granular, technical
- Attached to specific messages/code
- Actionable critique
- Resolution: ✅ Makes sense ("issue fixed" → resolved)

### General Questions & Discussions (Board-Level)

```
👤 Alice: "Should we use JWT or sessions for auth? I've seen agents go both ways."
👤 Bob: "JWT is better for our API architecture, see session #c3a7f2 for the decision."
👤 Charlie: "Agreed on JWT. Let's document this as a project standard."
```

**Characteristics:**

- Not tied to specific work
- Decision-making, strategy
- May reference sessions but not attached
- Resolution: ✅ Makes sense ("decision made" → resolved)

### Confusion & Help Requests

```
👤 Bob: "Why do we have 5 sessions doing authentication? Is this intentional or did something go wrong?"
👤 Alice: "Oh those are experiments! I was testing different approaches. The one in zone 2 is the winner."
👤 Bob: "Got it, thanks! Should we archive the failed experiments?"
```

**Characteristics:**

- Clarification-seeking
- May reveal workflow issues
- Human learning/context sharing
- Resolution: ✅ Definitely ("question answered" → resolved)

### Key Insight: Multiple Conversation Modes

From these examples, we see **three distinct conversation modes:**

1. **Strategic/Milestone** - "Are we done with auth?" (worktree/project scope)
2. **Tactical/Review** - "This session went wrong" (object scope)
3. **Operational/Organization** - "Let's group these sessions" (spatial/workflow scope)

**Question:** Do these all live in the same comment system, or should they be separated?

---

## Conversation Scoping: Where Should Comments Live?

### The Scoping Hierarchy

Agor has multiple organizational layers. Each suggests different conversation scopes:

```
Repository (Git Repo)
└── Worktree (Project/Feature Branch)
    ├── Board A (Organizational View)
    │   ├── Session 1
    │   ├── Session 2
    │   └── Zone (Spatial Grouping)
    └── Board B (Different View of Same Work)
        ├── Session 1 (same session, different board!)
        └── Session 3
```

### Scope Option 1: Board-Scoped (Current Implementation)

**What we have now:** Comments attached to boards.

**Works well for:**

- ✅ Workflow coordination ("organize sessions in this zone")
- ✅ Board-specific discussions ("this board is getting messy")
- ✅ Organizational questions ("which session should we focus on?")

**Doesn't work for:**

- ❌ Project milestones ("auth system complete") - What if same worktree has multiple boards?
- ❌ Session discussions ("this session failed") - Session might appear on multiple boards
- ❌ Worktree-wide decisions ("we're using JWT") - Discussion happens in board context, not project context

**Key limitation:** A session can be on multiple boards. If you comment on a session in Board A, should that comment appear in Board B?

### Scope Option 2: Worktree-Scoped

**Alternative:** Comments attached to worktrees (projects).

**Works well for:**

- ✅ Project milestone discussions ("auth system complete")
- ✅ Technical decisions ("we chose JWT over sessions")
- ✅ Documentation ("here's how our workflow works")
- ✅ Cross-board discussions (sessions on any board visible)

**Doesn't work for:**

- ❌ Board-specific organization ("clean up this board")
- ❌ Spatial coordination (worktrees don't have canvas coordinates)
- ❌ Multiple projects (would need worktree selector in UI)

**Interesting trade-off:** Worktrees = projects, Boards = views. Conversations about _work_ (worktree-scoped) vs conversations about _organization_ (board-scoped) are different!

### Scope Option 3: Dual-Scoped (Worktree + Board)

**Hybrid approach:** Support both worktree-scoped AND board-scoped conversations.

**Schema change:**

```typescript
export const boardComments = sqliteTable('board_comments', {
  // ... existing fields

  // EITHER board_id OR worktree_id (at least one required)
  board_id: text('board_id', { length: 36 }).references(() => boards.board_id),
  worktree_id: text('worktree_id', { length: 36 }).references(() => worktrees.worktree_id),
});
```

**UI:**

```
┌─ Comments Drawer ─────────────┐
│  Scope: [Project] [This Board] │  ← Scope selector
│                                │
│  📁 Project: Auth System       │
│    💬 "JWT decision made!"     │
│    💬 "Milestone: auth done"   │
│                                │
│  📋 Board: Sprint 3            │
│    💬 "Organize these sessions"│
│    💬 "Zone 2 needs cleanup"   │
└───────────────────────────────┘
```

**Pros:**

- ✅ Separates project discussions from board organization
- ✅ Project conversations persist across board reorganizations
- ✅ Clear mental model (project talk vs board talk)

**Cons:**

- ❌ More complex UX (two comment types)
- ❌ Users might not know which to use
- ❌ Schema change needed (worktree_id)

### Scope Option 4: Object-First (Session > Board)

**Alternative:** Primary scope is the object (session/task/message), board is secondary.

**Philosophy:** Comments are about _work artifacts_ (sessions, tasks), not organizational containers (boards).

**Schema stays same** but UI changes:

- "Comment on this session" is primary action
- Comments appear wherever that session appears
- Board-level comments are rare, for org/workflow only

**Example:** Session #a3f4c2 appears on "Sprint 3" and "Auth Work" boards. Comments on that session show on both boards.

**Pros:**

- ✅ Comments follow the work
- ✅ Natural for code review ("comment on this code")
- ✅ Sessions are the main work unit

**Cons:**

- ❌ Still doesn't solve project-wide discussions
- ❌ "General" comments still need a home

### Recommendation: Start with Board-Scoped, Add Worktree Later

**Phase 1 (shipped):** Board-scoped comments only

**Phase 2 (future):** Add worktree-scoped conversations when teams request it

**Reasoning:**

1. Most early usage will be organizational ("arrange these sessions")
2. Can learn from real usage patterns
3. Adding worktree scope is backward-compatible (just add `worktree_id` column)
4. Over-designing scope too early = complexity without validation

**Key question to validate with users:** _"Do you want to talk about the PROJECT (worktree) or the BOARD (view)?"_

---

## Comment Resolution: When Does It Make Sense?

We added a `resolved` boolean to comments, Figma-style. But does this make sense in Agor's context?

### Resolution in Figma

**Figma use cases:**

- "Move this button 2px left" → Designer moves it → ✅ Resolved
- "Change this to blue" → Changed → ✅ Resolved
- "Is this the right spacing?" → "Yes" → ✅ Resolved

**Characteristics:**

- Clear action items
- Visual, concrete changes
- Objective completion criteria
- Comments are about _what to change_

### Resolution in GitHub PRs

**GitHub use cases:**

- "This won't handle null" → Code fixed → ✅ Resolved
- "Add error handling" → Added → ✅ Resolved
- "Why this approach?" → Explained → ✅ Resolved (question answered)

**Characteristics:**

- Code review feedback
- Technical discussions
- Resolution = "issue addressed" or "question answered"
- Comments are about _code quality_

### Resolution in Agor: What Changes?

**The challenge:** In Agor, _what changes_ when you resolve a comment?

**Scenario 1: Actionable feedback**

```
💬 "Session #a3f4c2 used wrong approach, needs retry"
→ User forks session, fixes approach
→ ✅ Resolves comment
```

**Resolution means:** Issue addressed, action taken ✅ Makes sense

**Scenario 2: Strategic decision**

```
💬 "Should we use JWT or sessions for auth?"
💬 "Let's use JWT, see session #x for rationale"
→ Decision made
→ ✅ Resolves comment
```

**Resolution means:** Decision made, discussion closed ✅ Makes sense

**Scenario 3: Diagnostic discussion**

```
💬 "@alice Why did the agent choose Redux here?"
💬 "Oh, the context file was outdated"
→ Understanding reached
→ ✅ Resolves comment
```

**Resolution means:** Question answered ✅ Makes sense

**Scenario 4: Organizational coordination**

```
💬 "Let's group all database sessions in zone 2"
💬 "Good idea, I'll move them"
→ Sessions moved
→ ??? Resolved?
```

**Resolution means:** ??? Coordination complete? Unclear if meaningful.

**Scenario 5: Milestone celebration**

```
💬 "Auth system is complete! 🎉"
→ ??? Should this be resolved? It's not a question or action item.
→ Resolving feels like "dismissing" the celebration
```

**Resolution means:** ??? Not really applicable.

### When Resolution Works

Resolution makes sense when a comment is:

1. **A question** - "Why did X happen?" → answered → resolved
2. **An action item** - "Fix this session" → fixed → resolved
3. **A decision** - "Should we use X?" → decided → resolved
4. **A problem report** - "This failed" → addressed → resolved

### When Resolution Doesn't Work

Resolution is awkward when a comment is:

1. **Informational** - "FYI, I'm working on auth" → no action needed
2. **Celebratory** - "Great work!" → nothing to resolve
3. **Strategic** - "Our architecture is X" → statement, not question
4. **Ongoing coordination** - "Keep sessions organized" → continuous, not one-time

### Alternative: Comment Types

Instead of binary resolved/unresolved, what if comments had **types**?

```typescript
type CommentType =
  | 'question' // Needs answer
  | 'action-item' // Needs doing
  | 'decision' // Needs deciding
  | 'note' // FYI only
  | 'discussion'; // Open-ended

// Only question/action-item/decision can be "resolved"
```

**UI:**

```
💬 [Question] @alice Why did agent choose Redux?
   ✅ Resolve

💬 [Note] I'm working on auth system
   (no resolve button - it's just informational)

💬 [Action] Session #abc needs retry with correct context
   ✅ Resolve
```

**Pros:**

- ✅ Clearer semantics (not everything needs resolution)
- ✅ Filterable ("show only questions", "show open action items")
- ✅ Better for async work (know what needs response)

**Cons:**

- ❌ More complex UX (choose type when commenting)
- ❌ People might not understand types
- ❌ Over-engineering?

### Recommendation: Keep Resolution, Add Context

**Keep the current `resolved` boolean** but clarify its meaning:

**In UI:**

- Button text: "Mark as done" (not "Resolve")
- Tooltip: "Mark this comment as addressed/answered/complete"
- Only show for your own comments + mentions

**In filters:**

- "Open" instead of "Unresolved" (feels more action-oriented)
- "Done" instead of "Resolved" (clearer for non-code scenarios)

**Future enhancement:** Add comment types if usage patterns show clear categorization needs.

**Key insight:** Resolution in Agor means "this conversation reached conclusion" (question answered, decision made, action taken, issue addressed). It's valid for many comment types, but not all.

---

## Attachment Strategy Exploration

### Option 1: Spatial Annotations (Figma Pattern)

**How it works:** Comments pinned to (x, y) coordinates on board canvas, visible as icons/pins.

**User Experience:**

1. User clicks "Comment" button in header → enters comment mode
2. Clicks anywhere on canvas → comment bubble appears at that location
3. Other users see comment pin at (x, y) coordinate
4. Click pin → opens comment thread in right panel
5. Comments stay at coordinates even if sessions move

**Visual Example:**

```
┌──────────────────────────────────────┐
│  Board: Auth Refactor                │
│                                      │
│  [Session A]      💬 "Check this!"  │
│                   ↑ (x:300, y:150)  │
│                                      │
│       💬 "Why OAuth?"                │
│       ↑ (x:150, y:250)               │
│                                      │
│            [Session B]  [Session C]  │
│                                      │
│  💬 "Needs review"                   │
│  ↑ (x:100, y:400)                    │
└──────────────────────────────────────┘
```

**Pros:**

- ✅ True Figma-like experience
- ✅ Spatial context preserved ("that area", "top left")
- ✅ Can comment on empty space (e.g., "add session here")
- ✅ Visual scan shows discussion hotspots

**Cons:**

- ❌ Complex UX (comment mode, pin placement)
- ❌ Sessions move → comments don't follow (confusing)
- ❌ Clutter on canvas (many pins)
- ❌ Hard to see all comments (must scan canvas)
- ❌ Doesn't work well for non-visual discussions

**Technical:**

- Store `{ x: number, y: number }` in React Flow coordinates
- Render as custom nodes on canvas
- Need "comment mode" UI state

---

### Option 2: Object-Level Comments (GitHub PR Pattern)

**How it works:** Comments attached to specific entities (sessions, tasks, messages).

**User Experience:**

1. Right-click session → "Add comment"
2. Comment appears in session's context (SessionDrawer or dedicated comments section)
3. Comments follow the object (if session moves, comments move with it)

**Visual Example:**

```
Session A (Claude Code)
├─ Task 1: Implement auth
│  └─ 💬 "Use bcrypt for hashing" (Alice, 2h ago)
├─ Task 2: Add JWT
│  ├─ 💬 "Expiry should be 15min" (Bob, 1h ago)
│  └─ 💬 "Agreed" (Alice, 30m ago)
└─ Message 12 (assistant response)
   └─ 💬 "This approach won't scale" (Charlie, 10m ago)
```

**Pros:**

- ✅ Clear context (comment belongs to specific thing)
- ✅ Follows object (session moves → comments move)
- ✅ Natural fit for code review ("comment on this task")
- ✅ Can be granular (message-level) or coarse (session-level)

**Cons:**

- ❌ Can't comment on "general board" topics
- ❌ Harder to see all comments at once
- ❌ Requires context switching (open session to see comments)
- ❌ Complex data model (comments on multiple entity types)

**Technical:**

- `session_id`, `task_id`, or `message_id` foreign keys
- Display inline in SessionDrawer or as badges on session cards
- Need UI for each attachment point

---

### Option 3: Board-Level Conversations (Slack Channel Pattern)

**How it works:** Single chronological conversation thread per board (like a Slack channel).

**User Experience:**

1. Click "Comments" in header → drawer opens with conversation
2. See all board discussions in one place (oldest → newest)
3. Reference sessions with `#session-id` syntax
4. Click reference → highlights/opens session

**Visual Example:**

```
💬 Board: Auth Refactor

Alice (2h ago):
  "Started working on JWT implementation in #0199b856"

Bob (1h ago):
  "Looks good, but check #0199c4d2 - the expiry logic needs work"

Charlie (30m ago):
  "@alice can you review the bcrypt setup in #0199d123?"

Alice (10m ago):
  "@charlie looks good! Ready to merge"
```

**Pros:**

- ✅ Simple mental model (one conversation per board)
- ✅ Easy to see all discussions in one place
- ✅ Natural for async team communication
- ✅ No spatial complexity
- ✅ Works well for general questions ("which approach is best?")

**Cons:**

- ❌ Not Figma-like (no spatial context)
- ❌ Can get noisy with many comments
- ❌ Context requires manual references (#session-id)
- ❌ Less visual than spatial pins

**Technical:**

- Simple schema: `board_id` + `content` + `created_by`
- Optional `session_id`/`task_id` for explicit links
- Parse `#session-id` references for clickable links

---

### Option 4: Hybrid Approach

**How it works:** Combine board-level conversations + optional object attachments.

**User Experience:**

1. Default: Board-level conversation (Slack-style)
2. Optional: Attach comment to session/task (shows badge on card)
3. Drawer shows all comments, with visual grouping by context

**Visual Example:**

```
💬 Board Comments                   Filter: [All] [Sessions] [General]

📌 Session #0199b856
  Alice (2h ago): "JWT implementation done"
  Bob (1h ago): "Expiry logic needs work"

💬 General
  Charlie (45m ago): "Should we use OAuth instead?"
  Alice (30m ago): "Let's stick with JWT for now"

📌 Session #0199c4d2
  Charlie (10m ago): "@alice bcrypt setup looks good"
```

**Pros:**

- ✅ Flexibility (general + specific discussions)
- ✅ Simple default (board conversations)
- ✅ Optional context (attach to sessions when needed)
- ✅ Easy to see all comments in one place

**Cons:**

- ❌ More complex UX (two modes)
- ❌ Users might not understand when to attach vs not

**Technical:**

- Same schema as Option 3, but `session_id`/`task_id` are prominently used
- UI allows tagging sessions from within comment input

---

## Final Design: Figma-Style Threaded Comments with Reactions

After exploring multiple approaches and use cases, here's what we're building:

### Core Design Decisions

1. **Threading Model: Figma-Style (2-Layer Only)**
   - Every comment is a potential thread
   - Thread root = `parent_comment_id IS NULL`
   - Replies = `parent_comment_id IS NOT NULL`
   - No recursive nesting (replies cannot have replies)

2. **Reactions: JSON Blob (Table Stakes)**
   - Stored as JSON array on each comment/reply: `[{ user_id, emoji }, ...]`
   - Both thread roots AND replies can have reactions
   - Display grouped by emoji: `{ "👍": ["alice", "bob"], "🎉": ["charlie"] }`

3. **Resolution: Thread Roots Only**
   - Only top-level comments (thread roots) can be resolved
   - Replies don't have resolution state
   - Resolved threads can still receive new replies

4. **Attachments: Thread Roots Only**
   - Thread roots MUST have attachment (board_id, session_id, task_id, or position)
   - Replies inherit context from parent
   - Replies don't store attachment fields

5. **UI: List-Based Threads (Not Chat)**
   - Switch from `Bubble.List` (chat) to `List` (structured threads)
   - All comments left-aligned (not chat-style left/right)
   - Nested replies indented under parent
   - Reactions displayed inline with existing `emoji-picker-react`

### Why This Works

- ✅ **Simple mental model** - Every comment is a thread, replies nest under it
- ✅ **Proven pattern** - Figma/GitHub/Linear all use this
- ✅ **Future-proof** - Schema supports all attachment types (board, session, spatial)
- ✅ **Real-time friendly** - WebSocket broadcasts work naturally
- ✅ **Bounded complexity** - 2 layers prevent infinite nesting chaos

### Figma vs Agor Context

| Aspect    | Figma                       | Agor                            |
| --------- | --------------------------- | ------------------------------- |
| Content   | Static designs              | Movable session cards           |
| Feedback  | Visual ("move this")        | Abstract ("why this approach?") |
| Anchors   | UI elements (buttons, text) | Sessions (already have IDs)     |
| Layout    | Fixed layout per frame      | Free-form board arrangement     |
| Use Case  | Design critique             | Code review, planning           |
| Threading | 2-layer (comment + replies) | **2-layer (same!)** ✅          |
| Reactions | ✅ Emoji reactions          | **✅ Emoji reactions** ✅       |

**Key insight:** Agor conversations blend Figma's spatial annotations with GitHub's code review threads. We support both abstract discussions (board-level) AND object-specific feedback (session/task/message-level)

---

## Data Model: Single Table with Threading and Reactions

### Table: `board_comments`

**Design Philosophy:** Single table handles both thread roots and replies using `parent_comment_id`. Reactions stored as JSON blob for simplicity.

```typescript
// Location: packages/core/src/db/schema.ts
export const boardComments = sqliteTable(
  'board_comments',
  {
    // Primary identity
    comment_id: text('comment_id', { length: 36 }).primaryKey(), // UUIDv7
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }),

    // Threading (Figma-style: 2 layers only)
    // NULL = thread root (top-level comment)
    // NOT NULL = reply (child comment)
    parent_comment_id: text('parent_comment_id', { length: 36 }).references(
      () => boardComments.comment_id,
      { onDelete: 'cascade' }
    ),

    // Authorship
    created_by: text('created_by', { length: 36 })
      .notNull()
      .references(() => users.user_id, { onDelete: 'cascade' }),

    // ATTACHMENTS (only for thread roots, NULL for replies)
    // At least ONE required for thread roots, ALL should be NULL for replies
    board_id: text('board_id', { length: 36 }).references(() => boards.board_id, {
      onDelete: 'cascade',
    }),
    session_id: text('session_id', { length: 36 }).references(() => sessions.session_id, {
      onDelete: 'set null',
    }),
    task_id: text('task_id', { length: 36 }).references(() => tasks.task_id, {
      onDelete: 'set null',
    }),
    message_id: text('message_id', { length: 36 }).references(() => messages.message_id, {
      onDelete: 'set null',
    }),
    worktree_id: text('worktree_id', { length: 36 }).references(() => worktrees.worktree_id, {
      onDelete: 'set null',
    }),

    // SPATIAL POSITIONING (Phase 3)
    // Stored as JSON to support both absolute and relative positioning
    position: text('position', { mode: 'json' }).$type<{
      // Absolute board coordinates (React Flow coordinates)
      absolute?: { x: number; y: number };

      // OR relative to session (follows session when it moves)
      relative?: {
        session_id: string;
        offset_x: number; // Offset from session's top-left corner
        offset_y: number;
      };
    }>(),

    // Content
    content: text('content').notNull(), // Markdown-supported text
    content_preview: text('content_preview').notNull(), // First 200 chars

    // Reactions (for BOTH thread roots and replies)
    // Stored as JSON array: [{ user_id: "abc", emoji: "👍" }, ...]
    // Display grouped by emoji: { "👍": ["alice", "bob"], "🎉": ["charlie"] }
    reactions: text('reactions', { mode: 'json' })
      .$type<Array<{ user_id: string; emoji: string }>>()
      .default(sql`'[]'`),

    // Metadata
    resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false), // Only meaningful for thread roots
    edited: integer('edited', { mode: 'boolean' }).notNull().default(false),
    mentions: text('mentions', { mode: 'json' }).$type<string[]>(), // Array of user IDs
  },
  table => ({
    boardIdx: index('board_comments_board_idx').on(table.board_id),
    sessionIdx: index('board_comments_session_idx').on(table.session_id),
    taskIdx: index('board_comments_task_idx').on(table.task_id),
    messageIdx: index('board_comments_message_idx').on(table.message_id),
    worktreeIdx: index('board_comments_worktree_idx').on(table.worktree_id),
    createdByIdx: index('board_comments_created_by_idx').on(table.created_by),
    parentIdx: index('board_comments_parent_idx').on(table.parent_comment_id), // Critical for fetching replies
    createdIdx: index('board_comments_created_idx').on(table.created_at),
  })
);
```

### Business Rules

**Thread Roots (parent_comment_id IS NULL):**

1. MUST have at least one attachment:
   - `board_id` (general board discussion)
   - `session_id` (session-specific feedback)
   - `task_id` (task-specific feedback)
   - `message_id` (message-specific code review)
   - `worktree_id` (project-level milestone)
   - `position` (spatial annotation on canvas)

2. CAN be resolved (`resolved = true/false`)
3. CAN have replies (children with `parent_comment_id = this.comment_id`)
4. CAN have reactions

**Replies (parent_comment_id IS NOT NULL):**

1. MUST have `parent_comment_id` linking to thread root
2. SHOULD NOT have attachment fields (inherited from parent)
3. CANNOT be resolved (field ignored)
4. CANNOT have replies (2-layer limit)
5. CAN have reactions

### Attachment Type Logic

**How the system determines where to render a comment:**

```typescript
function getCommentAttachmentType(comment: BoardComment) {
  // Replies inherit context from parent
  if (comment.parent_comment_id) {
    return 'reply'; // Context comes from parent thread
  }

  // Thread roots (most specific → least specific)
  if (comment.message_id) return 'message';
  if (comment.task_id) return 'task';
  if (comment.session_id && comment.position?.relative) return 'session-spatial';
  if (comment.session_id) return 'session';
  if (comment.worktree_id) return 'worktree';
  if (comment.position?.absolute) return 'board-spatial';
  if (comment.board_id) return 'board';

  throw new Error('Thread root must have at least one attachment');
}
```

**Attachment hierarchy (thread roots only):**

1. **Message-level** - Most specific (e.g., "This line of code is wrong")
2. **Task-level** - Specific to a task (e.g., "This approach won't scale")
3. **Session-spatial** - Visual pin on session (e.g., "Check this session's output")
4. **Session-level** - Attached to session (e.g., "Great work on this!")
5. **Worktree-level** - Project milestones (e.g., "Auth system complete!")
6. **Board-spatial** - Visual pin on empty space (e.g., "Add session here")
7. **Board-level** - General conversation (e.g., "Should we use JWT?")

### TypeScript Types

```typescript
// Location: packages/core/src/types/board-comment.ts
import type { BoardID, CommentID, SessionID, TaskID, MessageID, WorktreeID, UserID } from './id';

// Individual reaction
export interface CommentReaction {
  user_id: string;
  emoji: string;
}

// Reactions grouped by emoji for display
export type ReactionSummary = {
  [emoji: string]: string[]; // { "👍": ["alice", "bob"], "🎉": ["charlie"] }
};

// Position for spatial comments (Phase 3)
export interface CommentPosition {
  absolute?: { x: number; y: number }; // Absolute board coordinates
  relative?: {
    // Relative to session (follows when moved)
    session_id: string;
    offset_x: number;
    offset_y: number;
  };
}

// Main comment type
export interface BoardComment {
  comment_id: CommentID;
  parent_comment_id?: CommentID; // NULL = thread root, NOT NULL = reply

  // Attachments (only for thread roots)
  board_id?: BoardID;
  session_id?: SessionID;
  task_id?: TaskID;
  message_id?: MessageID;
  worktree_id?: WorktreeID;
  position?: CommentPosition;

  content: string; // Markdown text
  content_preview: string; // First 200 chars for list views

  reactions: CommentReaction[]; // Raw storage format
  resolved: boolean; // Only meaningful for thread roots
  edited: boolean;
  mentions?: UserID[];

  created_by: UserID;
  created_at: Date;
  updated_at?: Date;
}

export type BoardCommentCreate = Omit<
  BoardComment,
  'comment_id' | 'created_at' | 'updated_at' | 'reactions' | 'resolved' | 'edited'
> & {
  reactions?: CommentReaction[];
  resolved?: boolean;
  edited?: boolean;
};

// Helper functions
export function isThreadRoot(comment: BoardComment): boolean {
  return !comment.parent_comment_id;
}

export function isReply(comment: BoardComment): boolean {
  return !!comment.parent_comment_id;
}

export function isResolvable(comment: BoardComment): boolean {
  return isThreadRoot(comment);
}

export function groupReactions(reactions: CommentReaction[]): ReactionSummary {
  const grouped: Record<string, string[]> = {};
  for (const { emoji, user_id } of reactions) {
    if (!grouped[emoji]) grouped[emoji] = [];
    grouped[emoji].push(user_id);
  }
  return grouped;
}
```

### Why Board-Scoped?

- **Privacy:** Comments stay within board context (future: board permissions)
- **Organization:** Conversations naturally grouped by project/feature
- **Performance:** Smaller query scope (vs. global chat)
- **Figma pattern:** Comments belong to files/boards, not global

---

## Backend Architecture

### FeathersJS Service

**Location:** `apps/agor-daemon/src/services/board-comments.ts`

```typescript
import { hooks } from '@feathersjs/feathers';
import type { Application } from '../declarations';
import { BoardCommentsRepository } from '@agor/core/db/repositories/board-comments';

export function boardComments(app: Application) {
  const repository = new BoardCommentsRepository(app.get('db'));

  app.use('/board-comments', {
    async find(params) {
      const { board_id, session_id, task_id } = params.query || {};
      return repository.findAll({ board_id, session_id, task_id });
    },

    async get(id: string) {
      return repository.findById(id);
    },

    async create(data) {
      // Extract mentions from content (e.g., "@alice" → user_id lookup)
      const mentions = extractMentions(data.content, app);
      return repository.create({ ...data, mentions });
    },

    async patch(id: string, data) {
      return repository.update(id, { ...data, edited: true });
    },

    async remove(id: string) {
      return repository.delete(id);
    },
  });

  // Register service for WebSocket events
  app.service('board-comments').hooks({
    before: {
      create: [
        // Validate board_id exists
        // Validate created_by exists (if not anonymous)
        // Auto-populate content_preview
      ],
    },
    after: {
      create: [
        // Send notifications to @mentioned users (future)
      ],
    },
  });
}
```

### WebSocket Broadcasting

**No changes needed!** Existing FeathersJS setup already broadcasts:

```typescript
// apps/agor-daemon/src/index.ts
app.publish(() => {
  return app.channel('everybody'); // All CRUD events broadcast
});
```

**Events emitted:**

- `board-comments created` - New comment
- `board-comments patched` - Comment edited
- `board-comments removed` - Comment deleted

**Future:** Board-specific channels for privacy:

```typescript
app.service('board-comments').publish('created', comment => {
  return app.channel(`board-${comment.board_id}`);
});
```

---

## UI/UX Design

### Component Strategy

**Phase 1 (shipped):** Used `Bubble.List` from Ant Design X for chat-style UI
**Phase 2 (now):** Switching to **Ant Design `List`** for threaded comment structure

**Why the switch:**

- ❌ `Bubble.List` is designed for AI chat (left/right message flow)
- ✅ `List` supports structured threads with nesting
- ✅ More like Figma/GitHub comments (all left-aligned, hierarchical)
- ✅ Better for 2-layer threading model

**Component breakdown:**

1. **`List`** (Ant Design) - Main container for thread roots
2. **`List.Item`** (Ant Design) - Individual thread root + nested replies
3. **`Sender`** (Ant Design X) - Input box (keep for @ mention support)
4. **`EmojiPicker`** (emoji-picker-react) - Already in use! Reaction picker

**Installation (already complete):**

```bash
# Already installed:
# - antd (for List, Avatar, Space, etc.)
# - @ant-design/x (for Sender)
# - emoji-picker-react (for reactions)
```

### CommentsDrawer Component (Phase 2: List-Based Threads)

**Location:** `apps/agor-ui/src/components/CommentsDrawer/CommentsDrawer.tsx`

```tsx
import { Drawer, List, Avatar, Space, Button, Badge, Popover, Tag } from 'antd';
import { CommentOutlined, SmileOutlined } from '@ant-design/icons';
import { Sender } from '@ant-design/x';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { BoardComment, User, ReactionSummary } from '@agor/core/types';
import { groupReactions, isThreadRoot } from '@agor/core/types';

interface CommentsDrawerProps {
  open: boolean;
  onClose: () => void;
  boardId: string;
  comments: BoardComment[]; // Includes both thread roots and replies
  users: User[];
  currentUserId: string;
  onSendComment: (content: string) => void;
  onReplyComment: (parentId: string, content: string) => void;
  onResolveComment: (commentId: string) => void;
  onToggleReaction: (commentId: string, emoji: string) => void;
}

export const CommentsDrawer: React.FC<CommentsDrawerProps> = ({
  open,
  onClose,
  comments,
  users,
  currentUserId,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
}) => {
  const [filter, setFilter] = React.useState<'all' | 'unresolved' | 'mentions'>('all');

  // Separate thread roots from replies
  const threadRoots = comments.filter(c => isThreadRoot(c));
  const allReplies = comments.filter(c => !isThreadRoot(c));

  // Group replies by parent
  const repliesByParent = allReplies.reduce(
    (acc, reply) => {
      if (reply.parent_comment_id) {
        if (!acc[reply.parent_comment_id]) acc[reply.parent_comment_id] = [];
        acc[reply.parent_comment_id].push(reply);
      }
      return acc;
    },
    {} as Record<string, BoardComment[]>
  );

  // Apply filters to thread roots only
  const filteredThreads = threadRoots.filter(thread => {
    if (filter === 'unresolved' && thread.resolved) return false;
    if (filter === 'mentions' && !thread.mentions?.includes(currentUserId)) return false;
    return true;
  });

  return (
    <Drawer
      title={
        <Space>
          <CommentOutlined />
          <span>Comments</span>
          <Badge count={filteredThreads.length} showZero={false} />
        </Space>
      }
      placement="left"
      width={500}
      open={open}
      onClose={onClose}
    >
      {/* Filter Tabs */}
      <Space style={{ padding: 16, borderBottom: '1px solid var(--colorBorder)' }}>
        <Button
          type={filter === 'all' ? 'primary' : 'default'}
          size="small"
          onClick={() => setFilter('all')}
        >
          All
        </Button>
        <Button
          type={filter === 'unresolved' ? 'primary' : 'default'}
          size="small"
          onClick={() => setFilter('unresolved')}
        >
          Open
        </Button>
        <Button
          type={filter === 'mentions' ? 'primary' : 'default'}
          size="small"
          onClick={() => setFilter('mentions')}
        >
          Mentions
        </Button>
      </Space>

      {/* Thread List */}
      <List
        dataSource={filteredThreads}
        renderItem={thread => (
          <CommentThread
            comment={thread}
            replies={repliesByParent[thread.comment_id] || []}
            users={users}
            currentUserId={currentUserId}
            onReply={onReplyComment}
            onResolve={onResolveComment}
            onToggleReaction={onToggleReaction}
          />
        )}
      />

      {/* Input Box for new top-level comment */}
      <div style={{ padding: 16, borderTop: '1px solid var(--colorBorder)' }}>
        <Sender placeholder="Add a comment..." onSubmit={onSendComment} />
      </div>
    </Drawer>
  );
};

// Individual thread component (root + replies)
const CommentThread: React.FC<{
  comment: BoardComment;
  replies: BoardComment[];
  users: User[];
  currentUserId: string;
  onReply: (parentId: string, content: string) => void;
  onResolve: (commentId: string) => void;
  onToggleReaction: (commentId: string, emoji: string) => void;
}> = ({ comment, replies, users, currentUserId, onReply, onResolve, onToggleReaction }) => {
  const [showReplyInput, setShowReplyInput] = React.useState(false);
  const user = users.find(u => u.user_id === comment.created_by);

  return (
    <List.Item>
      <div style={{ width: '100%' }}>
        {/* Thread Root */}
        <List.Item.Meta
          avatar={<Avatar>{user?.emoji || '👤'}</Avatar>}
          title={
            <Space>
              <span>{user?.name || 'Anonymous'}</span>
              <span style={{ color: 'gray', fontSize: 12 }}>
                {new Date(comment.created_at).toLocaleTimeString()}
              </span>
              {comment.resolved && <Tag color="success">Resolved</Tag>}
            </Space>
          }
          description={comment.content}
        />

        {/* Reactions */}
        <ReactionBar
          reactions={groupReactions(comment.reactions)}
          currentUserId={currentUserId}
          onToggle={emoji => onToggleReaction(comment.comment_id, emoji)}
        />

        {/* Actions */}
        <Space style={{ marginTop: 8 }}>
          <Button type="link" size="small" onClick={() => setShowReplyInput(!showReplyInput)}>
            Reply
          </Button>
          <Button type="link" size="small" onClick={() => onResolve(comment.comment_id)}>
            {comment.resolved ? 'Reopen' : 'Resolve'}
          </Button>
        </Space>

        {/* Nested Replies (1 level deep) */}
        {replies.length > 0 && (
          <div
            style={{
              marginLeft: 48,
              marginTop: 12,
              borderLeft: '2px solid var(--colorBorder)',
              paddingLeft: 12,
            }}
          >
            <List
              dataSource={replies}
              renderItem={reply => {
                const replyUser = users.find(u => u.user_id === reply.created_by);
                return (
                  <List.Item style={{ borderBottom: 'none', padding: '8px 0' }}>
                    <List.Item.Meta
                      avatar={<Avatar size="small">{replyUser?.emoji || '👤'}</Avatar>}
                      title={
                        <Space>
                          <span style={{ fontSize: 14 }}>{replyUser?.name || 'Anonymous'}</span>
                          <span style={{ color: 'gray', fontSize: 11 }}>
                            {new Date(reply.created_at).toLocaleTimeString()}
                          </span>
                        </Space>
                      }
                      description={reply.content}
                    />
                    <ReactionBar
                      reactions={groupReactions(reply.reactions)}
                      currentUserId={currentUserId}
                      onToggle={emoji => onToggleReaction(reply.comment_id, emoji)}
                    />
                  </List.Item>
                );
              }}
            />
          </div>
        )}

        {/* Reply Input */}
        {showReplyInput && (
          <div style={{ marginLeft: 48, marginTop: 8 }}>
            <Sender
              placeholder="Reply..."
              onSubmit={content => {
                onReply(comment.comment_id, content);
                setShowReplyInput(false);
              }}
            />
          </div>
        )}
      </div>
    </List.Item>
  );
};

// Reaction bar component
const ReactionBar: React.FC<{
  reactions: ReactionSummary;
  currentUserId: string;
  onToggle: (emoji: string) => void;
}> = ({ reactions, currentUserId, onToggle }) => {
  const [pickerOpen, setPickerOpen] = React.useState(false);

  return (
    <Space size="small" style={{ marginTop: 8 }}>
      {Object.entries(reactions).map(([emoji, userIds]) => (
        <Button
          key={emoji}
          size="small"
          type={userIds.includes(currentUserId) ? 'primary' : 'default'}
          onClick={() => onToggle(emoji)}
        >
          {emoji} {userIds.length}
        </Button>
      ))}
      <Popover
        content={
          <EmojiPicker
            onEmojiClick={emojiData => {
              onToggle(emojiData.emoji);
              setPickerOpen(false);
            }}
            theme={Theme.DARK}
            width={350}
            height={400}
          />
        }
        trigger="click"
        open={pickerOpen}
        onOpenChange={setPickerOpen}
      >
        <Button size="small" icon={<SmileOutlined />} />
      </Popover>
    </Space>
  );
};
```

### AppHeader Toggle Button

**Location:** `apps/agor-ui/src/components/AppHeader/AppHeader.tsx`

Add comment icon button:

```tsx
import { CommentOutlined } from '@ant-design/icons';

export const AppHeader: React.FC<AppHeaderProps> = ({
  // ... existing props
  onCommentsClick, // NEW
  unreadCommentsCount = 0, // NEW
}) => {
  return (
    <Header>
      <Space>
        {/* Existing buttons... */}
        <Badge count={unreadCommentsCount} dot>
          <Button
            type="text"
            icon={<CommentOutlined />}
            onClick={onCommentsClick}
            style={{ color: '#fff' }}
            title="Board Comments"
          />
        </Badge>
        {/* ... rest of header */}
      </Space>
    </Header>
  );
};
```

### Layout Integration

**Dual drawers:** SessionDrawer (right) + CommentsDrawer (left) can be open simultaneously.

```
┌────────────────────────────────────────────────┐
│             AppHeader [💬 Comments]            │
├──────────┬────────────────────────┬────────────┤
│          │                        │            │
│ Comments │   Session Canvas       │  Session   │
│ Drawer   │   (React Flow)         │  Drawer    │
│ (LEFT)   │                        │  (RIGHT)   │
│          │                        │            │
│ 💬 All   │   [Sessions] [Zones]   │ 🤖 Claude  │
│ 💬 @me   │                        │ Conversation
│ 💬 Open  │                        │ View       │
│          │                        │            │
└──────────┴────────────────────────┴────────────┘
```

---

## Advanced Features (V2+)

### 1. Context Links

Parse content for session/task references:

```markdown
Check session #0199b856 - the auth flow works!
```

→ Renders as clickable link that:

- Highlights session on canvas
- Opens SessionDrawer

### 2. @ Mentions with Autocomplete

**Sender component enhancement:**

```tsx
<Sender
  placeholder="Add comment..."
  onSend={handleSend}
  mentionOptions={users.map(u => ({
    value: u.user_id,
    label: `${u.emoji} ${u.name}`,
  }))}
/>
```

### 3. Notifications

**Future integration:**

- Email notifications for @mentions
- In-app toast when mentioned
- Badge count for unread mentions

### 4. Rich Media

**Ant Design X `<Attachment>` component:**

- Upload images/screenshots
- Attach code snippets
- Link to external resources

### 5. Comment Threads (Nested Replies)

Use `parent_comment_id` for GitHub-style threaded discussions:

```
💬 Alice: "Should we use JWT?"
  └─ 💬 Bob: "Yes, see session #abc123"
      └─ 💬 Charlie: "Agreed!"
```

### 6. Board Permissions

**Future:** When board access control is implemented:

- Only board members see comments
- Private boards = private comments
- Public boards = public comments (read-only for non-members)

---

## React Flow Spatial Rendering (Phase 3+)

### Technical Implementation

**Question:** How do we render comment pins spatially on the canvas?

**Answer:** React Flow provides APIs to get node positions and render comments as custom nodes!

### Getting Node Positions

```typescript
import { useReactFlow } from '@xyflow/react';

function CommentPinRenderer({ comment }: { comment: BoardComment }) {
  const { getNode } = useReactFlow();

  // Calculate final position based on attachment type
  const position = React.useMemo(() => {
    if (comment.position?.absolute) {
      // Absolute board coordinates
      return comment.position.absolute;
    }

    if (comment.position?.relative) {
      // Relative to session - follows session when it moves
      const sessionNode = getNode(comment.position.relative.session_id);
      if (sessionNode) {
        return {
          x: sessionNode.position.x + comment.position.relative.offset_x,
          y: sessionNode.position.y + comment.position.relative.offset_y,
        };
      }
    }

    // Fallback: center of board
    return { x: 0, y: 0 };
  }, [comment, getNode]);

  return { position };
}
```

**Key React Flow APIs:**

- `useReactFlow()` - Hook to access React Flow instance
- `getNode(id)` - O(1) lookup of node by ID, returns `{ position: { x, y }, ... }`
- `getNodes()` - Get all nodes
- `screenToFlowPosition()` - Convert screen coords → flow coords
- `project()` - Convert screen coords → flow coords (alternative)

### Rendering Comment Pins as React Flow Nodes

**Option A: Comment pins as custom nodes**

```typescript
// Add comment nodes to React Flow nodes array
const allNodes = [
  ...sessionNodes,
  ...zoneNodes,
  ...commentNodes.map(comment => ({
    id: `comment-${comment.comment_id}`,
    type: 'comment', // Custom node type
    position: calculateCommentPosition(comment, getNode),
    data: { comment },
    draggable: false,
    selectable: true,
  })),
];

// Custom comment node component
function CommentNode({ data }: { data: { comment: BoardComment } }) {
  const { comment } = data;

  return (
    <div
      style={{
        background: '#ffeb3b',
        borderRadius: '50%',
        width: 32,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      }}
      onClick={() => openCommentThread(comment)}
    >
      💬
    </div>
  );
}

// Register custom node type
const nodeTypes = {
  session: SessionNode,
  zone: ZoneNode,
  comment: CommentNode, // NEW
};
```

**Benefits:**

- ✅ Comments automatically part of React Flow coordinate system
- ✅ Pan/zoom handled automatically
- ✅ Can make draggable (reposition comments)
- ✅ Works in minimap (appears as small dots)

**Option B: Overlay layer with manual positioning**

Use DOM positioning with `getBoundingClientRect()` + coordinate conversion. More complex, not recommended.

### Absolute vs Relative Positioning

**Use Case 1: Comment on empty space (absolute)**

User clicks empty canvas → comment placed at (x, y) absolute coordinates.

```typescript
// Creating comment
const handleCanvasClick = (event: React.MouseEvent) => {
  const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });

  createComment({
    board_id,
    created_by,
    content: 'Add a session here',
    position: { absolute: flowPosition },
  });
};
```

**Behavior:** Comment stays at (x, y) even if sessions move around it.

**Use Case 2: Comment on session (relative)**

User right-clicks session → comment placed relative to session.

```typescript
// Creating comment on session
const handleSessionComment = (sessionId: string, offsetX: number, offsetY: number) => {
  createComment({
    board_id,
    session_id: sessionId,
    created_by,
    content: 'Check this output',
    position: {
      relative: {
        session_id: sessionId,
        offset_x: offsetX, // e.g., +50px from session top-left
        offset_y: offsetY, // e.g., -20px (above session)
      },
    },
  });
};
```

**Behavior:** Comment follows session when user drags it to new position!

### Comment Pin Lifecycle

```
1. User creates comment → Store in database with position
2. UI loads comments → Filter by board_id
3. Calculate positions:
   - Absolute: Use position.absolute directly
   - Relative: getNode(session_id) + offset
4. Render as React Flow nodes
5. User clicks pin → Open thread in drawer/popover
6. Session moves → Relative comments auto-update (React Flow re-renders)
```

### Performance Considerations

**Concern:** Many comment pins on canvas?

**Solution:**

- Only render comments for current board (board_id filter)
- Limit: ~50-100 comment pins per board (reasonable for team discussions)
- Use React Flow's built-in virtualization (only renders visible nodes)
- Comment drawer shows ALL comments (scrollable), canvas shows pins

**Optimization:**

```typescript
// Only render spatial comments as pins (not board-level conversations)
const spatialComments = comments.filter(c => c.position?.absolute || c.position?.relative);
const conversationComments = comments.filter(c => !c.position);
```

---

## Implementation Phases

### Phase 1: MVP (Board-Level Conversations) ✅ COMPLETE

- [x] Database table `board_comments` (flexible schema) - `packages/core/src/db/schema.ts:561-633`
- [x] **Incremental migration system** - `packages/core/src/db/migrate.ts`
  - Added `tableExists()` helper for checking individual tables
  - `initializeDatabase()` now checks for missing tables on existing DBs
  - Automatically adds `board_comments` table if missing
  - Pattern established for future incremental migrations
- [x] Auto-migration on daemon startup - `apps/agor-daemon/src/index.ts:281-283`
- [x] FeathersJS service `/board-comments` - `apps/agor-daemon/src/services/board-comments.ts`
  - Returns paginated results (`{ data, total, limit, skip }`)
  - Supports filtering by board_id, session_id, task_id, etc.
- [x] Repository layer with CRUD operations - `packages/core/src/db/repositories/board-comments.ts`
  - Type-safe branded UUID handling
  - Short ID support via `resolveId()`
  - Bulk create, resolve/unresolve, find by mentions
- [x] TypeScript types (`BoardComment`, `CommentID`, etc.) - `packages/core/src/types/board-comment.ts`
- [x] **CommentsDrawer component (Ant Design X Bubble.List)** - `apps/agor-ui/src/components/CommentsDrawer/`
  - Uses `Bubble.List` for chat-style message bubbles
  - Avatar with emoji, user name, timestamp
  - Resolve/unresolve buttons
  - Delete button (for current user only)
- [x] AppHeader toggle button with badge - `apps/agor-ui/src/components/AppHeader/AppHeader.tsx`
- [x] WebSocket real-time updates - `apps/agor-ui/src/hooks/useAgorData.ts:336-351`
  - Comments created/patched/removed events
  - Auto-updates UI without page refresh
- [x] Create/read/delete board-level comments (Phase 1 scope)
- [x] Resolve/unresolve comments
- [x] Filter tabs (All/Unresolved/Mentions)

**Status:** Shipped! 🎉 (January 2025)

**Schema note:** All optional fields (session_id, task_id, message_id, worktree_id, position, mentions) included in schema for Phase 2+

**Migration Strategy Established:**

- **Incremental table-by-table checking** for existing databases
- Manual SQL migrations in `packages/core/src/db/migrate.ts`
- `CREATE TABLE IF NOT EXISTS` pattern (safe for existing databases)
- `tableExists()` helper checks for individual tables
- Auto-run on daemon startup via `initializeDatabase()`
- Future migrations: Add new `tableExists()` check and SQL in `initializeDatabase()`

**Key Implementation Learnings:**

1. **Drizzle Kit `push`** doesn't work with existing DBs that have indexes
   - Falls back to manual SQL with incremental checks
2. **Ant Design X components:**
   - ❌ `Conversations` = List of conversation threads (sidebar)
   - ✅ `Bubble.List` = Chat message bubbles (conversation view)
3. **FeathersJS pagination:** Services must return `{ data, total, limit, skip }`
   - UI unpacks: `Array.isArray(result) ? result : result.data`
4. **Branded UUID types:** Need explicit casts when converting DB rows:
   - `row.user_id as UUID` not just `row.user_id`

### Phase 2: Threaded Comments with Reactions ✅ COMPLETE

**Goal:** Upgrade from flat chat-style comments to Figma-style threaded discussions with emoji reactions.

**Schema updates:**

- [x] Add `reactions` field to `board_comments` table (JSON blob)
- [x] Migration script for existing databases (auto-detects and adds column)

**Backend (Repository & Service):**

- [x] Add `toggleReaction(commentId, userId, emoji)` method
- [x] Add `createReply(parentId, content, createdBy)` method with 2-layer validation
- [x] Updated comments fetched as flat list, organized in UI
- [x] Validation: enforces no replies to replies (2-layer limit)
- [x] Custom routes with manual WebSocket broadcasting for reactions and replies

**Types & Helpers:**

- [x] Add `CommentReaction`, `ReactionSummary` types
- [x] Add `groupReactions()` helper function
- [x] Add `isThreadRoot()`, `isReply()`, `isResolvable()` helpers

**UI Components:**

- [x] Created new `CommentsPanel` component (permanent left sidebar)
- [x] Built `CommentThread` component (root + nested replies, 1 level deep)
- [x] Built `ReactionDisplay` and `EmojiPickerButton` components
- [x] Added hover-based action overlay (saves vertical space)
- [x] Reactions persist in separate row when present
- [x] Add "Reply" action to thread roots only
- [x] Update "Resolve/Reopen" logic (conditional rendering based on state)
- [x] Changed filter "Unresolved" → "Open"
- [x] Added navbar toggle button with unread count badge

**Real-time updates:**

- [x] Reply creation broadcasts correctly via manual emit
- [x] Reaction toggle updates all clients
- [x] Threads update incrementally

**UX Improvements:**

- [x] All action buttons use subtle icons with consistent styling
- [x] Hover overlay shows actions (Reply, Resolve, Delete, Add Reaction)
- [x] Auto-clears input after sending comment
- [x] Collapsed state completely hides panel
- [x] Board-scoped filtering (comments tied to current board)

**Next steps (Phase 3):**

- [ ] Link comments to sessions/tasks/messages (object attachments)
- [ ] Parse `#session-id` references in content
- [ ] Click reference → highlight/open session
- [ ] Badge on session cards showing comment count
- [ ] "Comment on this session" button in SessionDrawer

**Effort:** ~2 days

### Phase 3: Object Attachments & Context Linking

- [ ] Link comments to sessions/tasks/messages (object attachments)
- [ ] Parse `#session-id` references in content
- [ ] Click reference → highlight/open session
- [ ] Filter drawer by attachment type
- [ ] Badge on session cards showing comment count
- [ ] "Comment on this session" button in SessionDrawer
- [ ] Comment context menu on messages/tasks

**Effort:** ~2 days

### Phase 4: Spatial Annotations (Canvas Pins)

- [ ] "Add comment" canvas mode (Figma-style)
- [ ] Render comment pins as React Flow nodes
- [ ] Absolute positioning (empty space comments)
- [ ] Relative positioning (session-attached comments)
- [ ] Click pin → open thread in drawer/popover
- [ ] Drag to reposition (optional)
- [ ] Filter: show/hide spatial comments

**Effort:** ~2-3 days

### Phase 5: Mentions & Notifications

- [ ] @ mention autocomplete in Sender component
- [ ] Extract mentions from content
- [ ] Store in `mentions` field (already in schema)
- [ ] "Mentions" filter working properly
- [ ] Optional: Email/toast notifications
- [ ] Badge on header for unread mentions

**Effort:** ~1 day

### Phase 6: Advanced UX

- [ ] Edit comments (markdown preview)
- [ ] Delete comments with confirmation
- [ ] Attachments (images, files) - Ant Design X `<Attachment>`
- [ ] Mark comments as "outdated" (like GitHub)
- [ ] Keyboard shortcuts (Cmd+/ to toggle drawer)
- [ ] Link to comment (shareable URLs)

**Effort:** ~2 days

---

## Alternative Approaches Considered

### ❌ Global Chat (Rejected)

**Why not:** Doesn't scale, loses context, not Figma-like.

### ❌ Session-Scoped Comments (Rejected)

**Why not:** Too granular, board-level discussions are common ("which session should we use?").

### ✅ Board-Scoped Comments (Chosen)

**Why:** Natural context boundary, supports future board permissions, scales well.

---

## Technical Considerations

### Anonymous Mode Compatibility

**Question:** How do comments work in anonymous mode?

**Answer:**

- `created_by` defaults to `'anonymous'` user
- All comments show as "Anonymous" with default emoji
- @ mentions disabled (no user roster)
- Works for single-user local development

### Markdown Support

Use existing markdown renderer (or add):

```bash
pnpm add react-markdown
```

```tsx
import ReactMarkdown from 'react-markdown';

<Bubble content={<ReactMarkdown>{comment.content}</ReactMarkdown>} />;
```

### Performance

**Query optimization:**

```sql
-- Index on board_id ensures fast lookups
SELECT * FROM board_comments WHERE board_id = ? ORDER BY created_at ASC;

-- Session-filtered view
SELECT * FROM board_comments WHERE board_id = ? AND session_id = ? ORDER BY created_at ASC;
```

**Expected scale:**

- 100s of comments per board (fine for SQLite)
- Real-time WebSocket broadcasting (no pagination needed for MVP)

### Testing Strategy

**Unit tests:**

- Repository CRUD operations
- Mention extraction logic

**Integration tests:**

- WebSocket event emission
- Comment creation via API

**E2E tests (Storybook):**

- CommentsDrawer interactions
- Filter tabs
- Send comment flow

---

## Open Questions

1. **Default drawer state:** Should comments drawer open by default? (No - opt-in)
2. **Keyboard shortcut:** Should there be a hotkey to toggle? (e.g., `Cmd+/`)
3. **Unread tracking:** Do we need a "last read" timestamp per user? (V2 feature)
4. **Comment ordering:** Chronological (oldest first) or reverse? (Oldest first, like Figma)
5. **Editing:** Allow editing comments? Time limit? Show edit history? (Allow editing, mark as `edited`)

---

## References

- **Ant Design X:** https://x.ant.design/components/conversations/
- **Figma Comments:** https://help.figma.com/hc/en-us/articles/360041546233-Add-comments-to-files
- **GitHub PR Comments:** https://github.com (threaded replies, resolve, reactions)
- **Agor Multiplayer:** [multiplayer.md](../concepts/multiplayer.md)
- **Agor WebSockets:** [websockets.md](../concepts/websockets.md)

---

## Summary

**User conversations is a natural extension of Agor's multiplayer vision.** We've designed a flexible system that supports multiple comment attachment strategies:

### Key Design Decisions

1. **Flexible Schema** - Single table supports board-level, object-level, AND spatial comments
2. **Incremental Implementation** - Ship board conversations first (Phase 1), add complexity later
3. **Absolute + Relative Positioning** - Spatial comments can be fixed OR follow sessions
4. **React Flow Native** - Render comment pins as custom nodes for seamless pan/zoom/minimap
5. **Ant Design X Components** - Perfect fit with `<Conversations>`, `<Bubble>`, `<Sender>`

### Why This Approach Wins

| Feature                 | Status  | Benefit                               |
| ----------------------- | ------- | ------------------------------------- |
| Board conversations     | Phase 1 | Simple MVP, instant value             |
| Session attachments     | Phase 2 | Context without spatial complexity    |
| Spatial pins (absolute) | Phase 3 | Figma-like annotations on empty space |
| Spatial pins (relative) | Phase 3 | Comments follow sessions when moved   |
| Message-level comments  | Future  | Granular code review feedback         |

### Technical Highlights

- **React Flow APIs:** `useReactFlow()` + `getNode(id)` gives us O(1) position lookups
- **Relative positioning:** Comments with `session_id` + offset follow sessions automatically
- **Custom nodes:** Comment pins render as React Flow nodes (pan/zoom/minimap just work)
- **WebSocket sync:** Existing infrastructure broadcasts comment CRUD events
- **Anonymous-compatible:** Works in local dev with `created_by: 'anonymous'`

### Implementation Roadmap

**✅ Phase 1 DONE** (January 2025): Board conversations with Bubble.List (chat-style)
**🚧 Phase 2 IN PROGRESS** (~2 days): Threaded comments + reactions
**📋 Phase 3 PLANNED** (~2 days): Object attachments (session/task/message)
**📋 Phase 4 PLANNED** (~2-3 days): Spatial annotations (canvas pins)
**📋 Phase 5 PLANNED** (~1 day): Mentions & notifications
**📋 Phase 6 PLANNED** (~2 days): Advanced UX (edit, attachments, keyboard shortcuts)

This design future-proofs Agor for Figma-style spatial annotations while delivering immediate value with threaded conversations.

---

## Implementation Notes (January 2025)

### Migration System Established

First database migration successfully implemented! Pattern for future migrations:

1. **Add table/columns to schema** - `packages/core/src/db/schema.ts`
2. **Add SQL to migration** - `packages/core/src/db/migrate.ts` (`createInitialSchema`)
3. **Use `CREATE TABLE IF NOT EXISTS`** - Safe for existing databases
4. **Auto-runs on daemon startup** - `initializeDatabase()` in `apps/agor-daemon/src/index.ts`

**Key insight:** The hybrid approach (manual SQL + Drizzle ORM) works well:

- Schema.ts is source of truth for TypeScript types
- Manual SQL in migrate.ts ensures backward compatibility
- `IF NOT EXISTS` makes migrations safe and idempotent
- No migration tracking table needed (yet!)

### What Works Out of the Box

- **Real-time sync** - All users see comments instantly via WebSocket
- **Dual drawers** - Comments (left) + Session (right) can both be open
- **Anonymous mode** - Works with `created_by: 'anonymous'`
- **Unread badge** - Shows count of unresolved comments
- **Three filters** - All / Unresolved / Mentions
- **User attribution** - Emoji + name shown for each comment
- **Resolve workflow** - GitHub PR-style resolve/unresolve

### Tested & Verified

- ✅ Fresh database gets all tables (including board_comments)
- ✅ Existing database gets new table added (no data loss)
- ✅ Real-time comment creation across multiple clients
- ✅ Resolve/unresolve updates instantly
- ✅ Delete works correctly
- ✅ Filters work (All/Unresolved/Mentions)
- ✅ Badge count updates in real-time

---

## Final Design Summary (Updated February 2025)

After exploration and discussion, here are the **definitive design decisions** for Agor comments:

### 1. Threading Model: Figma-Style (2-Layer)

- **Every comment is a thread**: Thread root (`parent_comment_id IS NULL`) can have replies
- **Replies are flat**: Replies (`parent_comment_id IS NOT NULL`) cannot have sub-replies
- **Maximum depth: 2 layers** (root + replies, no recursion)

### 2. Data Storage: Single Table

- **One table** (`board_comments`) handles both thread roots and replies
- **`parent_comment_id`** distinguishes: `NULL` = root, `NOT NULL` = reply
- **Reactions as JSON blob**: `[{ user_id, emoji }, ...]` stored on each comment/reply
- **No separate reactions table**: Simpler queries, better real-time performance

### 3. Resolution & Attachments

- **Thread roots only**: Can be resolved, must have ≥1 attachment (board/session/task/message/worktree/position)
- **Replies**: Cannot be resolved, don't store attachments (inherited from parent)
- **Resolution semantics**: "This conversation reached conclusion" (question answered, decision made, action taken)

### 4. UI: List-Based Threads (Not Chat)

- **From:** `Bubble.List` (Ant Design X) - chat-style left/right bubbles
- **To:** `List` (Ant Design) - structured threads, all left-aligned
- **Inspiration:** Figma + GitHub comments (threaded discussions, not chat)

### 5. Reactions: Table Stakes

- **Storage**: JSON array `[{ user_id, emoji }, ...]` on each row
- **Display**: Grouped by emoji `{ "👍": ["alice", "bob"] }`
- **Picker**: `emoji-picker-react` (already in use)
- **Both roots and replies** can have reactions

### 6. Real-Time Updates

- **Existing FeathersJS WebSocket** broadcasts all CRUD events
- **Reply creation**: Broadcast `board-comments created` with `parent_comment_id`
- **Reaction toggle**: Patch comment with updated `reactions` array
- **No special handling needed**: Current infrastructure works perfectly

### 7. Fetching Strategy

- **Two queries**:
  1. Fetch all thread roots (`parent_comment_id IS NULL`)
  2. Fetch all replies (`parent_comment_id IS NOT NULL`)
- **Group in memory**: `repliesByParent[parent_id] = [reply1, reply2]`
- **Why not JOIN**: Simpler, more flexible, N is small (one board's comments)

### 8. Scoping Strategy

- **Phase 1 & 2**: Board-scoped only (`board_id`)
- **Phase 3**: Add object attachments (`session_id`, `task_id`, `message_id`)
- **Future**: Consider worktree-scoped conversations for project milestones
- **Key insight**: Boards = organizational views, Worktrees = projects (different scopes!)

### 9. Component Architecture

```
CommentsDrawer (Drawer)
├─ Filter buttons (All / Open / Mentions)
├─ List (thread roots)
│  └─ CommentThread (each root)
│     ├─ List.Item.Meta (avatar, name, timestamp, content)
│     ├─ ReactionBar (emoji buttons + picker)
│     ├─ Actions (Reply, Resolve)
│     ├─ Nested replies (List)
│     │  └─ List.Item (each reply)
│     │     ├─ Meta (smaller avatar, name, content)
│     │     └─ ReactionBar
│     └─ Reply input (Sender, shown on demand)
└─ New comment input (Sender)
```

### 10. Implementation Order

1. ✅ **Phase 1** - Board conversations (chat-style, shipped)
2. 🚧 **Phase 2** - Threading + reactions (List-based, in progress)
3. 📋 **Phase 3** - Object attachments (session/task/message comments)
4. 📋 **Phase 4** - Spatial annotations (canvas pins)
5. 📋 **Phase 5** - Mentions & notifications
6. 📋 **Phase 6** - Advanced UX (edit, attachments, shortcuts)

### Key Technical Decisions

| Aspect                | Decision                      | Rationale                                  |
| --------------------- | ----------------------------- | ------------------------------------------ |
| **Threading depth**   | 2 layers max                  | Prevents complexity, matches Figma/GitHub  |
| **Reactions storage** | JSON blob in same row         | Simpler than separate table, bounded data  |
| **Emoji picker**      | emoji-picker-react            | Already installed, works with Popover      |
| **UI framework**      | Ant Design `List`             | Better for threads than Bubble.List (chat) |
| **Fetching**          | Two queries + in-memory group | Simple, flexible, performant for scale     |
| **Real-time**         | Existing FeathersJS           | No changes needed, broadcasts work OOB     |
| **Resolution**        | Thread roots only             | Replies are conversational, not actionable |
| **Attachments**       | Thread roots only             | Replies inherit parent context             |

**Next Step:** Implement Phase 2 (threading + reactions) as documented in the checklist above.
