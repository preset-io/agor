# Worktree-Centric RBAC

> **⚠️ ARCHIVED:** This exploration doc has been superseded by the production implementation.
>
> **See instead:**
> - **User Guide:** `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`
> - **Implementation Guide:** `context/guides/rbac-and-unix-isolation.md`
> - **Feature Flags:** `CLAUDE.md` (Feature Flags section)
>
> This document remains for historical context on the RBAC design exploration.

**Status:** 🔬 Exploration (ARCHIVED - See above)
**Scope:** Application-level authorization (FeathersJS services + socket events) ✅ IMPLEMENTED
**Last Updated:** 2025-01-23
**Archived:** 2025-02-03

> This document focused on Agor's app-layer RBAC for worktrees and the sessions that belong to them. The concepts here have been implemented in production. For the unified OS-level + app-level design, see `context/guides/rbac-and-unix-isolation.md`.

---

## Problem & Goals

Current Agor deployments behave like a shared devbox: every authenticated user can read and mutate every worktree, session, and task. We need an RBAC layer that:

1. Models **worktree ownership** as many-to-many between users and worktrees.
2. Allows owners to set a coarse sharing mode for “others”: `view`, `prompt`, or `all`.
3. Propagates the same permission envelope to **sessions/tasks/messages** because every session is scoped to exactly one worktree.
4. Applies identically across REST, WebSocket, and MCP code paths by leveraging FeathersJS hooks and services.
5. Plays nicely with the future Unix-isolation work while still delivering practical guardrails today (soft privacy).

Out of scope: filesystem isolation, true “private” worktrees, network/mac-level sandboxing.

---

## Permission Model

### Entities

| Entity       | Notes                                                              |
| ------------ | ------------------------------------------------------------------ |
| Worktree     | Primary object. Has many owners, tracks `others_can` sharing mode. |
| Session      | Always references a worktree; inherits its permission envelope.    |
| Task/Message | Tied to a session ⇒ inherits the parent worktree’s permissions.    |

### Ownership

- Introduce `worktree_owners` join table (user_id ⇄ worktree_id).
- Ownership implies **full** (`all`) access regardless of the `others_can` mode.
- Owners manage the sharing mode and can add/remove other owners (subject to future UX).

### Sharing Modes (`others_can`)

| Mode     | Capabilities for non-owners                                                  |
| -------- | ---------------------------------------------------------------------------- |
| `view`   | Read-only: can list/get worktrees/sessions/tasks/messages, but no mutations. |
| `prompt` | Everything in `view` plus create new tasks/messages (i.e., “run agents”).    |
| `all`    | Equivalent to ownership for CRUD purposes (minus managing owners).           |

`none` is intentionally omitted to avoid a silent UX that pretends privacy while events still broadcast over shared sockets. If true privacy is needed later, we’ll revisit channel scoping once Unix-level isolation exists.

### Session Ownership (CRITICAL)

**Key insight:** Sessions are **immutable to their creator**.

- `session.created_by` is set on creation and NEVER changes
- Session creator determines execution context (Unix user, credentials, ~/.claude/ state)
- When Bob prompts Alice's session:
  - **App-layer:** Task creator is Bob (`task.created_by = Bob`)
  - **OS-layer:** Execution runs as Alice (`session.created_by = Alice`)
  - Alice's credentials, SSH keys, Claude SDK state are used

**Permission inheritance from worktree:**

- Every session belongs to exactly one worktree
- Permission checks resolve the worktree first, then apply to the session
- Derived rules:
  - `view` on worktree → can read sessions/tasks/messages
  - `prompt` on worktree → can create tasks/messages in existing sessions
  - `all` on worktree → can create new sessions, delete sessions

---

## FeathersJS Enforcement Strategy

### Hook Helpers

Implement shared utilities (similar to `requireMinimumRole`) to centralize worktree authorization:

```ts
loadWorktree(context, worktreeIdField = 'worktree_id');
ensureWorktreePermission(context, level: 'view' | 'prompt' | 'all');
scopeWorktreeQuery(context); // inject owner/others_can filters for find
```

- `loadWorktree` fetches the worktree once, caches it on `context.params.worktree`, and resolves owners + sharing mode.
- `ensureWorktreePermission` checks ownership first, then compares the requested level to `others_can`. Throws `Forbidden` for external requests; internal daemon calls (no `params.provider`) bypass as today.
- `scopeWorktreeQuery` rewrites `context.params.query` so `find` never returns unauthorized rows (owners OR `others_can >= view`).

### Services to Touch

| Service                           | Hook usage                                                             |
| --------------------------------- | ---------------------------------------------------------------------- |
| `worktrees`                       | Gate `get/find/patch/remove` + owner management endpoints.             |
| `sessions`                        | Before hooks load the related worktree and reuse permission checks.    |
| `tasks`, `messages`               | Require `prompt` for create/update/delete, `view` for reads.           |
| `board-objects`, `board-comments` | Mirror worktree checks because they surface worktree data.             |
| MCP + custom routes               | Always call Feathers services with `provider: undefined` so hooks run. |

