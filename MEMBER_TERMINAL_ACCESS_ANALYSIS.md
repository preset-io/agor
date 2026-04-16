# Member Terminal Access — Analysis

**Status:** Implemented. The design below led to an `execution.allow_web_terminal`
config flag (default `false`). When on, any user with role `member` or higher can
open the web terminal; worktree-level RBAC still applies. See
`apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx` for the user-facing
docs.

**Scope:** Evaluate whether the `member` role should be allowed to open web terminals, and under which unix execution modes that is safe.

---

## 1. Current State

### Terminal is ADMIN-only at every layer

**Backend (Feathers hook):**
`apps/agor-daemon/src/register-hooks.ts:945-949`

```ts
safeService('terminals')?.hooks({
  before: {
    all: [requireAuth, requireMinimumRole(ROLES.ADMIN, 'access terminals')],
  },
});
```

Every method on `/terminals` (create/close) requires `admin` (rank 2) or higher. `requireMinimumRole` is defined at `apps/agor-daemon/src/utils/authorization.ts:45-50` and delegates to `hasMinimumRole` in `packages/core/src/types/user.ts:51`.

Role ranks (`packages/core/src/types/user.ts:30-36`):

| Role | Rank |
|---|---|
| viewer | 0 |
| member | 1 |
| admin | 2 |
| superadmin / owner | 3 |

So `member` is currently blocked at rank-1 vs required rank-2.

**Frontend (UI gate):**
`apps/agor-ui/src/components/TerminalModal/TerminalModal.tsx:94, 100, 344`

```tsx
const isAdmin = hasMinimumRole(user?.role, ROLES.ADMIN);
if (!isAdmin) return;
...
{!isAdmin ? (
  <div>Terminal access requires <strong>admin</strong> or <strong>owner</strong> role.
  Terminal sessions run as the daemon's system user and can execute arbitrary code...</div>
) : ... }
```

The modal renders an explanatory denial instead of the xterm view. The xterm setup effect also early-returns for non-admins. The "Open Terminal" buttons on worktree cards (`WorktreeCard.tsx:847`) and session panel (`SessionPanel.tsx:1007`) are rendered unconditionally; only the modal refuses.

### Terminal service internals

`apps/agor-daemon/src/services/terminals.ts`:

- One executor process per user, owning a single PTY running `zellij attach`.
- Zellij multiplexes tabs — typically one tab per worktree — within that single session.
- PTY I/O streams over the Feathers channel `user/${userId}/terminal`.
- `create({ worktreeId })` uses the given worktree only to resolve `cwd` and to send a `terminal:tab` create command; there is **no RBAC check against the worktree**.
- The executor is spawned via `spawnExecutorFireAndForget({ asUser: finalUnixUser || undefined })` where `finalUnixUser` is resolved by `resolveUnixUserForImpersonation`.
- User env vars / API keys are written to `/tmp/agor-env-<shortId>.sh`, chowned to the impersonated user when applicable, and sourced by the shell. This contains only the authenticated user's own decrypted secrets (from `resolveUserEnvironment`, `packages/core/src/config/env-resolver.ts`), not daemon-wide secrets.

**Relevant auth/role references:**
- `packages/core/src/types/user.ts:14-54` — role enum, ranks, `hasMinimumRole`.
- `apps/agor-daemon/src/utils/authorization.ts:17-50` — `ensureMinimumRole` / `requireMinimumRole`.
- `apps/agor-daemon/src/utils/worktree-authorization.ts:65-89, 1055-1152` — worktree-level permission checks (`view` / `session` / `prompt` / `all`).

---

## 2. Unix Execution Modes Inventory

Defined in `packages/core/src/unix/user-manager.ts:316` and resolved in `resolveUnixUserForImpersonation` (lines 360-402). Config flags live in `execution.worktree_rbac` and `execution.unix_user_mode` in `~/.agor/config.yaml`.

### Mode A — `simple` (default)

- **Config:** `worktree_rbac: false` (typical) or `worktree_rbac: true` + `unix_user_mode: simple`.
- **Impersonation:** **None.** `asUser` is `undefined`.
- **Who owns the PTY:** The daemon's own Unix user (e.g. `agorpg`).
- **Filesystem access the terminal inherits:**
  - Full read/write on `~/.agor/config.yaml` — contains the daemon JWT secret, DB path, executor settings, and potentially `executor_unix_user` / provider API keys.
  - Full read/write on `~/.agor/agor.db` — every user's sessions, tasks, encrypted env blobs (the encryption key is in config, so a shell could decrypt them).
  - Whatever worktrees live on disk under `storage.repos_dir` / `storage.worktrees_dir`.
  - The entire daemon process environment is available from `/proc/<daemon-pid>/environ` to anyone who is the daemon user.
