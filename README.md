<img src="https://github.com/user-attachments/assets/e34f3d25-71dd-4084-8f3e-4f1c73381c66" alt="Agor Logo" width="320" />

# Agor

Orchestrate Claude Code, Codex, and Gemini sessions on a multiplayer canvas. Manage git worktrees, track AI conversations, and visualize your team's agentic work in real-time.

**[Docs](https://mistercrunch.github.io/agor/)** | **[Discussions](https://github.com/mistercrunch/agor/discussions)**

---

## Quick Start

**Try in Codespaces:**

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/mistercrunch/agor?quickstart=1&devcontainer_path=.devcontainer%2Fplayground%2Fdevcontainer.json)

**Or run locally:**

```bash
docker compose up
# Open http://localhost:5173
# Login: admin@agor.live / admin
```

---

## What It Does

- **Agent orchestration** - Run Claude Code, Codex, Gemini from one interface
- **Git worktree management** - Isolated workspaces per session, no branch conflicts
- **Real-time board** - Drag sessions around, organize by project/phase/zone
- **Session tracking** - Every AI conversation is stored, searchable, forkable
- **MCP integration** - Configure MCP servers once, use across all agents
- **Multiplayer** - See teammates' sessions, share environments, async handoffs

---

## Core Concepts

**Sessions** - Container for agent interactions with git state, tasks, genealogy
**Worktrees** - Git worktrees managed by Agor, isolated per session
**Boards** - Spatial canvas for organizing sessions (like Trello for AI work)
**Zones** - Areas on board that trigger templated prompts when sessions dropped
**Tasks** - User prompts tracked as first-class work units

---

## Architecture

```
Frontend (React + Ant Design)
    ↓ WebSocket
Daemon (FeathersJS)
    ↓
Database (LibSQL) + Git Worktrees
    ↓
Agent SDKs (Claude, Codex, Gemini)
```

**Stack:** FeathersJS, Drizzle ORM, LibSQL, React Flow, Ant Design

See [Architecture Guide](https://mistercrunch.github.io/agor/guide/architecture) for details.

---

## Key Features

### Git Worktree Management

Every session maps to a git worktree - no more branch conflicts when running parallel AI work.

### Environment Management

Start/stop dev servers per worktree. Each gets unique ports. Share running environments with teammates via URL.

### Zone Triggers

Drop sessions on zones to trigger templated workflows (analyze → develop → review → deploy).

### Session Genealogy

Fork sessions to explore alternatives. Spawn subtasks with fresh context. Full ancestry tracking.

### Multi-Agent Support

Swap between Claude/Codex/Gemini mid-task. Compare outputs. Hand off when one model stalls.

---

## Development

```bash
# Terminal 1: Daemon
cd apps/agor-daemon && pnpm dev  # :3030

# Terminal 2: UI
cd apps/agor-ui && pnpm dev      # :5173
```

See [CLAUDE.md](CLAUDE.md) for dev workflow and [PROJECT.md](PROJECT.md) for roadmap.

---

## Roadmap

- Match CLI-native features as SDKs evolve
- Bring Your Own IDE (VSCode/Cursor remote connection)
- Session forking UI with genealogy visualization
- Automated reports after task completion
- Context management system (modular markdown files)
