# Env var access and exposure

**Status:** 🧪 Exploration — problem framing, two-part cleanup + gating model, minimal v1 scope, parked future branches. **V0.5 shipped 2026-04-18** (`feat-env-var-scope` branch): schema + `global`/`session` scopes + session selections + RBAC + UI all landed; v1 (Part A executor-auth homes, additional scope values, full resolver graph) still pending.

Related concepts: [`permissions.md`](../concepts/permissions.md) · [`mcp-integration.md`](../concepts/mcp-integration.md) · [`auth.md`](../concepts/auth.md) · [`agent-integration.md`](../concepts/agent-integration.md) · [`worktrees.md`](../concepts/worktrees.md)

---

## The problem

Today Agor env vars are **ambient**. The daemon's (or impersonated user's) full env flows into every executor child process. From the agent's side, `env` / `printenv` / `cat /proc/self/environ` dumps all of it in a single tool call.

This is a real blast-radius concern:

- A prompt-injection attack (hostile README, issue, dependency, web fetch) can exfiltrate every secret the user has configured, regardless of what the agent was asked to do.
- A session that was spawned to "fix a typo in the docs" has the same env reach as one spawned to "push to prod" — even though the user's intent was narrower.
- Secrets mixed into `User Settings → Env Vars` today span wildly different sensitivity levels: `GIT_AUTHOR_EMAIL` sits next to `ANTHROPIC_API_KEY` sits next to `FIVETRAN_API_KEY`.

The secret-argv hardening in PR #1015 closed the external exfil surface (`ps`, `/proc/*/cmdline`) but did nothing to reduce what the agent itself can see.

This doc captures the design space for **reducing agent-side env exposure** without turning env configuration into a nightmare.

---

## The problem splits cleanly in two

### Part A — Executor auth doesn't belong in generic env vars

A chunk of what users currently set in `User Settings → Env Vars` is actually **executor authentication material masquerading as env**:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` → Claude Code
- `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_CODE` → Claude Code
- `CLAUDE_CODE_USE_BEDROCK`, `AWS_*`, `VERTEX_AI_*`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT` → Claude Code (Bedrock/Vertex backends) or Gemini
- `OPENAI_API_KEY` → Codex
- `GH_TOKEN` / `GITHUB_TOKEN` for Copilot SDK → Copilot

These should live in `User Settings → Agentic Tools → <executor> → Auth` as **typed fields**, not free-form env strings. Benefits:

- Injected into the child env *only when that executor fires*. A Codex session never sees `ANTHROPIC_API_KEY`. A Claude session never sees `OPENAI_API_KEY`. Real blast-radius reduction before any runtime gating.
- The UI can render each executor's auth options properly: radio between `API key | OAuth | Bedrock | Vertex` instead of users guessing which env vars to set.
- Multi-account becomes possible (two Anthropic accounts on two worktrees) without env-var collision.
- Cleans up the user's mental model — generic env vars stop being a catch-all for authentication plumbing.

Precedent: MCP OAuth tokens are already per-MCP-server and only injected when that MCP is in session scope. Apply the same shape to executor auth.

Migration is a one-shot sweep: "we detected these keys in your user env, they look like they belong in Agentic Tools — move them? (y/n)". Classify-and-suggest rather than auto-migrate.

### Part B — Remaining env vars need exposure controls

Once Part A evacuates the executor auth, what remains in `User Settings → Env Vars` is **user-integration env** — `GITHUB_TOKEN` for `gh`/`git`, `DATABASE_URL`, `STRIPE_API_KEY`, custom project keys. These are what the *project* needs, not what the *agent* needs to exist.

For these, the design question is: **who can see what, and where?**

---

## The authorization model: user authorizes, consumer declares

Early drafts of this design had consumers declaring what they need and the system auto-binding. That's backwards.

The right shape mirrors OAuth consent:

- **Consumers declare** what env vars they can use. Just metadata / discovery hints. An MCP server can declare "I know how to use `SHORTCUT_API_TOKEN`." An artifact feature can declare "I need `AGOR_API_KEY`."
- **Users authorize** which of their env vars are exposed to which consumers. This is the actual security boundary. Declaration alone grants nothing.

UI shape is user-centric:

```
Your env vars:
  SHORTCUT_API_TOKEN
    Exposed to: ☑ Shortcut MCP
  GITHUB_TOKEN
    Exposed to: ☑ any consumer in [datagor repo ▾]
  HUBSPOT_API_KEY
    Exposed to: ☑ any consumer in [assistants repo ▾]
```

Default for a new env var: exposed nowhere until user opts in. Explicit, reviewable, safe.

---

## Data model: flat scope + long-tail data blob

Early drafts proposed a polymorphic `env_var_authorizations` join table. That's overengineered for what's essentially a one-env-var-one-home relationship. Simpler model: **scope as an attribute on the env var row itself**, with a JSON blob alongside for future long-tail attributes.

