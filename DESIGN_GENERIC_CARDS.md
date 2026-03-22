# Design: Generic Cards & CardTypes

**Status:** Draft
**Author:** Claude (design session with Max)
**Date:** 2026-03-22

---

## Problem

Every entity on an Agor board is a **worktree** — a git branch tied to a repo. This limits Agor to coding workflows. But the board/zone spatial metaphor is powerful and general. With Agor Assistants, agents can do anything — yet the entity model forces everything through the git worktree lens.

**Goal:** Introduce **Cards** as a generic, schema-driven entity that lives on boards alongside worktrees, enabling arbitrary workflow orchestration.

---

## Why Cards

Agents can already do everything through chat and files. An assistant can manage tickets in a JSON file, write status to markdown, track state in its own database. Cards don't enable new *agent capabilities*.

**Cards enable human oversight of agent work.** The board becomes a dashboard where a manager can glance at 50 cards across 5 zones and see: 12 tickets in triage, 8 being worked, 3 escalated, 27 resolved — without opening a chat or asking the agent "what's the status?" The spatial layout IS the status.

This is the same insight that made Agor work for coding: you could already run Claude Code in 10 terminals, but the board gives you spatial oversight across worktrees. **Cards generalize that to any workflow.** Agor fundamentally provides spatial/visual oversight of agentic work — coding or not.

## V1 Philosophy: Dumb Cards

Cards in V1 are **visual feedback for users, fully managed by agents.**

- Agents create, update, move, and archive cards via MCP tools
- Cards are inert — no zone triggers, no events, no automation
- No auto-generated forms from JSON Schema (agents set `data` directly)
- If a user moves a card on the board, they'd need to tell their agent if they want actions taken
- The agent (Agor Assistant) is the brain; cards are the work items it visualizes

This keeps the V1 surface minimal: data model + MCP tools + board rendering + Settings CRUD.

---

## Use Cases

| Domain | Card Examples | Zone Pipeline |
|--------|--------------|---------------|
| DevOps | Incidents | Triage → Investigation → Fix → Resolved |
| Sales | Leads | Pipeline → Qualified → Proposal → Closed |
| Content | Articles | Draft → Review → Published |
| Migration | Dashboards | Assess → Migrate → Validate → Done |
| Support | Tickets | New → Assigned → In Progress → Resolved |
| Healthcare | Patients | Intake → Triage → Treatment → Discharge |

---

## Data Model

### Cards table

```sql
CREATE TABLE cards (
  card_id          TEXT PRIMARY KEY,           -- UUIDv7
  board_id         TEXT NOT NULL REFERENCES boards(board_id) ON DELETE CASCADE,
  card_type_id     TEXT REFERENCES card_types(card_type_id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  url              TEXT,                       -- Link to external resource (makes title clickable)
  description      TEXT,                       -- Markdown: stable context about the entity, collapsed after N chars on card
  note             TEXT,                       -- Markdown: agent's live commentary, always shown in full on card
  data             TEXT,                       -- JSON blob (validated against CardType.json_schema if present)
  color_override   TEXT,                       -- Hex color (null = inherit from CardType)
  emoji_override   TEXT,                       -- Single emoji character (null = inherit from CardType)
  created_by       TEXT,
  created_at       INTEGER NOT NULL,           -- timestamp_ms
  updated_at       INTEGER NOT NULL,
  archived         INTEGER DEFAULT 0,          -- boolean
  archived_at      INTEGER
);
```

**Design decisions:**

- **`board_id` required** — Cards live on boards, like worktrees. No orphan cards.
- **`card_type_id` nullable** — Untyped cards are valid. A quick sticky note doesn't need a type.
- **`url`** — Cards often represent external entities. When set, the title becomes a clickable link to the real thing.
- **`description`** — Markdown. Stable context about the entity — what it is, background info. Displayed on the card but **collapsed after N characters** with a "show more" toggle. Think of it as the card's "about" section.
- **`note`** — Markdown. The agent's live commentary — ephemeral, transient. **Always shown in full** on the card with a visually distinct treatment (different background/border). Used for things like "Escalated to eng, ETA tomorrow" or "URGENT: contract expires in 2 days." The agent updates this frequently as the card progresses.
- **`data` is JSON** — A local cache for agentic workflow state, not a system of record. The source of truth for entities like tickets or leads is the external system (Hubspot, Jira, etc.). The `data` field lets agents keep structured context they need for their workflow without round-tripping to external APIs every time. Think `{ priority: "P1", assignee: "alice", eta: "2026-04-01" }`. Validated against `CardType.json_schema` if present. **Not displayed on the card** — only visible in the CardModal under a collapsed JSON viewer. Each agent/workflow is responsible for defining how they use the schema and keeping data in sync. Any entity-specific state (status, assignee, priority) lives here, not as top-level columns.
- **`color_override` / `emoji_override`** — Nullable overrides. When null (the common case), the card inherits its CardType's defaults. Only set to visually flag an individual card (e.g., red for "on fire"). Named `_override` to make it clear these should normally be left empty.
- **No `status` column** — The card's zone on the board IS its status. Any additional status-like metadata belongs in `data`.

