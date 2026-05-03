# Core primitives

> For the marketing-grade pitch, voice, and tagline: read [`context/messaging-and-positioning.md`](../messaging-and-positioning.md). This file is for agents who need a quick mental model.

Agor has **five primitives**. Almost everything in the codebase is one of these or a relationship between them.

## 1. Worktree — the unit of work

A **git worktree** at `~/.agor/worktrees/<repo>/<name>`, on its own branch, with its own dev environment. Conventionally: 1 worktree = 1 feature/bug = 1 PR.

- First-class table (was previously nested in `repos` JSON).
- Multiple sessions (and users) can share one worktree's filesystem and git state.
- Has an associated `Environment` (running dev server, ports allocated via `worktree.unique_id`).
- Lives on **boards** as a card.

Type: `packages/core/src/types/worktree.ts`. Cheat sheet: [`worktrees.md`](worktrees.md).

## 2. Board — the spatial canvas

A 2D canvas where worktrees are arranged as cards. Boards have **zones** (rectangular regions with optional Handlebars prompt templates that fire when a worktree is dropped in).

**Worktrees are the primary card on a board, not Sessions.** Sessions appear *inside* a worktree card as a genealogy tree.

User-facing reference: [`apps/agor-docs/pages/guide/boards.mdx`](../../apps/agor-docs/pages/guide/boards.mdx).

## 3. Session — agent conversations with genealogy

A conversation with a coding agent (Claude Code, Codex, Gemini, OpenCode). Required FK to a **Worktree**.

Two relationship types:

- **Fork** — sibling session that copies parent context up to a fork point. Same worktree.
- **Spawn** — child session with a fresh context window. Same worktree.

Status: `idle | running | completed | failed`. Tasks within a session can queue (see [`task-queueing.md`](task-queueing.md)).

User-facing reference: [`apps/agor-docs/pages/guide/sessions.mdx`](../../apps/agor-docs/pages/guide/sessions.mdx).

## 4. Task — the queueable unit of work

A single user-prompt-and-its-execution within a session. Tasks materialize on every `POST /sessions/:id/prompt`. Tasks (not messages) are what queue when a session is busy. See [`task-queueing.md`](task-queueing.md).

## 5. Report — markdown summaries (planned/partial)

Markdown summaries written by agents at task completion. Surfaces in board cards, comments, and PR descriptions. Status varies — check code before assuming behavior.

---

## Composition rules to internalize

- Sessions reference worktrees, not the other way around. Cascading from worktree → sessions, never the inverse.
- Boards display worktrees. UIs that show "session list on board" are wrong shapes.
- Fork/spawn happen on the same worktree. They diverge in conversation, not in filesystem.
- Tasks are inside sessions. Messages are inside tasks (after the never-lose-prompt redesign — see `docs/never-lose-prompt-design.md`).

## Related

- [`architecture.md`](architecture.md) — system shape
- [`worktrees.md`](worktrees.md) — worktree details
- [`ts-types.md`](ts-types.md) — type catalog
