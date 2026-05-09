# context/ — fast orientation for agents

This folder is **not** Agor's documentation. The user-facing docs live in [`apps/agor-docs/pages/guide/`](../apps/agor-docs/pages/guide/) and on [agor.live](https://agor.live).

This folder is a small set of **agent-oriented cheat sheets** — tight pointers, file maps, gotchas, and design rationale that an LLM dropped into the repo would actually want to skim before opening code.

## Working principles

- **Code is ground truth.** If a doc here drifts from the code, the code wins.
- **Guides are user truth.** If a topic has a guide page, this folder links to it instead of duplicating it.
- **Keep it small.** A bloated `context/` is a tax on every agent that loads it.

If you're tempted to add a long prose doc here — write it as a guide in `apps/agor-docs/pages/guide/` instead, and link to it from here.

---

## Layout

### `concepts/` — agent cheat sheets

Tight, code-pointer-heavy notes on internals.

| File | What it's for |
|---|---|
| [`core.md`](concepts/core.md) | The five primitives (Worktree, Board, Session, Task, Report). Mental model. |
| [`architecture.md`](concepts/architecture.md) | System shape: services / repos / executor / storage. Where to look first. |
| [`worktrees.md`](concepts/worktrees.md) | Worktree-centric architecture (read before touching boards). |
| [`security.md`](concepts/security.md) | Web-layer hardening: CSP, CORS, recipes, debugging. |
| [`id-management.md`](concepts/id-management.md) | UUIDv7, branded ID types, short-ID resolution. |
| [`task-queueing.md`](concepts/task-queueing.md) | Task lifecycle and queue-on-busy semantics. |
| [`mcp-session-tools.md`](concepts/mcp-session-tools.md) | `agor_sessions_*` MCP tool surface and override semantics. |

### `guides/` — how-tos

Step-by-step implementation guides referenced from code.

- [`creating-database-migrations.md`](guides/creating-database-migrations.md) — Drizzle migrations (sqlite + postgres).
- [`extending-feathers-services.md`](guides/extending-feathers-services.md) — Adding services, methods, hooks.
- [`rbac-and-unix-isolation.md`](guides/rbac-and-unix-isolation.md) — Implementation guide for worktree RBAC + Unix user modes (referenced from CLI admin commands and unix utilities).

### `guidelines/` — house rules

- [`testing.md`](guidelines/testing.md) — Vitest patterns and conventions.
- [`toasts.md`](guidelines/toasts.md) — Toast/message pattern. Always `useThemedMessage()` — never static `message.x()`.

### `explorations/` — active design docs

Designs that are referenced from code or in flight. Anything here is either still being built or documents a security/behavior contract you'd want before touching the relevant code.

- [`executor-isolation.md`](explorations/executor-isolation.md) — executor process / unix isolation architecture (referenced from `packages/executor/` and `apps/agor-docs/pages/guide/architecture.mdx`).
- [`executor-expansion.md`](explorations/executor-expansion.md) — referenced from `packages/core/src/config/`.
- [`executor-implementation-plan.md`](explorations/executor-implementation-plan.md) — phased plan for executor work.
- [`env-var-access.md`](explorations/env-var-access.md) — per-user / per-session env var access model (referenced from schemas, types, and migrations).
- [`session-sharing.md`](explorations/session-sharing.md) — `dangerously_allow_session_sharing` security contract (referenced from `AGENTS.md` and `apps/agor-docs/pages/security.mdx`).
- [`parent-session-callbacks.md`](explorations/parent-session-callbacks.md) — child-session completion notifications (referenced from `docs/never-lose-prompt-design.md`).

### `messaging-and-positioning.md`

Internal source of truth for product copy (taglines, hero, package descriptions, blog voice). Read this before writing user-facing prose; do **not** paraphrase the codebase to invent new framing.

### `images/`

Assets used by docs in this folder.

---

## What lives elsewhere now

A previous version of this folder had ~95 files (concepts/, archives/, explorations/, projects/) totaling ~57k lines. Most was either:

- duplicated by the user-facing guide pages in `apps/agor-docs/pages/guide/*.mdx`,
- design exploration for features that have since shipped (the code is the source of truth),
- or stale plans for features that never shipped.

If you're looking for a topic and don't see it here, try (in order):

1. The relevant guide page in `apps/agor-docs/pages/guide/`
2. `git log --all --diff-filter=D -- 'context/**'` to find the deleted version
3. The actual code under `packages/` or `apps/`
