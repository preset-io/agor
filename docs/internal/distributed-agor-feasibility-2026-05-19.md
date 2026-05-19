# Distributed / Federated Agor — Feasibility Analysis

**Date:** 2026-05-19
**Author:** Claude (Opus 4.7) for Max
**Status:** 🔬 Exploration / position paper. **No code from this worktree.**

**Companion docs:**
- [`context/explorations/daemon-fs-decoupling.md`](../../context/explorations/daemon-fs-decoupling.md) — PR #1209, the Options A/B/C/D topology analysis. **Foundational dependency.**
- [`context/explorations/segmentation-and-enforcement.md`](../../context/explorations/segmentation-and-enforcement.md) — in-flight `design-ui-daemon-executor-segmentation` worktree, drift-prevention layer. **Enforcement prerequisite.**
- [`context/explorations/executor-expansion.md`](../../context/explorations/executor-expansion.md) — the original "executor as unified isolation pivot" position paper (2025-12-17). The seam this analysis leans on.
- [`docs/internal/in-conversation-widgets-design-2026-05-19.md`](./in-conversation-widgets-design-2026-05-19.md) — sister design doc, same dated-deliverable shape.

---

## TL;DR

**Yes — there is a viable path to a distributed/federated Agor where worktrees can live on a user's machine while a hosted daemon orchestrates them. It is materially harder than the hosted-only Option C in PR #1209's analysis, but the architectural seams already exist.** The complexity wall is real and concentrated in two places: (i) **offline + reconnect conflict resolution** when local state diverges from remote, and (ii) **a long-lived authenticated WebSocket channel from outbound-only local agents back to the hosted daemon**, with token rotation and reconnect semantics. Everything else is mostly plumbing.

**Recommendation, in three commitments:**

1. **Variant C (Hybrid: remote daemon + local executor agent) is the long-term answer**, not Electron-local. The collaboration story is what makes Agor interesting; Variant B (Electron-local) doesn't deliver it.
2. **Variant B (Electron-packaged) is worth doing later, as a *delivery vehicle* for the local executor agent, not as a standalone product.** Bundle the local agent in an Electron tray app once Variant C v1 lands. Skipping straight to "Electron with a local-only daemon" reproduces the 2025-12-03 → 2025-12-15 prototype that was abandoned (commits `38a3e438` → `4306f99d`); same shape, same answer.
3. **The roadmap is staged: segmentation enforcement → executor-agent RPC protocol doc → local agent v0 (toy) → per-worktree home assignment → auth/authz → offline queue → bidirectional sync. Electron wrap is at the end.** No phase is wasted work if we stop after it.

**Estimated to v1 of "remote daemon, local execution":** ~14–18 eng-weeks of focused effort, sequenced behind the segmentation/Option-C work already in flight. **Not parallelizable with that work** — distributed Agor only makes sense once the daemon ⊥ worktree-FS boundary is enforced, otherwise local-executor mode regresses the same coupling that hosted mode is trying to eliminate.

**The complexity wall, named precisely:**
- It is **not** "how do we punch through NAT?" — outbound WebSocket from local-agent to hosted-daemon (the Cloudflared/Tailscale/Actions-runner pattern) closes that completely.
- It is **not** "how do we package an Electron app?" — thousands of apps do this; the cost is maintenance, not novelty.
- It **is** "what happens when the same worktree was edited offline on my laptop AND remotely on the hosted canvas, and how do we converge state without losing user work or quietly executing as the wrong identity?" That is the question the rest of this doc is organized around.

---

## 1. What "distributed Agor" actually means

The shape Max framed: a user installs a small local agent on their machine; their *worktrees* live there (their actual git checkouts, their code, their dev servers); but the *canvas* — the boards, the session genealogy, the shared state, the team's view of what's happening — lives on a hosted Agor instance. When a teammate looks at the board, they see your worktree card; when an agent runs against your worktree, the executor process runs on your hardware against your files.

This is different from:

- **Today's self-hosted Agor**, where everything (daemon, executor, UI, worktree) lives on one machine.
- **PR #1209's hosted Option C**, where everything (daemon, executor, worktree EBS) lives in the same Kubernetes cluster.

It is a **third deployment shape**, not just a refinement of either. The DB, the API, the board canvas all live remotely; the user's worktree filesystem and the executor that touches it both live locally. The remote daemon never sees the user's source code — it only sees session metadata, message streams (LLM I/O), and structured side effects (git SHAs, file paths in messages, artifact summaries).

**Why anyone would want this:**

1. **Source code never leaves the user's machine.** Big differentiator for enterprise / regulated industries. A team can use hosted-Agor for the collaboration surface without exfiltrating their codebase to Preset's infrastructure.
2. **Team canvas without team infrastructure.** Today's self-hosted = "someone runs a VM." Hosted-only = "everyone's code goes to the cloud." Distributed = "we share the canvas, you keep your code."
3. **BYO compute.** User's M3 Max is bigger than any executor pod Preset will provision. Their `pnpm dev` server has zero cold-start. Their `playwright` runs at native speed. They keep their existing dev environment.
4. **Offline-tolerant.** Take your laptop on a plane; sessions you spawn locally still work; sync when you reconnect.

**Why this is hard:** every one of those wins introduces a new coordination problem with the hosted side. Sections 3 and 4 catalog them precisely.

---

## 2. Prior art / what already exists in the codebase

Three things in tree make this analysis feasible at all. Without them, distributed Agor would be a from-scratch rewrite.

### 2.1 Executor command template (the wire-format seam)

`packages/core/src/config/types.ts:340-387` defines `execution.executor_command_template`. The daemon already supports spawning executors via a configurable shell command. Today it's used (or rather, *demonstrated*) for `kubectl run` and `docker run` patterns. Implementation: `apps/agor-daemon/src/utils/spawn-executor.ts:387-455` (`spawnExecutorWithTemplate`).

**What this means for distributed Agor:** the daemon already knows how to "shell out to some other thing that runs the executor for me." Replacing `kubectl run` with `agor-relay forward-to-user --user=alice --task={task_id}` is a config-knob change for the daemon. The daemon-side surface area to add a new spawn mode is small.

**What's missing:** the *relay* itself. There is no service today that proxies an executor invocation across a network boundary to a user's local agent. That's the v0 build.

### 2.2 Outbound-only websocket pattern (`AgorClient`)

