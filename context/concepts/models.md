# Information Architecture & Data Models

Related: [[core]], [[architecture]]

This document defines Agor's high-level information architecture and key data models.

## Core Models

### Session

The universal container for all agent interactions.

```typescript
Session {
  // Identity
  session_id: string
  agent: 'claude-code' | 'codex' | 'gemini'
  agent_version?: string
  status: 'idle' | 'running' | 'completed' | 'failed'

  // Repository Context (required)
  repo: {
    repo_id?: string              // If Agor-managed repo
    repo_slug?: string            // Repo slug (e.g., "myapp")
    worktree_name?: string        // Worktree name if using Agor-managed
    cwd: string                   // Working directory (absolute path)
    managed_worktree: boolean     // true if in ~/.agor/worktrees/
  }

  // Context
  concepts: string[]              // Loaded concept file paths
  description?: string            // Human-readable summary

  // Git State
  git_state: {
    ref: string                   // Branch/tag name
    base_sha: string              // Starting commit
    current_sha: string           // Current commit (can be {sha}-dirty)
  }

  // Genealogy
  genealogy: {
    forked_from_session_id?: string
    fork_point_task_id?: string
    parent_session_id?: string
    spawn_point_task_id?: string
    children: string[]
  }

  // Aggregates
  tasks: string[]                 // Ordered task IDs
  message_count: number
  tool_use_count: number

  // Timestamps
  created_at: string
  last_updated: string
}
```

### Task

Granular work unit within a session.

```typescript
Task {
  // Identity
  task_id: string
  session_id: string
  description: string             // User prompt
  full_prompt: string             // Complete user input
  status: 'created' | 'running' | 'completed' | 'failed'

  // Message Range
  message_range: {
    start_index: number
    end_index: number
    start_timestamp: string
    end_timestamp?: string
  }

  // Git State
  git_state: {
    sha_at_start: string
    sha_at_end?: string           // Can be {sha}-dirty
    commit_message?: string
  }

  // Model & Metrics
  model: string                   // Can change per-task
  tool_use_count: number

  // Report
  report?: {
    template: string
    path: string
    generated_at: string
  }

  // Timestamps
  created_at: string
  completed_at?: string
}
```

### Repo

Git repository (managed or referenced by Agor).

```typescript
Repo {
  // Identity
  repo_id: string                 // UUIDv7
  slug: string                    // URL-friendly identifier (e.g., "myapp")
  name: string                    // Human-readable name

  // Git
  remote_url?: string             // Git remote (if cloned by Agor)
  local_path: string              // Path to bare repo (~/.agor/repos/{slug})
  managed_by_agor: boolean        // true if cloned by Agor
  default_branch?: string         // Usually "main" or "master"

  // Worktrees
  worktrees: WorktreeConfig[]     // Active worktrees for this repo

  // Timestamps
  created_at: string
  last_updated: string
}

WorktreeConfig {
  name: string                    // Worktree slug (e.g., "feat-auth")
  path: string                    // Absolute path to worktree directory
  ref: string                     // Branch/tag/commit checked out
  new_branch: boolean             // Created during worktree creation?
  tracking_branch?: string        // Remote tracking branch (if any)
  sessions: string[]              // Session IDs using this worktree
  last_commit_sha?: string        // Last commit in this worktree
  created_at: string
  last_used: string
}
```

### Board

Collection of sessions (organizational primitive).

```typescript
Board {
  board_id: string
  name: string
  slug?: string                   // Optional URL-friendly slug
  description?: string
  icon?: string                   // Emoji or icon identifier
  color?: string                  // Hex color for visual distinction

  sessions: string[]              // Session IDs in this board

  created_at: string
  last_updated: string
}
```

### Concept

Knowledge module (file-based).

```typescript
Concept {
  // File-based, not stored as JSON
  // Located in context/*.md

  name: string                    // Filename without .md
  content: string                 // Markdown content
  references: string[]            // [[other-concept]] links
}
```

### Agent

Coding agent metadata.

```typescript
Agent {
  id: string
  name: 'claude-code' | 'codex' | 'gemini'
  icon: string
  installed: boolean
  version?: string
  description?: string
  installable: boolean
}
```

## Key Relationships

### Session Tree Structure

```
Session A (root)
├─ Task 1
├─ Task 2
│
├─ Session B (fork from Task 1)
│   └─ Task 3
│
└─ Session C (spawn from Task 2)
    └─ Task 4
```

**Relationship Types:**

1. **Session → Tasks**: One-to-many (parent-child)
   - A session contains ordered tasks
   - Tasks reference their parent session