- **Risk:** Equivalent to shell-on-the-daemon-host. A terminal here owns the whole Agor instance.

### Mode B — `insulated`

- **Config:** `worktree_rbac: true`, `unix_user_mode: insulated`, optional `executor_unix_user: agor_executor`.
- **Impersonation:** Executor (and therefore the terminal PTY) is spawned via `sudo -u <executor_unix_user>` (see `spawn-executor.ts:260-299`).
- **Who owns the PTY:** A single shared, non-daemon executor user (e.g. `agor_executor`), added to each worktree's `agor_wt_*` Unix group so it can enter worktree directories.
- **Filesystem access the terminal inherits:**
  - Cannot read daemon's `~/.agor/config.yaml` or `agor.db` (owned by daemon user, mode `0600`/`0640`).
  - CAN read/write any worktree whose group `agor_wt_*` it belongs to — in practice this is "every worktree" so a shared executor can serve any user's session.
  - Shares `~/.bash_history`, `~/.cache/zellij`, `/tmp` etc. with every other member's terminal — two members can see each other's shell history, env files, tty dumps, tmux sockets, etc.
- **Risk:** Isolated from the daemon, but **NOT isolated between members**. One member can observe/mutate another member's shell state.

### Mode C — `strict`

- **Config:** `worktree_rbac: true`, `unix_user_mode: strict`.
- **Impersonation:** Executor spawned via `sudo -u <user.unix_username>` — each Agor user has a dedicated Unix user (`agor_<shortId>` or custom). `resolveUnixUserForImpersonation` throws if `unix_username` is not set.
- **Who owns the PTY:** The Agor user's own dedicated Unix account.
- **Filesystem access the terminal inherits:**
  - Own `/home/<unix_username>/` — SSH keys, `.bashrc`, `.cache/zellij`, etc. isolated per user.
  - `~/agor/worktrees/<name>` symlinks exist only for worktrees where this user is an owner (see `context/guides/rbac-and-unix-isolation.md:289-317`).
  - OS-enforced: can only enter worktree directories whose `agor_wt_*` group the user belongs to. Read vs. read-write is governed by the worktree's `others_fs_access` (none/read/write).
- **Risk:** Equivalent to giving the user SSH as themselves. They can already do whatever Unix lets them do; terminal is just a convenience.

### Mode comparison

| Aspect | simple | insulated | strict |
|---|---|---|---|
| Runs as | daemon user | shared executor user | user's own Unix account |
| Sees daemon secrets / db | **yes** | no | no |
| Cross-user isolation | no | **partial** (shared `$HOME`) | yes |
| Filesystem enforcement | none | OS groups per worktree | OS groups per worktree + per-user home |
| Requires sudoers setup | no | yes | yes |
| Requires `unix_username` on user | no | no | **yes** |

---

## 3. Recommendation per Mode

### `strict` → ALLOW member terminal ✅

This is the safe case the user's intuition targeted. A member opening a terminal gets a shell as their own Unix account, which is a strict subset of what they already get via SSH on the host. The OS enforces worktree boundaries; there is no privilege escalation beyond what the user already has as that Unix user.

Additional safeguard needed: **check worktree-level RBAC on the `worktreeId` argument** (`view` or higher). Today `terminals.create` trusts the passed worktreeId without any permission check. Admin gets away with it because admins bypass most gates; members should not.

### `insulated` → ALLOW with reservations ⚠️

This is defensible because members are isolated from the daemon, but they share a home directory and `/tmp` with every other member. Practical risks:
- Shell history leakage between members.
- Env file `/tmp/agor-env-<shortId>.sh` is `0600` then chowned to the executor user — every member's secrets end up readable by every other member running as the same executor user. **This is the most concrete leakage vector.**
- Zellij sessions persisted in `~/.cache/zellij` could in principle be hijacked (same Unix user can attach).

Recommendation: **allow, but only if the deployment explicitly opts in.** Add a config flag like `execution.allow_member_terminal` (default `false`) and require it on top of `insulated`. Also fix the env-file leakage: in insulated mode, scope the tmp filename by user-uuid (already the case — `agor-env-${userId.substring(0,8)}.sh`) but make ownership `<executor-user>:<executor-user>` mode `0400` unreadable via directory listing (… already fine since path is random-ish but not unguessable — consider moving to `/tmp/agor/<userId>/` or using `mkstemp`).

### `simple` → DENY member terminal ❌