Sketch:

```
env_vars
  id
  user_id
  name
  value_encrypted
  scope           text not null default 'global'
  resource_id     text nullable                -- uuid/name of the target (null when scope is global|session)
  extra_config    json nullable                -- long-tail attributes (access-method, TTL, per-call rules, audit flags, etc.)
  ...timestamps...

session_env_selections                          -- many-to-many, only for scope='session'
  session_id      (fk → sessions, cascade)
  env_var_id      (fk → env_vars, cascade)
  PRIMARY KEY (session_id, env_var_id)
```

Properties:

- **Flat and legible.** One row per env var. Pick scope from a dropdown, pick target from a picker.
- **`session_env_selections` is the only join table** — for `scope='session'` vars, which sessions opted in.
- **Duplicate-for-multiple-targets is the escape hatch.** If you genuinely need `GITHUB_TOKEN` exposed to two different MCPs, create two rows. Rare in practice; resolution order is most-specific first (executor > mcp_server > artifact_feature > repo > session > global), first-match-wins within the same scope.
- **Long-tail attributes live in `extra_config`.** Access method (ambient vs tool-only), TTL, per-consumer identity filters, audit toggles — all additive without schema migration. Scope and resource_id stay as first-class indexed columns so env resolution queries are fast.

Valid `scope` values:

| Scope | Meaning | `resource_id` | Example |
|---|---|---|---|
| `global` | Available to any session | null | `GIT_AUTHOR_EMAIL`, `GITHUB_TOKEN` for trusted users |
| `session` | Only sessions explicitly opted in via `session_env_selections` | null | `FIVETRAN_EVAN_API_KEY` for a one-off session |
| `repo` | Sessions in worktrees of this repo | repo uuid | `FIVETRAN_API_KEY` in `datagor` |
| `mcp_server` | Only when this MCP is in session scope | mcp server uuid | `SHORTCUT_API_TOKEN` ↔ Shortcut MCP |
| `artifact_feature` | Only when this Agor feature is active | feature name | `AGOR_API_KEY` for Artifacts |
| `executor` | Part A's home — executor-specific auth | executor name | `ANTHROPIC_API_KEY` for Claude Code |

Do **not** encode enum values in SQL `CHECK` constraints — see [`database-migrations.md`](../concepts/database-migrations.md). Validate in the Drizzle schema + Zod + service hooks. The DB stores text.

Explicitly **not** a scope: `worktree`. Worktrees are ephemeral; scoping to them creates re-granting churn. Repo is the stable boundary.

---

## Access method: ambient vs tool-mediated

Orthogonal to *where* a var is eligible is *how* it gets to the agent. Three options on the ladder:

1. **Ambient** — exported into the child env. `env` reveals it. Today's default. Adequate when the var is already scoped narrowly (via the authorization table) to a trusted consumer.
2. **Tool-only** — never in the child env. Agent uses a wrapper MCP tool (e.g., `agor.run_with_env(cmd, env: ["GITHUB_TOKEN"])`) which the daemon resolves server-side and injects only into the spawned subprocess. Stored tool-call args contain the var *name*, not its value. Audit log per access. Enables mid-session revocation.
3. **Tool-only + approval** — tool-only plus a user permission prompt at first use, with scope options (once / session / worktree / persistent grant). Reuses the existing permission system (same primitive as tool-call approval).

### Why v1 skips tool-only and approval

A walkthrough of actual user data (see §"Concrete mapping" below) shows 9/10 real env vars want plain ambient. The tool-only and approval tiers solve threats that aren't imminent (prod AWS keys, compliance attestation). Shipping them early means carrying UX weight for cases no one has today.

The **authorization table is the v1 security win** — narrowing *which consumers can see a var at all* delivers most of the blast-radius reduction. Ambient-within-a-narrow-scope is much better than ambient-everywhere, and it preserves the "agent just runs `gh`" ergonomics.

Tool-only and approval tiers are designed in so the future expansion is additive, not a rewrite.

### On the logging paradox (captured for future reference)

Tool-only tiers have a subtle design tension worth noting: if the agent fetches a secret via `env.get("KEY")` → value enters the model context → next tool call (e.g., `bash("curl -H 'Authorization: token <value>' ...")`) stores the literal value in the messages table anyway. Redacting *only* the `env.get` result is insufficient.

The cleanest fix is a wrapper-tool pattern that never returns the value to the agent at all:

```
agent: agor.run_with_env(cmd: "gh pr create ...", env: ["GITHUB_TOKEN"])
daemon: resolves, spawns subprocess with GITHUB_TOKEN in its env, returns stdout
stored: cmd + env name list — never the value
```

