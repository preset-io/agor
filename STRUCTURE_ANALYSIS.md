# Agor Repository Structure Analysis

## Executive Summary

**Agor** is a sophisticated, production-ready multiplayer orchestration platform for managing AI coding agents (Claude Code, Codex, Gemini). The codebase demonstrates enterprise-grade architecture with:

- **Monorepo structure** (4 apps + 2 core packages)
- **Full-stack TypeScript** across all layers
- **Comprehensive architecture documentation** (24+ concepts)
- **357 test files** covering major functionality
- **Turbo-optimized builds** with pnpm workspaces
- **Hybrid-schema database** (Drizzle ORM + SQLite)
- **Real-time WebSocket communication** (FeathersJS + Socket.io)

The project is mature, well-documented, and designed for extensibility.

---

## 1. REPOSITORY STRUCTURE OVERVIEW

### Root Level Organization

```
agor/
├── apps/                          # 4 application modules
│   ├── agor-daemon/               # FeathersJS REST + WebSocket backend
│   ├── agor-ui/                   # React 18 + Ant Design frontend
│   ├── agor-cli/                  # oclif-based command-line tool
│   └── agor-docs/                 # Nextra documentation website
│
├── packages/                       # 2 shared packages
│   ├── core/                       # Canonical @agor/core monolith
│   └── agor-live/                 # (Secondary package)
│
├── context/                        # Architecture documentation
│   ├── concepts/                   # 24+ core concept files
│   ├── explorations/               # WIP design documents
│   ├── archives/                   # Historical research
│   └── guidelines/                 # Coding patterns
│
├── .github/                        # CI/CD workflows
├── .devcontainer/                  # GitHub Codespaces config
├── turbo.json                      # Monorepo build orchestration
├── package.json                    # Root workspace config
├── biome.json                      # Code quality rules
├── CLAUDE.md                       # AI agent instructions
├── CONTRIBUTING.md                 # Developer guide
└── docker-compose.yml              # Local dev environment
```

### File Counts