### CardTypes table

```sql
CREATE TABLE card_types (
  card_type_id  TEXT PRIMARY KEY,           -- UUIDv7
  name          TEXT NOT NULL,              -- "Ticket", "Patient", "Lead"
  emoji         TEXT,                       -- Default emoji (single character, uses emoji picker)
  color         TEXT,                       -- Default hex color
  json_schema   TEXT,                       -- Optional JSON Schema for card.data validation
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

**Design decisions:**

- **Global scope** — CardTypes are global (org-level). A "Ticket" type defined once is usable on any board. No `board_id` FK. This avoids duplicating types across boards and makes assistants reusable across contexts.
- **`emoji`** — Named `emoji` (not `icon`) to match the existing pattern for user-facing entities: `users.emoji`, `assistants.emoji`. Single character, selected via the emoji picker.
- **`json_schema` optional** — Types without schemas are just visual groupings (emoji + color). Types with schemas get data validation when agents set `card.data`. No auto-form generation in V1.

**Example CardType:**

```json
{
  "card_type_id": "01JQ...",
  "name": "Support Ticket",
  "emoji": "🎫",
  "color": "#f5222d",
  "json_schema": {
    "type": "object",
    "properties": {
      "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] },
      "assignee": { "type": "string" },
      "customer": { "type": "string" },
      "source": { "type": "string", "enum": ["email", "slack", "phone", "web"] },
      "eta": { "type": "string", "format": "date" }
    },
    "required": ["priority"]
  }
}
```

### Board Objects: Polymorphic Placement

The existing `board_objects` table places worktrees on boards. We extend it to also place cards:

```sql
-- Current schema (modified):
CREATE TABLE board_objects (
  object_id     TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES boards(board_id) ON DELETE CASCADE,
  created_at    INTEGER,
  worktree_id   TEXT REFERENCES worktrees(worktree_id) ON DELETE CASCADE,  -- NOW NULLABLE
  card_id       TEXT REFERENCES cards(card_id) ON DELETE CASCADE,          -- NEW
  data          TEXT  -- JSON: { position: {x, y}, zone_id?: string }
);

-- Constraint: exactly one of (worktree_id, card_id) must be non-null
-- Enforced in application layer (SQLite CHECK constraints on nullable cols are tricky)
```

**Why polymorphic on `board_objects`?**

- Zones already reference `board_objects` via `zone_id`. Cards in zones need the same position + zone_id mechanics.
- The UI's React Flow canvas renders `board_objects` as nodes. Adding a new entity type means one new node type, not a parallel placement system.
- `board_objects` IS the "card on a board" abstraction — it was always a placement record. Now it can place two kinds of things.

**Alternatives considered:**

| Approach | Pros | Cons |
|----------|------|------|
| **Polymorphic `board_objects`** (chosen) | Single placement system, zones work identically, minimal UI change | Nullable FKs, app-layer constraint |
| Separate `board_card_objects` table | Clean schema | Duplicates all position/zone logic, zones need to query two tables |
| Abstract `board_entities` table | Pure relational | Over-engineered for two entity types |

### TypeScript Types

```typescript
// packages/core/src/types/card.ts

export interface Card {
  card_id: CardID;
  board_id: BoardID;
  card_type_id?: CardTypeID;
  title: string;
  url?: string;
  description?: string;       // Stable context, collapsed on card
  note?: string;              // Agent's live commentary, always visible on card
  data?: Record<string, unknown>;
  color_override?: string;    // null = inherit from CardType
  emoji_override?: string;    // null = inherit from CardType
  created_by?: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
  archived_at?: string;
}

