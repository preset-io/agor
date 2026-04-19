# Session Sharing & Identity Borrowing

**Status:** short-term flag **shipped** (`dangerously_allow_session_sharing`).
Longer-term redesign options are tracked here for future work; none are
scheduled yet.

---

## The problem

Before this work, the sessions service's `fork()` and `spawn()` paths — and
their MCP-tool front-ends `agor_sessions_spawn` and
`agor_sessions_prompt(mode:"fork"|"subsession")` — created child sessions with:

```ts
created_by:   parent.created_by,   // inherits parent owner
unix_username: parent.unix_username // inherits parent's Unix identity
```

The intent was "child belongs to the same person as the parent." In practice,
combined with `others_can: 'session'` (the safe default that lets non-owners
create sessions in a worktree) and the MCP surface, it meant any user able to
*see* another user's session could spawn or fork from it and have that child
session execute under the original creator's:

- Unix user (filesystem permissions, `~/.claude/`, `~/.codex/` storage, etc.)
- Encrypted env vars (`session_env_selections` resolved against
  `parent.created_by`'s stored vars)
- Provider credentials (Anthropic / OpenAI / Gemini / Copilot tokens)
- SDK session state directories

That is **identity borrowing** via the spawn/fork MCP surface: a collaborator
running their own prompt would still have the agent run as the original user.
This was effectively the same risk surface that `others_can: 'prompt'` already
exposes for *direct* prompts — but it was unconditional on spawn/fork, with no
opt-in toggle and no warning, even when the worktree was on the safe default
of `others_can: 'session'`.

Admins and superadmins also inherited rather than being attributed to
themselves, which broke the audit trail on admin-driven spawns.

---

## Short-term flag (shipped)

A new worktree-level boolean controls whether legacy identity borrowing is
preserved on spawn/fork.

```ts
// packages/core/src/types/worktree.ts
interface Worktree {
  // ...
  /** DANGEROUS: opt in to legacy parent-inheriting identity on spawn/fork */
  dangerously_allow_session_sharing?: boolean; // default: false
}
```

### New rules (see `apps/agor-daemon/src/utils/worktree-authorization.ts`
`determineSpawnIdentity`)

| Caller                          | Flag OFF (default)            | Flag ON                         |
| ------------------------------- | ----------------------------- | ------------------------------- |
| Same user as parent             | `created_by = caller`         | `created_by = caller`           |
| Admin / superadmin              | `created_by = admin` (always) | `created_by = admin` (always)   |
| Other user (cross-user spawn)   | `created_by = caller` (safe)  | `created_by = parent_owner` ⚠️  |
| Service account (executor etc.) | `created_by = parent_owner`   | `created_by = parent_owner`     |

When the legacy path triggers (cross-user spawn, flag ON), the daemon emits a
structured `console.warn('[SECURITY] legacy_session_sharing', { event,
caller_id, parent_owner_id, worktree_id })` log line for audit trails.

The new child session's `unix_username` is left to the existing
`setSessionUnixUsername` hook, which stamps it with the *caller's* current
Unix username. With the safe default this means the execution context now
matches the attribution.

**Important caveat — flag scope is app-identity only:**

The flag restores legacy attribution at the *application* layer
(`session.created_by`) but does **not** propagate the parent's
`unix_username` to the child. The downstream effect depends on
`unix_user_mode`:

- **`simple`** — no per-user Unix identity exists, so flag-ON behaves as
  intended: the child is attributed to the parent owner and runs under the
  daemon user.
- **`insulated`** — sessions execute as a shared executor user. Same as
  `simple` from an OS-identity perspective; flag-ON works.
- **`strict`** — sessions execute as the *creator's* Unix user, and
  `validateSessionUnixUsername` (in `worktree-authorization.ts`) compares the
  session's stamped `unix_username` against the *current* `created_by`
  user's `unix_username`. Because flag-ON sets `created_by = parent_owner`
  but `unix_username = caller`, this check **fails** and the child session
  refuses to execute.

In other words, flag-ON is effectively a no-op in `strict` mode (sessions
are created but cannot be prompted). This is intentional — strict mode is
the security guarantee we don't want a worktree-level toggle to undermine.
Operators who genuinely need cross-user identity borrowing should use
`simple` or `insulated` mode.

### UI

`WorktreeModal → Owners & Permissions` exposes the toggle as
"Allow legacy session sharing" with a red `Alert` describing the risk. Copy is
marked TODO for product to finalize.

### Tests

`apps/agor-daemon/src/utils/determine-spawn-identity.test.ts` covers the
matrix above plus admin/superadmin overrides, service-account fallback,
missing-caller refusal, and the warn-log signal.

---

## Longer-term design options (not scheduled)

The flag is a hardening fix, not a redesign. Four directions are worth
considering before we either remove the flag or invert its default:

### Option A — Worktree-scoped SDK home

Move every SDK's per-user state (`~/.claude/`, `~/.codex/`, etc.) into a
worktree-scoped directory, e.g. `<worktree.path>/.agor-sdk/<tool>/`. Sessions
in the same worktree share SDK state, and "forking from another user's
session" becomes meaningful (same on-disk SDK chain, attributed to the new
caller). Removes the "child needs the parent's home directory" coupling that
made identity borrowing tempting in the first place.

### Option B — Fork = copy semantics

On fork, snapshot the parent's SDK transcript / tool state into the child
session's own storage instead of pointing at the parent's. Eliminates the
shared-credentials problem but increases storage and breaks "talking to the
same model context" expectations.

### Option C — Stateless portability

Persist SDK session state as portable artifacts (transcript + cached tool
output) decoupled from any user's home directory. Sessions become
"replayable" — any user with `prompt` access can resume one under their own
identity without filesystem coupling. Largest effort, but cleanest long-term.

### Option D — Executor sandbox always-on

Force every session to run inside the executor sandbox (no user-home access),
making "whose Unix identity does this run as?" a non-question. Pairs well
with strict Unix mode and would let us remove the flag entirely once
sandboxing is the default.

These are sketches; each has open questions around SDK feature parity,
backwards compatibility, and storage cost. Pick this back up when the
short-term flag's friction surfaces real demand.