| Module | TS/TSX Files | Test Files | Key Purpose |
|--------|------------|-----------|-------------|
| **packages/core** | 136 | ~100 | Shared types, DB, git, APIs, SDK integrations |
| **apps/agor-daemon** | 40+ | ~30 | Backend services, FeathersJS setup |
| **apps/agor-ui** | 88+ | ~20 | React components, hooks, state management |
| **apps/agor-cli** | 20+ | ~5 | CLI commands, user-facing tools |
| **context/** | - | - | 24+ markdown documentation files |
| **Total** | ~395+ | ~357 | Comprehensive testing |

---

## 2. ENTRY POINTS & KEY MODULES

### 2.1 Core Package: @agor/core

**Location:** `packages/core/`
**Role:** Shared foundation for all apps
**Test Coverage:** 357 tests across codebase

The core package is exported via **tsup with multiple entry points**:

```typescript
// Primary entry points in packages/core/tsup.config.ts:
- index                  // Main exports
- types/index           // All type definitions
- db/index              // Database & repositories
- git/index             // Git operations
- api/index             // API client
- claude/index          // Claude SDK integration
- config/index          // Configuration
- tools/index           // Agent tool abstractions
- permissions/index     // Permission system
- feathers/index        // FeathersJS re-exports
- templates/handlebars-helpers  // Templating
- environment/variable-resolver // Env handling
- utils/pricing         // Token/cost calculation
```

#### Core Subdirectories

| Directory | Purpose | Files |
|-----------|---------|-------|
| **types/** | Canonical TypeScript types | 23 files (Session, Task, User, Worktree, etc.) |
| **db/** | Drizzle ORM + repositories | 25 repositories, schema.ts (748 lines) |
| **git/** | Git operations (simple-git wrapper) | 4 files |
| **tools/** | Agent SDK abstractions (Claude, Codex, Gemini) | 16 files |
| **claude/** | Claude Agent SDK integration | 7 files + imports |
| **config/** | Configuration management | 21 files |
| **permissions/** | Permission system | 5 files |
| **api/** | API client utilities | 4 files |
| **utils/** | Helpers (pricing, cron, URLs) | 9 files |

### 2.2 Backend: agor-daemon

**Location:** `apps/agor-daemon/`
**Tech Stack:** Express + FeathersJS + Socket.io
**Entry Point:** `src/index.ts` (2,459 lines)

**Services (18 files):**

```
services/
├── sessions.ts          # Session CRUD & genealogy
├── worktrees.ts         # Worktree management + environments
├── tasks.ts             # Task lifecycle
├── messages.ts          # Message persistence
├── users.ts             # User management
├── boards.ts            # Board layout/organization
├── board-objects.ts     # Worktree cards on boards
├── board-comments.ts    # Spatial comments
├── repos.ts             # Repository tracking
├── context.ts           # Context file management
├── mcp-servers.ts       # MCP server registry
├── session-mcp-servers.ts  # Session-level MCP config
├── scheduler.ts         # Scheduled session execution
├── health-monitor.ts    # System health tracking
├── terminals.ts         # Terminal/shell management
├── config.ts            # Daemon configuration
└── (8 more support services)
```

**Key Entry Point Details:**
- Loads config via `loadConfig()`
- Initializes FeathersJS with REST + WebSocket
- Registers 18+ services via `app.configure()`
- Sets up authentication (Local + JWT strategies)
- Runs health checks and scheduler
- Provides Swagger API documentation

### 2.3 Frontend: agor-ui

**Location:** `apps/agor-ui/`
**Tech Stack:** React 18 + Vite + Ant Design + React Flow
**Entry Point:** `src/main.tsx` → `src/App.tsx`

**Component Structure (88+ components):**

```
components/
├── App/                       # Main app layout
├── ConversationView/          # Message display + task blocks
├── SessionCard/               # Session visualization
├── WorktreeModal/             # 5-tab worktree editor
│   └── tabs/
│       ├── Overview
│       ├── Environment
│       ├── Terminal
│       ├── Details
│       └── MCP Servers
├── SessionDrawer/             # Session details sidebar
├── Board-related/
│   ├── BoardCanvas/           # React Flow canvas
│   ├── BoardObjects/          # Worktree cards
│   └── SpatialComments/       # Comment threads
├── Modals/
│   ├── NewSessionModal
│   ├── ForkSpawnModal
│   ├── NewWorktreeModal
│   └── SettingsModal
├── Auth/
│   ├── LoginPage
│   └── WelcomeModal
└── (30+ other components)
```

**Hooks (15+ files):**
- `useAgorClient()` - WebSocket connection
- `useAgorData()` - Real-time data synchronization
- `useAuth()` - Authentication state
- `useSessionActions()` - Session operations
- `useBoardActions()` - Board manipulation
- `usePresence()` - Multiplayer cursors/facepile
- (10+ more domain-specific hooks)

### 2.4 CLI: agor-cli

**Location:** `apps/agor-cli/`
**Framework:** oclif
**Entry Points:** Commands in `src/commands/`

**Command Structure:**

```
commands/
├── daemon/
│   ├── start.ts
│   ├── stop.ts
│   └── status.ts
├── session/
│   ├── create.ts
│   ├── list.ts
│   └── view.ts
├── worktree/
│   ├── create.ts
│   ├── list.ts
│   └── update.ts
├── config/
│   ├── get.ts
│   ├── set.ts
│   └── view.ts
├── mcp/
│   ├── add.ts
│   ├── remove.ts
│   └── list.ts
├── init.ts              # Initialization
├── open.ts              # Launch UI browser
└── (8+ more commands)
```

### 2.5 Documentation: agor-docs

**Location:** `apps/agor-docs/`
**Framework:** Nextra (Next.js-based)
**Purpose:** User-facing documentation website

---

## 3. MAIN DEPENDENCIES & ARCHITECTURE DECISIONS

### Backend Stack

| Dependency | Version | Purpose |
|-----------|---------|---------|
| **feathersjs** | ^5.0 | REST + WebSocket framework |
| **socket.io** | ^4.7 | Real-time bidirectional communication |
| **express** | ^5.1 | HTTP server |
| **drizzle-orm** | ^0.44 | Type-safe ORM |
| **@libsql/client** | ^0.15 | SQLite database client |
| **simple-git** | ^3.28 | Git operations (NEVER subprocess) |
| **@anthropic-ai/claude-agent-sdk** | ^0.1.25 | Claude Code integration |
| **@openai/codex-sdk** | ^0.47 | Codex integration |
| **@google/gemini-cli-core** | ^0.9 | Gemini integration |
| **cron-parser** | ^5.4 | Cron scheduling |
| **jsonwebtoken** | ^9.0 | JWT authentication |

### Frontend Stack

| Dependency | Version | Purpose |
|-----------|---------|---------|
| **react** | ^18.3 | UI library |
| **react-router-dom** | ^7.9 | Routing |
| **antd** | ^5.27 | UI component library |
| **reactflow** | ^11.11 | Canvas/diagram rendering |
| **socket.io-client** | ^4.8 | WebSocket client |
| **vite** | ^7.1 | Build tool |
| **ansi-to-react** | ^6.1 | Terminal output rendering |
| **xterm** | ^5.3 | Terminal emulation |
| **emoji-picker-react** | ^4.14 | Emoji selection |

### Build & Quality Tools

| Tool | Purpose |
|------|---------|
| **turbo** | Monorepo build orchestration |
| **pnpm** | Package manager (workspace support) |
| **tsup** | TypeScript bundler (core package) |
| **tsx** | TypeScript executor (dev watching) |
| **biome** | Formatter + linter (replaces ESLint + Prettier) |
| **drizzle-kit** | ORM migrations + schema generation |
| **vitest** | Test runner |
| **storybook** | Component documentation |

---

## 4. DATABASE ARCHITECTURE

### Schema Overview

**Location:** `packages/core/src/db/schema.ts` (748 lines)

**Core Tables:**

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| **sessions** | Agentic conversations | session_id, worktree_id, agentic_tool, status, genealogy (FK), data (JSON) |
| **tasks** | User prompts | task_id, session_id, status, prompt, response |
| **messages** | Session conversations | message_id, session_id, role, content, token_usage |
| **worktrees** | Git worktrees | worktree_id, repo_id, path, branch, environment_status |
| **repos** | Git repositories | repo_id, url, clone_path, default_branch |
| **users** | User accounts | user_id, email, password_hash, role, created_at |
| **boards** | Spatial canvases | board_id, user_id, zones (JSON), layout_data (JSON) |
| **board_objects** | Worktree cards | object_id, board_id, worktree_id, position (JSON) |
| **board_comments** | Spatial comments | comment_id, board_id, object_id, author_id, thread_id |
| **mcp_servers** | MCP configuration | server_id, name, type, connection_config (JSON) |

### Hybrid Schema Strategy

**Philosophy:** Balance between flexible JSON and queryable columns
- **Materialized columns:** status, agentic_tool, genealogy FK (efficient filtering)
- **JSON blobs:** git_state, model_config, custom_context (rarely queried)

### Repositories (25 files)

Each table has a corresponding repository in `packages/core/src/db/repositories/`:

```
repositories/
├── sessions.ts          # CRUD + genealogy queries
├── tasks.ts             # Task lifecycle
├── messages.ts          # Pagination, filtering
├── worktrees.ts         # Environment tracking
├── users.ts             # User management
├── boards.ts            # Layout persistence
├── board-comments.ts    # Thread management
├── mcp-servers.ts       # Server registry
└── (17 more)
```

---

## 5. CODE PATTERNS & ARCHITECTURAL DECISIONS

### 5.1 Type-Driven Development

**All types centralized in `packages/core/src/types/`:**

```typescript
// Import from canonical source, NEVER redefine
import type {
  Session,
  Task,
  User,
  Worktree,
  Message,
  Board,
  PermissionMode,
  AgenticTool,
} from '@agor/core/types';
```

### 5.2 Git Operations Strategy

**Rule:** ALWAYS use `simple-git`, NEVER subprocess

```typescript
// ✅ Correct
import { getGitClient } from '@agor/core/git';
const git = getGitClient(worktreePath);
await git.checkout(branch);

// ❌ WRONG (never do this)
execSync('git checkout ' + branch);
spawn('git', ['checkout', branch]);
```

### 5.3 Service Layer Pattern

**Each daemon service:**
1. Extends FeathersJS service interface
2. Implements CRUD operations
3. Provides domain-specific methods
4. Emits WebSocket events on mutations

```typescript
// Example: SessionsService
export class SessionsService extends Service {
  async create(data: Partial<Session>) {
    // Validate + save to DB
    // Emit 'sessions:created' event
    // Return complete Session
  }

  async fork(sessionId: SessionID, taskId?: TaskID) {
    // Create genealogy relationship
    // Copy permissions & config
    // Emit 'sessions:forked' event
  }
}
```

### 5.4 Component Organization (React)

**Patterns:**
1. Collocated styles (CSS modules)
2. Custom hooks for data fetching
3. Compound components for modals
4. Controlled components (no local state except UI state)

```typescript
// ✅ Pattern: Hook + Component
function useSessionData(sessionId) {
  const [session, setSession] = useState(null);
  useEffect(() => {
    client.service('sessions').get(sessionId).then(setSession);
  }, [sessionId, client]);
  return session;
}

export function SessionCard({ sessionId }) {
  const session = useSessionData(sessionId);
  return <div>{session?.title}</div>;
}
```

### 5.5 Permission System

**Multi-tier permission design:**
1. **User role** - Global (admin, member, viewer)
2. **Session permission mode** - Agent-specific (auto, ask, deny, allow)
3. **Tool-level policies** - Fine-grained (file access, network, shell)

### 5.6 MCP (Model Context Protocol) Integration

**First-class MCP support:**
- Server registry + CRUD
- Session-level selection (can enable/disable per session)
- Token management for Agor self-access
- Environment variable resolution

---

## 6. DEVELOPER WORKFLOW & TOOLING

### Build System: Turbo + pnpm

**Two-process development:**

```bash
# Terminal 1: Core + Daemon (watches for changes, auto-restarts)
cd apps/agor-daemon
pnpm dev

# Terminal 2: UI dev server
cd apps/agor-ui
pnpm dev
```

**Turbo task graph:**

```json
{
  "build": { "dependsOn": ["^build"] },
  "dev": { "cache": false, "persistent": true },
  "test": { "dependsOn": ["^build"] },
  "typecheck": { "cache": false }
}
```

**Key commands:**
- `pnpm build` - Build all packages (turbo orchestrated)
- `pnpm dev` - Watch all (use 2 terminals instead)
- `pnpm test` - Run all tests
- `pnpm lint` - Check code quality
- `pnpm check` - typecheck + lint + build

### Code Quality

**Tools:**
- **Biome** - Formatter + linter (single tool)
- **TypeScript strict mode** - No `any`, branded types
- **Vitest** - Fast test runner
- **Husky + lint-staged** - Pre-commit hooks

**Configuration highlights:**

```json
// biome.json
{
  "formatter": { "lineWidth": 100 },
  "linter": {
    "suspicious": { "noExplicitAny": "error" },
    "correctness": { "noUnusedImports": "warn" }
  }
}
```

### Testing Strategy

**357 test files covering:**
- Repository layer (DB queries)
- Service logic (business rules)
- Component rendering (React)
- Permission checks
- Edge cases

**Test file pattern:** `*.test.ts` or `*.test.tsx`

---

## 7. ARCHITECTURAL OBSERVATIONS

### Strengths

1. **Monorepo clarity** - Clear separation between apps/packages
2. **Type safety** - Branded types, strict TypeScript, centralized definitions
3. **Documentation excellence** - 24+ concept files covering architecture
4. **Extensible SDK design** - Claude/Codex/Gemini abstraction
5. **Real-time multiplayer** - FeathersJS + Socket.io integrated
6. **Testing coverage** - 357 tests, strong repo/service layers
7. **Database hygiene** - Hybrid schema with repositories
8. **Developer experience** - Watch mode, hot reloading, clear patterns

### Potential Organizational Issues

1. **Large daemon index.ts** (2,459 lines)
   - Consider breaking service registrations into separate files
   - Could benefit from service factory pattern

2. **Wide core package** (136 TS files)
   - Contains types, db, git, apis, tools, config, permissions
   - Could split into sub-packages (e.g., @agor/types, @agor/db)
   - Currently mitigated by tsup entry points, but could be clearer

3. **Agent tool implementations** (Claude/Codex/Gemini in tools/)
   - Each has similar structure (prompt-service, message-builder, models)
   - Could benefit from factory pattern or shared base class

4. **Component proliferation** (88+ components)
   - Some could be composed from smaller atomic components
   - Consider establishing component composition patterns

5. **Schema complexity** (748 lines)
   - Multiple JSON blobs (data, git_state, genealogy)
   - Consider documenting JSON schema validation

### Consistency Patterns

1. **Service → Repository → Type flow** is well-established
2. **Hook → Component** pattern is consistent
3. **Entry points via tsup** is clear
4. **Command → lib + service** pattern in CLI works well
5. **Biome + TypeScript enforcement** maintains consistency

---

## 8. ENTRY POINT SUMMARY

| Application | Primary Entry | Tech | Purpose |
|-------------|---------------|------|---------|
| **daemon** | apps/agor-daemon/src/index.ts | FeathersJS/Express | REST + WebSocket API |
| **ui** | apps/agor-ui/src/main.tsx | React/Vite | Browser UI |
| **cli** | apps/agor-cli/bin/dev.ts | oclif/tsx | Command-line tool |
| **docs** | apps/agor-docs/pages/ | Nextra/Next.js | Documentation site |
| **core** | packages/core/tsup.config.ts | tsup | Shared library (22 entry points) |

---

## 9. CONFIGURATION & ENVIRONMENT

**Configuration hierarchy:**

1. `~/.agor/config.yaml` - User configuration (persistent)
2. `.env` files - Environment variables (development)
3. Environment-specific overrides - PORT, VITE_DAEMON_URL

**Default paths:**
- Database: `~/.agor/agor.db` (SQLite)
- Config: `~/.agor/config.yaml` (YAML)
- CLI: `agor` command (npm global)

---

## 10. DOCUMENTATION STRUCTURE

**Context files are the source of truth:**

```
context/
├── README.md                    # Index of all concepts
├── concepts/ (24 files)
│   ├── core.md                 # 5 primitives (Session, Task, Worktree, Report, Concept)
│   ├── models.md               # Data model relationships
│   ├── architecture.md         # System design
│   ├── design.md               # UI/UX principles
│   ├── frontend-guidelines.md  # React/Ant Design patterns
│   ├── worktrees.md           # Worktree-centric architecture
│   ├── permissions.md         # Permission system
│   ├── agent-integration.md   # SDK integration
│   └── (16 more concept docs)
├── explorations/ (WIP designs)
│   ├── subsession-orchestration.md
│   ├── async-jobs.md
│   ├── unix-user-integration.md
│   └── (more experimental ideas)
└── archives/ (historical research)
```

---

## 11. CONCLUSION

**Agor is a sophisticated, enterprise-grade platform** with:

- Clear architectural layering (types → db → services → UI)
- Strong type safety enforcement
- Production-ready tooling (Turbo, Biome, Vitest)
- Excellent documentation
- Real-time multiplayer capabilities
- Extensible agent SDK design

**Next steps for quality improvement:**
1. Break down large monolithic files (daemon/index.ts)
2. Extract types/db into separate packages for clarity
3. Document JSON schema validation patterns
4. Establish component composition guidelines
5. Consider agent SDK refactoring (factory pattern)

The codebase is well-organized and maintainable, following consistent patterns throughout.