export interface CardType {
  card_type_id: CardTypeID;
  name: string;
  emoji?: string;             // Single emoji character
  color?: string;             // Default hex color
  json_schema?: JSONSchema;   // Optional JSON Schema
  created_by?: string;
  created_at: string;
  updated_at: string;
}

// Extend BoardEntityObject to be polymorphic
export interface BoardEntityObject {
  object_id: string;
  board_id: BoardID;
  worktree_id?: WorktreeID;   // One of these two is set
  card_id?: CardID;           // One of these two is set
  entity_type: 'worktree' | 'card';  // Computed/convenience field
  position: { x: number; y: number };
  zone_id?: string;
  created_at: string;
}
```

### Entity Relationship Diagram

```
┌─────────────┐     ┌───────────────┐     ┌─────────────────┐
│  CardType   │     │    Card       │     │   board_objects  │
│─────────────│     │───────────────│     │─────────────────│
│ card_type_id│◄────│ card_type_id  │     │ object_id       │
│ (global)    │     │ board_id      │◄────│ board_id        │
│ name        │     │ title         │◄────│ card_id?        │
│ emoji       │     │ url           │     │ worktree_id?    │
│ color       │     │ description   │     │ position {x,y}  │
│ json_schema │     │ note          │     │ zone_id?        │
│             │     │ data (json)   │     │                 │
│             │     │ color_override│     └────────┬────────┘
│             │     │ emoji_override│              │
└─────────────┘     │ archived      │              │
                    └───────────────┘     ┌────────┴────────┐
                                          │     Board       │
┌─────────────┐                          │─────────────────│
│  Worktree   │◄─────────────────────────│ board_id        │
│─────────────│                          │ name            │
│ worktree_id │                          │ objects (zones) │
│ board_id?   │                          └─────────────────┘
│ ...         │
└──────┬──────┘
       │
┌──────┴──────┐
│  Session    │
│─────────────│
│ session_id  │
│ worktree_id │  (still required — sessions belong to worktrees)
└─────────────┘
```

---

## Card ↔ Session Relationship

**V1: Cards do NOT own sessions.**

Sessions require a `worktree_id` FK. Changing this is a large, risky migration that touches every service. Instead:

- An **Agor Assistant** (a long-lived worktree+session) manages cards via MCP tools
- The assistant creates, updates, moves, and processes cards
- The assistant's session is the "brain" — cards are the "work items"

This is the natural pattern: a support bot assistant processes tickets (cards). A sales assistant manages leads (cards). The assistant lives in a worktree; the cards live on the board.

**Future (V2):** Cards could optionally reference a session (e.g., `card.session_id`), allowing cards to spawn dedicated agent sessions. But this is additive and can wait.

---

## Zone Interactions

### V1: Cards are inert in zones

Moving a card to a zone updates `board_objects.zone_id` and position. **No trigger fires.** Cards are visual feedback — the agent manages all state.

If a user moves a card on the board, nothing happens automatically. The user would tell their agent: "I moved ticket X to Done" and the agent decides what to do based on its instructions.

### Future: Zone triggers for cards

Two models to explore later:

**Model A: "Smart assistant, dumb zones"** — The assistant subscribes to card events (via a `card_events` table + WebSocket). When anything happens (user moves card, card enters zone), the assistant gets notified and decides what to do based on its instructions. Zones are just visual buckets.

**Model B: "Dumb assistant, smart zones"** — Zones have card-specific trigger configs (target assistant/worktree, card template, agent selection). Moving a card to a zone fires a prompt to a designated assistant. This adds significant config complexity to zones (already heavy with worktree triggers).

**Leaning toward Model A** for V2. The assistant already has domain knowledge in its instructions — it knows what "Triage → In Progress" means. No need to duplicate that logic in zone configs. The key primitive is a `card_events` table that tracks who moved what, from where, to where — and WebSocket broadcasts so assistants can react.

---

## MCP Tools

### Card CRUD

```
agor_cards_create
  Required: boardId, title
  Optional: cardTypeId, zoneId, url, description, note, data, colorOverride, emojiOverride
  Returns: Card object with board placement
  Note: Creates card + board_objects record in one call. If zoneId provided, card is placed directly in that zone.

agor_cards_get
  Required: cardId
  Returns: Card with resolved CardType info (emoji/color inherited if no override)

agor_cards_list
  Optional: boardId, cardTypeId, zoneId, search, archived, limit, offset
  Returns: Paginated card list