Opening a shell here gives the member full control of the daemon and its database. This is not salvageable by a worktree-RBAC check. Keep ADMIN-only (or even tighten to `superadmin` — admins in simple mode are implicitly trusted operators).

### Summary matrix

| Mode | Current | Proposed |
|---|---|---|
| `simple` | admin+ | admin+ (unchanged) |
| `insulated` | admin+ | member+ **iff** `allow_member_terminal: true` (opt-in), with worktree `view` check |
| `strict` | admin+ | **member+** by default, with worktree `view` check |

---

## 4. Interaction with Worktree RBAC (`others_can`)

Terminals today are worktree-scoped on the client (the UI always passes `worktreeId`) but worktree-permission-agnostic on the server. If we expose terminals to members we should align:

- **`others_can: none`** — member without explicit ownership has no access to the worktree at all. Opening a terminal "for" this worktree must be rejected. Creating a terminal at all if this is the user's only worktree should probably be rejected too.
- **`others_can: view`** — member can see sessions/files. Terminal access is **more** than view (they can execute code). Should this be gated behind `prompt`, or is terminal itself its own axis? My read: it belongs at `prompt` rank, because like prompt it causes code execution — but unlike prompt it executes under the *current user's* identity rather than the session creator's. Either `view` (cwd into it, read-only if FS denies writes) or `prompt` (execute) is defensible. **Flag for decision.**
- **`others_can: session`** (default) — member can create sessions running as themselves. Terminal-as-self is functionally similar; allow.
- **`others_can: prompt`** / **`all`** — allow.
- **Worktree owner** — always allow.

My recommendation: require **`session` or higher** on the target worktree to open a terminal. Rationale: terminal executes as the current user (never as someone else), so the threat model matches "create a session" — not "prompt someone else's session". Owners of course pass.

A separate consideration: the OS layer will refuse `cd` / writes if the user isn't in `agor_wt_*` anyway, so the app-layer check is defense-in-depth rather than the sole barrier in strict/insulated modes.

### Terminal is shared across worktrees inside Zellij

One subtlety: since the executor is one-per-user and Zellij runs for the whole session, a member who opens a terminal for worktree A can manually `cd` to worktree B inside Zellij (if OS permissions allow). The app-layer `worktreeId` check only controls the *initial tab*. That's consistent with how Zellij/SSH works and shouldn't block the change, but worth calling out.

---

## 5. Proposed Code Changes (not implemented)

All of these are file-path pointers + intent; no edits in this commit.

### 5.1 Role check: mode-aware gate

**File:** `apps/agor-daemon/src/register-hooks.ts:945-949`

Replace the static `requireMinimumRole(ROLES.ADMIN, 'access terminals')` with a hook that consults `execution.unix_user_mode` (and `execution.worktree_rbac`) at request time:

- `simple` → require `ADMIN`.
- `insulated` → require `ADMIN` unless `execution.allow_member_terminal === true`, then `MEMBER`.
- `strict` → require `MEMBER`.

Suggested new helper next to `requireMinimumRole` in `apps/agor-daemon/src/utils/authorization.ts`:

```ts
// sketch, not to be applied
export function requireTerminalAccess(config: Config) {
  return (context: HookContext) => {
    const mode = config.execution?.unix_user_mode ?? 'simple';
    const allowMember = config.execution?.allow_member_terminal === true;
    const minimum: UserRole =
      mode === 'strict' ? ROLES.MEMBER
      : mode === 'insulated' && allowMember ? ROLES.MEMBER
      : ROLES.ADMIN;
    ensureMinimumRole(context.params, minimum, 'access terminals');
    return context;
  };
}
```

Config would need to be loaded once and injected into the hook factory (or re-read per request, which is simpler given `loadConfig()` is already used inside the terminals service).

### 5.2 Worktree-level RBAC check inside `terminals.create`

**File:** `apps/agor-daemon/src/services/terminals.ts:170-196`

When `data.worktreeId` is provided, resolve the worktree, ownership, and `others_can`, then enforce `session` permission (or whatever level we settle on). Reuse `hasWorktreePermission` from `apps/agor-daemon/src/utils/worktree-authorization.ts:65-89`. Reject with `Forbidden` if the member lacks access to that worktree.

This is a no-op for admins/superadmins (ensured by `ensureMinimumRole` already) but a meaningful check for members.

### 5.3 New config flag

**File:** `packages/core/src/config/types.ts`

Add:

```ts
execution: {
  // ...existing fields...
  /**
   * Allow members (not just admins) to open web terminals.
   * Only honored when unix_user_mode is 'insulated' or 'strict'.
   * In 'strict' mode this defaults to true; in 'insulated' it defaults to false.
   */
  allow_member_terminal?: boolean;
}
```

