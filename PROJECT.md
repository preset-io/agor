## Implementation Status

### ✅ Phase 2 Complete (Multi-User Foundation)

**Backend:**

- FeathersJS daemon with REST + WebSocket (:3030)
- User authentication (email/password + JWT)
- Real-time position sync for multi-user boards
- Sessions, Tasks, Messages, Repos, Boards, Users, MCP Servers
- Claude Agent SDK integration (CLAUDE.md auto-loading)
- Git operations via simple-git (clone, worktree management)

**Frontend:**

- React Flow canvas with drag-and-drop sessions
- Real-time WebSocket sync across clients
- User management UI with emoji avatars
- SessionDrawer with conversation view
- Board organization and session cards
- Ant Design component system with token-based styling

**CLI:**

- `agor init` - Setup auth and database
- `agor session list/load-claude` - Session management
- `agor repo add/list/worktree` - Git repository operations
- `agor board list/add-session` - Board organization
- `agor config get/set` - Configuration management
- `agor user list/create` - User management

**Documentation:** Complete architecture in `context/concepts/` (core, models, architecture, auth, design, websockets)

**See:** [CLAUDE.md](CLAUDE.md) for development guide and [context/concepts/auth.md](context/concepts/auth.md) for collaboration features.

---

## Next Up

### Phase 3a: MCP Server Integration (3-5 days)

See [context/explorations/mcp-integration.md](context/explorations/mcp-integration.md) for detailed design.

**Goal:** Wire up MCP servers to Claude Agent SDK for enhanced tool capabilities.

- [ ] **MCP server configuration UI** - Manage MCP servers (2 days)
  - Display available MCP servers in settings modal
  - Enable/disable servers per session
  - Show discovered tools, resources, prompts
  - Test connection and capability discovery

- [ ] **Hook up to Agent SDK** - Pass MCP servers to Claude (1-2 days)
  - Pass `mcpServers` config to Claude Agent SDK
  - Filter by session-level enablement
  - Handle MCP server lifecycle (start/stop)
  - Show MCP tool usage in conversation view

- [ ] **Polish & debugging** - Error handling and UX (1 day)
  - Display MCP connection errors
  - Show which tools came from which server
  - Add MCP server status indicators

### Phase 3b: Social Collaboration (1-2 weeks)

See [context/explorations/social-features.md](context/explorations/social-features.md) for detailed implementation plan.

**Goal:** Add presence indicators so teammates can see what each other is doing in real-time.

- [ ] **Facepile** - Show active users on board (1-2 days)
  - PresenceManager service in daemon
  - `board:join` / `board:leave` WebSocket events
  - `usePresence()` hook in UI
  - Ant Design `Avatar.Group` component in canvas header

- [ ] **Cursor swarm** - Real-time cursor positions (2-3 days)
  - `cursor:move` / `cursor:update` events (throttled to 50ms)
  - `useCursorBroadcast()` and `useRemoteCursors()` hooks
  - CursorOverlay component with smooth interpolation
  - Use React Flow project() for coordinate mapping

- [ ] **Presence indicators** - Who's viewing which sessions (1 day)
  - `viewing:session` events
  - Mini avatar badges on session cards
  - Tooltip showing viewer names

- [ ] **Typing indicators** - Who's prompting (1 day)
  - `typing:start` / `typing:stop` events
  - "User is typing..." below prompt input

### Phase 3c: Session Orchestration (2-3 weeks)

**Goal:** Complete the core fork/spawn workflow for parallel session management.

- [ ] **Session forking UI** - Fork sessions at decision points
  - Wire fork button to `/sessions/:id/fork` API
  - Display fork genealogy on canvas (React Flow edges)
  - Show fork point in conversation view

- [ ] **Genealogy visualization** - Show session relationships
  - React Flow edges between parent/child/forked sessions
  - Different edge styles (solid spawn, dashed fork)
  - Click edge to see fork/spawn context

- [ ] **Session state machine** - Idle → Running → Completed
  - Auto-transition on prompt execution
  - Visual state indicators (spinner, checkmark, error)
  - Status filtering on board

### Phase 3d: Polish & UX (1-2 weeks)

- [ ] **Token tracking** - Show costs from Claude API
  - Capture from Agent SDK responses
  - Display in session cards and conversation view
  - Aggregate board-level costs

- [ ] **Concept management** - Modular context files
  - CRUD operations for concepts
  - Attach/detach concepts from sessions
  - Auto-suggest based on session description

- [ ] **Report generation** - Auto-summarize completed tasks
  - LLM-powered task summaries
  - Export session reports
  - Share reports with team

### Future (Phase 4+)

See [context/explorations/](context/explorations/) for detailed designs:

- **OAuth & organizations** ([multiplayer-auth.md](context/explorations/multiplayer-auth.md)) - GitHub/Google login, team workspaces, RBAC
- **Desktop app** - Electron/Tauri packaging with bundled daemon
- **Multi-agent support** ([agent-interface.md](context/concepts/agent-integration.md)) - Cursor, Codex, Gemini
- **Cloud deployment** - PostgreSQL migration, Turso/Supabase

---

## Roadmap

### V1: Local Orchestrator (Current - Q2 2025)

**Status:** Core features complete, polish phase

**Complete:**

- ✅ Multi-user authentication and real-time sync
- ✅ Visual session canvas with drag-and-drop
- ✅ Git worktree integration
- ✅ Claude Agent SDK with CLAUDE.md loading
- ✅ CLI + GUI + WebSocket architecture

**In Progress:**

- 🔄 Social collaboration features (facepile, cursors, presence)
- 🔄 Session fork/spawn genealogy
- 🔄 State machine and lifecycle management

**Remaining:**

- Desktop packaging (Electron/Tauri)
- Concept library
- Report generation
- Multi-agent adapters (Cursor, Codex)

### V2: Cloud Collaboration (Q3-Q4 2025)

**Goal:** Enterprise-ready collaborative platform

**Key Features:**

- PostgreSQL migration for cloud hosting
- OAuth providers (GitHub, Google, OIDC/SAML)
- Organizations and team workspaces
- Role-based access control (CASL)
- Board-level permissions and sharing
- API tokens for CI/CD automation

**See:** [context/explorations/multiplayer-auth.md](context/explorations/multiplayer-auth.md) for detailed design.

---

## Project Structure

```
agor/
├── apps/
│   ├── agor-daemon/       # FeathersJS backend (REST + WebSocket)
│   ├── agor-cli/          # CLI tool (oclif)
│   └── agor-ui/           # React UI (Storybook-first)
│
├── packages/
│   └── core/              # Shared @agor/core package
│       ├── types/         # TypeScript types
│       ├── db/            # Drizzle ORM + repositories
│       ├── git/           # Git utilities
│       ├── claude/        # Claude Code integration
│       └── api/           # FeathersJS client
│
└── context/               # Architecture documentation
    ├── concepts/          # Core design docs (read first)
    └── explorations/      # Experimental designs
```

**Monorepo:** Turborepo + pnpm workspaces

---

## Quick Start

### Run Daemon

```bash
cd apps/agor-daemon
pnpm dev  # Starts on :3030
```

### Use CLI

```bash
# Initialize database
pnpm agor init

# Import a Claude Code session
pnpm agor session load-claude <session-id>

# List sessions
pnpm agor session list
```

### Develop UI

```bash
cd apps/agor-ui
pnpm storybook  # Component development
pnpm dev        # Full app
```

**See:** [CLAUDE.md](CLAUDE.md) for complete development guide.

---