agor_cards_update
  Required: cardId
  Optional: title, url, description, note, data, colorOverride, emojiOverride (all nullable to clear)
  Returns: Updated Card

agor_cards_delete
  Required: cardId
  Behavior: Hard delete (cards are lightweight, not like worktrees)

agor_cards_archive / agor_cards_unarchive
  Required: cardId
  Behavior: Soft archive (remove from board visually, retain data)

agor_cards_move
  Required: cardId, zoneId (or null to unpin from zone)
  Optional: position
  Behavior: Updates board_objects placement
  Note: Does NOT fire zone triggers in V1
```

### CardType CRUD

```
agor_card_types_create
  Required: name
  Optional: emoji, color, jsonSchema
  Returns: CardType object

agor_card_types_get
  Required: cardTypeId
  Returns: CardType

agor_card_types_list
  Optional: limit
  Returns: All CardTypes (global)

agor_card_types_update
  Required: cardTypeId
  Optional: name, emoji, color, jsonSchema
  Returns: Updated CardType

agor_card_types_delete
  Required: cardTypeId
  Behavior: Hard delete. Cards with this type get card_type_id set to NULL.
```

### Bulk Operations

```
agor_cards_bulk_create
  Required: boardId, cards[] (array of {title, cardTypeId?, description?, note?, data?, ...})
  Returns: Created cards
  Use case: Agent imports 50 tickets from Jira, creates them all at once

agor_cards_bulk_update
  Required: updates[] (array of {cardId, ...fields})
  Returns: Updated cards
  Use case: Agent triages a batch of tickets, setting priority on all of them

agor_cards_bulk_move
  Required: moves[] (array of {cardId, zoneId})
  Returns: Updated placements
  Use case: Agent moves resolved tickets to "Done" zone in bulk
```

---

## UI / UX

### Settings: Card Types & Cards Management

Card management lives in **Settings**, in the existing "Workspace" section alongside Repos, Worktrees, and Assistants. Three-column drill-down:

```
Settings
├── Workspace
│   ├── Repos
│   ├── Worktrees
│   ├── Assistants
│   └── Cards          ← NEW
```

**Column 1: Card Types list** (thin CRUD list)
```
Card Types                    [+ New]
──────────────────────────────────
  🎫 Support Ticket         ✏️ 🗑️
  💰 Sales Lead              ✏️ 🗑️
  📄 Contract                ✏️ 🗑️
  🏥 Patient                 ✏️ 🗑️
```

**Column 2: Cards for selected type**
```
Support Ticket (47 cards)
──────────────────────────────────
  Title                    Board
  Customer login broken    Support Pipeline
  API rate limiting        Support Pipeline
  Dark mode toggle         Product Board
  ...