Document it in `CLAUDE.md` next to the other `execution` flags, and mention it in `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`.

### 5.4 UI updates

**File:** `apps/agor-ui/src/components/TerminalModal/TerminalModal.tsx`

- Replace the hard-coded `isAdmin = hasMinimumRole(user?.role, ROLES.ADMIN)` gate with a capability flag the backend exposes. Cleanest option: extend `/config` (already admin-gated) or a new public-safe endpoint like `/capabilities` returning `{ terminalMinimumRole: 'admin' | 'member' }` derived from mode + config.
- Hide the "Open Terminal" button (`WorktreeCard.tsx:847-857`, `SessionPanel.tsx:1007-1020`) when the user doesn't meet the minimum role, instead of always rendering + denying in the modal.
- Update the denial text to reflect the actual reason (mode-dependent) rather than a blanket "requires admin".

### 5.5 Env-file hardening (insulated mode leakage)

**File:** `apps/agor-daemon/src/services/terminals.ts:71-122` (`writeEnvFile`)

Only an issue in `insulated` mode where the executor user is shared:
- Write to `path.join(os.tmpdir(), 'agor', userId.substring(0,8), 'env.sh')` with the directory created `mode: 0o700` chowned to the executor user, making it harder for other members to list/read.
- Or better: skip the env file and stream exports into the PTY directly (avoids a file-on-disk lifetime concern). This is a bigger change.

---

## 6. Migration / Breaking Changes

- **No DB migrations needed.** Role and `others_can` columns already exist.
- **No breaking API changes** for existing admins — they keep their access.
- **New behavior is opt-in** in insulated mode (`allow_member_terminal` flag). Defaults preserve current behavior there.
- **Default behavior changes in `strict` mode** — members gain terminal access where they didn't have it before. If this is undesirable for existing strict-mode deployments, flip the default to `false` and require explicit opt-in everywhere. User's call.
- UI changes are additive (visibility of a button) and shouldn't regress admins.

---

## 7. Open Questions / Decisions Needed

1. **Minimum worktree permission for terminal:** `view`, `session`, or `prompt`? I recommend `session` but `prompt` is defensible if you treat terminal as execution-on-other-people's-worktrees.
2. **`strict` mode default:** grant members terminal by default, or require `allow_member_terminal: true` there too (uniform opt-in)?
3. **Naming of the config flag:** `allow_member_terminal`, `member_terminal: allow|deny`, or fold into a broader `terminal: { minimum_role: 'member' }`?
4. **Superadmin path:** superadmins currently bypass RBAC (`isSuperAdmin` in `worktree-authorization.ts:35-38`). Should they also bypass the mode-based terminal check? Today ADMIN-only already lets superadmin in; no change needed unless we want to restrict superadmin from terminals in certain modes.
5. **Insulated-mode env file leakage** — fix it as part of this change or track separately? It's a pre-existing issue, but opening the door to members makes it more exploitable.
6. **"Open Terminal" button visibility** — hide entirely for users who can't use it, or show-and-disable with tooltip explaining why? Hiding is cleaner; disabled-with-tooltip is more discoverable.
7. **Viewer role:** explicitly never gets terminal, even in strict mode? I'd say yes — `viewer` should stay read-only.
8. **Audit / logging:** terminal creation is not currently recorded in any audit log beyond the daemon console. Do we want a DB row per terminal session for compliance (especially relevant in strict mode)?

---

## 8. Files Touched by a Future Implementation (summary)

Read-only references for the implementer:

- `apps/agor-daemon/src/register-hooks.ts:945-949` — swap the static admin gate.
- `apps/agor-daemon/src/utils/authorization.ts` — add `requireTerminalAccess` helper.
- `apps/agor-daemon/src/services/terminals.ts:170-196, 71-122` — worktree RBAC check in `create`, harden env file.
- `packages/core/src/config/types.ts` — new optional config field.
- `packages/core/src/unix/user-manager.ts:316-402` — unchanged but the source of truth for mode behavior.
- `apps/agor-ui/src/components/TerminalModal/TerminalModal.tsx:94-100, 344-353` — replace role check with capability from backend.
- `apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx:847-857`, `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx:1007-1020` — conditional button visibility.
- `CLAUDE.md` + `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx` — doc updates.

---

**TL;DR:** `strict` mode makes member terminal access roughly equivalent to SSH — recommend allowing by default, gated by a worktree-level `session`-or-higher check. `insulated` is borderline because of shared `$HOME` / tmp between members — recommend opt-in via a new config flag, plus an env-file hardening pass. `simple` mode must stay admin-only; a shell there owns the daemon and its database.
