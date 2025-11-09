# Agor Context

This directory contains modular knowledge files that document Agor's concepts, architecture, and design principles. These files are designed to be:

- **Composable** - Load only what you need
- **Self-referencing** - Concepts link to related concepts
- **Version-controlled** - Track evolution of ideas over time
- **AI-friendly** - Agents can load specific concepts as context

## Available Concepts

### Core Concepts

- **[core.md](concepts/core.md)** - The 5 primitives, core insights, and vision
- **[models.md](concepts/models.md)** - Information architecture, data models, and relationships
- **[id-management.md](concepts/id-management.md)** - UUIDv7 strategy, short IDs, collision resolution
- **[architecture.md](concepts/architecture.md)** - System design, storage structure, data flow
- **[design.md](concepts/design.md)** - UI/UX principles and component patterns
- **[frontend-guidelines.md](concepts/frontend-guidelines.md)** - React/Ant Design patterns, token-based styling, WebSocket integration, component structure
- **[conversation-ui.md](concepts/conversation-ui.md)** - Task-centric conversation UI, universal message schema, component patterns
- **[tool-blocks.md](concepts/tool-blocks.md)** - Advanced tool visualization, semantic grouping, file impact graphs
- **[llm-enrichment.md](concepts/llm-enrichment.md)** - AI-powered session analysis, summaries, pattern detection, quality insights
- **[websockets.md](concepts/websockets.md)** - Real-time communication with FeathersJS/Socket.io, progressive streaming, future scalability
- **[agent-integration.md](concepts/agent-integration.md)** - Claude Agent SDK integration, session continuity, live execution
- **[agentic-coding-tool-integrations.md](concepts/agentic-coding-tool-integrations.md)** - Feature comparison matrix for Claude Code, Codex, and Gemini integrations
- **[auth.md](concepts/auth.md)** - Authentication & authorization, anonymous-first, JWT/Local strategies, user attribution
- **[multiplayer.md](concepts/multiplayer.md)** - Real-time collaboration, facepile, cursor swarm, presence indicators
- **[board-objects.md](concepts/board-objects.md)** - Board layout system, zones, session pinning, zone triggers with Handlebars
- **[worktrees.md](concepts/worktrees.md)** - Worktree-centric architecture: data model, worktree-centric boards, WorktreeModal (5 tabs), environments, terminal integration
- **[session-worktree-attribute-migration.md](concepts/session-worktree-attribute-migration.md)** - Data attribute migration analysis (issue_url, pull_request_url, etc.)
- **[mcp-integration.md](concepts/mcp-integration.md)** - MCP server management, CRUD UI/CLI, session-level selection
- **[permissions.md](concepts/permissions.md)** - Permission system, task-centric approval, audit trails
- **[agor-mcp-server.md](concepts/agor-mcp-server.md)** - Built-in MCP endpoint that gives agents self-awareness of sessions, boards, and worktrees
- **[api-docs.md](concepts/api-docs.md)** - Auto-generated Swagger/OpenAPI docs for every Feathers service
- **[conversation-autocomplete.md](concepts/conversation-autocomplete.md)** - `@` autocomplete for files and users inside prompt inputs
- **[database-migrations.md](concepts/database-migrations.md)** - Drizzle migration workflow plus `agor db status/migrate`
- **[environment-logs.md](concepts/environment-logs.md)** - Worktree environment controls, log viewer, and MCP hooks
- **[mcp-session-tools.md](concepts/mcp-session-tools.md)** - `agor_sessions_*` MCP tools for continuing, forking, and editing sessions
- **[message-queueing.md](concepts/message-queueing.md)** - Line-up prompts with queued message status and processing rules
- **[opencode-integration.md](concepts/opencode-integration.md)** - Server-mode OpenCode agent integration
- **[per-user-api-keys.md](concepts/per-user-api-keys.md)** - Encrypted Anthropic/OpenAI/Gemini key storage with reusable UI component
- **[scheduler.md](concepts/scheduler.md)** - Worktree-scoped cron scheduler that spawns autonomous sessions
- **[sdk-compaction-status.md](concepts/sdk-compaction-status.md)** - Surfacing Claude SDK compaction events in UI + metrics
- **[messaging.md](concepts/messaging.md)** - Product taglines, before/after framing, and visual storytelling cues
- **[task-tool-message-attribution.md](concepts/task-tool-message-attribution.md)** - Proper labeling for Task tool prompts/results
- **[text-display.md](concepts/text-display.md)** - Collapsible/ANSI text patterns for readable tool output
- **[thinking-mode.md](concepts/thinking-mode.md)** - Auto/manual/off thinking controls with keyword detection
- **[user-env-vars.md](concepts/user-env-vars.md)** - Encrypted per-user environment variables merged into agent subprocesses

