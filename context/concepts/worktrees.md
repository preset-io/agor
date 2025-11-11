# Worktrees in Agor

**Status:** ✅ Complete (Phase 0-2)
**Last Updated:** 2025-10-24
**Epic:** Worktree-First Architecture

---

## Table of Contents

1. [Overview](#overview)
2. [Data Model](#data-model)
3. [Worktree-Centric Boards](#worktree-centric-boards)
4. [WorktreeModal UI](#worktreemodal-ui)
5. [Environment Management](#environment-management)
6. [Terminal Integration](#terminal-integration)
7. [Implementation Status](#implementation-status)
8. [Future Work](#future-work)

---

## Overview

### Core Concept

**Worktrees** are first-class entities in Agor that provide isolated git + environment contexts for AI-assisted development.

**Key Insight:** Sessions are conversations, worktrees are work contexts. Both are essential.

```
Sessions (Conversations)
  ├─ Ephemeral AI conversations
  ├─ Reference a worktree (via FK)
  └─ Live on boards for organization

Worktrees (Work Contexts)
  ├─ Isolated git branches + environments
  ├─ Persistent state (issues, PRs, environments)
  ├─ Referenced by multiple sessions (over time)
  └─ Displayed on boards as primary units
```

### Architectural Relationships

**Current State:**

```
Boards ←(one-to-many)→ Worktrees ←(one-to-many)→ Sessions
```

- Boards display **Worktrees** as cards
- Worktrees belong to ONE board (or none)
- Sessions are accessed THROUGH worktrees (genealogy tree inside WorktreeCard)
- Sessions always reference a worktree (required FK)

### Why Worktrees?

1. **Persistent Context:** Worktrees outlive sessions
   - Git branch/commits persist after session ends
   - Environment configuration (dev server keeps running)
   - Issue/PR associations (work continues across sessions)
   - Concept files (CLAUDE.md, context/\*.md in repo)

2. **Collaboration:** Multiple users, same worktree
   - Alice creates session in `feat-auth` worktree
   - Bob creates new session in same worktree
   - Both sessions share: environment URL, git branch, concepts

3. **Work Unit Mapping:**
   - 1 worktree = 1 feature / 1 bug fix / 1 experiment
   - 1 worktree = 1 PR (often)
   - 1 worktree = isolated dev environment + git branch

---

## Data Model

### Normalized Worktrees Table ✅

**Before:** Worktrees nested in repos JSON blob (unqueryable, unindexable)

**After:** First-class table with full query/index support

```sql
CREATE TABLE worktrees (
  -- Identity
  worktree_id TEXT PRIMARY KEY,        -- UUIDv7
  repo_id TEXT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,

  -- Attribution
  created_by TEXT NOT NULL DEFAULT 'anonymous',

  -- Board assignment (one board per worktree)
  board_id TEXT REFERENCES boards(board_id) ON DELETE SET NULL,

  -- Materialized columns for queries
  name TEXT NOT NULL,                  -- "feat-auth", "main"
  ref TEXT NOT NULL,                   -- Current branch/tag/commit

  -- JSON blob for metadata
  data TEXT NOT NULL,

  -- Constraints
  UNIQUE(repo_id, name)
);

-- Indexes
CREATE INDEX worktrees_repo_idx ON worktrees(repo_id);
CREATE INDEX worktrees_board_idx ON worktrees(board_id);
```

### Worktree Type

```typescript
// packages/core/src/types/worktree.ts
export interface Worktree {
  worktree_id: WorktreeID;
  repo_id: RepoID;
  board_id?: BoardID;
  created_at: string;
  updated_at?: string;
  created_by: string;

  // Git metadata
  name: string;
  ref: string;
  path: string;

  // Optional metadata
  issue_url?: string;
  pull_request_url?: string;
  notes?: string;

  // Environment configuration
  environment_instance?: WorktreeEnvironmentInstance;
}
```

### Session FK Constraint ✅

Sessions MUST reference a worktree (required FK):

```sql
ALTER TABLE sessions ADD COLUMN worktree_id TEXT NOT NULL REFERENCES worktrees(worktree_id);
```

---

## Worktree-Centric Boards

### Architecture Change

**BEFORE:** Boards displayed sessions as primary cards

```
Board → SessionCard (many-to-many via board_objects)
```

**AFTER:** Boards display worktrees as primary cards

```
Board → WorktreeCard (one-to-many)
  └─ Sessions (nested inside card)
```

### BoardEntityObject (Simplified)

```typescript
// packages/core/src/types/board.ts
export interface BoardEntityObject {
  object_id: string;
  board_id: BoardID;
  worktree_id: WorktreeID; // Only worktrees (no dual card system)
  position: { x: number; y: number };
  zone_id?: string; // Pinned to zone
  created_at: string;
}
```

**Key Decision:** No hybrid dual-card system. Only worktrees on boards. Sessions displayed within WorktreeCard.

### WorktreeCard Component ✅

Located: `apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx`

**Features:**

- Header: name, ref, branch icon, edit/delete buttons
- Metadata pills: CreatedBy, Issue, PR
- Collapsible session list
- Session status indicators and badges
- Click session → opens SessionDrawer
- "New Session" button (primary when empty, subtle "+" when sessions exist)
- Draggable via React Flow
- Visual zone pinning indicator

**Layout:**

```
┌──────────────────────────────────────┐
│ 🌿 feature/user-auth    [edit] [del] │
├──────────────────────────────────────┤
│ 👤 Max  #123  PR #456                │
├──────────────────────────────────────┤
│ ▾ Sessions (3)                   [+] │
│   ├─ Initial implementation ✓        │
│   └─┬ Fix OAuth flow ⟳              │
│     └─ Try PKCE approach ✗          │
└──────────────────────────────────────┘
```

### Zone Triggers for Worktrees ✅

**ZoneTrigger Interface:**

```typescript
export type ZoneTriggerBehavior = 'always_new' | 'show_picker';

export interface ZoneTrigger {
  template: string; // Handlebars template
  behavior: ZoneTriggerBehavior; // always_new or show_picker
}
```

**Zone Trigger Flow:**

1. **User drops worktree onto zone**
2. **Behavior: "always_new"**
   - Creates new root session immediately
   - Applies template as first message
   - Starts execution
3. **Behavior: "show_picker"**
   - Opens ZoneTriggerModal
   - User selects session (or creates new)
   - User chooses action: Prompt / Fork / Spawn
   - Applies template via chosen action

**ZoneTriggerModal Features:**

- Smart default session selection (prioritizes active sessions)
- Session tree visualization
- Action selection (Prompt, Fork, Spawn)
- Template preview with Handlebars context
- Agent/model/MCP server configuration
- Permission mode selection

**Template Context:**

```handlebars
{{worktree.name}}
{{worktree.ref}}
{{worktree.issue_url}}
{{worktree.pull_request_url}}
{{worktree.repo.slug}}
{{worktree.repo.remote_url}}
{{board.name}}
{{board.description}}
{{board.custom_context}}
```

---

## WorktreeModal UI

### 5-Tab Modal ✅

Located: `apps/agor-ui/src/components/WorktreeModal/WorktreeModal.tsx`

**Tabs:**

1. **General** ✅
   - Metadata (name, ref, issue, PR, notes)
   - Editable fields
   - Session list with status

2. **Environment** ✅
   - Environment configuration display
   - Start/Stop/Restart buttons
   - Status indicators (running/stopped)
   - Health check links
   - Port mappings

3. **Terminal** ✅
   - Embedded xterm.js terminal
   - Runs in worktree directory (`cwd: worktree.path`)
   - Full shell access (bash/zsh)
   - Resize support

4. **Concepts** ✅
   - File tree viewer for worktree-specific concepts
   - CLAUDE.md, context/\*.md from repo
   - Read-only display

5. **Repo** ✅
   - Link to parent repository settings
   - Quick navigation

### Access Points ✅

- Click worktree badge in SessionHeader
- Click row in Settings → Worktrees table
- Click "Edit" button on WorktreeCard

---

## Environment Management

### Configuration Model

```typescript
// packages/core/src/types/repo.ts
export interface RepoEnvironmentConfig {
  type: 'docker-compose';
  compose_file: string; // Relative path in repo
  services?: string[]; // Services to start (empty = all)
  health_check?: {
    url_template: string; // Handlebars template
    expected_status?: number;
  };
}

// packages/core/src/types/worktree.ts
export interface WorktreeEnvironmentInstance {
  status: 'running' | 'stopped' | 'starting' | 'stopping' | 'error';
  started_at?: string;
  stopped_at?: string;
  error?: string;
  ports?: { service: string; host: number; container: number }[];
}
```

### Start/Stop/Restart ✅

**Implementation:** `apps/agor-daemon/src/services/worktree-environments.ts`

**Operations:**

```typescript
// Start environment
POST /worktrees/:id/environment/start
→ Runs docker-compose up -d
→ Updates worktree.environment_instance.status = 'running'

// Stop environment
POST /worktrees/:id/environment/stop
→ Runs docker-compose down
→ Updates worktree.environment_instance.status = 'stopped'

// Restart environment
POST /worktrees/:id/environment/restart
→ Stop + Start
```

**UI:** Settings → Worktrees → Action buttons in table

**Logs:** Real-time docker-compose output via WebSocket events

---

## Terminal Integration

### Embedded Terminal ✅

**Implementation:** WorktreeModal → Terminal tab + TerminalModal

**Tech Stack:**

- xterm.js (frontend terminal emulator)
- node-pty (backend pseudoterminal)
- Socket.io (bidirectional communication)
- tmux (optional, for persistent sessions)

**Service:** `apps/agor-daemon/src/services/terminals.ts`

```typescript
POST /terminals
→ Spawns pty with optional worktree context
→ Returns {
    terminalId: string,
    cwd: string,
    tmuxSession?: string,
    tmuxReused?: boolean,
    worktreeName?: string
  }

Socket events:
- 'terminals/data' → pty output
- 'terminals/input' → user input
- 'terminals/resize' → terminal size change
- 'terminals/exit' → pty closed
```

**Features:**

- Full shell access (bash/zsh)
- Working directory = worktree path (when worktreeId provided)
- Resize support
- Auto-cleanup on disconnect
- **Tmux integration for persistent sessions**

### Tmux Integration ✅

**Status:** Fully implemented

**How It Works:**

Agor automatically detects tmux and creates a single shared session (`agor`) with one window per worktree:

- **First terminal open:** Creates window in `agor` session (or creates session if needed)
- **Reopen same worktree:** Reconnects to existing window
- **Multiple worktrees:** Each gets its own window in the shared session
- **After modal closes:** Windows persist with full history and running processes
- **Switch worktrees:** Use `Ctrl+B w` to navigate between windows

**Multiplayer Bonus:** Multiple users opening the same worktree terminal see each other's keystrokes in real-time (shared tmux window + WebSocket broadcasting).

**Benefits:**

- Persistent terminal sessions that survive browser disconnects
- All worktrees in one tmux session for easy navigation
- Long-running processes continue after closing modal
- Real-time collaboration when multiple users work in same worktree

### Future: Terminal Shortcut

**Idea:** Command palette shortcut to open terminal in worktree path directly from board

**Use Case:** Quick terminal access without opening WorktreeModal

**Status:** Minor future enhancement (tracked in PROJECT.md)

---

## Implementation Status

### Phase 0: Data Model ✅ COMPLETE

- ✅ Worktrees table created with full schema
- ✅ Sessions reference worktrees via FK (NOT NULL constraint)
- ✅ WorktreesService (REST + WebSocket) operational
- ✅ UI updated (separate Repositories and Worktrees tabs)
- ✅ Git operations fully working (bare repos, SSH auth)
- ✅ Docker environment with SSH key mounting
- ✅ board_id column added to worktrees

### Phase 1: Worktree-Centric Boards ✅ COMPLETE

- ✅ BoardEntityObject simplified (worktree-only, no dual card system)
- ✅ WorktreeCard component with collapsible sessions
- ✅ SessionCanvas displays worktrees as primary nodes
- ✅ NewWorktreeModal for quick creation from canvas
- ✅ IssuePill and PullRequestPill components
- ✅ WorktreeModal clickable from SessionHeader badge
- ✅ "New Session" button in WorktreeCard
- ✅ Real-time WebSocket updates for board layout

### Phase 1.5: Session-Worktree Integration ✅ COMPLETE

- ✅ Session creation requires worktree selection
- ✅ NewSessionModal simplified (removed complex repo modes)
- ✅ Sessions store worktree_id (required FK)
- ✅ Sessions run in correct worktree directory
- ✅ ClaudePromptService and Codex use worktree.path as cwd
- ✅ Docker environment includes agent CLIs (claude-code, gemini)

### Phase 2: Zone Triggers ✅ COMPLETE

- ✅ ZoneTrigger schema (behavior + template)
- ✅ ZoneTriggerModal with session picker
- ✅ Smart default session selection
- ✅ Action selection (Prompt/Fork/Spawn)
- ✅ Handlebars template rendering with context
- ✅ Agent/model/MCP configuration in modal
- ✅ Zone pinning via board_objects.zone_id

### Phase 3: WorktreeModal ✅ COMPLETE

- ✅ 5-tab modal (General, Environment, Terminal, Concepts, Repo)
- ✅ General tab with editable metadata
- ✅ Environment tab with start/stop controls
- ✅ Terminal tab with xterm.js
- ✅ Concepts tab with file tree viewer
- ✅ Repo tab with navigation link

### Phase 4: Environment + Terminal ✅ COMPLETE

- ✅ Docker Compose integration
- ✅ Start/Stop/Restart operations
- ✅ Health check URLs with templates
- ✅ Port mapping display
- ✅ Embedded terminal with node-pty
- ✅ Terminal runs in worktree.path
- ✅ Resize and cleanup support

---

## Future Work

### Minor Enhancements

**Terminal Shortcut:**

- Command palette shortcut to open terminal in worktree path
- Quick access without opening WorktreeModal
- Status: Low priority, nice-to-have

**See PROJECT.md for full roadmap and future features.**

---

## Related Documentation

- [[models]] - Canonical data model definitions
- [[board-objects]] - Zone system and board layout
- [[agent-integration]] - Agent SDK integration details
- [[design]] - UI/UX principles