```

**Column 3: Card detail (CardModal)**

Clicking a card opens the detail view (same `CardModal` component used when clicking a card on the board canvas — one component, two entry points).

### CardModal

```
┌──────────────────────────────────────────────────┐
│ 🎫  Customer login broken              [Open ↗] │
│──────────────────────────────────────────────────│
│ Type: Support Ticket                             │
│ Board: Support Pipeline                          │
│ Zone: In Progress                                │
│──────────────────────────────────────────────────│
│ Note:                                     [Edit] │
│ ┌──────────────────────────────────────────────┐ │
│ │ Escalated to eng team, fix ETA is tomorrow.  │ │
│ │ Monitoring.                                  │ │
│ └──────────────────────────────────────────────┘ │
│──────────────────────────────────────────────────│
│ Description:                              [Edit] │
│ Customer reports 500 error after password        │
│ reset. Affects OAuth flow. Reproduced on         │
│ Chrome 120+ with 2FA enabled.                    │
│──────────────────────────────────────────────────│
│ ▸ Data                                    [JSON] │
│   { "priority": "P0", "assignee": "alice" }     │
│──────────────────────────────────────────────────│
│ Created by: support-bot • 2h ago                 │
│                                                  │
│                        [Archive]  [Delete] [Save]│
└──────────────────────────────────────────────────┘
```

- **Title + URL** — Title prominent, "Open" link to external resource if `url` is set
- **Metadata** — Type, board, zone (read-only context)
- **Note** — Agent's live commentary, shown prominently with distinct styling. Editable
- **Description** — Stable context about the entity. Rendered markdown, editable
- **Data** — Collapsed JSON viewer by default. Power users / agents set via MCP. No auto-form in V1
- **Actions** — Archive, delete, save edits

### Board Canvas: CardNode

Cards on the React Flow canvas use a `CardNode` component, visually distinct from `WorktreeCard`:

```
┌──────────────────────────────────────┐
│ 🎫 Customer login broken       [↗]  │  ← title (clickable if url set)
│──────────────────────────────────────│
│ OAuth flow breaks after password     │  ← description (collapsed after N chars)
│ reset on Chrome 120+...  [more]      │
│──────────────────────────────────────│
│ ⚡ Escalated to eng team, fix ETA   │  ← note (always full, distinct bg)
│ is tomorrow. Monitoring.             │
└──────────────────────────────────────┘
```

**Card fields displayed on board:**
- `title` — always shown, prominent. Clickable link if `url` is set
- `description` — collapsed after N characters with "show more"
- `note` — always shown in full, visually distinct (different background/border)
- `data` — NOT shown on card, only in CardModal

**Key visual differences from WorktreeCard:**
- Colored left border from CardType color (vs environment status color on worktrees)
- CardType emoji instead of git/folder icon
- Description + note instead of repo slug + environment status
- Slightly smaller footprint (cards are often more numerous)
- Click → opens CardModal

---

## Implementation Plan

### Phase 1: Schema + Backend + MCP

1. Add `cards` and `card_types` tables via Drizzle migration
2. Make `board_objects.worktree_id` nullable, add `card_id` column
3. Add `CardRepository` and `CardTypeRepository` in `packages/core/src/db/repositories/`
4. Add `CardsService` and `CardTypesService` in `apps/agor-daemon/src/services/`
5. Register MCP tools in `apps/agor-daemon/src/mcp/routes.ts`
6. Extend `BoardObjectsService` to handle card placements
7. WebSocket events for card CRUD (`cards created`, `cards patched`, `cards removed`)

**Zero breaking changes.** All existing worktree functionality untouched. The nullable `worktree_id` migration is safe — existing rows all have it set.

### Phase 2: Board UI

1. Add `CardNode` React Flow component
2. Extend `SessionCanvas` to render card-type `board_objects` as `CardNode`
3. Card drag-and-drop within/between zones (same mechanics as worktree cards)
4. Click card → `CardModal`

### Phase 3: Settings UI

1. "Cards" entry in Settings workspace section
2. CardType CRUD list (column 1)
3. Cards-per-type list (column 2)
4. CardModal as detail view (column 3)

---

## Open Questions

### 1. Card ordering within zones — DEFERRED

V1 uses freeform positioning (same jitter-based placement as worktrees). Ordered list layouts (`sort_order`, zone `layout` mode, auto-snap) are a future enhancement once we see how cards are actually used on boards.

### 2. Card history / audit trail — DEFERRED

No `card_events` table in V1. The MCP tool response serves as an implicit log within the agent's session. A formal event log is a V2 primitive — likely needed when we add "smart assistant, dumb zones" notifications.

### 3. Cross-board cards

Can a card move between boards? Worktrees can change `board_id`. Should cards?

**Recommendation:** No, in V1. Cards are board-scoped. If needed, an agent can delete + recreate.

### 4. Card links / relationships

Cards might reference other cards (e.g., "blocked by") or worktrees (e.g., "fix in feat-auth").

**Recommendation:** Defer. Use the markdown `body` for ad-hoc references.

### 5. CardType inheritance

Should CardTypes inherit from other CardTypes?

**Recommendation:** No. Keep it flat. JSON Schema's `allOf` can compose schemas if needed.

---

## Summary

| Concept | V1 (MVP) | V2 | V3 |
|---------|----------|-----|-----|
| **Cards** | CRUD, board placement, zone pinning, dumb/inert | Card events, assistant notifications | Cross-board, relationships |
| **CardTypes** | Global, emoji/color, optional schema | Dynamic forms from schema | Schema inheritance |
| **MCP Tools** | Full CRUD + bulk ops | Activity log | Webhooks |
| **Zone Triggers** | Cards are inert (no triggers) | Smart assistant notifications (Model A) | Zone-level card triggers (Model B) |
| **Sessions** | Cards don't own sessions | Optional card → session FK | Card-spawned sessions |
| **UI** | CardNode on board, CardModal, Settings CRUD | List layout zones | Compact views, charts |

The core insight: **Cards are to workflows what worktrees are to code.** They're the unit of work on the board. The board/zone metaphor doesn't change — we're just expanding what can live on the canvas.