### Explorations (Work in Progress)

Experimental ideas and designs not yet crystallized into concepts. These represent active thinking and may graduate to `concepts/` when ready:

- **[ide-integration.md](explorations/ide-integration.md)** - Evaluating Remote SSH vs code-server for worktree IDE support
- **[native-cli-feature-gaps.md](explorations/native-cli-feature-gaps.md)** - Pointer to the living SDK comparison guide on agor.live
- **[unix-user-integration.md](explorations/unix-user-integration.md)** - Deep dive on sudo-based impersonation and OS-level user isolation

**Lifecycle:** `explorations/` → `concepts/` when design is validated and ready to be official

### Archives

Historical documentation and completed research preserved for reference:

- **[agor-mcp-server.md](archives/agor-mcp-server.md)** - Research + prototypes for exposing Agor as its own MCP server
- **[async-jobs.md](archives/async-jobs.md)** - Background job processing exploration (resolved: not needed for local dev tool, use async functions + WebSocket events)
- **[auto-generated-api-docs.md](archives/auto-generated-api-docs.md)** - Feathers Swagger evaluation and rollout plan
- **[conversation-autocomplete.md](archives/conversation-autocomplete.md)** - Full UX spec for the `@` autocomplete experience
- **[database-migrations.md](archives/database-migrations.md)** - Launch-blocker write-up for adopting Drizzle migrations
- **[environment-logs-and-mcp.md](archives/environment-logs-and-mcp.md)** - Process control + log access blueprint
- **[gemini-integration-research.md](archives/gemini-integration-research.md)** - Gemini CLI SDK discovery process, API analysis, and integration decisions (completed Oct 2025)
- **[launch-prep.md](archives/launch-prep.md)** - v0.4.0 release checklist and launch validation
- **[messaging.md](archives/messaging.md)** - Original brainstorm for taglines, metaphors, and visual cues
- **[mcp-session-management.md](archives/mcp-session-management.md)** - MCP tool spec for session CRUD, forks, and updates
- **[message-queueing.md](archives/message-queueing.md)** - Queueing proposal that informed the current implementation
- **[task-queuing-and-message-lineup.md](archives/task-queuing-and-message-lineup.md)** - Advanced sequencing concepts (interrupt, priority) for future queue iterations
- **[opencode-integration.md](archives/opencode-integration.md)** - OpenCode server-mode analysis and integration plan
- **[per-user-api-keys.md](archives/per-user-api-keys.md)** - API key UX + encryption decisions
- **[scheduler.md](archives/scheduler.md)** - Autonomous worktree automation deep dive
- **[sdk-compaction-status.md](archives/sdk-compaction-status.md)** - Claude compaction event handling research
- **[task-tool-message-attribution.md](archives/task-tool-message-attribution.md)** - Bug record + UI fix proposal
- **[text-display-improvements.md](archives/text-display-improvements.md)** - Exploration that drove Collapsible/ANSI components
- **[thinking-mode.md](archives/thinking-mode.md)** - Keyword detection + UX decisions for thinking controls
- **[user-comments-and-conversation.md](archives/user-comments-and-conversation.md)** - Historical notes on conversation surfacing
- **[user-env-vars.md](archives/user-env-vars.md)** - Per-user environment variable architecture

**Purpose:** Archives preserve the research journey and decision-making context for completed features. They're valuable for understanding "why" things were built certain ways.

### Primitives (Deep Dives)

Future location for detailed explorations of each primitive:

- `primitives/session.md` - Sessions in depth
- `primitives/task.md` - Tasks in depth
- `primitives/report.md` - Reports in depth
- `primitives/worktree.md` - Worktrees in depth
- `primitives/concept.md` - Concepts in depth (meta!)

## Using Context Files

### For Developers

Read concept files to understand specific aspects of Agor:

```bash
# Start with core concepts
cat context/concepts/core.md

# Then explore specific areas
cat context/concepts/architecture.md
cat context/concepts/design.md
```

### For AI Agents

Load relevant concepts into session context:

```bash
# Example: Starting a session focused on UI work
agor session start \
  --concepts design \
  --agent claude-code
```

## Contributing

When adding new concepts:

1. Create focused, single-topic files (prefer smaller over larger)
2. Use wiki-style links to reference related concepts: `[[concept-name]]`
3. Include "Related:" section at the top
4. Add entry to this README
5. Update cross-references in existing concepts

## Philosophy

> "Context engineering isn't about prompt templates—it's about managing modular knowledge as first-class composable primitives."

These concept files embody Agor's own design philosophy applied to documentation.
