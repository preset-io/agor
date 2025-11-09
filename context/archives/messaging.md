# Messaging Ideas

Marketing/positioning elements to consider for future website or promotional materials.

## Taglines

- "Great solo. Even better together."
- "git tracks code, Agor tracks the conversations that produced it."

## Value Propositions

### Before/After Framing

**Before Agor:**

- AI sessions are invisible to your team
- Switching agents means starting over
- No way to fork/compare approaches
- Context gets lost between handoffs

**With Agor:**

- See all team sessions on one board
- Swap agents mid-task, compare outputs
- Fork sessions to explore alternatives
- Share running environments via URL

### Metaphors

- "Organize sessions spatially (like Trello for AI work)"
- "Coordinate agentic work like a multiplayer RTS"
- "Agor turns invisible AI sessions into visual, collaborative workspaces"

## Visual Concepts

**Placeholder GIF ideas:**

- Multiplayer board with live cursors, dragging sessions, zone triggers
- Creating a session, agent executing, zone trigger workflow
- Session conversation view with task breakdown, tool outputs
- Forking a session, zone trigger activation, environment sharing

**Screenshot concepts:**

- Board view with sessions, zones, facepile
- Session drawer showing conversation, git state, genealogy

## Architecture Diagrams

```
Your IDE (VSCode/Cursor)        Multiplayer Board
       ↓                               ↓
  Agor Daemon ← Git Worktrees + LibSQL Database
       ↓
Agent SDKs (Claude, Codex, Gemini)
```

## Worktree Example

```bash
# Worktree 1: feature/auth (Claude Code) - http://localhost:4000
# Worktree 2: feature/payments (Codex) - http://localhost:5000
# Worktree 3: feature/analytics (Gemini) - http://localhost:6000
```

## Zone Workflow Example

```
[Analyze Zone] → [Develop Zone] → [Review Zone] → [Deploy Zone]
```
