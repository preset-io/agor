# Anonymous Mode Removal Analysis

**Date:** 2026-05-10
**Author:** Claude (Opus 4.7) for Max
**Status:** Phase 1 — analysis only. No code changes proposed in this PR.
**Decision asked:** Approve or reject removal. If approved, Phase 2 implementation follows in a separate PR series.

---

## TL;DR

Anonymous mode is a **~370–400 LOC complexity tax** carrying **31 conditional branches across ~22 files**, two confusingly-paired config flags (`daemon.allowAnonymous` / `daemon.requireAuth`), and a synthetic-user data model where the literal string `'anonymous'` is written into `created_by` columns even though **no `users` row with that ID ever exists**. It has caused at least **four bugs** in the last six months — three merged fixes (#1150 / #564 / #1037) and one currently-open issue (#1126) whose root cause overlaps the same "no-caller-identity" pattern.

The functional gap that anonymous mode fills today — *"user runs `agor init`, then opens the UI without typing credentials"* — can be replaced by **auto-creating a default admin during `agor init` and persisting a one-time login token to disk** so the UI authenticates silently on first open. Single-user installs stay frictionless; multi-user installs gain the consistency they should have always had.

**Recommendation: rip it out**, in 2–3 small PRs. The replacement keeps solo-install UX equal-or-better, simplifies every auth code path, eliminates an entire category of bugs, and removes a security footgun (`allowAnonymous: true` on a misconfigured public deployment) that today is only protected by a runtime startup check.

---

## 1. What anonymous mode is today

### 1.1 Config surface

Two flags in `packages/core/src/config/types.ts:104-108`, both under `daemon.*`:

| Flag | Default | What it gates |
|---|---|---|
| `daemon.allowAnonymous` | `true` (set in `config-manager.ts:131`) | Registers the `anonymous` Feathers auth strategy; collapses `getReadAuthHooks()` to `[]` so reads bypass auth |
| `daemon.requireAuth` | `false` (set in `config-manager.ts:132`) | Surfaced via `/health` to the client; UI uses it to decide whether to show LoginPage |

These flags are **redundant in practice but read in slightly different places** (`requireAuth` is mostly client-facing, `allowAnonymous` is daemon-side enforcement). Their independent existence is itself a footgun: setting only one of them produces inconsistent behavior.

The `agor init` command flips both atomically — `init.ts:447-448` and `init.ts:346-347` — so the only user-facing knob is "Enable authentication?". But config files on disk can drift, and `apps/agor-cli/src/commands/config/index.ts:94-128` exposes both as separately-settable.

No env-var override, no `soloMode` / `singleUser` / `devMode` flag exists. Public-deployment detection (`apps/agor-daemon/src/index.ts:213-217`) refuses to boot if `allowAnonymous && (non-loopback bind || public base URL || RAILWAY/RENDER env)`, which is a guard against the most obvious misconfiguration. **That guard exists only because anonymous mode exists.** Remove anonymous mode → remove the guard.

### 1.2 The synthetic anonymous user

`apps/agor-daemon/src/strategies/anonymous.ts:21-49` mints a fake user object on every anonymous request:

```ts
return {
  accessToken: '',
  authentication: { strategy: 'anonymous' },
  user: {
    user_id: 'anonymous',          // string literal, no DB row
    email: 'anonymous@localhost',
    role: ROLES.VIEWER,
  },
};
```

This synthetic value flows into the data layer:

- **4 schema columns** default to it: `created_by` on `sessions`, `tasks`, `boards`, `worktrees` (`packages/core/src/db/schema.sqlite.ts:52,216,381,508` and the postgres mirror at `:64,228,389,516`)
- **6 repositories** apply `?? 'anonymous'` fallback when callers omit `created_by`: `tasks`, `gateway-channels`, `boards`, `worktrees`, `sessions`, `board-comments` repositories
- **`apps/agor-daemon/src/utils/inject-created-by.ts:46`** defaults internal-call attribution to `'anonymous'` if the caller user is missing
- **`packages/core/src/seed/dev-fixtures.ts:33,89`** seeds dev data with `userId='anonymous'`

**There is no `users` row with `user_id = 'anonymous'`.** No migration creates it; no seed inserts it. The string is a sentinel. The `created_by` columns have **no foreign-key constraint** pointing at `users.user_id` — they can hold any string, including dangling references. This is convenient for the synthetic case but means:

- Rows attributed to `'anonymous'` are permanently orphaned
- Joins against `users` silently drop these rows
- The "list my sessions" query returns nothing for anonymous because no real user has that ID
- Other tables *do* have FK constraints to `users` (e.g. `worktreeOwners.user_id`, `userApiKeys.user_id`, `userMcpOauthTokens.user_id`), so the data model is inconsistently enforced

This is the root of bug #564 (scheduler trying to mint a session token for `user_id='anonymous'` and the executor's `users` lookup throwing `User not found: anonymous`).

### 1.3 Code-path branching (the complexity count)

Across the codebase, **31 distinct conditional branches** exist *only because anonymous mode exists*:

| Site | Count | Where |
|---|---|---|
| `getReadAuthHooks()` spread (`...allowAnonymous ? [] : [requireAuth]`) | 16 | `apps/agor-daemon/src/register-hooks.ts` (lines 344, 433, 442, 480, 566, 577, 591, 896, 1476, 1867, 1945, +5 more) |
| Conditional role gate (`allowAnonymous ? [] : [requireMinimumRole(MEMBER)]`) | 3 | `register-hooks.ts:345, 578, 592` (board-objects, repos, worktrees) |
| Auth strategy array branch | 1 | `apps/agor-daemon/src/index.ts:147` |
| Public-deployment security check | 1 | `index.ts:219-239` |
| Anonymous-strategy class | 1 | `apps/agor-daemon/src/strategies/anonymous.ts` (whole file) |
| Anonymous fallback in `inject-created-by` | 1 | `utils/inject-created-by.ts:46` |
| WebSocket "anonymous OK" branch | 1 | `apps/agor-daemon/src/setup/socketio.ts:288` |
| Health endpoint exposes flag to client | 2 | `register-routes.ts:3099-3100` |
| CLI base-command anonymous fallback auth | 1 | `apps/agor-cli/src/base-command.ts:84-116` |
| CLI `init` auth-prompt branching | 2 | `init.ts:342-373` (skip-prompts) and `:425-505` (interactive) |
| CLI `config` displays the flags | 2 | `commands/config/index.ts:94-128` |
| UI client connect branches | 3 | `useAgorClient.ts:110, 281, 427` |
| UI handshake/login gate | 1 | `App.tsx:326-376` |
| Repository `?? 'anonymous'` fallbacks | 6 | 6 repository files |
| Schema `default('anonymous')` | 4 | sessions/tasks/boards/worktrees in both sqlite + postgres |

Most of these are tiny — a ternary, a one-line fallback. But they compound. Every reviewer of an auth-touching PR has to ask "does this work in anonymous mode too?" The implicit invariant — *"if `allowAnonymous`, behave as if a viewer user is present; otherwise demand auth"* — is enforced by hand in 31 places. Misalignment between any two of them is a bug.

### 1.4 User identity assumptions

When a session is created in anonymous mode:
- It gets `created_by = 'anonymous'` (via repository fallback or schema default)
- Its scheduler / executor flow needs a session token, which needs a `sub` claim, which is the user_id — `'anonymous'` (caused #564)
- Permission checks (RBAC) skip entirely when `worktree_rbac` is off; when on, the synthetic viewer role grants read but not write — but writes are pre-gated by the `allowAnonymous ? [] : [...]` ternaries, so RBAC is mostly bypassed

Multiplayer features that are inert in anonymous mode:
- Presence / cursors (no real user → no avatar to show)
- User-targeted notifications
- Worktree owners (the table exists; nothing populates it)
- Per-user OAuth tokens, per-user API keys, per-user `unix_username`

The product *as designed* assumes real users. Anonymous mode is a degraded shadow of it.

### 1.5 Init / setup flow

`agor init` (`apps/agor-cli/src/commands/init.ts:425-505`) prompts:
> *"Enable authentication and multiplayer features?" (default: yes)*

If **yes**: prompts for email/username/password, sets both flags to auth-required, calls `createUser()` directly against the SQLite file. No daemon needs to be running.

If **no**: prints a "you can enable later" hint with `agor config set daemon.requireAuth true` + `agor user create-admin`. Leaves both flags unset (defaults take over → anonymous wins).

`--force` mode (`init.ts:345-372`) auto-enables auth and creates the default `admin@agor.live` / `admin` user. **Today, `agor init` already has a complete auth-required path that produces a working solo install.** What anonymous mode buys is "skip the email/password prompts during init."

There is **no daemon-side first-run bootstrap.** If the database has zero users and `requireAuth: true`, the daemon will start and the UI's LoginPage will accept no credentials. The user must run `agor user create-admin` (or `agor init`) out of band. This is an upgrade-path gap we'll have to close as part of removal.

### 1.6 Documentation surface

Anonymous mode is mentioned in:

- `apps/agor-docs/pages/api-reference/index.mdx:94` — "Anonymous Mode: For local development, anonymous authentication is enabled by default"
- `apps/agor-docs/pages/guide/typescript-client.mdx:80, 144` — code comment + auth-strategy table row
- `apps/agor-docs/pages/guide/architecture.mdx:177` — strategy list mentions `anonymous`
- `apps/agor-docs/pages/security.mdx:171-172` — "Anonymous mode (if enabled) is read-only viewer"
- `apps/agor-docs/pages/guide/getting-started.mdx`, `README.md` — Quick Start implicitly relies on no-auth-by-default

Estimated docs PR scope: **~5 files, ~30-50 line edits.**

### 1.7 Test surface

14 test files reference `anonymous` / `allowAnonymous` / `requireAuth`. Most are auth-integration tests that already assume auth-required and won't change:

- `apps/agor-daemon/src/auth-jwt-integration.test.ts` (46 tests) — unchanged
- `apps/agor-daemon/src/register-hooks.test.ts` (19 tests) — unchanged
- `apps/agor-daemon/src/setup/socketio.test.ts` — 1-2 anonymous-specific tests removed
- `apps/agor-daemon/src/utils/inject-created-by.test.ts:105` — 1 test for the `'anonymous'` fallback removed
- `packages/core/src/db/repositories/{sessions,tasks,boards,worktrees,board-comments,board-objects}.test.ts` — ~6 tests update default-value assertions
- `packages/core/src/permissions/permission-service.test.ts` — minor cleanup
- `packages/core/src/config/config-manager.test.ts` — 2 default-value tests removed

**Total impact: ~10 tests touched, ~30-40 LOC of test code changed.** No dedicated anonymous-mode test suite to delete. This is a small surface.

---

## 2. Bug evidence: anonymous mode is actively expensive

The strongest argument for removal is the recent bug history. Each of these was caused or aggravated by anonymous mode complexity:

### #1150 — Quick Start broken (merged a6db045e on 2026-05-09)
**The bug:** `pnpm dev` daemon refused to serve the UI because the security check that blocks `allowAnonymous && publicDeployment` ran in background-daemon mode but not foreground-daemon mode (or vice versa); separately, the `/ui` route didn't mount in solo mode. Two distinct misalignments of the "is this an anonymous-OK situation?" question.
**Anonymous mode's role:** The whole `if (allowAnonymous)` ladder needs every code path that could ever serve a request to make the same decision. The bug was a missed branch.
**Removal payoff:** the security check disappears entirely. The `/ui` mount becomes unconditional.

### #564 — Scheduler sessions stuck "User not found: anonymous" (merged fed3dcb0)
**The bug:** Scheduler-spawned sessions hung at status=running with zero messages. Executor logged `Error: User not found: anonymous`.
**Anonymous mode's role:** The scheduler invoked the prompt service without passing user context; `injectCreatedBy()` defaulted to `'anonymous'`; session-token minting used that as `sub`; executor's `users.get('anonymous')` returned null and crashed.
**Removal payoff:** if every internal caller MUST pass a real user, this whole bug class disappears at the type level.

### #1037 — Session-identity hardening (merged 2f70c51b)
**The bug:** External callers could set `created_by` to arbitrary user IDs.
**Anonymous mode's role:** `injectCreatedBy()` had to grow conditional logic — *external calls overwrite, internal calls respect explicit value, default to caller user_id, fall back to `'anonymous'`* — *only because* `'anonymous'` is a valid attribution value. Without anonymous mode, "no user → throw NotAuthenticated" is the only sensible default and the hook becomes 5 lines instead of 30.

### #1126 (open) — Private repo clone silently fails
**The bug:** `agor_repos_create_remote` returns `{status: "pending"}` for private GitHub repos but the clone never completes; daemon process has no `GITHUB_TOKEN`.
**Anonymous mode's relationship:** *Indirect.* The bug is "daemon doesn't pass per-user credentials to git", which is a different issue. But anonymous mode normalized "the daemon acts on behalf of nobody in particular" as a valid mode of operation — the design pressure to pass per-user credentials at call time has been weaker because the daemon was never required to know who the caller was. Removing anonymous mode makes "use the calling user's GitHub token" the obvious shape of every git operation.

### Churn evidence
Recent commits touching anonymous code (`git log --grep='anonymous'`):
- `fed3dcb0` (Nov 2025) — fix scheduler vs anonymous user
- `2ee23bfa` (Nov 2025) — CLI authentication for anonymous mode (conditional hooks)
- `2f70c51b` — Session-identity hardening (Chain D)
- `1f305978` — `created_by` overwrite hardening
- `b08db2c9` / `df2262f8` (May 2026) — Quick Start anonymous-mode + public-deployment-check fixes

**Five commits across six months specifically maintaining the anonymous-mode contract, with no offsetting feature work.** This is pure tech debt servicing.

---

## 3. Replacement design: always multi-user, N=1 by default

**Core principle:** *Single-user is multi-user with one user.* No special path.

### 3.1 Single-user solo install (the new default)

```bash
$ pnpm install -g agor
$ agor init
✔ Created database at ~/.agor/agor.db
✔ Created admin user (admin@agor.live)
  Generated password: ko4n-5xqj-b8wm-pa11   ← shown ONCE, also written to ~/.agor/admin-credentials with mode 0600
✔ Wrote ~/.agor/auth-token (browser auto-login token, mode 0600, single-use, 7-day expiry)

$ agor daemon start
$ agor open
  → opens browser at http://localhost:5173/?t=<auth-token>
  → UI consumes the token, exchanges it for a JWT, stores in localStorage, redirects to /
  → token file is deleted after first use
  → user lands in the app, no login screen
```

Two ways the credential reaches the user:
1. **Generated password** printed to stdout once + saved to `~/.agor/admin-credentials` (mode 0600). User can recover it any time with `agor user show-credentials`.
2. **One-time auth token** in `~/.agor/auth-token` consumed by the UI on first `agor open`. Deleted after use; regenerable via `agor user issue-login-link`.

Solo UX is equivalent to today (open browser, you're in) but with three improvements:
- Every action is attributed to a real user (no orphaned `created_by='anonymous'` rows)
- The "I want to add a second user" path is just `agor user create` — no config-file edits, no daemon restart
- The "I exposed this on a public network" footgun (`allowAnonymous: true` + non-loopback bind) is gone by construction

### 3.2 Multi-user install

Same as today's auth-required path. Existing behavior, just becomes the only path.

### 3.3 What we delete

- `daemon.allowAnonymous` config key (with one-release deprecation warning)
- `daemon.requireAuth` config key (collapses to "auth always required")
- `apps/agor-daemon/src/strategies/anonymous.ts` (entire file)
- The public-deployment security check in `index.ts:213-239`
- All 16 `getReadAuthHooks()` spreads → become unconditional `[requireAuth]`
- All 3 conditional role gates → unconditional `[requireMinimumRole(MEMBER)]`
- The `?? 'anonymous'` fallback in `inject-created-by.ts` → `throw NotAuthenticated`
- The 6 repository fallbacks → required `created_by` parameter
- The 4 schema `default('anonymous')` → drop the default
- The CLI base-command anonymous fallback path
- The UI client's anonymous-mode branches in `useAgorClient.ts` (3 sites)

### 3.4 What we add

- **First-run admin bootstrap on daemon start.** New module `apps/agor-daemon/src/setup/first-run-bootstrap.ts`: if `users` table has zero rows, create the default admin (with a generated password, not the hardcoded `admin/admin`), write credentials to `~/.agor/admin-credentials` (mode 0600), and write a one-time auth token to `~/.agor/auth-token`. Log to stderr that this happened. **This is the safety net for upgrades** — daemons that started anonymous and have data with `created_by='anonymous'` will get an admin user automatically; the operator finds credentials in `~/.agor`.
- **`agor open` consumes `~/.agor/auth-token`** when present, appends `?t=<token>` to the URL, deletes the file.
- **UI redeem-token flow.** New route `/auth/redeem?t=<token>` on the daemon: validates the token, mints a JWT, sets it in the response, redirects to `/`. Token is single-use, 7-day expiry, lives in a new `auth_tokens` table or as a row in an existing one.
- **`agor user issue-login-link`** CLI to regenerate a one-time token (covers password loss, lets sysadmins email a self-serve link).
- **Migration on first daemon start** (idempotent): for every row with `created_by = 'anonymous'`, attribute it to the bootstrapped admin user. Audit log entry.

### 3.5 What stays the same

- `agor init` interactive flow continues to work. The only change: the "Enable auth?" question is removed (it's always enabled).
- `agor user create-admin` continues to work for sysadmins who want to scripted-bootstrap.
- The default `admin@agor.live` / `admin` constant stays for `--force` mode but emits a "MUST change password" warning that's already enforced by `must_change_password`.
- All RBAC, Unix isolation, multiplayer features unchanged.

---

## 4. Migration plan for existing anonymous installs

Three populations:

1. **Fresh installers post-removal** — get the new flow. No migration needed.
2. **Anonymous-mode installs being upgraded** — daemon starts, sees zero users, runs first-run bootstrap, attributes all `created_by='anonymous'` rows to the new admin. Operator finds credentials in `~/.agor/admin-credentials`. **No data loss.** Print a clear notice on daemon startup: *"Migrated N rows from anonymous attribution. Admin credentials at ~/.agor/admin-credentials."*
3. **Auth-required installs** — already working; the only change is the deprecated config keys log a warning for one release and then are removed. They no-op in the meantime.

### Database migration

A single migration that:
- Adds `auth_tokens` table (for one-time login links)
- Drops the `default('anonymous')` from `created_by` columns (the column itself stays NOT NULL, defaults are removed at the schema level — runtime code now always provides a real value)

The `created_by='anonymous'` rows are NOT mass-migrated by the SQL migration — that's done by the daemon's first-run bootstrap so it can attribute them to the bootstrapped admin's UUID rather than any hard-coded value.

### Rollback story

A single revert-PR is sufficient if removal causes regressions in the first release. The migration is additive (new table, drop default); a rollback adds the defaults back. No data is destroyed.

---

## 5. Phased PR breakdown

### PR 1 — Infrastructure: first-run bootstrap + auth-token path
- Add `auth_tokens` table + repository + service
- Add `first-run-bootstrap.ts` to daemon startup
- Add `agor user issue-login-link` CLI
- Add UI `/auth/redeem` route handler
- Modify `agor open` to consume `~/.agor/auth-token`
- **Keep `allowAnonymous` flag working** so old installs still boot with the same behavior
- Tests for the new bootstrap path
- **Risk: low.** Adds capability, removes nothing.

### PR 2 — Flip default + deprecate flag
- Change `config-manager.ts:131-132` defaults to `allowAnonymous: false`, `requireAuth: true`
- On daemon start, if `allowAnonymous: true` is set in config, log a deprecation warning with removal date
- Update `agor init` to no longer ask the auth question (always enabled)
- Migration for existing `created_by='anonymous'` rows runs on first daemon boot post-upgrade
- Docs sweep (the 5 doc files identified above)
- **Risk: medium.** Behavior change for anyone who was relying on default-anonymous. Mitigated by the bootstrap-admin path and the deprecation warning.

### PR 3 — Removal
- Delete `apps/agor-daemon/src/strategies/anonymous.ts`
- Remove `allowAnonymous` and `requireAuth` from config types
- Replace 16 `getReadAuthHooks()` spreads with `[requireAuth]`
- Remove 3 conditional role gates (always require)
- Remove 6 repository `?? 'anonymous'` fallbacks
- Remove `'anonymous'` fallback in `inject-created-by`
- Drop schema `default('anonymous')` (migration)
- Remove UI client branches for anonymous
- Remove CLI base-command anonymous fallback
- Remove the public-deployment security check
- Update / remove the ~10 affected tests
- **Risk: low** *if* PR 2 has been in a release for one cycle.

**Possible alternative:** ship as a single PR if scope stays manageable. PR 1 is genuinely independent (additive). PR 2 + PR 3 could merge if we're confident no one's running production anonymous installs. **My recommendation: keep them separate.** The per-step risk is lower, the deprecation window catches surprises, and PR 3 ends up being a satisfying ~400-LOC delete.

---

## 6. Estimated complexity removed

| Metric | Estimate |
|---|---|
| Total LOC removed (production code) | **370–400** |
| Total LOC removed (tests) | **30–40** |
| Conditional branches eliminated | **31** |
| Files touched | **~22** |
| Config flags removed | **2** (`allowAnonymous`, `requireAuth`) |
| Whole files deleted | **1** (`strategies/anonymous.ts`) |
| Schema columns simplified (default removed) | **4** in sqlite + 4 in postgres |
| Repository fallbacks removed | **6** |
| Tests deleted | **~3** |
| Tests simplified | **~7** |

Per-file LOC estimates:
- `anonymous.ts` — 49 (whole file)
- `apps/agor-daemon/src/index.ts` — ~65 (auth strategy array, security check)
- `register-hooks.ts` — ~40 (helper definition + 16 spreads collapse + 3 ternaries)
- `apps/agor-cli/src/commands/init.ts` — ~120 (`promptAuthSetup` simplifies dramatically)
- `useAgorClient.ts` — ~25 (3 connection branches collapse)
- `App.tsx` — ~20 (requireAuth gate goes away)
- `base-command.ts` — ~32 (anonymous fallback auth path)
- Misc — ~20 (config types, defaults, repo fallbacks, schema defaults)
- Total: **~371 LOC** in the conservative estimate.

The numbers won't blow anyone's mind — anonymous mode isn't a 5,000-line subsystem. **The win is the cognitive simplification.** Every PR touching auth no longer has to ask "does this work in anonymous mode?" Every reviewer no longer has to verify the `if (allowAnonymous)` ladder is consistent. Every `created_by` field has a guaranteed-valid UUID. The mental model collapses.

---

## 7. Risks and verification needed

**Things that need verification before Phase 2 starts:**

1. **Are there real users running anonymous mode in production?** Worth a quick check of any Sentry / telemetry signal we have, plus a Discord / GitHub Discussions poll. If yes, the deprecation window in PR 2 should be longer. If no, we can compress.
2. **The `~/.agor/auth-token` UX** — is writing a file to disk and consuming it via URL the right pattern, or do we want a different bootstrap (e.g., printed magic link, env var, browser-side prompt)? **This is the single biggest UX decision in the proposal.** I picked file-on-disk because it makes `agor open` Just Work and matches the SSH-like ergonomic of "if you have shell access, you have admin."
3. **The migration of `created_by='anonymous'` rows** — attribute them to the bootstrapped admin? Or to a "system" sentinel user that we *do* create as a real row? The latter is more honest about provenance ("we don't know who made this") but adds a special-case user. I lean toward attributing to admin and noting in an audit log; happy to be overruled.
4. **Behavior when `users` table has zero rows but `requireAuth: true` (today's scenario for fresh-installs-without-`init`)** — today the daemon starts and the UI is unusable. Post-removal, the bootstrap fixes this. But during PR 2's deprecation window, the bootstrap should already be in place (PR 1) so this case is covered.
5. **CLI scripting** — anyone with shell scripts that hit the daemon anonymously will break. Audit our own examples / docs / CI for this; warn external users via the deprecation notice.
6. **Tests under postgres** — most of the analysis was sqlite-focused. Need to verify postgres schema migrations work the same way.

**Risks that I assess as low:**

- **Breaking change visibility** — the deprecation warning + clear migration messaging should make the upgrade obvious. No silent breakage.
- **Data loss** — none. The migration is read-and-attribute, not delete.
- **Security regression** — the change is *strictly safer*. We're removing the unauthenticated request surface entirely. No new attack surface added by the auth-token path (single-use, 7-day expiry, file mode 0600).

---

## 8. Coordination with in-flight work

- **`fix-quickstart-daemon-and-ui-404` branch** (#1150 source) — already merged into `main` as `b08db2c9` + `df2262f8` + `a6db045e`. The branch itself is a long-running divergent fork with hundreds of unrelated changes; we don't need to wait on it. The relevant fix is in main. **If anonymous mode goes away, the security check that #1150 had to fix simply disappears.** PR descriptions for this work should reference #1150 as motivation.
- **#1126 (private repo clone)** — independent issue, not blocked. Removal of anonymous mode doesn't fix #1126 directly but makes the obvious fix (per-user credential injection) easier to reason about because there's always a "calling user."
- **No other branches touching `anonymous.ts` or the auth strategy registration are open** as of this analysis. Path is clear.

---

## 9. Decision request

**Approve removal?** If yes, I'll proceed to Phase 2:
- Open PR 1 (additive bootstrap + auth-token infrastructure) within ~1-2 days
- PR 2 (flip default + deprecate) gated on PR 1 merge + one release cycle
- PR 3 (full removal) gated on PR 2 merge + one release cycle, OR merged with PR 2 if you'd rather not stretch it out

**Push back?** Two specific things you might want to push back on:
- The `~/.agor/auth-token` mechanism (alternatives: magic link printed to stdout that you paste, or always show LoginPage and let user paste credentials from `~/.agor/admin-credentials`).
- Single-PR vs three-PR pacing.

**Reject?** If anonymous mode is load-bearing in some way I missed, I want to hear it. The analysis above assumes the only role it plays is "skip the auth prompt during init for solo users" — if there's a deeper reason (CI use case, embedded use case, testing fixture pattern), that changes the calculus.

---

## Appendix A: Key files audited (for reviewer convenience)

- `apps/agor-daemon/src/strategies/anonymous.ts` (entire file)
- `apps/agor-daemon/src/index.ts:130-240` (auth config, security check)
- `apps/agor-daemon/src/register-hooks.ts` (16 spread sites + 3 conditional gates)
- `apps/agor-daemon/src/register-routes.ts:280, 1114, 1710, 3099-3100`
- `apps/agor-daemon/src/utils/inject-created-by.ts:32-46`
- `apps/agor-daemon/src/setup/socketio.ts:288`
- `apps/agor-cli/src/base-command.ts:84-116`
- `apps/agor-cli/src/commands/init.ts:340-505`
- `apps/agor-cli/src/commands/config/index.ts:94-128`
- `apps/agor-cli/src/commands/user/create-admin.ts` (whole file)
- `apps/agor-ui/src/hooks/useAgorClient.ts:41, 110, 281, 427`
- `apps/agor-ui/src/hooks/useAuthConfig.ts:14, 91`
- `apps/agor-ui/src/App.tsx:326-376`
- `packages/core/src/config/types.ts:104-108`
- `packages/core/src/config/config-manager.ts:131-132`
- `packages/core/src/db/schema.sqlite.ts:52, 216, 381, 508` (and postgres mirror)
- `packages/core/src/db/repositories/{tasks,gateway-channels,boards,worktrees,sessions,board-comments}.ts`
- `packages/core/src/db/user-utils.ts` (existing `createUser`, `createDefaultAdminUser`)
- `packages/core/src/seed/dev-fixtures.ts:33, 89`

## Appendix B: Source PRs and commits referenced

| Reference | What it is |
|---|---|
| #1150 / commits b08db2c9, df2262f8, a6db045e | Quick Start fix — forced solo-mode + /ui mount + tightened public-deployment check |
| #1153 | Backport / re-roll of #1150 |
| #564 / commit fed3dcb0 | Scheduler vs. anonymous user fix |
| #1037 / commit 2f70c51b | Session-identity hardening (Chain D, `created_by` trust) |
| commit 1f305978 | `created_by` overwrite hardening (related to #1037) |
| commit 2ee23bfa | CLI authentication for anonymous mode (added the conditional fallback path) |
| #1126 (open) | Private repo clone fails — daemon has no per-user GitHub token |