By forcing _every_ code path through these hooks, we ensure consistent RBAC across REST, WebSocket, daemon-to-daemon, and MCP tooling.

---

## Real-Time Strategy

- Keep today’s single `everybody` channel (`apps/agor-daemon/src/index.ts:932-938`).
- Rely on the same service hooks to prevent unauthorized CRUD; “view” events are still visible to all authenticated sockets (soft privacy).
- Future option: move to per-worktree channels once we need true privacy; this doc stays focused on the simpler single-channel design.

---

## Data Model Changes

1. **Drizzle migration**

   ```sql
   -- App-layer permissions
   ALTER TABLE worktrees ADD COLUMN others_can TEXT NOT NULL DEFAULT 'view';

   -- OS-layer permissions (see unix-user-modes.md)
   ALTER TABLE worktrees ADD COLUMN unix_group TEXT NULL;
   ALTER TABLE worktrees ADD COLUMN others_fs_access TEXT NOT NULL DEFAULT 'read';

   -- Ownership (many-to-many)
   CREATE TABLE worktree_owners (
     worktree_id TEXT NOT NULL REFERENCES worktrees(worktree_id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
     PRIMARY KEY (worktree_id, user_id)
   );

   -- Ensure sessions are immutably bound to creator
   -- (created_by already exists, just document it's immutable)
   ```

2. Repository helpers for adding/removing owners and fetching ownership lists in bulk (to avoid N+1 lookups inside hooks).

3. **Critical constraint:** `sessions.created_by` is immutable (enforce in app code, not DB for flexibility)

---

## Implementation Phases

1. **Schema + Repos**
   - Add columns/tables.
   - Extend `WorktreeRepository` with ownership helpers and a bulk loader.

2. **Hook Utilities**
   - Implement `ensureWorktreePermission`, `scopeWorktreeQuery`, etc.
   - Unit-test edge cases (internal calls, anonymous mode, no user on params).

3. **Service Wiring**
   - Inject hooks into `worktrees`, `sessions`, `tasks`, `messages`, `board-*`.
   - Ensure session creation (which currently enriches repo metadata) still succeeds when hooks run (`apps/agor-daemon/src/index.ts:940-1008`).

4. **UI/CLI Exposure (later)**
   - Owner management UI, “others can” selector, error surfacing when actions are blocked.
   - CLI commands for listing/managing owners if needed.

5. **Testing**
   - Add integration tests covering REST + socket flows.
   - Ensure MCP tools (which call services internally) inherit the same enforcement.

6. **Unix Integration Alignment**
   - Integrate with worktree Unix groups (see `unix-user-modes.md`)
   - Add owner management also updates Unix group membership
   - Changing `others_fs_access` updates filesystem permissions (chmod)

---

## Complexity & Risks

| Area                         | Complexity  | Notes                                                                                                                                                                                                         |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema/repo changes          | Low-Medium  | Straightforward migrations + helpers.                                                                                                                                                                         |
| Hook logic & service updates | Medium-High | Touches many services; must respect internal call bypass semantics.                                                                                                                                           |
| Query scoping performance    | Medium      | Need batching/caching to avoid per-request owner lookups.                                                                                                                                                     |
| UI/UX follow-up              | Medium      | Surfacing permissions, managing owners, clear error messaging.                                                                                                                                                |
| Security limitations         | High        | Without Unix isolation, RBAC is advisory—motivated users can still inspect worktree files via shell access. Reference `@context/explorations/unix-user-integration.md` for the roadmap toward real isolation. |

---

## Open Questions

1. Do we need an audit log for owner changes and permission escalations?
   - **Likely yes** - important for compliance, debugging
   - Could be simple table: `worktree_audit_log` with actor, action, timestamp

2. Should "prompt" cover only task/message creation, or also session creation?
   - **Both** - if you can prompt a worktree, you can create sessions in it
   - But session execution runs as the session creator (not the worktree owner)

3. How do we expose ownership via CLI/API for automation without overcomplicating the UI?
   - CLI: `agor worktree owners <worktree>`, `agor worktree add-owner <worktree> <email>`
   - API: `PATCH /worktrees/:id/owners` with `{ add: [userId], remove: [userId] }`
   - UI: Simple owner list with add/remove buttons

4. ~~At what point do we introduce per-worktree socket channels?~~
   - **Not needed yet** - app-layer hooks + OS-layer groups provide sufficient isolation
   - Revisit if we need true "invisible" worktrees (not just restricted access)

---

## References

- `@context/explorations/unix-user-modes.md` — **Unified design** covering Unix modes, worktree groups, session immutability
- `@context/explorations/unix-user-integration.md` — Original sudo impersonation exploration (superseded by unix-user-modes.md)
- `apps/agor-daemon/src/utils/authorization.ts` — existing role helpers to extend
- `apps/agor-daemon/src/index.ts` — service hook registrations and socket setup
- `context/concepts/architecture.md` — rationale for always using service layer so hooks (and future RBAC) apply everywhere