Agent-authored commands using `$GITHUB_TOKEN` as a shell reference stay clean in storage; shell interpolation happens at exec time in the daemon-spawned child.

This is deferred to future branches. V1 doesn't introduce the wrapper tool because v1 doesn't introduce tool-only tiers.

---

## Concrete mapping (real user inventory)

Applied to a real `User Settings → Env Vars` list:

| Var | Part A / Part B | Authorization(s) |
|---|---|---|
| `ANTHROPIC_API_KEY` | Part A | moves to Agentic Tools → Claude Code |
| `CLAUDE_CODE_OAUTH_TOKEN` | Part A | moves to Agentic Tools → Claude Code |
| `OPENAI_API_KEY` | Part A | moves to Agentic Tools → Codex |
| `GITHUB_TOKEN` | Part B | `global` |
| `GIT_AUTHOR_NAME` | Part B | `global` |
| `GIT_AUTHOR_EMAIL` | Part B | `global` |
| `AGOR_API_KEY` | Part B | `artifact_feature` (Artifacts) |
| `SHORTCUT_API_TOKEN` | Part B | `mcp_server` (Shortcut MCP) |
| `HUBSPOT_API_KEY` | Part B | `repo` (assistants) |
| `FIVETRAN_API_KEY` | Part B | `repo` (datagor) |

Session-scope isn't in the target state for this data (every var above has a more specific home), but it's in the scope enum and ships in **v0.5** (see below) as the UX proving ground before the richer scope values are wired.

The narrowing from `global-everywhere` to `specific-resource-only` is the meaningful security delta.

---

## Deployment-mode defaults

Following the existing taxonomy (dev / local / solo / team):

| Mode | Default for new env vars | Migration from today's ambient behavior |
|---|---|---|
| dev | `global` (opt-out via UI) | Preserves today's UX. |
| local | `global` | Same. Single-user workstation. |
| solo | prompt on first save | User picks at save-time: global vs narrower. |
| team | narrow-default | New vars denied until user authorizes a resource. Existing vars marked `global` with "confirm this is what you want" banner. |

Strict / compliance modes would additionally force tool-only or approval tiers for anything classified as secret. Not in v1 scope.

---

## V0.5 scope — first shippable step ✅ SHIPPED 2026-04-18

Smaller-than-v1 proving step that establishes the schema and UI pattern without yet wiring all scope values. Landed on branch `feat-env-var-scope`:

1. **Schema**: add `scope` (text, default `'global'`), `resource_id` (text, nullable), `extra_config` (json, nullable) columns to `env_vars`. Create `session_env_selections` join table.
2. **Validated scope values for v0.5**: only `'global'` and `'session'`. Other values are reserved in the enum (validated at the app layer) but not yet offered in the UI or resolved by the resolver.
3. **Env resolution logic**: daemon computes a session's effective env at spawn time from:
   - all global-scope env vars for the session's user, plus
   - session-scope env vars where a matching row exists in `session_env_selections` for this session.
4. **UI — `User Settings → Env Vars`**: add scope dropdown (Global | Session) per row.
5. **UI — session settings / spawn modal**: multi-select of the user's session-scoped env vars.
6. **RBAC**: `session_env_selections` editable only by `session.created_by`, admin, superadmin. Worktree `all` tier does **not** grant this — session env vars are the owner's secret material, not shared worktree state.
7. **Behavior**: selection changes take effect on next spawn, not live.
8. **Migration**: existing rows default to `'global'`; no user-visible disruption.
9. **Tests**: scope resolution, RBAC enforcement, migration.

## V1 scope — full Part A + Part B

Beyond v0.5:

1. **Part A — Agentic Tools credential homes** for Claude Code, Codex, Gemini, Copilot. Typed auth field per executor. Migration-detection prompt on existing env keys.
2. **Part B — remaining scope values** (`repo`, `mcp_server`, `artifact_feature`, `executor`) wired into the resolver, with `resource_id` pickers in the UI.
3. **Env resolution**: walks the full scope graph (user × worktree repo × in-scope MCPs × executor) at spawn time.
4. **Consumer declaration hints** for MCP servers and Agor features so the UI offers sensible pickers.
5. **UI**:
   - Per-var exposure row with scope + resource picker.
   - Agentic Tools panels for executor auth.
   - Spawn-time transparency display: "this session will have access to: [list]".

Explicitly **not in v1**:

- Tool-only wrapper (`agor.run_with_env`) and per-call audit log.
- Approval prompts at access time.
- WebAuthn / passkey / TOTP step-up for sensitive vars.
- TTL / lease on grants (`extra_config.expires_at` present but unused).
- Per-call scoping ("only `gh` can use `GITHUB_TOKEN`").
- Worktree-level grants (ephemeral-object problem).
- Wildcards within a type ("any repo").
- Remote-trigger-specific grant objects.
- Revocation UI beyond "delete a grant row".

