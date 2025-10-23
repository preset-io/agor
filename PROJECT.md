## TODOs and Roadmap

See [context/concepts/multiplayer.md](context/concepts/multiplayer.md) and [context/concepts/mcp-integration.md](context/concepts/mcp-integration.md) for full documentation.

### Phase 3: Collaboration & Orchestration

**Goal:** Complete fork/spawn workflow and advanced presence features.

**Orchestration (2-3 weeks):**

- [ ] **Session forking UI** - Fork sessions at decision points
  - Wire fork button to `/sessions/:id/fork` API
  - Display fork genealogy on canvas (React Flow edges)
  - Show fork point in conversation view

- [ ] **Genealogy visualization** - Show session relationships
  - React Flow edges between parent/child/forked sessions
  - Different edge styles (solid spawn, dashed fork)
  - Click edge to see fork/spawn context

### Phase 4: Distribution & Packaging (Q2-Q4 2025)

**Goal:** Make Agor easy to install and use for non-developers.

See [context/explorations/single-package.md](context/explorations/single-package.md) for complete distribution strategy.

**Phase 4a: Quick npm Release (Q2 2025) - 1-2 weeks**

- [ ] Publish `@agor/core` to npm
- [ ] Publish `@agor/daemon` to npm
- [ ] Publish `@agor/cli` to npm
- [ ] Update README with npm install instructions
- [ ] Document daemon setup separately

**Phase 4b: Bundled Experience (Q3 2025) - 2-4 weeks**

- [ ] Bundle daemon into CLI package
- [ ] Implement auto-start daemon on CLI commands
- [ ] Add `agor daemon` lifecycle commands (start/stop/status/logs)
- [ ] Publish `agor` meta-package
- [ ] Update README with simplified instructions

---

### Future (Phase 5+)

See [context/explorations/](context/explorations/) for detailed designs:

- **OAuth & organizations** - GitHub/Google login, team workspaces, RBAC
- **Multi-agent support** ([agent-integration.md](context/concepts/agent-integration.md)) - Cursor, Gemini
- **Cloud deployment** - PostgreSQL migration, Turso/Supabase, hosted version
- **Worktree UX** ([worktree-ux-design.md](context/explorations/worktree-ux-design.md)) - Git worktree management UI

---

# Critical Path

- troubleshoot Claude session without clear/final results
- ⏳ **Concepts & Reports** - integrate in UI/CLI as first-class primitives
  - Concept management (CRUD/CLI) - many-to-many per session, shows as readonly
  - Report management + production system

**Tool Visualization:**

- ⏳ **Todo tool visualization** - render task list with checkboxes
- ⏳ **Write (diff) tool** - show file changes with syntax highlighting

**Distribution:**

- [x] **Doc website** - Nextra-based documentation site at `apps/agor-docs` (see [docs-website.md](context/explorations/docs-website.md))
  - [x] User guides (getting started, Docker, development)
  - [x] Manual REST API docs (manual approach due to MDX constraints)
  - [x] CLI reference (auto-generated from oclif commands)
  - [ ] Architecture docs (adapted from concepts/)
  - [ ] Deploy to docs.agor.dev (Vercel)
  - **Running:** `pnpm docs:dev` → http://localhost:3001
  - **Note:** Manual REST API docs preferred over auto-generation (TypeDoc/widdershins) due to Nextra MDX parsing issues

# Nice to Have

- [ ] **Token count & cost** - show $ per task/session (when applicable)
- [ ] **`@`-triggered autocomplete** - mention sessions, repos, concepts
- [ ] **Typing indicators** - "User is typing..." in prompt input
- [ ] agor worktree .\* CLI commands (list/create/delete)
