# UI / Daemon / Executor Segmentation — Enforcement & Next Steps

**Status:** 🔬 Exploration / design. Follow-up to [`daemon-fs-decoupling.md`](./daemon-fs-decoupling.md) (PR #1209).
**Created:** 2026-05-18

**Companion docs:**
- [`daemon-fs-decoupling.md`](./daemon-fs-decoupling.md) — the topology analysis this builds on (Options A/B/C/D, Phase 1A H1–H4 shipped in PR #1209)
- [`executor-expansion.md`](./executor-expansion.md) — the original "daemon never touches AGOR_DATA_HOME" position paper
- [`executor-isolation.md`](./executor-isolation.md) — process-level isolation tiers

---

## TL;DR

PR #1209 cleaned up the **config** boundary (executor stops reading `config.yaml`; daemon is the sole authority). The next layer of the same problem is the broader **package-level** segmentation: today nothing prevents the executor from importing the DB client, the daemon from `fs.readFile`'ing a worktree, or the UI from reaching past `@agor-live/client`. The boundaries are de-facto, not enforced.

**The architecture is sounder than a casual reading suggests.** The executor already talks to the daemon via Feathers (`AgorClient`) and has no real DB calls — its `@agor/core/db` imports are utility functions (`shortId`, `generateId`, `isForeignKeyConstraintError`) mis-located under `/db`. The "executor depends only on `@agor/client`" aspiration is reachable; it just needs (a) a couple of relocations, (b) a `@agor/types` extraction, and (c) a lint/contract fence.

**Recommendation:** ship enforcement in three tiers, ordered cheapest→most-rigorous: (1) Biome `noRestrictedImports` boundaries config at warning level (this PR / next PR — ~30 lines), (2) extend the existing source-grep contract tests from `packages/executor/src/contract.test.ts`, (3) eventually drop `@agor/core` from `packages/executor/package.json` as the mechanical fence after the relocations land. The WebSocket / HA wall is real but framed precisely below — punt the solution behind a single experiment.

**The next-step PR list in §6 is the deliverable.** Six concrete PRs, each one-sitting-reviewable, sequenced so subsequent worktrees can pick up #1 and roll forward.

---

## 1. Where we are after PR #1209

### 1.1 What PR #1209 actually shipped (the foundation)

PR #1209 landed **four hygiene items** plus the topology analysis doc:

| # | Item | Boundary it enforces |
|---|------|---------------------|
| **H1** | `ResolvedConfigSlice` payload + executor-local `getDaemonUrl()` | **Executor no longer reads `config.yaml`.** Schema lives in `@agor/core/config`; executor consumes via payload, never via FS. |
| **H2** | Stat-validated cache for `loadConfig*` | Daemon-only optimization. Cache returns clones (no shared-state poisoning). |
| **H3** | Capability-driven secret resolution (`AGOR_JWT_SECRET`, `AGOR_MASTER_SECRET`, `AGOR_ADMIN_PASSWORD`) | **Daemon degrades silently on read-only mounts.** No mode flag. |
| **H4** | Shutdown sentinel logs once, degrades silently | Same — read-only deployments work. |

Plus — and this is the seed for this whole doc — PR #1209 added **`packages/executor/src/contract.test.ts`** (93 lines) that **source-scans for forbidden imports** in the executor. Right now it pins three things:

- No `getDaemonUrl` import from `@agor/core`
- No `loadConfig` / `loadConfigSync` / `loadConfigFromFile` import from `@agor/core`
- The executor-local `getDaemonUrl()` reads only `DAEMON_URL` (no escape hatch)

**That's the enforcement primitive Max asked for, scoped to one boundary.** The rest of this doc is "what other boundaries deserve the same treatment, and which tool to use for each."

### 1.2 The gap that remains

Building on [`daemon-fs-decoupling.md`](./daemon-fs-decoupling.md) §1.1 (the 25-row FS touchpoint table), the position-of-record is:

- **Self-hosted = Option A** (single-host, daemon-FS-coupled OK)
- **Hosted = Option C** (daemon stateless, executor owns FS, env-pod model)
- **Two deployments, one codebase = Option D**

That picture is **about topology** (where processes run, what they mount). This doc is about **drift prevention** (what stops the codebase from growing tendrils across boundaries that would make Option C impossible).

A topology refactor without an enforcement layer is a six-month diet that gets eaten back as the team ships features. A small enforcement layer shipped early — even at warning level — gives every future PR a chance to course-correct.

---

## 2. Current segmentation reality

### 2.1 The intent

| Layer | Should depend on | Should NOT touch |
|-------|------------------|------------------|
| `apps/agor-ui` | `@agor-live/client` (npm-published). Static-shippable. | DB, FS (`~/.agor/*`), executor internals |
| `apps/agor-daemon` | `@agor/core` (full), DB, FS for config + sentinel | Worktree FS (`~/.agor/repos`, `~/.agor/worktrees`) — that's executor territory |
| `packages/executor` | `@agor-live/client` (or `@agor/core/client`) for daemon RPC; types + git + unix utils | DB driver, `@agor/core/db/client`, `~/.agor/config.yaml`, `~/.agor/agor.db` |
| `packages/core` | Itself + driver SDKs | n/a — leaf |
| `packages/client` | `@agor/core/client` + Feathers transports | DB, FS, executor |

### 2.2 The reality — measured

`@agor/core` is barrel-exported (`packages/core/src/index.ts` does `export * from './db/index.js'`, etc.), so `import { ... } from '@agor/core'` can pull anything. Subpaths (`@agor/core/types`, `@agor/core/db`, etc.) exist as a soft hint. Per-package import counts to `@agor/core` subpaths (production source only, today):

**Executor** (`packages/executor/src/**`, non-test):

| Subpath | Count | Verdict |
|---|---|---|
| `@agor/core/types` | 47 | ✅ Pure types. Safe forever. |
| `@agor/core/db` | 17 | ⚠️ All are `shortId` / `generateId` / `isForeignKeyConstraintError` — utility functions mis-located under `/db`. Relocate. |
| `@agor/core/sdk` | 12 | ✅ SDK type wrappers (Claude / Codex / Gemini shapes). Safe. |
| `@agor/core` (barrel) | 8 | ⚠️ Should be subpathed for clarity. Mostly `generateId`, `shortId`, `validateDirectory`. |
| `@agor/core/templates` | 4 | ✅ `renderAgorSystemPrompt` — needed for system prompt rendering. |
| `@agor/core/models` | 4 | ✅ Model registry (display names, capabilities). Safe. |
| `@agor/core/tools` | 3 | ✅ MCP JWT auth helpers. |
| `@agor/core/config` | 3 | ✅ Post-H1: `ResolvedConfigSlice`, `resolveApiKey`, `parseAgorYml`. **No `loadConfig`.** |
| `@agor/core/api` | 3 | ✅ `createClient`, `AgorClient` — this is HOW executor talks to daemon. |
| `@agor/core/utils` | 2 | ✅ Pure functions. |
| `@agor/core/git` | 2 | ✅ `getGitState` — executor does git ops. |
| `@agor/core/unix` | 1 | ✅ Impersonation helpers. Executor owns impersonation. |
| `@agor/core/mcp` | 1 | ✅ Types. |
| `@agor/core/client` | 1 | ✅ Browser-safe client surface. **Ideal target.** |

**No imports of `@agor/core/db/client`, `@agor/core/db/repositories/*`, or `@agor/core/feathers` from executor production code.** The executor is functionally already DB-free; the formal proof is what's missing.

**Daemon** (`apps/agor-daemon/src/**`, non-test, top 5):

| Subpath | Count | Verdict |
|---|---|---|
| `@agor/core/types` | 103 | ✅ |
| `@agor/core/db` | 69 | ✅ **Daemon owns the DB.** |
| `@agor/core/config` | 43 | ✅ **Daemon owns config.** |
| `@agor/core/feathers` | 40 | ✅ **Daemon owns the Feathers server.** |
| `@agor/core/utils` | 14 | ✅ |

**UI** (`apps/agor-ui/src/**`):

| Subpath | Count | Verdict |
|---|---|---|
| `@agor/core/client` | 1 | ✅ |

Total: **1 import.** The UI is functionally clean. (Note: UI primarily imports from `@agor-live/client`, which itself re-exports `@agor/core/client`. This is the right shape.)

### 2.3 Daemon → worktree FS touches (still TODO from §1.1)

The `daemon-fs-decoupling.md` §1.1 inventory enumerated 25 daemon FS touchpoints. PR #1209 closed config-related ones (rows 1–4 partially). The **remaining 20+ touchpoints** in `apps/agor-daemon/src/` are concentrated in: `services/artifacts.ts`, `services/repos.ts`, `services/worktrees.ts`, `services/terminals.ts`, `services/files.ts`, `utils/upload.ts`, `utils/realign-repo-origin.ts`. These are Phase 1B in the existing roadmap — not this worktree's job to ship, but **the enforcement layer should be in place before the sweep starts**, so each Phase 1B PR can prove its narrow win without re-introducing drift elsewhere.

---

## 3. Enforcement options

Five mechanisms, ranked cheapest → most-rigorous. Don't pick one — they layer.

### 3.1 (A) Biome `noRestrictedImports` — boundaries as lint rules

Biome 2.4 (we're on `2.4.4`) supports `noRestrictedImports` in stable, configurable via `overrides` per-directory. The pattern:

```jsonc
{
  "overrides": [
    {
      "includes": ["packages/executor/src/**/*.ts"],
      "linter": {
        "rules": {
          "correctness": {
            "noRestrictedImports": {
              "level": "warn", // start at warn; tighten to "error" later
              "options": {
                "paths": {
                  "@agor/core/db/client": "Executor must not access the database directly. Use AgorClient (Feathers) to call daemon services.",
                  "@agor/core/db/repositories": "Executor must not access repository layer. Use AgorClient.",
                  "@agor/core/feathers": "Executor is a Feathers client, not server. Use @agor/core/api (or @agor-live/client).",
                  "@agor/core/config/config-manager": "Executor must not load config.yaml. Use ResolvedConfigSlice from the payload."
                }
              }
            }
          }
        }
      }
    },
    {
      "includes": ["apps/agor-daemon/src/services/**/*.ts"],
      "linter": {
        "rules": {
          "correctness": {
            "noRestrictedImports": {
              "level": "warn",
              "options": {
                "paths": {
                  // Daemon shouldn't directly fs-touch worktrees.
                  // Tightening this requires extracting a thin allowlist
                  // for legacy callers — see PR #B in §6.
                }
              }
            }
          }
        }
      }
    }
  ]
}
```

**Wins:** Zero new tooling. Surfaces violations in CI today. Each developer sees boundaries violations as they type (Biome runs in editors). Warn-level means today's incidental drift doesn't block merges — but every new violation gets a yellow squiggle.

**Loses:** Biome `noRestrictedImports` matches on **import specifier** strings, not on **graph reachability**. If `@agor/core` (barrel) re-exports `db/client`, the lint won't catch `import { foo } from '@agor/core'` even when `foo` actually came from `db/client`. Subpath-discipline matters. (Mitigated by also restricting barrel `@agor/core` imports from the executor — but this is a bigger sweep.)

**Effort:** 30–50 lines of biome.json. ~half a day to land the warn-level config, half a day to triage initial warnings.

### 3.2 (B) Source-grep contract tests — already established

`packages/executor/src/contract.test.ts` already source-scans for `getDaemonUrl` and `loadConfig*` from `@agor/core`. **Extend the same test** to cover the additional forbidden imports listed in §3.1. Source-grep tests catch the namespace-import escape hatch (`import * as core from '@agor/core'; core.loadConfig(...)`) that Biome may miss.

**Wins:** Same teststest harness, same CI signal. The pattern is proven in the codebase.

**Loses:** Tests are easy to bypass with `// biome-ignore` or by adding the offender to the allow-set. But: the test is in `git`, so a bypass shows up in code review.

**Effort:** ~20 lines on the existing test file.

### 3.3 (C) Drop `@agor/core` from `packages/executor/package.json` (the mechanical fence)

The headline aspiration. Once executor's only legitimate `@agor/core` usage is types + a few utility functions, we can replace `"@agor/core": "workspace:*"` with `"@agor-live/client": "workspace:*"` plus a new `"@agor/types": "workspace:*"` and have the build break the moment anyone reaches deeper.

**Wins:** Mechanically impossible to regress. The strongest fence.

**Loses:** Requires extracting `@agor/types` (today the types live in `packages/core/src/types/`). And `getGitState`, `parseAgorYml`, `shortId`, `generateId`, `assertChpasswdInputSafe`, the unix helpers, the SDK type wrappers — all need a non-`@agor/core` home. Either each gets its own package (heavy), or they move into a single `@agor/shared` package (cleaner, still work), or they go directly into `packages/executor/src/` (drift risk if daemon also uses them).

**Effort:** 2–3 PRs of relocation + 1 PR to drop the dep. The relocation cost is the gating item.

### 3.4 (D) `dependency-cruiser` (alternative to Biome boundaries)

Specialized monorepo tool, declarative graph constraints, generates SVGs of the dep graph, opinionated CI failures.

**Why skip:** Biome already runs in CI, in editors, and Max's team knows it. Adding `dependency-cruiser` is a second tool with second config to maintain. Biome's coverage is good enough for the boundaries we care about. If we hit a case Biome can't express, revisit.

### 3.5 (E) TypeScript project references with strict `paths` boundaries

The most-rigorous answer at the build-system layer. Each package becomes its own `tsconfig` project; cross-project imports must be declared in `references`. Tools like `tsc --build` will refuse to compile invalid graphs.

**Wins:** Build-time enforcement, IDE-friendly (Go-to-definition still works), no runtime cost.

**Loses:** **Multi-week migration.** Every package needs `tsconfig.references` + `composite: true` + `declaration: true` setup. Turbo build orchestration may need rework. Risky to do before the easier fences (3.1, 3.2, 3.3) prove out where the real boundaries should sit. Premature.

**Recommendation:** punt to v2. Revisit after (A)+(B)+(C) have been in for 2-3 months and we know the boundaries are right.

---

## 4. The WebSocket / HA wall

**Daemon HA is blocked today.** Framing it precisely:

### 4.1 What's actually socket-stateful in `apps/agor-daemon/src/setup/socketio.ts`

| State | Where | What | Cross-pod implications |
|-------|-------|------|------------------------|
| **Cursor presence** | `socket.broadcast.emit('cursor-moved', ...)` (line ~407) | Each cursor-move broadcasts to all sockets on **this server**. | Two users on different pods see no cursor of the other. UX degradation. |
| **Terminal channels** | `user/<userId>/terminal` joins | Browser ↔ executor terminal stream lives over one socket connection. | If browser is on pod A and executor connects to pod B, no terminal. |
| **Feathers events (in-process EventEmitter)** | `register-services.ts:189,287` (explicit comments: "fires locally on the server's EventEmitter and never reaches any socket boundary") | Service-to-service hooks fan out via in-process EventEmitter. | Service hooks (e.g. session created → fan out a side effect) fire only on the pod that handled the request. |
| **Service tokens / executor sockets** | Authenticated executor socket connection (terminal streaming, etc.) | Long-lived authenticated socket per executor process. | Routing executor↔daemon socket to a specific pod requires either pinning or a routing layer. |

### 4.2 Smallest-possible path to statelessness

Three sub-problems, three independent answers:

**(a) Cross-pod socket.io fan-out.** Solved problem: drop in [`@socket.io/redis-adapter`](https://socket.io/docs/v4/redis-adapter/). Each daemon pod connects to the same Redis; broadcasts fan out via Redis pub/sub. ~5 lines of code in `socketio.ts`, plus a Redis dependency in hosted deployments. **Cost: 1–2 eng-days.**

**(b) Feathers cross-pod events.** Harder, because Feathers' in-process EventEmitter is integral to service-to-service hooks. Options:
  - **Sticky sessions** (LB routes each user to one pod) — eliminates the problem for client-facing events but doesn't solve service-to-service. Quick but partial.
  - **Move side-effects to DB-level triggers** (write to `events` table, all pods subscribe). Heavyweight redesign of how hooks publish.
  - **Audit which Feathers events actually need cross-pod fan-out** and which are pod-local by design. The two `register-services.ts` comments imply some events are already in-process by intent — not all need fan-out.

**(c) Executor socket routing.** Either pin executor→daemon socket connections (sticky / IP-based routing) or replace the long-lived socket with a stateless RPC (HTTP/2 streams or gRPC). Latter is cleaner but rewires the executor↔daemon channel.

### 4.3 The smallest experiment that would prove a path

**Spike: deploy two daemon pods behind a sticky-session ELB on a staging cluster, with `@socket.io/redis-adapter` configured, and measure:**
1. Do cursor moves from user A on pod A reach user B on pod B?
2. Does a session created on pod A trigger the right hooks on pod B's connected clients?
3. Does an executor connected to pod A continue working if pod A restarts (does sticky session's failover transfer it to pod B, and does the executor reconnect cleanly)?

**Time-box:** 3 eng-days. **Outcome:** a precise list of what breaks under sticky+Redis, which is the actual roadmap for HA.

**Don't propose a full HA design before running this.** Most of the hand-wringing is "we don't know" — pay 3 days to know.

---

## 4.5. The executor command templating that already exists

Worth surfacing because it materially changes how PRs E, H, and the Phase 3 work get framed: **the executor command templating is already built and shipped**, just dormant by default.

- **Config field:** `execution.executor_command_template` (`packages/core/src/config/types.ts:340-387`). Optional string. When unset → local subprocess spawn. When set → daemon runs `sh -c <substituted_template>` and pipes the JSON payload to stdin.
- **Template variables substituted at spawn time:** `{task_id}`, `{command}`, `{unix_user}`, `{unix_user_uid}`, `{unix_user_gid}`, `{session_id}`, `{worktree_id}`. Both kubectl and docker example templates are baked into the type docstring.
- **Implementation:** `apps/agor-daemon/src/utils/spawn-executor.ts:387-455` (`spawnExecutorWithTemplate`). Uses `stdio: ['pipe', 'pipe', 'pipe']` in template mode (vs `['pipe', 'inherit', 'inherit']` local) so the daemon can capture stdout/stderr that kubectl pipes back.
- **Backend extensibility:** any `sh`-invocable command works. SLURM, Nomad, AWS Batch, Lambda-style async backends all fit as long as they accept stdin and pipe stdout/stderr. The constraint is the I/O contract, not the orchestrator.
- **What's NOT there yet:** the daemon doesn't *parse* executor stdout — it logs it. Today's 10 executor commands are fire-and-forget (write to DB via Feathers, exit). **PR H introduces the synchronous-RPC-over-stdout pattern** that subsequent `worktree.*.query` commands can reuse. The template path picks it up for free since it already captures stdout.

This is the seam Phase 3 of [`daemon-fs-decoupling.md`](./daemon-fs-decoupling.md) was going to lean on; reassuring to confirm it's not vapor — it's the "abstraction is there, implementation is partial" line in §1.4 of that doc.

---

## 5. Executor sandboxing — chroot-style, per-worktree

Max's aspiration: each executor process sees exactly one worktree's filesystem, nothing else.

### 5.1 What we have today

- **Impersonation** (`unix_user_mode: strict`): each executor runs as the session-creator's Unix user. `setfacl` ACLs gate worktree access by group membership. See [`address-issue-1140-impersonation-abstraction`](#) (closed 2026-05-09 — the executor-as-impersonation-boundary work landed).
- **Process-level isolation** docs in [`executor-isolation.md`](./executor-isolation.md).
- **Docker option** (per [`containerized-execution.mdx`](../../apps/agor-docs/pages/guide/containerized-execution.mdx)): executor in a container with the worktree mounted.

### 5.2 What chroot-style adds (and what it costs)

**Mount namespaces (`unshare --mount`):** spawn the executor with its own mount namespace; bind-mount only the one worktree path; everything else (other worktrees, `~/.agor/config.yaml`, `~/.agor/agor.db`) is invisible.

**Wins:** Defense in depth on top of ACLs. Even if impersonation fails or an executor escalates within its uid, it can't even *name* another worktree's path. Kernel-level guarantee.

**Loses:**
- Requires `CAP_SYS_ADMIN` to call `unshare`, OR running setuid `unshare`, OR using `user` namespace nesting (Linux 3.8+, well-supported). User-namespace nesting is the right answer for non-root daemons.
- Doesn't apply on macOS (self-hosted devs lose this).
- More complex than just `setfacl` — operators must understand mount namespaces.
- Tooling: `node-pty` and SDK child-process spawning interactions with `unshare` need testing.

**Verdict:** **v2 or v3.** Document the aspiration; do not block on it. The current uid + ACL model is already substantial; mount namespacing is one more belt on top of existing suspenders. Ship the Option C topology first; revisit sandboxing once executor pods are running in production and we know the actual threat model.

### 5.3 Where this intersects with hosted Option C

In **hosted Option C**, the executor (or env-pod) gets a Kubernetes pod with **a single PVC for the worktree**. The pod's filesystem already only contains that worktree (plus the OS + executor binary). **Per-pod isolation in Kubernetes gives most of what mount namespacing gives**, with less custom tooling. So:

- **Self-hosted single-host:** mount namespaces are the right tool *if* you're already paranoid. v2.
- **Hosted Option C:** pod-per-worktree gives effectively chroot-style isolation for free. Already in the plan.

**Don't pay for mount namespaces if hosted Option C ships first; the threat model converges.**

---

## 6. Concrete next-step PRs

The deliverable. Each PR is sized for one worktree, reviewable in one sitting (≤500 lines net change). Listed in recommended sequence.

---

### PR A — `lint: Biome boundaries warnings for executor → @agor/core`

- **Scope:** `biome.json` — add an `overrides` block restricting `@agor/core/db/client`, `@agor/core/db/repositories`, `@agor/core/feathers`, `@agor/core/config/config-manager` imports from `packages/executor/src/**`. Warn level, not error. Optionally extend the existing executor `contract.test.ts` to mirror the same list as source-grep tests (catches namespace-import bypass).
- **Files:** `biome.json` (+~40 lines), `packages/executor/src/contract.test.ts` (+~20 lines)
- **Effort:** ~half a day
- **Risk:** Low — warn-level, no failed builds
- **Depends on:** Nothing
- **Hard rules:** Must use `warn` level. Must include a `message:` field explaining the alternative for each restricted path.
- **Success criteria:** `pnpm lint` emits zero new errors; warnings (if any) point at real candidates for PR B/C. Contract test passes.

### PR B — `refactor: relocate shortId / generateId / FK-error helper out of @agor/core/db`

- **Scope:** Move `shortId`, `generateId`, `isForeignKeyConstraintError`, and any other non-DB utilities currently exported from `@agor/core/db/index.ts` to `@agor/core/utils/ids.ts` (or `@agor/core/lib/`). Update import sites in `packages/executor/` and `apps/agor-daemon/` and `apps/agor-ui/` (if any). Keep a re-export shim in `@agor/core/db` for one PR cycle to avoid churn; delete the shim in a follow-up.
- **Files:** `packages/core/src/db/index.ts`, new `packages/core/src/utils/ids.ts` (or equivalent), 17+ executor sites, 69+ daemon sites
- **Effort:** ~1 day (mostly mechanical find/replace; the `check:shortid` script in package.json already guards `shortId` usage so the boundary is well-understood)
- **Risk:** Medium — touches a high-frequency import. Codemod-friendly. CI will catch any miss.
- **Depends on:** Nothing (parallel to A)
- **Hard rules:** Don't change function behavior. Don't widen the `shortId` API surface; the existing `check:shortid` script must still pass. Keep the `@agor/core/db` re-export for one cycle.
- **Success criteria:** Executor's `@agor/core/db` import count drops from 17 to 0. Daemon's drops by the same amount (these helpers belonged outside `/db` anyway). All tests pass.

### PR C — `lint: tighten executor boundaries warn → error`

- **Scope:** Flip the `noRestrictedImports` level in `biome.json` (added in PR A) from `warn` to `error`, after PR B drops the last legitimate `@agor/core/db` imports from the executor. Source-grep contract test in `contract.test.ts` extended to assert the executor has zero `@agor/core/db/client`, `@agor/core/db/repositories`, `@agor/core/feathers` imports.
- **Files:** `biome.json`, `packages/executor/src/contract.test.ts`
- **Effort:** ~2 hours
- **Risk:** Low — should be a no-op if PR B was thorough.
- **Depends on:** PR B
- **Hard rules:** Don't add new restricted paths beyond what PR A introduced — keep the diff small.
- **Success criteria:** CI fails if anyone adds a forbidden import. Contract test passes.

### PR D — `docs + design: WebSocket HA spike plan`

- **Scope:** A short doc (`context/explorations/websocket-ha-spike.md`) that codifies the §4 framing here, plus a concrete 3-day spike plan: deploy 2 daemon pods behind sticky-session LB + `@socket.io/redis-adapter` in staging, run the three measurement points (cursor fan-out, hook fan-out, executor reconnect), report findings. No code shipped here — just the spike plan and what the team will measure.
- **Files:** `context/explorations/websocket-ha-spike.md` (new, ~150–200 lines)
- **Effort:** ~half a day
- **Risk:** None (doc only)
- **Depends on:** Nothing
- **Hard rules:** The doc must commit to a measurement, not a design. "Run experiment X, expect outcome Y, do Z next" — not "the architecture should be …".
- **Success criteria:** Doc lands. The actual spike is a separate PR after the team has a staging cluster.

### PR E — `refactor: artifact landing → executor` (first of Phase 1B sweep)

- **Scope:** Move `services/artifacts.ts:717-812` (the recursive mkdir + writeFile FS landing path) into a new executor handler `artifact.land`. Daemon shrinks to "issue payload to executor + record result." Adds a new payload type in `packages/executor/src/payload-types.ts`. This is the smallest unit of "daemon → executor FS handoff" and was called out in §1.2 of `daemon-fs-decoupling.md` as the cleanest first move.
- **Files:** `apps/agor-daemon/src/services/artifacts.ts`, `packages/executor/src/handlers/artifact.ts` (new), `packages/executor/src/payload-types.ts`
- **Effort:** ~1 eng-week
- **Risk:** Medium — sidecar metadata semantics must be preserved exactly. Strong tests required.
- **Depends on:** Nothing (parallel to A–D)
- **Hard rules:** Don't change the artifact data model. Don't change the API surface. Pure refactor — should be invisible to users.
- **Success criteria:** Daemon no longer calls `fs.mkdir` / `fs.writeFile` from `services/artifacts.ts`. Artifact landing tests pass unchanged. Hosted Option C work no longer blocked on this row.

### PR F — `refactor: extract @agor/types package (preparation for dropping @agor/core from executor)`

- **Scope:** Move `packages/core/src/types/` into a new `packages/types/` (`@agor/types`). Update `packages/core` to re-export from `@agor/types` (for backwards compat during the transition). Update executor + daemon + UI to import from `@agor/types` directly where they currently use `@agor/core/types` — this can be incremental.
- **Files:** `packages/types/` (new package), `packages/core/src/types/index.ts` (becomes a re-export), and many import sites across all consumers
- **Effort:** ~2 eng-days (the move is mechanical; the cleanup is meaningful but not invasive)
- **Risk:** Medium — touches every package. Build tooling (turbo, tsup) needs the new package wired in.
- **Depends on:** PR B (so the relocations land before the extraction; otherwise extraction has to take ID helpers along for the ride)
- **Hard rules:** Pure relocation. No behavior change. Don't change a single type signature.
- **Success criteria:** `packages/types/` is its own publishable package. The executor's `@agor/core/types` imports rewrite cleanly to `@agor/types`. `pnpm check` green.

### (Later) PR G — `chore: drop @agor/core from packages/executor/package.json`

- **Scope:** Replace `"@agor/core": "workspace:*"` with `"@agor-live/client": "workspace:*"` + `"@agor/types": "workspace:*"`. May require relocating `parseAgorYml`, `assertChpasswdInputSafe`, `getGitState`, `renderAgorSystemPrompt`, `resolveMCPAuthHeaders`, and a handful of model registries either into the executor itself or into a shared `@agor/shared` (or wherever they belong).
- **Files:** `packages/executor/package.json`, plus the relocations above
- **Effort:** ~1 eng-week (the relocations are the work; the package.json change is one line)
- **Risk:** Medium-high — touches the entire executor's import surface. The reward is the mechanical fence.
- **Depends on:** PRs A, B, C, F (and likely a precursor PR or two for each remaining non-types `@agor/core` subpath the executor uses)
- **Hard rules:** Don't introduce a circular dependency. Don't duplicate code — relocate, don't copy.
- **Success criteria:** Executor's `package.json` has no `@agor/core` dependency. `pnpm build` succeeds. Source-grep contract test extended to forbid all `@agor/core/*` imports from the executor.

---

### PR H — `refactor: move git ls-files autocomplete to executor (always)`

- **Scope:** Replace the daemon-side `git ls-files` call in `apps/agor-daemon/src/services/files.ts:73-84` with an executor RPC. Adds a new executor command `worktree.files.list` (payload: `{ worktreeId, pattern?, limit? }`; result: `{ files: string[] }`). Daemon spawns executor, writes payload to stdin, **awaits a single JSON result line on stdout**, parses it, returns to caller. No caching — executor spawn cost (~200–500ms local, 5–15s k8s cold-start) is the wall. Autocomplete latency is acceptable at that level for a low-hit-rate feature; warm executor pools (Phase 3) eventually solve k8s.
- **New pattern introduced — flag explicitly:** Today's 10 executor commands are fire-and-forget (write to DB via Feathers, exit). This is the **first synchronous-RPC-over-stdout** executor command. Establishes the contract: a `worktree.*.query` family that returns its result as the final stdout line in a stable JSON shape, daemon awaits exit code and parses. ~30 lines added to `spawn-executor.ts`, but worth its own design call-out in the PR description since future "daemon needs to peek at worktree FS" needs will reuse it (`worktree.files.read`, `worktree.git.status`, etc.).
- **Side effect:** One of the 5 daemon-side `@agor/core/git` (simple-git) call sites goes away. Doesn't drop simple-git anywhere yet — but it's the start of `@agor/core/git` becoming executor-only.
- **Files:** `apps/agor-daemon/src/services/files.ts`, `apps/agor-daemon/src/utils/spawn-executor.ts` (add a `spawnExecutorWithStdoutResult` variant — or generalize the template path to read a result line), `packages/executor/src/commands/worktree-files-list.ts` (new), `packages/executor/src/payload-types.ts` (new payload + result types)
- **Effort:** ~1 eng-week (the new RPC pattern is the meaningful work; the actual `git ls-files` invocation is one simple-git call)
- **Risk:** Medium — introduces a new executor I/O contract. Strong tests for both stdout parsing and the local + template spawn paths.
- **Depends on:** Nothing (parallel to A–G). Recommended to ship before PR F (`@agor/types` extraction), otherwise the new payload types get migrated twice.
- **Hard rules:** Stdout result line must be the **last** non-empty line, prefixed with a stable marker (e.g. `__AGOR_RESULT__:<json>`) so interspersed log lines don't confuse the parser. Must work identically under local subprocess spawn AND under `executor_command_template` (kubectl pipes stdout back the same way — see `spawn-executor.ts:387-455` for the existing template path). Don't cache. Don't introduce a Feathers callback path — keep it stdin → exec → stdout-result, no daemon-side polling.
- **Success criteria:** Daemon `services/files.ts` makes zero `simple-git` calls. File autocomplete works in both local and (with a configured `executor_command_template`) k8s modes. The stdout result protocol is documented in a one-page note that subsequent `worktree.*.query` PRs can cite.
- **Sets up:** Companion PRs for the remaining 4 daemon-side simple-git sites (`utils/realign-repo-origin.ts`, `services/users.ts`, `services/repos.ts`, `index.ts`), each using the same stdout-RPC pattern. After all 5: relocate pure helpers (`buildGitConfigParameters`, `isLikelyGitToken`, `ensureGitRemoteUrl`) out of `@agor/core/git` to a neutral subpath, and `@agor/core/git` becomes executor-only — lint-enforceable.

### PR I — `infra: split-home Docker compose (runtime enforcement of daemon ⊥ worktree FS)`

- **Scope:** A new `docker/docker-compose.split.yml` (and matching CI job) that runs daemon and executor as **two different Unix users** with **two different home directory mounts**, using the existing `paths.data_home` config (`packages/core/src/config/config-manager.ts:847-945` — already supports this) plus the existing `execution.executor_unix_user` knob. Daemon runs as `agor`, owns `~/.agor/` (config.yaml, agor.db, admin-credentials, sentinel). Executor runs as `agor_executor`, owns `/var/lib/agor-data/{repos,worktrees}/`. Filesystem permissions (0700 on the data home) prevent daemon from even `stat`'ing worktree paths. CI runs the existing test suite against this compose — **every today-daemon-touches-worktree-FS path surfaces as a real failing test**, not a lint warning.
- **Why this matters:** Lint catches new violations as code is added. Runtime enforcement catches today's drift. They're complementary — lint prevents future regressions; this compose proves today's state. It also gives operators a documented "strict mode" deployment shape (`unix_user_mode: insulated` + split data home) that's already half-built in config.
- **What you expect to see fail initially:** Per §1.1 of `daemon-fs-decoupling.md`, ~7 of the 13 daemon-FS-touching files touch worktree paths. Under split-home they'll EACCES: artifact landing, upload write, autocomplete (until PR H lands), worktree existsSync probes, realign-repo-origin, env-file write, env-process spawn. **Each failure is a forcing function for the corresponding Phase 1B PR.** Mark expected failures explicitly in the PR description — turning known-drift into known-test-failures is the win, not pretending it'll all pass.
- **Files:** `docker/docker-compose.split.yml` (new), `docker/Dockerfile.split` or extension of existing, CI workflow YAML, a short `apps/agor-docs/pages/guide/split-home-deployment.mdx` for operators
- **Effort:** ~1 eng-week (compose is small; meaningful work is triaging which test failures are "expected — see Phase 1B PR X" vs. "unexpected — needs investigation")
- **Risk:** Medium — surfaces lots of red CI initially. Mitigated by clearly labelling expected failures with their Phase 1B owner PR.
- **Depends on:** Nothing (parallel to A–H). High signal value if it lands EARLY; each subsequent Phase 1B PR can flip a known-failing test to passing.
- **Hard rules:** Use the existing `paths.data_home` and `executor_unix_user` config — do NOT introduce new config knobs. The mode is already half-built. Do not modify the daemon's behavior to "tolerate EACCES gracefully" — let it fail. The failures are the deliverable.
- **Success criteria:** Compose runs. Known-drift files fail with EACCES (cataloged in PR description, tied to their cleanup PR). Non-drift files pass. CI exposes a "split-home" job that subsequent PRs can watch turn green incrementally.

---

### Recommended sequence

Two parallel streams:

**Stream 1 — Enforcement (cheap, immediate value):**
- PR A (lint warn) → PR B (relocate IDs) → PR C (lint error)

**Stream 2 — Topology debt (heavier, ongoing):**
- PR E (artifact via executor) → PR H (git ls-files via executor — introduces the sync-RPC-over-stdout pattern) → next Phase 1B PRs (upload via executor, realign-origin via executor, etc., reusing PR H's pattern) → eventually Phase 2 (`EnvironmentRuntime` interface)

**Stream 3 — HA framing (low-cost, high-information):**
- PR D (spike plan) → run the spike → write up findings → decide

**Stream 4 — The mechanical fence (long-term):**
- PR F (extract `@agor/types`) → PR G (drop `@agor/core` from executor)

**Stream 5 — Runtime enforcement (high-signal, parallel to all of the above):**
- PR I (split-home Docker compose) — surfaces today's drift as failing CI; each Phase 1B PR flips failures green

Stream 1 should ship first because (a) it's cheap, (b) it gates drift while Streams 2 and 4 are in flight, and (c) it surfaces real violations that Streams 2 and 4 will need to know about. **PR I should ship as early as possible alongside Stream 1** — it's the runtime counterpart to lint and provides the test signal for Stream 2's incremental wins.

---

## 7. What I'd want to know to be more confident

These would shift the plan above if surprising:

1. **How much of `@agor/core/sdk` is "types" vs. "code"?** The 12 executor imports from `@agor/core/sdk` need to be available somewhere when we extract `@agor/types`. If most are types, easy. If they include `claude-system-suppression` or other runtime code, the relocation has a bigger surface.
2. **Is there a build-time barrel-elimination strategy?** Today `import { x } from '@agor/core'` works because of `export * from './db/index.js'` in `packages/core/src/index.ts`. If we tightened the barrel (or added a Biome rule against bare `@agor/core` imports from the executor), would anything break? Worth a 1-hour spike.
3. **What's the actual Phase 2 (`EnvironmentRuntime`) timeline?** PR D-G are all "prepare ground for Phase 2/3." If Phase 2 is 6 months out, do A/B/C/F first and let the enforcement layer accumulate signal. If Phase 2 starts in 4 weeks, push harder on E and the rest of Phase 1B sweep.
4. **Did issue #1140 close out the executor-as-impersonation-boundary work cleanly?** Closed 2026-05-09. Worth a quick read of the merged PR(s) to confirm there are no remaining daemon-side impersonation paths that PR I would surface as failures and that we'd then mis-attribute to drift instead of "intentional but not migrated yet."

---

## 8. What this worktree shipped

This worktree intentionally ships **the design only**. Per the brief:

> No big code refactor in this worktree — the analysis + concrete next-PR definitions ARE the deliverable. Enforcement primitive only if it's a small win.

The Biome `noRestrictedImports` config (PR A) is small enough that the team may pick it up next, but landing the *config* without first auditing what it would warn on (Stream 1) felt premature — the right framing is "PR A is a 1-PR follow-up that any reviewer can pick up next."

---

_End of analysis._