---

## Future branches

Each of these can be added without reshaping v1.

### Tool-mediated access (`agor.run_with_env`)

New MCP tool that accepts `(cmd, env_name_list)` and returns stdout. Daemon resolves env names to values server-side, spawns the subprocess with just those vars in its env, returns output. Values never enter agent context or persisted message state. Enables per-call audit logging and mid-session revocation. Adds an `access_method: ambient | tool_only` column to the authorization table (or a parallel config table keyed on env var).

### Approval prompts

Pairs with tool-mediated access. First `agor.run_with_env` call for a `tool_only + approve` var pauses the session, emits a permission-request event, UI shows modal with scope options, user approves, execution resumes. Reuses the existing permission system — no new infra.

Remote-triggered sessions (Slack, GitHub webhook, cron) can't participate in interactive approval. Options for that:

- Fail closed on approve-tier vars ("requires interactive session") and let the agent retry when a user is present.
- Pre-approved grant tokens — user creates a grant object ahead of time ("Slack triggers may access `GITHUB_TOKEN` for 24h in repo X") with TTL and revocation.
- Async push-to-mobile approval.

### Cryptographic proof (WebAuthn)

For the `mfa` tier where audit/compliance demands proof of human involvement, not just a click. WebAuthn is better than TOTP: hardware-bound, non-phishable, one-tap UX, off-the-shelf libraries. Enrollment flow needs account-recovery design. Not attractive until a concrete compliance driver exists.

### Handle pattern / per-call scoping

Beyond tool-mediated access — agent never even sees the wrapper-tool's env names, just opaque handles. Or: wrapper tools gate which *commands* can resolve which env vars ("`GITHUB_TOKEN` only inside `gh` / `git` / `curl`"). Both reduce exposure further but cost real UX and complexity. Not worth it until a specific threat warrants them.

### TTL / leases

The `expires_at` column is there for v2. "Grant `AWS_PROD_KEY` to this worktree for 30 minutes." Background sweeper deletes expired grants. UI shows ticking expiration.

### First-class audit objects

Each access becomes a row in an `env_access_log` table, surfaced as a browsable timeline per worktree / per user / per var. Complements per-row grant state on `env_vars` with per-use events from the tool-only path.

### Worktree-as-scope

If a user case appears for "just this one worktree", add it as a `scope` value with `resource_id` pointing at a worktree. Schema supports it trivially. Deferred because worktree ephemerality creates UX churn and today's data doesn't demand it.

### Executor-declared required env

Formal registry: each executor publishes the env var names it *requires* to function vs. *accepts* optionally. Authorization UI auto-suggests. Prevents a Claude session from being spawned without a resolvable `ANTHROPIC_API_KEY` and producing a useless failure.

---

## Open questions

- **Agor-defined vs user-defined consumers.** MCP servers have stable IDs; users can add/remove them. Artifact features and executors are platform-defined strings. The `resource_id` column needs to gracefully handle both — probably foreign keys only for stable-table targets, with runtime existence check plus cleanup on target deletion for the rest.
- **Consumer-declaration schema.** Where does an MCP server publish "I use these env vars"? A field in the MCP server registration config? A manifest convention? Do we allow declarations for vars the user hasn't defined (so they can bootstrap the suggestion)?
- **Migration UX for existing deployments.** Today every user's env is effectively `global`. On upgrade, do we stamp `global` for every existing var, or force a one-time review? Defaults differ per deployment-mode.
- **Cross-user grants.** Today env vars are per-user. Can user A grant user B's session access to user A's `GITHUB_TOKEN` via session sharing? See [`session-sharing.md`](./session-sharing.md) — this is another face of identity borrowing and should be designed jointly.
- **UI density for users with many env vars.** Mature users accumulate 30+ env vars. The per-var exposure checklist scales badly. Grouping / bundles / search needed, but not v1-critical.

---

## Why this is right as the v1 move

- **Narrow the ambient default without breaking ergonomics.** The agent still does `gh`, `curl $GITHUB_TOKEN`, `terraform` naturally. Only the *set* of vars available to a given session shrinks.
- **Honest about the threat model.** V1 doesn't pretend to defend against a prompt-injection agent that chooses to exfiltrate what it legitimately has. It defends against *breadth of exposure* — the fact that a doc-edit session has AWS creds available just because they were set globally.
- **Forward-compatible.** The authorization table, the consumer-declaration pattern, and the user-authorize-consumer model all survive intact when tool-only, approval, and MFA tiers get added.
- **Small enough to ship.** Two weeks of work (Part A migration + schema + resolution logic + UI) rather than a multi-month identity rewrite.

The bigger design conversation about approval flows, handle patterns, and cryptographic attestation stays parked until a specific deployment needs it — at which point this doc should be revisited.