2. **Session → Session (Fork)**: One-to-many
   - `forked_from_session_id` points to parent
   - Inherits full conversation history up to fork point
   - Divergent exploration path

3. **Session → Session (Spawn)**: One-to-many
   - `parent_session_id` points to parent
   - Fresh context window
   - Delegated subsession

4. **Session → Concepts**: Many-to-many
   - A session can load multiple concepts (file paths)
   - A concept can be used by multiple sessions

5. **Board → Sessions**: One-to-many
   - A board contains multiple sessions
   - A session can belong to one board

6. **Repo → Worktrees**: One-to-many
   - A repo can have multiple worktrees
   - Each worktree checks out a specific branch

7. **Worktree → Sessions**: One-to-many
   - Multiple sessions can share a worktree (same working directory)
   - Sessions track which worktree they use via `repo.worktree_name`

8. **Session → Repo**: Many-to-one (optional)
   - Sessions using Agor-managed worktrees reference a repo
   - Sessions in user directories have no repo link (repo_id is null)

9. **Session → Git State**: One-to-one
   - Each session tracks a git reference
   - Repo context provides working directory (cwd)

## Information Flow

### Session Creation

```
User Action → Create Session
  ├─ Select Agent
  ├─ Load Concepts
  ├─ Set Git Ref
  ├─ Optional: Create Worktree
  └─ Initialize Session Metadata
```

### Task Execution

```
User Prompt → Create Task
  ├─ Capture Git SHA (start)
  ├─ Record Message Range
  ├─ Agent Processes → Messages + Tool Calls
  ├─ Capture Git SHA (end)
  ├─ Task Completes
  └─ Optional: Generate Report
```

### Fork Operation

```
User: "Fork at Task N"
  ├─ Create New Session
  ├─ Copy Context up to Task N
  ├─ Set genealogy.forked_from_session_id
  ├─ Set genealogy.fork_point_task_id
  ├─ Optional: Create New Worktree
  └─ User Continues with Divergent Path
```

### Spawn Operation

```
User: "Spawn subsession"
  ├─ Create New Session
  ├─ Fresh Context (no history)
  ├─ Load Focused Concepts
  ├─ Set genealogy.parent_session_id
  ├─ Set genealogy.spawn_point_task_id
  └─ Different Agent (optional)
```

## Storage Strategy

### File-Based Storage

```
.agor/
├── sessions/
│   ├── {session-id}/
│   │   ├── metadata.json        # Session model
│   │   ├── tasks/
│   │   │   ├── {task-id}.json   # Task model
│   │   │   └── ...
│   │   └── reports/
│   │       ├── {task-id}-report.md
│   │       └── ...
│   └── ...
│
└── boards/
    └── boards.json               # All boards (single file for now)
```

### In-Memory State (UI)

```typescript
AppState {
  sessions: Session[]
  tasks: Record<sessionId, Task[]>
  boards: Board[]
  agents: Agent[]

  currentBoardId: string
  selectedSessionId?: string
}
```

## Constraint & Invariants

### Session Tree Invariants

1. **No cycles**: A session cannot be its own ancestor
2. **Single fork point**: A forked session has exactly one fork_point_task_id
3. **Single spawn point**: A spawned session has exactly one spawn_point_task_id
4. **Mutual exclusion**: A session is either forked OR spawned, not both

### Task Invariants

1. **Ordered**: Tasks within a session are chronologically ordered
2. **Non-overlapping messages**: Message ranges don't overlap
3. **Git progression**: sha_at_end is reachable from sha_at_start

### Git State Invariants

1. **Dirty indicator**: Only current_sha and sha_at_end can have -dirty suffix
2. **Clean commits**: base_sha and sha_at_start are always clean SHAs
3. **Worktree isolation**: Managed worktrees are deleted when session is pruned

### Board Invariants

1. **Session uniqueness**: A session belongs to at most one board
2. **Referential integrity**: All session_ids in board.sessions exist

## Extensibility Points

### Future Models

**Merge** (V2):

```typescript
Merge {
  merge_id: string
  parent_sessions: string[]       // Sessions being merged
  merged_session_id: string       // Result session
  strategy: 'cherry-pick' | 'rebase' | 'concept-union'
  created_at: string
}
```

**Team** (V2 - Cloud):

```typescript
Team {
  team_id: string
  name: string
  members: string[]               // User IDs
  shared_boards: string[]
  shared_concepts: string[]
}
```

**User** (V2 - Cloud):

```typescript
User {
  user_id: string
  email: string
  name: string
  teams: string[]
  created_at: string
}
```

---

See also:

- [[core]] - Core concepts and primitives
- [[architecture]] - System architecture details
- [[design]] - UI/UX implementation
