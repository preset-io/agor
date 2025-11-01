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

### Explorations (Work in Progress)

Experimental ideas and designs not yet crystallized into concepts. These represent active thinking and may graduate to `concepts/` when ready:

**Future Features:**

- **[native-cli-feature-gaps.md](explorations/native-cli-feature-gaps.md)** - Feature comparison between native agent CLIs and SDK capabilities

**Orchestration & Coordination:**

- **[subsession-orchestration.md](explorations/subsession-orchestration.md)** - Multi-agent task coordination and getting agents to spawn Agor-tracked subsessions
- **[async-jobs.md](explorations/async-jobs.md)** - Background job processing, queuing strategies, and long-running task management

**Distribution & Launch:**

- **[single-package.md](explorations/single-package.md)** - Distribution strategy (bundled CLI + daemon + UI into single npm package)
- **[docs-website.md](explorations/docs-website.md)** - Documentation website with Nextra (user guides, REST API reference, MDX support)

**Onboarding & UX:**

- **[init-experience.md](explorations/init-experience.md)** - Init flow, auth checking, API key management, tool availability UI patterns

**Security & Multi-Tenancy:**

- **[unix-user-integration.md](explorations/unix-user-integration.md)** - Deep exploration of OS-level Unix user integration: user management, process impersonation, credential storage, worktree ownership, security implications, and decision framework

**Lifecycle:** `explorations/` → `concepts/` when design is validated and ready to be official

### Archives

Historical documentation and completed research preserved for reference:

- **[gemini-integration-research.md](archives/gemini-integration-research.md)** - Gemini CLI SDK discovery process, API analysis, and integration decisions (completed Oct 2025)
- **[async-jobs.md](archives/async-jobs.md)** - Background job processing exploration (resolved: not needed for local dev tool, use async functions + WebSocket events)

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