The executor already connects out to the daemon via Feathers over WebSocket (`@agor/core/api` → `AgorClient`). The relationship is one-way: executor opens the socket, daemon authenticates the connection (session token), executor calls Feathers services. **This is exactly the pattern a local agent needs.** The local agent is just a long-lived executor process that registers and waits for work instead of receiving a single task at startup.

**What this means:** the protocol shape ("authenticated outbound WebSocket from executor-side process to daemon") is already proven in production, with reconnect, token expiry handling (#1209-adjacent `jwt-expired-on-reconnect`), and authentication wired through the same path that other clients use. The local-agent isn't introducing a new auth mechanism — it's reusing an existing one with a longer-lived identity (a personal API key instead of a short-lived session token).

### 2.3 Personal API keys (the auth substrate)

PR #913 (`feat: add user API keys for programmatic authentication`), PR #1077 (storage refactor), PR #1164 / PR #1220 (`fix(api-keys): allow revoking personal keys`), and `feat(mcp): allow sessionless access with personal API keys` together give us:

- Per-user API keys, encrypted at rest (AES-256-GCM), revocable
- Sessionless authentication for MCP / programmatic clients
- A users-service `/users/me/api-keys` surface

**What this means:** the local agent's enrollment ceremony is "user generates a personal API key in the UI → pastes it into `agor-local-agent init` → agent uses that key to authenticate its outbound WebSocket forever." This is the GitHub Actions self-hosted runner enrollment model, the Tailscale auth-key model. **Mature pattern, already-shipped substrate.**

Caveat from `feedback_destructive_actions.md` / `project_credential_scoping_gap.md` in memory: per-SDK credential scoping is still a gap. Distributed mode doesn't make this worse but also doesn't solve it.

### 2.4 The abandoned Electron prototype (2025-12-03 → 2025-12-15)

Four commits in tree (`38a3e438`, `098512c4`, `34d94926`, `4306f99d`) added `apps/agor-desktop` — a macOS Electron app bundling the daemon as a child process, with a tray icon, custom URL support, and smart daemon startup. **Never merged to main.**

The prototype validated:
- Electron can launch the daemon child process cleanly
- Tray UX shape works
- Per-user config for daemon URL (local-vs-remote) is workable

Why it was abandoned (inferred — not documented in commit messages, worth a direct Max retrospective): the experience of "Electron-local Agor" is functionally the same as `npm i -g agor-live && agor start`. The Electron wrapper saves a `brew install node` step but doesn't unlock collaboration, doesn't give offline-with-sync, doesn't help teams. **Electron-as-installer-vehicle solves a small problem; Electron-as-architecture solves nothing.**

**Lesson for this analysis:** don't repeat that experiment. Variant B (Electron-local) below is dismissed for the same reason. Variant C (Hybrid) is where the value is; Electron later becomes a *delivery* vehicle for the local agent component of Variant C.

---

## 3. Topology variants

Five variants. Each gets shape + pros/cons + verdict. Ranked at the end of this section.

### 3.1 Variant A — Local-only `agor-live` install (today)

**Shape.** User runs `npm i -g agor-live`. Daemon, UI, executor, worktrees all on one machine. No remote at all. This is the codebase today (modulo PR #1209's hosted-prep config hygiene).

**Pros.**
- Zero sync complexity. Works offline natively.
- One process model. Easy to reason about, easy to debug.
- Already exists.

**Cons.**
- No team collaboration on the canvas.
- No remote orchestration ("show me what my agent did while I was at lunch" requires the machine to be on).
- Cross-device access requires the user to set up a VPN / tunnel / ngrok themselves.

**Verdict:** ✅ **Status quo. Keep shipping. Foundation for everything below.**

### 3.2 Variant B — Electron-packaged local-only

**Shape.** Same as A, but distributed as a `.app` / `.exe`. Electron bundles the daemon + UI + executor; user double-clicks to launch. The 2025-12 prototype (`apps/agor-desktop`) was this shape.

**Pros.**
- No `npm install` step. Familiar desktop-app distribution model.
- Tray icon + autostart on login.
- Better first-run UX for non-developers (though Agor's audience is developers, so this matters less).

**Cons.**
- Electron bundle size (~150 MB minimum, before adding any executor SDK images).
- macOS notarization, Windows code signing, autoupdate plumbing (electron-updater is fine but is its own subsystem to maintain).
- **Dual distribution channel forever** — npm package + .app + .exe + (eventually) Linux AppImage. Each release multiplies QA matrix.
- **Does not unlock any of the collaboration value.** A user with Electron-local Agor is in exactly the same isolation tier as a user with `npm i -g agor-live`.
- The 2025-12 experiment validates: this is technically straightforward and strategically empty.

**Verdict:** ❌ **As a standalone product — no.** ✅ **As a delivery vehicle for the local-agent component of Variant C — yes, later.** See §6, Phase 7.

### 3.3 Variant C — Hybrid: remote daemon, local executor agent (the federated mode)

**Shape.** Hosted Agor (daemon, UI, DB) is the source of truth for board / session / worktree state. User installs a small **local agent** on their laptop (`agor-local-agent`, a `~5 MB` Node binary or single-file pkg). The local agent:

1. Authenticates outbound to hosted-daemon over WebSocket using a personal API key
2. Registers itself as a candidate executor host: "I am Alice's laptop; here are the worktrees I host; here is my health status."
3. Listens for `executor.spawn` directives from the daemon — when a task is assigned to a local worktree, the daemon emits the directive over the WebSocket, the local agent spawns the executor process locally, captures stdout/stderr, pipes events back over the WebSocket as if it were a local executor.
4. Owns the worktree filesystem entirely. Hosted-daemon never `stat`s a local worktree path.

Each worktree gets a `home` attribute: `local | remote`. Local worktrees route to the local agent; remote worktrees route to hosted executor pods (Option C from PR #1209). A worktree's home is fixed once chosen — no "this worktree exists in both places simultaneously."

The board canvas shows both kinds of worktrees as equal cards. A user pinning a `local` worktree onto a shared board lets the team see its session activity (message streams, task status) without giving the team filesystem access. **An RBAC / `dangerously_allow_session_sharing` policy can additionally constrain whether teammates can prompt the local worktree's sessions** (which would execute on the owner's laptop under the owner's Unix identity).

**Pros.**
- **The collaboration story works.** Team canvas, your code stays local.
- **BYO compute.** User's hardware runs the executor; no pod cold-start.
- **Offline tolerant.** Local agent queues events when disconnected; replays on reconnect. The append-only nature of session/task events makes most of this trivial.
- **Reuses existing patterns:** outbound WebSocket (executor-style), personal API keys (auth), executor command template (spawn-side seam), per-worktree config (`others_can`, `dangerously_allow_session_sharing`).
- **Composable with hosted Option C.** A hosted instance can have BOTH remote env-pod worktrees (PR #1209 Option C) AND local-agent worktrees on the same board. Same daemon, two executor backends.

**Cons.**
- **Complexity wall.** Three load-bearing problems: (i) bidirectional offline-sync conflict resolution, (ii) long-lived WebSocket auth/rotation/reconnect, (iii) trust model for daemon → local-executor commands. §4 frames each precisely.
- **Months of work.** v1 = 14–18 eng-weeks behind the in-flight segmentation work.
- **Local-agent auto-update.** Long-lived binary on users' machines; we now have an update channel to maintain.
- **Slack/gateway latency.** If hosted-daemon is in us-east and the user is in Bangalore, every executor turn round-trips twice across the Pacific. WebSocket masks the worst of this, but real-time message streaming has a latency floor.

**Verdict:** ✅ **The long-term answer.** Phased delivery required.

### 3.4 Variant D — P2P / fully federated

**Shape.** Each install is a peer; state syncs via CRDT or eventually-consistent gossip; no central server is mandatory; peer discovery via DHT or a small coordinator.

**Pros.**
- No central server required for state.
- Maximally resilient.

**Cons.**
- **CRDTs for the entire data model.** Sessions, messages, tasks, boards, zones, worktrees, permissions — every entity needs conflict-free semantics. Years of work, large state-management library footprint.
- **Peer discovery.** "Pure P2P" needs DHT (Kademlia) or signaling. Either way, you end up with a coordinator. So the "no central server" claim is misleading at v1.
- **Identity + auth without a central server.** Every peer needs to verify every other peer. Public-key infrastructure, trust-on-first-use, revocation lists — all hard.
- **Storage cost.** Every peer holds the whole graph (or a partition with replication).
- **No clear product win.** What does P2P-Agor enable that Variant C doesn't? "Works without Preset's hosted instance" is a research project, not a v1 differentiator.

**Verdict:** ❌ **Not a v1 path. Dismissed.** If we ever build it, it's a research direction, not a product roadmap.

### 3.5 Variant E — Local-primary with remote shadow

**Shape.** Local install is source of truth (Variant A). Periodically, the local agent pushes a *redacted* slice of state (board layout, worktree names, session summaries — no message content, no source code) to a remote read-only viewer ("public link" for sharing your canvas).

**Pros.**
- Users keep full ownership.
- "Public link" / "show & tell" UX is interesting (think loom.com for agent sessions).

**Cons.**
- **Niche.** The use cases are demo / portfolio / sharing-after-the-fact. Doesn't enable collaborative work.
- **Redaction is hard.** What counts as "safe to push"? File paths often contain proprietary info. Message excerpts leak strategy. A naive redaction filter is a leak waiting to happen.
- **The value-add over `agor session export` to a gist is unclear.** If the goal is "share my session," a static export does most of the job.

**Verdict:** ⚠️ **Park.** Worth revisiting as a feature on top of Variant A in 12+ months. Not on the critical path.

### 3.6 Ranking

| # | Variant | Status |
|---|---------|--------|
| **A** | Local-only `agor-live` (today) | ✅ **Foundation.** Keep shipping. |
| **C** | Hybrid: remote daemon, local executor agent | ✅ **Long-term answer.** Months of work, but path is clear. |
| **B** | Electron-packaged local-only | ⚠️ **As delivery vehicle for C's local agent — yes, later.** As a standalone product — no. |
| **E** | Local-primary with remote shadow | ⚠️ **Park.** Re-evaluate in 12+ months as a feature on top of A. |
| **D** | P2P / fully federated | ❌ **Dismissed.** Research direction, not v1. |

---

## 4. The complexity wall, framed precisely

For each non-trivial variant (B, C), the specific hard problems.

### 4.1 Variant B (Electron-local) — the wall is small

The 2025-12 prototype proved the technical shape works. Cost is concentrated in:

| Problem | Difficulty | Mitigation |
|---|---|---|
| Bundle size (~150 MB+) | Low | Accept it. Modern users have disk. |
| macOS notarization, Windows signing | Low | Standard process. Apple developer cert + signing certificate purchase. |
| Autoupdater | Low | `electron-updater` is the industry-standard answer. Hosted update channel (S3 + signed manifests) is a half-day setup. |
| Dual distribution (npm + .app + .exe + AppImage) | **Medium** | Real ongoing maintenance cost. Every dep bump touches the Electron bundle. CI matrix doubles. |
| OS permission prompts (filesystem, network) | Low | Documented in onboarding. |
| Maintainership cost | **Medium** | Someone owns the Electron pipeline forever. Volunteer effort doesn't scale. |

**The actual wall:** there isn't one technically. The wall is *strategic*: this delivers no collaboration value. Don't build it as a product; build it as a vehicle for Variant C's local agent.

### 4.2 Variant C (Hybrid) — three precise walls

#### 4.2.1 Network model (NOT the wall)

This is the easy part, despite being the obvious-looking complexity. **Outbound-only WebSocket from local agent to hosted daemon.** Local agent initiates the connection; hosted daemon never tries to reach the local agent at a publicly-routable address. No NAT punching, no DNS, no inbound port on the user's machine.

Industry precedent is overwhelming:

| Precedent | What it proves |
|---|---|
| **SSH reverse tunnel** (`ssh -R 8080:localhost:80 jump.host`) | The pattern is ~30 years old. Outbound TCP carries multiplexed bidirectional streams. |
| **Cloudflared** | Production-grade implementation: persistent outbound HTTPS from a local daemon to Cloudflare's edge, exposing local services via Cloudflare's public network. |
| **Tailscale** | WireGuard mesh over a coordination server. Local agents punch out, never accept inbound. |
| **ngrok** | Commercial product around the exact "expose local dev server via outbound tunnel" pattern. |
| **GitHub Actions self-hosted runners** | The reference architecture for our problem. Runner registers with GitHub via personal access token, holds an outbound long-poll, GitHub assigns jobs over the same channel. Auth model, lifecycle, reconnect — all directly cribbable. |
| **VS Code Dev Tunnels / Remote-SSH** | Microsoft's adoption of the same pattern for remote-dev IDE bridging. |
| **Replit Agent / Anthropic Computer Use cloud runners** | Recent precedent in our adjacent space. |

**Implementation cost:** building this *protocol* — not "make it secure for production," but "the bytes move" — is **2 eng-weeks for v0**. Reconnect + heartbeat is another week. Tokenrotation is another week. Below the wall.

#### 4.2.2 Authentication & trust model (a small wall)

The daemon needs to:
1. **Authenticate the local agent's identity** on every connection.
2. **Authorize each command it sends** to the local agent (e.g., "spawn an executor for task X in worktree Y").
3. **Ensure the local agent only accepts commands authorized for the worktree(s) it hosts.**

The substrate is mostly there:

- **Identity:** personal API key (PR #913, sessionless MCP via #1220). Local agent connects with `Authorization: Bearer <api_key>`. Daemon resolves to a user record.
- **Command authorization:** every directive sent over the WebSocket is scoped to a worktree the local agent has registered as hosting. Per-worktree `others_can` (existing) controls who can issue prompts. The same machinery that prevents User B from spawning a session on User A's hosted worktree must prevent User B from sending a `spawn` directive routed to User A's local agent.
- **Local-side authorization:** the local agent must NOT blindly execute anything the daemon hands it. The agent enforces "this directive's target worktree is in my registered set; the issuing user is permitted (per cached RBAC) to issue this kind of directive against it; the directive's payload is well-formed." Defense-in-depth — if the daemon is compromised, the local agent doesn't become a remote shell.

The wall:

| Problem | Where it bites |
|---|---|
| **Long-lived tokens are bigger blast radius than short-lived session tokens.** | A local agent's API key, if exfiltrated from a user's `~/.agor-agent/config.yaml`, lets an attacker register as that user and accept commands forever (or until revoked). Mitigation: tokens are scoped (can-execute-on-my-worktrees-only, not full-user-impersonation); revocation is immediate (`/users/me/api-keys/:id DELETE`); UI shows active agents per user with last-seen timestamps. |
| **Cross-user spawn attribution.** | If User B is allowed to prompt a session on User A's local worktree (because A set `others_can: prompt`), the resulting executor runs on **A's machine, under A's Unix identity, with A's credentials**. Same surprising-attribution risk as today's `dangerously_allow_session_sharing` flag (see `context/explorations/session-sharing.md`). The flag's semantics extend cleanly: OFF = local agent refuses cross-user directives; ON = local agent accepts them and emits `[SECURITY]` logs. **No new policy primitive needed; just consistency with the existing flag.** |
| **Daemon compromise = local agent compromise.** | If the hosted daemon is breached, the attacker can issue directives to every registered local agent. Mitigation: rate-limit directives per-agent; local agent shows "executing task X (from Y)" in tray UI so user notices anomalous activity; users can pause / revoke an agent without rebooting. |
| **Trust-on-first-use risk during enrollment.** | User pastes API key into CLI. If the CLI is a malicious clone of `agor-local-agent`, it just stole the key. Mitigation: standard secure-channel guidance (signed binaries, verified install path). Not novel. |

**Engineering cost:** ~3 eng-weeks for v1 (token plumbing, per-directive authz check on both sides, revocation propagation, tray-UI status). Doable.

#### 4.2.3 Offline + reconnect conflict resolution (THE WALL)

This is where most of the eng budget actually goes. Frame it precisely:

**The data model split into mergability classes:**

| Entity | Mergeability | Conflict story |
|---|---|---|
| **Messages, tasks, reports** (the conversation history) | ✅ **Append-only.** | Trivial. Local agent buffers events while offline; flushes on reconnect; daemon inserts by `created_at` + idempotency key. No conflict possible because no entity is mutated after creation. |
| **Session state (`status`, `current_task_id`, etc.)** | ⚠️ **Last-writer-wins or causal-LWW.** | Most updates are monotonic state-machine transitions (`idle` → `running` → `awaiting_input`). The local agent is the source of truth for "what state is this session actually in right now" because it owns the executor process. Conflict only arises if the daemon's view diverges due to lost connectivity. Resolution: on reconnect, local agent's view of its own sessions overrides daemon's stale view. |
| **Worktree metadata** (board placement, zone assignment, custom title) | ⚠️ **LWW.** | Cosmetic. If both sides edited while disconnected: last write wins. Worst case the user re-drags the card. Acceptable. |
| **Worktree permissions** (`others_can`, owners) | ❌ **Conflict-sensitive.** | If User A (local) sets `others_can: none` while offline, and User B (remote, on the hosted daemon) sets `others_can: prompt`, what wins? The conservative answer is "the stricter setting wins on conflict" — security defaults err safe. Document it; ship it; small UX surprise but defensible. |
| **Worktree FS** (the actual code) | ❌ **Not mergeable.** | This is the load-bearing decision. **Resolved by constraint, not by merge:** one worktree has exactly one home (local OR remote, not both). A "local" worktree's files only exist on the user's machine; the hosted daemon has no copy to merge with. A "remote" worktree's files only exist in a hosted env-pod's PVC. **No bidirectional FS sync. Ever.** This eliminates 90% of the offline-sync nightmare. |
| **Active executor processes** | ❌ **Not transferable.** | A session running on the local agent can't fail over to a hosted executor mid-stream (different uid namespace, different env, different installed tools). On reconnect after a long disconnection, the daemon shows "session was active offline; here's what happened" — the events replay into the timeline; the session continues on the local agent if still alive, or is marked `disconnected/orphaned` if the local agent died. |

**The real conflict scenarios that need explicit handling:**

1. **Local agent disconnected; user keeps using local Agor UI to prompt their session.** (Requires the local agent to also serve its own UI in offline mode, or the user has no UI at all when disconnected.) **Decision: v1 has no local UI; offline-prompt support waits for v2 + an Electron wrap.** A user who wants offline UI uses Variant A (local-only).
2. **Local agent disconnected; teammate on hosted UI tries to prompt the local-worktree session.** Daemon queues the prompt as a `pending_directive` row; flushes when the local agent reconnects. If the local-side session has been killed in the meantime, the directive errors out cleanly: "session no longer exists." **No data loss; the prompt is preserved in transcript as a `[delivery_failed]` system message.**
3. **Local agent disconnected; hosted daemon revokes the agent's API key.** On reconnect, agent gets an auth error, refuses to drain its event queue, surfaces to the user "your token was revoked; events for sessions X/Y are buffered locally; you can either re-enroll or export them." **No silent data loss.**
4. **Two local agents claim the same worktree.** (User installed agent on both laptop and desktop, both registered with overlapping worktree sets.) Daemon enforces: each worktree's `local_agent_id` is unique; the second registrant for an already-claimed worktree gets a "claim conflict — last writer wins, but the existing agent is notified and detaches." **Document; test; not actually that hard.**

**The non-trivial subsystems offline-sync requires:**

| Subsystem | Engineering cost |
|---|---|
| Append-only event buffer in local agent (SQLite local cache; replay-on-reconnect; idempotency keys) | 1 eng-week |
| Daemon-side `pending_directive` queue (per-worktree, replays-when-agent-online) | 1 eng-week |
| Conflict-resolution policy: state machine for "which side wins" per entity class (table above) | 0.5 eng-week design + 1 eng-week impl |
| `daemon_view_drift` reconciliation: on reconnect, agent + daemon exchange last-known-state, daemon applies agent's authoritative-for-its-sessions view, agent applies daemon's authoritative-for-board-state view | 2 eng-weeks |
| Failure-mode UX: "your local agent has been offline 6 days; X events buffered; Y conflicts to resolve" | 1 eng-week |
| End-to-end test harness: simulated network partitions, recovery scenarios | 2 eng-weeks |

**Total offline-sync subsystem: ~8 eng-weeks.** This is the bulk of the Variant C cost. **It is also the thing that, if skipped, makes the product feel fragile.**

#### 4.2.4 Daemon → local-executor command surface

Today's executor commands (10, per PR #1209 §1.2): `prompt`, `git.clone`, `git.worktree.add`, `git.worktree.remove`, `git.worktree.clean`, `unix.sync-worktree`, `unix.sync-repo`, `unix.sync-user`, `zellij.attach`, `zellij.tab`. Each of these needs to work over the local-agent channel exactly as it does over the local subprocess channel today.

**The interface already exists** (executor command template). The new path is: daemon doesn't `kubectl run` or `child_process.spawn`; it emits a structured directive over the WebSocket to the local agent, which fans out to a local `child_process.spawn(agor-executor, ...)`. Stdout/stderr/exit code stream back over the WebSocket.

**Risk:** the existing executor commands assume a daemon-adjacent filesystem for things like `zellij.attach`'s socket path, `unix.sync-worktree`'s sudo group operations. **These need per-command audit.** Some commands (`unix.sync-user`) presumably make no sense in distributed mode at all — a hosted daemon doesn't manage Unix groups on user laptops. **Document which commands are valid in distributed mode and which are no-ops.**

**Engineering cost:** ~2 eng-weeks audit + adapt.

### 4.3 Variant D (P2P) — the wall is "everything"

For completeness:

| Problem | Why it's a wall |
|---|---|
| CRDTs for every entity | Cost in eng-quarters. Library footprint adds 5-10 MB to client bundle. |
| Peer discovery | Pure P2P requires DHT (Kademlia). DHT bootstrapping requires seed peers. Seed peers require coordination. So you have a coordinator anyway. |
| Identity + revocation | Without a CA or central revocation, compromise of one node has no clean recovery. |
| Storage growth | O(n) per peer for state; needs aggressive partitioning + replication. |
| Performance | Eventual consistency means UI lag for cross-peer state. Hard to debug. |

**Verdict: dismissed for v1.** Mentioning it here so the doc is complete. The right time to revisit is "after we have shipped C and there is a documented business case for a no-central-server mode" — which is unlikely to ever materialize for Agor's target users.

---

## 5. Recommendation

Three commitments, as the brief asked.

### 5.1 Is Variant B (Electron) worth shipping ahead of Variant C?

**No.** The Electron-local product solves a small problem (npm-install friction) and doesn't unlock collaboration. The 2025-12 prototype proved the technical shape; the prototype's abandonment is evidence that the strategic value isn't there.

**However:** when Variant C's local agent ships and stabilizes, **wrap it in an Electron tray app**. At that point Electron is doing valuable work — distributing a long-lived background service to non-technical users, providing tray UX, autoupdate — and is no longer just a `node` installer.

### 5.2 Is Variant C (hybrid) the long-term answer?

**Yes, with caveats.**

The hybrid model is the *only* topology that gives Agor both "keep my code local" AND "team canvas." Any other answer (local-only, hosted-only) sacrifices one of those. Agor's product thesis — multiplayer agent orchestration for teams who care about their codebase — points squarely at this shape.

**Caveats:**
- It is months of work, sequenced behind the segmentation enforcement (PR #1209 + the in-flight `design-ui-daemon-executor-segmentation` next-steps).
- Phase it carefully (§6 below). Each phase must be valuable standing alone, so we can stop after any one and have shipped something useful.
- The offline-sync subsystem (§4.2.3) is the single largest cost. Budget honestly.

### 5.3 Phased delivery — the smallest unit that proves the model

**v0 — Toy local agent.** ~2 weeks.
Outbound WebSocket from a 200-line local-agent prototype. Registers with a hosted daemon via personal API key. Accepts ONE pre-configured worktree assignment. Spawns ONE session. Streams events back. No auth, no offline, no UI. **Validates the network model and the spawn-pattern adaptation. Throwaway code — don't ship.**

**v0.5 — Token-bound auth + revocation.** ~2 weeks.
Replaces v0's hardcoded creds with personal API keys. Daemon enforces per-directive authz against `worktree.owners` / `others_can`. Local agent rejects directives outside its registered worktree set. Revocation propagates within 5s. Still no offline; still command-line only.

**v1 — Per-worktree home + basic offline queue.** ~6 weeks.
Adds `worktree.home: local | remote` column. UI lets a user pick a home when creating a worktree on a hosted instance. Local agent maintains a SQLite event buffer for offline periods; replays on reconnect. Daemon's `pending_directive` queue holds inbound prompts for offline agents. **This is the first version a user could meaningfully use.**

**v2 — Bidirectional sync + conflict resolution.** ~5 weeks.
Full §4.2.3 subsystem. Drift reconciliation. Failure-mode UX. Documented conflict policy per entity class. End-to-end test harness for network partitions.

**v3 — Electron wrap.** ~3 weeks.
Bundles the local agent in a tray app with autoupdate. Borrows from the 2025-12 prototype where applicable. NOT a daemon-in-Electron — just the local agent.

**Total to v3: ~18 eng-weeks**, sequenced behind segmentation + Option C prep. Each phase ships independently; we can stop at any v.N and have something useful (v1 onwards).

**Honest worst-case:** v1 alone is shippable as a beta. If user adoption is tepid or the offline-sync is more painful than estimated, the project can stop at v1 with "early-access distributed mode" and pivot. The Phase 1 → 4 segmentation work isn't wasted regardless — it unlocks Option C (hosted env-pods) too.

---

## 6. Concrete next-step PRs

The deliverable. Each PR sized for one worktree, reviewable in one sitting (≤500 lines net change unless explicitly larger). Sequenced so subsequent worktrees can pick up the chain. Following the same shape as `segmentation-and-enforcement.md` §6.

### Stream 0 — Prerequisites (NOT this analysis's PRs, but must land first)

These already exist as in-flight work. Distributed Agor is blocked behind them:

- **`segmentation-and-enforcement.md` PRs A, B, C** (Biome boundaries + ID relocations + lint→error). Without lint enforcement, distributed mode regresses the same boundaries it depends on.
- **`segmentation-and-enforcement.md` PR I** (split-home Docker compose for runtime enforcement). Surfaces today's drift as failing CI; distributed mode needs daemon ⊥ worktree-FS proven before adding a new executor channel.
- **`daemon-fs-decoupling.md` Phase 1B** (artifact landing → executor, upload → executor, realign-origin → executor). Each daemon-side FS touch must move to executor before that executor can be a *remote* executor — otherwise distributed mode means "daemon reaches across the network to do FS work," which defeats the point.

**Hard rule for the PRs below: do not start before Stream 0 PR I (split-home compose) is green for the artifact / upload / realign-origin failures.** Otherwise distributed mode is testing on quicksand.

---

### PR D1 — `docs: distributed Agor feasibility analysis` (this PR)

- **Scope:** This doc. `docs/internal/distributed-agor-feasibility-2026-05-19.md`. No code.
- **Files:** Just this file.
- **Effort:** Done.
- **Risk:** None.
- **Depends on:** Nothing.
- **Hard rules:** Draft PR only. Do not merge until Max approves the topology + phased delivery.
- **Success criteria:** Max signs off on Variant C as the long-term direction and on the v0 → v3 phasing.

---

### PR D2 — `docs: local-agent RPC protocol design`

- **Scope:** A separate design doc (`context/explorations/local-agent-protocol.md`) specifying the wire-format between hosted daemon and local agent. Concretely: directive shapes (`executor.spawn`, `executor.cancel`, `worktree.health.probe`, `agent.heartbeat`), event shapes (`executor.event`, `executor.exit`, `agent.registered`, `agent.disconnected`), framing (Feathers service over WebSocket vs. a custom multiplex), backpressure semantics, error model. Borrows from `executor-expansion.md` JSON-over-stdin contract for individual command shapes.
- **Files:** `context/explorations/local-agent-protocol.md` (new, ~400 lines).
- **Effort:** ~3 eng-days.
- **Risk:** None (doc).
- **Depends on:** PR D1 (this doc) approved.
- **Hard rules:** Spec the wire format before writing a single line of agent code. The whole point of having existing precedent (Feathers, executor JSON-over-stdin) is to compose them clearly, not to invent a third protocol.
- **Success criteria:** Doc lands. The next worktree (PR D3) picks up the spec and implements without re-negotiating wire format mid-build.

---

### PR D3 — `feat(local-agent): v0 toy — outbound websocket + one-session spawn`

- **Scope:** A new `packages/local-agent/` package. ~500 lines max. Implements: outbound WebSocket to a hosted daemon URL; CLI-flag-driven worktree assignment; spawn one local executor per `executor.spawn` directive; pipe stdout/stderr/exit back as `executor.event` messages. Hardcoded auth (single-line API key in env var). No reconnect, no offline buffer. **Throwaway intent.** Validates §4.2.1 network model end-to-end.
- **Files:** `packages/local-agent/src/` (new package), `packages/local-agent/package.json`, `apps/agor-daemon/src/services/local-agents.ts` (new, ~150 lines: registers the WebSocket channel, routes directives), `pnpm-workspace.yaml`.
- **Effort:** ~2 eng-weeks.
- **Risk:** Medium. New package; new daemon service; new directive shape. **Mitigation: tag commits explicitly as "v0 — DO NOT MERGE, demo only".** Lands behind a feature flag (`execution.local_agent_enabled`, default `false`).
- **Depends on:** PR D2 (protocol doc).
- **Hard rules:** No auth beyond a hardcoded env-var token. No reconnect. No offline. **Throwaway code.** The deliverable is a demo: "I am running an agent against a worktree on my laptop, the daemon thinks the executor is local-pod-equivalent, here's the message stream."
- **Success criteria:** Live demo of one session running against one worktree on a remote machine, with events streaming to the hosted UI in real time. Latency measured and documented.

---

### PR D4 — `feat(local-agent): v0.5 — personal-API-key auth + per-directive authz + revocation`

- **Scope:** Local agent reads its API key from `~/.agor-agent/config.yaml` (created by `agor-local-agent init`). Daemon-side: WebSocket connection authenticates via existing personal-API-key path (`packages/core/src/auth/` adjacent to PR #1220's surface). Every directive issued to the agent is authz-checked against `worktree.owners` + `others_can` (reuse the existing RBAC machinery). Local agent re-checks every inbound directive against its locally-cached permission view (defense in depth). Revocation: when a key is deleted via `/users/me/api-keys/:id DELETE`, all open agent connections using that key are torn down within 5s.
- **Files:** `packages/local-agent/src/auth.ts` (new), `apps/agor-daemon/src/services/local-agents.ts` (auth hook), `apps/agor-daemon/src/services/api-keys.ts` (revocation broadcast).
- **Effort:** ~2 eng-weeks.
- **Risk:** Medium. Touches auth-critical code. Strong tests required for revocation propagation.
- **Depends on:** PR D3.
- **Hard rules:** No long-lived shared secrets. Every directive is per-call authz-checked on both sides. Revocation must be testable end-to-end (test: create key → connect agent → delete key → assert agent disconnect within 5s).
- **Success criteria:** A revoked key cannot keep an agent connected. A directive targeting an unauthorized worktree errors cleanly on both sides. Cross-user spawn attribution behavior matches today's `dangerously_allow_session_sharing` semantics (default off = local-agent refuses cross-user directives).

---

### PR D5 — `feat(worktree): home column (local | remote) + UI selector`

- **Scope:** Add `worktree.home` column (default `remote` for existing rows on hosted instances; `local` for self-hosted). UI lets the user pick a home when creating a new worktree on a hosted instance (dropdown of registered local agents or "remote"). Daemon's worktree-create + executor-spawn paths route based on `home`: `remote` → existing path (subprocess / `kubectl run`); `local` → emit directive over the local-agent WebSocket. The `home` value is immutable once set — to "move" a worktree, you delete and recreate (which forces a clear mental model: the worktree's files don't migrate).
- **Files:** `packages/core/src/types/worktree.ts`, `packages/core/src/db/schema.{sqlite,postgres}.ts` (+ migration), `apps/agor-daemon/src/services/worktrees.ts` (routing), `apps/agor-ui/src/components/WorktreeCreate/HomeSelector.tsx` (new).
- **Effort:** ~3 eng-weeks (DB migration + routing + UI).
- **Risk:** Medium-high. Schema migration; routing-fork in worktree creation; UI surface. Strong test coverage for the routing branches.
- **Depends on:** PR D4.
- **Hard rules:** `home` is immutable once set. Self-hosted instances default to `local` for all worktrees; the dropdown is hidden. Hosted instances default to `remote`; the dropdown shows only when at least one local agent is registered for the current user.
- **Success criteria:** A user with a registered local agent can create a `local` worktree, and the resulting session spawns on their machine. A user without a local agent has no UX regression.

---

### PR D6 — `feat(local-agent): v1 — offline event buffer + reconnect`

- **Scope:** Local agent gains a SQLite-backed event buffer (`~/.agor-agent/buffer.db`). When the WebSocket is disconnected, executor events are buffered with monotonic sequence IDs + idempotency keys. On reconnect, agent drains buffer to daemon; daemon inserts via INSERT-OR-IGNORE on the idempotency key. **Append-only events only** (messages, tasks, reports). Daemon-side: `pending_directives` queue holds inbound prompts targeted at offline local-worktree sessions; flushes on agent reconnect. Failure path: directive's session no longer exists → queue a `[delivery_failed]` system message in the transcript.
- **Files:** `packages/local-agent/src/buffer.ts` (new), `packages/local-agent/src/reconnect.ts` (new), `apps/agor-daemon/src/services/pending-directives.ts` (new), DB migration for `pending_directives` table.
- **Effort:** ~6 eng-weeks (the offline subsystem is the meat of v1).
- **Risk:** High. Distributed-systems correctness. Strong tests required for: ordering, idempotency, max-buffer-size, agent-died-mid-flush, daemon-restarted-during-flush, simultaneous reconnect-and-revocation.
- **Depends on:** PR D5.
- **Hard rules:** Append-only entities only. No bidirectional sync of mutable state in this PR. Idempotency keys on every event; daemon refuses duplicates without erroring. Buffer has a max size (default 100k events / 100 MB); past that, oldest events are dropped with a tray-UI warning and a `[buffer_overflow]` system message.
- **Success criteria:** Simulated 24h disconnect with active sessions → all events replay on reconnect, no duplicates, no losses (within buffer limits). Tested under chaos.

---

### PR D7 — `feat(distributed): v2 — bidirectional state sync + conflict resolution`

- **Scope:** §4.2.3 in full. State-machine reconciliation on reconnect: agent + daemon exchange last-known-state per session/worktree owned by the agent; conservative-wins for permissions (stricter wins on conflict); LWW for cosmetic fields (placement, title); agent-authoritative for session-runtime state. UX for "your local agent has been offline 6 days; here's what happened" — a per-user "agent activity" panel.
- **Files:** `packages/local-agent/src/reconcile.ts` (new), `apps/agor-daemon/src/services/agent-reconciliation.ts` (new), `apps/agor-ui/src/components/LocalAgentStatus/` (new).
- **Effort:** ~5 eng-weeks.
- **Risk:** High. Bidirectional sync is the hardest case. **Mitigation: this PR ships behind a per-instance `execution.local_agent_bidirectional_sync` flag; v1 (PR D6) ships without it.**
- **Depends on:** PR D6.
- **Hard rules:** No conflict resolution that silently loses user-authored data. Every conflict resolution decision is logged + surfaced in the UI (`[Agor] Reconciled 3 conflicts on reconnect; click for details`).
- **Success criteria:** Documented test matrix for the conflict scenarios in §4.2.3 — all pass.

---

### PR D8 — `feat(electron): wrap local agent in tray app` (optional, parallel to D7)

- **Scope:** Electron tray app bundling the local agent. Tray icon shows agent status (connected, syncing, offline, X buffered events). Right-click menu: pause agent, disconnect, view recent activity, open hosted UI in browser, quit. NOT a daemon-in-Electron — the daemon stays remote; only the local agent is bundled. Autoupdate via `electron-updater` against a Preset-hosted update channel. Cribs from the 2025-12 `apps/agor-desktop` prototype where applicable.
- **Files:** `apps/agor-local-agent-desktop/` (new), forge config, signing setup, autoupdate scaffolding.
- **Effort:** ~3 eng-weeks.
- **Risk:** Low (technical). Medium (maintenance cost forever).
- **Depends on:** PR D6 (v1 local agent). Can ship before D7 (bidirectional sync) — autoupdate handles the v1→v2 upgrade.
- **Hard rules:** Tray app distributes ONLY the local agent, not the daemon. Autoupdate must be opt-in for users in regulated environments.
- **Success criteria:** Signed macOS .app + signed Windows .exe + Linux AppImage. Users can install, paste their API key, and have a working local-agent-as-tray-icon on first launch. Autoupdate verified end-to-end on a beta channel.

---

### Recommended sequence

```
Stream 0 (prereq): segmentation A/B/C + PR I + Phase 1B sweep
              │
              ▼
D1 (this doc) ──▶ D2 (protocol design) ──▶ D3 (v0 toy)
                                              │
                                              ▼
                                          D4 (auth + revocation)
                                              │
                                              ▼
                                          D5 (worktree.home + UI)
                                              │
                                              ▼
                                          D6 (offline queue + reconnect)
                                              │
                                ┌─────────────┴─────────────┐
                                ▼                           ▼
                            D7 (bidirectional sync)     D8 (Electron tray)
                                                        [parallel, optional]
```

**Quick wins:** D1, D2 (docs — half a day each in terms of merge ceremony).
**Complexity-wall PRs:** D6 (offline buffer + reconnect) and D7 (bidirectional sync). These are where 70% of the eng cost sits.
**Stop-after-this-and-still-useful:** D5 (per-worktree home, no offline) or D6 (with offline) are both shippable as beta features. D7 is the polish layer.

---

## 7. Open questions / experiments worth running

These would shift the recommendation or the phasing if their answers were surprising.

1. **Latency floor for hosted-daemon ↔ user-laptop round-trips.** A 200ms RTT US ↔ Europe is fine for prompt issuance. Is it fine for live message streaming where each token-delta is a separate event? **Spike: instrument a v0 (PR D3) demo and measure event-emit-to-UI-render latency under realistic network conditions.** Time-box: 2 days. **If > 500ms p99, we need to think about local event batching or compression.**

2. **What % of v1 users will actually use the offline path?** If most usage is online and offline-tolerance is a checkbox feature, PR D6's offline-buffer subsystem is over-engineered. If users routinely close their laptops mid-session, the subsystem is the product. **Without user data, I'd budget for the latter (Agor users are developers on laptops); but it's worth surveying after PR D5 ships.**

3. **Does the personal-API-key revocation propagation work fast enough?** Today, personal API keys are checked at request time; the question is whether long-lived WebSocket connections will pick up a revocation without restarting the connection. **Spike: 1 day. Either revocation already kicks the connection (clean) or we need to add a connection-bound TTL refresh.**

4. **Multi-laptop scenarios.** A user with two laptops (work and personal) wants their work laptop's agent to host work-worktrees and the personal one to host personal-worktrees. Does our `worktree.local_agent_id` model handle this cleanly? **PR D5 design should anticipate this** — a worktree's home is a specific agent registration, not just "the user's local environment."

5. **Auto-update for the bare CLI agent (pre-Electron).** Between PR D6 (v1 CLI agent) and PR D8 (Electron wrap), there's a window where users are running a bare CLI local agent with no auto-update. Do we ship a built-in `agor-local-agent self-update` command? Ride on Homebrew? Punt to documentation? **Decide before PR D6 ships, not after.**

6. **Slack / gateway sessions on local worktrees.** Gateway sessions (#1166-adjacent) need the daemon to mediate. Does "the executor for this gateway session lives on Alice's laptop" work when the gateway message arrives while Alice's laptop is closed? **Answer: PR D6's `pending_directives` queue handles it — Slack message arrives → daemon queues directive → local agent reconnects later → directive flushes → Slack thread updates.** Worth a design check, not a spike.

---

## 8. What we lose if we don't do this

Honest assessment, framed against Agor's stated thesis (multiplayer canvas for orchestrating AI coding agents).

**If we skip Variant C entirely and stay at A + hosted Option C:**

- **No enterprise/regulated story.** Companies that can't put source code in Preset's cloud have only Variant A (self-host the whole thing). The "shared canvas without shared infrastructure" pitch goes away.
- **Cold-start latency floor.** Every hosted session pays for env-pod spin-up. Local agents (using the user's already-warm dev environment) eliminate this.
- **BYO compute is off the table.** Users with serious local hardware (M3 Max, 64GB RAM, local LLM rigs) can't bring it to bear on hosted-Agor.
- **No offline story at all.** Hosted-only Agor is dead when the network is dead.
- **Smaller addressable market.** "Hosted SaaS only" caps us at customers willing to send code to Preset. Substantial fraction of dev teams aren't.

**If we ship Variant C v1 but not v2 (no bidirectional sync, only offline buffer):**

- Mostly OK. Append-only events cover 80% of the offline value. The user-visible loss is "if your agent is offline 6 days and a teammate edits worktree permissions in the meantime, on reconnect the agent's view is stale by 6 days." Probably acceptable for v1.

**If we ship Variant C but never Electron (no D8):**

- CLI install for power users only. Friction. Probably fine for the developer-tooling audience but limits adoption among less-technical teams.

**If we never ship anything beyond today:**

- Agor stays "hosted-only OR self-hosted-only," a hard binary. The middle is empty. That's the strategic risk this analysis is about.

---

## 9. Coordination notes

- **`analyze-daemon-fs-decoupling` (PR #1209):** This doc inherits Option D's split (self-hosted Option A; hosted Option C). Distributed Agor is **a third deployment shape** that composes with both — a hosted-Option-C daemon can host both env-pod worktrees AND local-agent worktrees on the same board. No conflict.

- **`design-ui-daemon-executor-segmentation` (in flight):** Segmentation enforcement is the prerequisite. **Do not start any PR D* before its Stream 1 (Biome boundaries) and Stream 5 (split-home compose) have landed.** Distributed mode introduces a new way for the daemon to "touch" a remote worktree (via the local agent); without enforced boundaries, drift is guaranteed.

- **`design-in-conversation-widget-primitive` (sister design doc, 2026-05-19):** Same dated-deliverable shape. Widgets are orthogonal to distributed mode — both can ship independently. No code dependency.

- **PR #1220 (api-key revocation), PR #913 (personal API keys), `feat(mcp): allow sessionless access with personal API keys`:** The auth substrate for D4. Already in tree.

- **`address-issue-1140-impersonation-abstraction` (closed 2026-05-09):** The executor-as-impersonation-boundary work that PR D4's "local agent runs executor as the right user" depends on. Already in.

- **Per-SDK credential scoping gap** (`project_credential_scoping_gap.md` — memory): distributed mode doesn't worsen this gap; on the contrary, local-agent mode naturally scopes credentials to the user's local environment. **Distributed mode is not the right place to fix the gap, but it benefits from the fix landing.**

---

## 10. What this worktree shipped

Per the brief:

> ❌ No code from this worktree — analysis only.

This doc is the deliverable. A draft PR (`docs: distributed Agor feasibility analysis`) ships it for review. Subsequent worktrees pick up PR D2 (protocol design) and onward.

The recommendation is **commit to Variant C as the long-term direction**, sequenced behind segmentation work, phased v0 → v3 over ~14–18 eng-weeks. Variant B (Electron-local) is dismissed as a standalone product; revisited as a delivery vehicle for Variant C's local agent in PR D8.

The complexity wall is real but local: it lives almost entirely in §4.2.3 (offline + reconnect conflict resolution). Everything else is plumbing on top of existing seams (executor command template, outbound WebSocket via `AgorClient`, personal API keys, per-worktree RBAC).

---

_End of analysis._
