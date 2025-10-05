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
- **[architecture.md](concepts/architecture.md)** - System design, storage structure, data flow (WIP)
- **[design.md](concepts/design.md)** - UI/UX principles and component patterns

### Explorations (Work in Progress)
Experimental ideas and designs not yet crystallized into concepts. These represent active thinking and may graduate to `concepts/` when ready:

**Architecture & Infrastructure:**
- **[architecture-api.md](explorations/architecture-api.md)** - **[DECISION]** FeathersJS + Drizzle full-stack architecture
- **[state-management.md](explorations/state-management.md)** - Persistence layer (Drizzle ORM + LibSQL/PostgreSQL)
- **[state-broadcasting.md](explorations/state-broadcasting.md)** - Real-time sync & multi-client (FeathersJS WebSocket)
- **[cli.md](explorations/cli.md)** - CLI design (oclif, entity commands, stateful context)
- **[git-worktree.md](explorations/git-worktree.md)** - Git worktree management strategy

**Agent Integration:**
- **[agent-interface.md](explorations/agent-interface.md)** - Agent abstraction layer (Claude Code, Codex, Gemini, etc.)
- **[native-cli-feature-gaps.md](explorations/native-cli-feature-gaps.md)** - Native CLI features vs SDK limitations analysis
- **[subtask-orchestration.md](explorations/subtask-orchestration.md)** - Getting agents to spawn Agor-tracked subtasks

**Lifecycle:** `explorations/` → `concepts/` when design is validated and ready to be official

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
