# Agor Feature Brainstorm — 2026-05-08

> A creative, opinionated brainstorm. Half-baked ideas welcome. We'll prune later.
>
> **Method:** read every page in `apps/agor-docs/pages/guide/` (features-overview, sessions, worktrees, boards, assistants, internal-mcp, multiplayer-social, rich-chat-ux, environment-configuration, scheduler, cards, artifacts, message-gateway, sdk-comparison), the README, last ~50 commits, and 30 open issues + 30 open PRs for pain-point patterns.

---

## Today's Surface (inventory)

What Agor markets externally, mapped from the feature-overview hub.

### Core primitives
- **Worktree** — git working directory + DB record. The spine. `(repo, branch, board, issue_url, pull_request_url, owners, env, sessions)`.
- **Session** — agent conversation pinned to one worktree. Has model, effort, permission mode, MCP servers attached, optional callbacks.
- **Task** — a single user-prompt-and-execution within a session (the queueable unit).
- **Message** — one turn in a task.
- **Board** — 2D Figma-style canvas of worktrees at `(x, y)`.
- **Zone** — region on a board with an optional Handlebars prompt template that fires on drop.
- **Card** (beta) — generic non-worktree workflow entity (ticket, lead, patient).
- **Artifact** — Sandpack app rendered live on the canvas, written by an agent.
- **Assistant** — persistent worktree backed by the agor-assistant framework repo (BOOTSTRAP/SOUL/IDENTITY/USER/HEARTBEAT/BOARD.md).
- **Channel** — message-gateway portal (Slack / GitHub) bound to a target worktree.
- **Schedule** — cron attached to a worktree that fires templated prompts.
- **Environment** — managed dev server per worktree, with port allocation derived from `unique_id`, three-layer config (`.agor.yml` variants → DB overrides → rendered snapshot).
- **MCP Server (external)** — per-user OAuth grants; `stdio`/`sse`/`http` transports.
- **Card Type** — emoji + color + optional JSON schema, global.

### Orchestration features
- **Fork** (Claude only) — sibling session that inherits parent's transcript via SDK replay.
- **Spawn** — child session with fresh context window; non-blocking parent; callback-on-completion (status, summary, optional last message); cross-tool (Claude → Codex etc.).
- **BTW** — ephemeral fork; result delivered back inline in parent's transcript.
- **Zone trigger** — drop-into-zone fires a templated prompt; choose new/reuse/most-recent session.
- **Scheduler** — cron + Handlebars-templated prompts; powers Assistant heartbeats.
- **Message gateway** — Slack DM / GitHub `@agor` mentions spawn or continue sessions; outbound after-hook routes responses back; per-channel agent config.

### Integrations / runtimes
- **Agentic tools** — Claude Code, Codex, Gemini, Copilot, OpenCode (75+ providers via OpenCode).
- **Internal MCP server** — every session auto-issued a scoped JWT (`agor:mcp:internal`, 24h, no revocation, re-minted per fetch).
- **External MCP servers** — per-user OAuth 2.1 with discovery + DCR; encrypted refresh tokens.
- **Slack** (Socket Mode), **GitHub** (App + polling).
- **TypeScript client** — `@agor-live/client` for non-agent automation.

### UX surfaces
- Per-prompt token + dollar accounting; cumulative session cost; analytics page.
- Live context-window meter (with caveats around cache reads / system overhead).
- Structured tool blocks (Read / Edit-with-diff / Bash / Grep / Write / MCP collapsible).
- Per-message git tracking, AgentChain auto-grouping, Task subsession nesting.
- Sticky live TodoWrite, queued messages, file/user `@`-autocomplete.
- Favicon status dots (white = working, green = ready), attention-pulse on worktree cards, completion chimes, mobile UI.
- Streamdown markdown (Mermaid / KaTeX / 100+ langs).
- Multiplayer: live cursors, facepile, scoped/threaded comments (Board / Zone / Worktree / Session), shared tmux terminal.
- Per-user settings: env vars (Global/Session scoped, encrypted), per-runtime credentials, audio prefs, API tokens, OAuth grants.
- File uploads with worktree/temp/global landing + auto-prompt template.

### Security / deployment posture
- Worktree RBAC tiers: `none` / `view` / `session` / `prompt` / `all`.
- `unix_user_mode`: `simple` / `insulated` / `strict`.
- `dangerously_allow_session_sharing` flag for impersonation.
- Web terminal toggle, password sync, MCP token TTL.
- Three-layer env config (.agor.yml / DB overrides / rendered snapshot).

---

## Ideas

I'm grouping by axis, but the strongest ideas (top picks) get pulled out at the end.

### a) Adjacent — extends what exists

**1. Worktree forking.** Today fork = session-level (Claude only). #374 already asks for it. Forking a *worktree* means: copy filesystem snapshot, branch off, copy session genealogy at fork point. Two parallel timelines of the same feature, A/B-able on the canvas. "I want to try the OAuth approach in one branch, the API-key approach in another, side-by-side."

**2. Session merge / rebase.** The fork tree is one-way today. Allow:
- Take session A's last 6 turns and replay them onto session B's context (rebase).
- Squash a fan-out: 8 children completed → "merge their reports into a single distilled session" with cross-references.
- This is genuinely native to AI coding — no tool has it because none have multiplayer transcript trees.

**3. Zone macros (chained zones).** Today a zone triggers one prompt. Add: "after this prompt completes, drop into the next zone." A worktree drop becomes a *pipeline run*. Triage → Plan → Build → Review → Ship as a literal directed graph of zones, with conditional branches based on the previous zone's outcome ("if tests fail, drop into 'Fix' zone").

**4. Worktree + filesystem snapshots.** Per-message git tracking exists. Promote it: every assistant turn auto-creates a checkpoint commit on a hidden ref. Time-travel slider on the worktree card — drag to any prior state, see filesystem + transcript pair as it was.

**5. Cross-repo worktrees / "monorepo overlay" boards.** A worktree is one repo. Real features touch frontend + backend + infra repos. Allow a board with worktrees from different repos visually grouped, and a "compound worktree" (a worktree bundle) where one session sees all three filesystems.

**6. Card-from-Issue ingest.** Cards are "dumb." Wire them to GitHub/Linear/Jira: import issues as cards on a board, drag a card → "hatch into worktree" creates the branch, links the issue, fires a triage zone. Closes the loop with the gateway.

**7. Re-trigger zones on demand.** #352 — UI affordance to re-fire the zone prompt on a worktree without dragging it out and back. Right-click → "Re-run this zone."

**8. Slash commands inside Agor sessions.** #359 — pipe `/review`, `/explain`, `/plan` etc. into the session as templated prompts (Handlebars over the same zone-template variables). Each user can author their own.

### b) New primitives

**9. `Goal` — the multi-session objective.** Above sessions, below worktrees. A Goal has a description, success criteria (assistant-evaluable), a budget (`$ N` or `M tokens`), and a status. It owns one or many sessions and rolls up their progress. "Fix the OAuth bug ($5 budget, must pass test X) — succeeded in $1.83 across 1 fork + 2 spawned children." This is the primitive Linear/JIRA pretend issues are, but for actual machine work.

**10. `Watcher` — the reactive agent.** A long-lived rule that fires when an event matches, similar to scheduler but event-driven, not time-driven:
- "When any session in this board completes with `failed`, spawn a Codex sibling to analyze the failure."
- "When a worktree's PR gets a review comment, route into the 'Address Review' zone."
- "When any session uses >$5, ping the owner."
- It's already half-implemented in the gateway after-hook + scheduler — formalize it.

**11. `Bench` — paired-LLM evaluator.** A persistent worktree that evaluates other worktrees. Wire any Goal's "success criteria" through it. The bench itself is a session/template/MCP composite. "Did this PR meet the acceptance criteria?" → bench ship/no-ship verdict + diff pointer.

**12. `Scratch` — ephemeral throwaway sessions.** A first-class tier for "ask Claude a code question, no worktree, no transcript saved past today." Issue #237 wants this. Don't make it a fake worktree on the board — make it a separate side panel. Keeps the board clean.

**13. `Prompt Library` (formal).** Today's zone templates are inline strings inside a zone. Promote prompt templates to a first-class entity: shareable across boards/zones/scheduler/macros, versioned, with named variables, and discoverable in `agor_prompts_list` MCP tool. Marketplace-able.

### c) Multiplayer / collaboration

**14. Pair-prompt mode.** Two humans co-author a prompt before it sends. Real-time CRDT input; either can submit. Chess-clock-style affordance for who has the pen. Useful for design review or onboarding ("type with me — I'll show you what context to load").

**15. Session-level review queue.** A user-explicit "send to review" action on a completed task; the receiver gets a notification with the diff + transcript + a one-click "approve & merge plan" or "reject + send back with note." This is the missing piece between AI-completes-work and human-approves-work today; the attention-pulse only signals "look at me."

**16. Spectator mode.** Watch a session live without joining it — read-only stream over the same WebSocket. Hide my cursor from teammates I'm spectating. Useful for daily standup ("show me what your assistant did overnight"), code review, learning.

**17. @-mention agents in comments.** Comments are pinned to scopes. Add `@bob-the-reviewer` (an assistant) inside a worktree comment → it queues a session against that worktree with the comment as the prompt. Comments become latent prompts.

**18. Live presence in sessions, not just boards.** Show "Max is reading this transcript" on the session view. Cursors-on-text inside long completed transcripts. Surfaces shared review without screenshare.

**19. Whiteboard sticky notes.** Stickies on the canvas not bound to any worktree — quick "TODO: figure out the migration story" pinned to a board zone. Convertible to a worktree later. Right now thoughts that aren't yet code have nowhere to live in Agor.

### d) Observability / introspection

**20. Session replay / scrubbing.** Render a session's full lifecycle as a timeline with tool calls, file edits, costs. Drag a scrubber. Time-travel scrubbing. This is what #628 is asking for — it should be in the product, not a side project.

**21. Cost & token dashboards.** Today's analytics is per-user. Add: per-board, per-goal, per-zone (which zones are expensive?), per-prompt-template (which templates fail vs. succeed and at what cost?), per-agentic-tool. Spotting "the security-review zone always burns 60K tokens before failing" is the kind of insight that flips workflows.

**22. Trajectory diff viewer.** Two siblings via fork — show what each did differently. Side-by-side transcript with anchor lines, diffed file changes, diffed tool sequences. A/B comparison is the power-move you cannot get from any CLI.

**23. Failure taxonomy + auto-tagging.** Run a classifier (cheap LLM) over completed sessions; tag them: `succeeded`, `gave-up`, `infinite-loop`, `permission-stuck`, `compaction-truncated`, `tool-error`, `human-corrected`. Surface trends in a dashboard. "70% of your sessions in the past week ended in compaction-truncated — you should spawn earlier."

**24. Context window forensics.** Today's meter is "estimated." Build a real one: show the inflation source (cache reads from MCP tool definitions, system prompt, CLAUDE.md, accumulated tool outputs). Flag when MCP servers are eating 30K of every prompt's context. This directly addresses #267, #230 ("more compaction than without Agor"). Aside: this is a multi-thousand-dollar insight per user.

**25. Per-message hooks.** #104 — emit webhooks on session/task lifecycle. Any user-defined URL gets pinged. Lets people build their own observability without polling the daemon.

### e) AI-native UX inventions

**26. Natural-language board querying.** "Show me all worktrees where the assistant is stuck waiting on permission" → board filter applied via a parsed query. Or: "highlight the most expensive sessions this week." Use the same `@`-autocomplete affordance — type `?` to query.

**27. Agent autopilot for stuck sessions.** When the favicon goes green (waiting for input) for >N minutes on a session marked `autopilot`, an assistant peeks in, summarizes where it stuck, and either nudges it ("continue") or escalates ("summon a human"). Don't rebuild the wheel; the assistant primitive already exists — give it a "watch for stuck siblings" template.

**28. Agent-suggested next steps.** When a session completes, an inline panel of "what would I do next?" buttons authored by the agent at completion time — `Spawn a Codex reviewer`, `Open a draft PR with this title`, `Trigger zone "Tests"`. One click = zone trigger. Reduces "what now?" friction.

**29. Visual prompt builder.** Drag tool definitions, files (via `@`), recent transcript snippets, and Handlebars vars into a prompt the way you compose a complex search filter. This is what `Prompt Library` (#13) becomes when given UI love.

**30. AI-suggested zone authoring.** Show the assistant the last 50 zone-triggers and their outcomes; ask it "which 3 zones should I add to this board?" It proposes a zone with template + position. Hot-take: zones-of-zones, where a meta-zone can author other zones.

**31. Diff-aware chat.** When the assistant proposes a `git diff`, render it as a real diff with click-to-accept-hunk affordance — like a smaller scoped version of GitHub's PR review. "Accept hunks 1-3, reject 4, leave note on 5." Right now you accept whole edits or nothing.

**32. Repo-aware code search inside the chat input.** Type `?function loginUser` → autocomplete filenames; pick one and the agent receives `@-mention` context with the right file pinned. Ripgrep + LSP inside the prompt input. Combined with #29 it becomes a search-driven prompt builder.

### f) Integrations / ecosystem

**33. IDE bridges.** README roadmap already lists "BYO IDE." Make it real: a VSCode/Cursor/Zed extension where opening a file in the IDE is mirrored as a `@-mention` in the active Agor session, and Agor edits get reflected as git diffs that the IDE can explore with full LSP. The session is the cloud co-pilot; the IDE is the local explorer.

**34. GitHub Actions adapter.** Agor as a CI step. `agor session create --worktree X --prompt '/review'` from a GH Actions YAML, gated on PRs that need an LLM review. Reuses the gateway plumbing.

**35. Linear / Jira bidirectional sync.** Worktrees auto-link to Linear issues; closing the PR closes the issue; failing CI re-opens it; assistant-detected scope-creep posts a Linear comment. Cards (#6) are the primitive; this is the integration.

**36. BYO model providers — first-class.** OpenCode already does 75+ providers. Hoist that up: let the user pick "Claude via Bedrock," "Sonnet via Vertex" inside the *Claude Code* runtime, not just OpenCode. #132, #449. This is a checkbox enterprise demands.

**37. Agor inside Slack — beyond the gateway.** Don't just route DMs to sessions; let teammates *converse* about a session inside Slack as if it were a thread, with the session pulse-state shown. Combine with the comment system (multiplayer-social), so Slack comments and Agor comments cross-post.

**38. Agor for non-coding workflows is real — sell it.** Cards + Artifacts already cover this, but it's buried. Build the "support inbox" / "lead pipeline" / "patient triage" templates as one-click board presets. Marketing motion: "Linear, but the agent does the work."

**39. Public assistant marketplace.** `agor-assistant` is a framework repo; assistants are forks. Make a discovery page: "PR-review assistant," "incident-commander assistant," "OnCall-summary assistant." Install with one click → forks the framework + applies overlays. This is the equivalent of Cursor's recent slash-command ecosystem but spatial.

### g) Pain points (patterns from in-flight work)

Reading the last 50 commits + 30 open issues + 30 open PRs, here's what I'm seeing.

**Pattern A — Real-time-state drift.** A *lot* of recent commits are about the UI losing sync with the daemon: pinned worktrees piling at origin, MCP pill stuck "connected" after revoke, JWT expired sticky banner, session list filter resets on WS events, board re-render perf, OAuth UI not refreshing post-reauth. **Diagnosis:** the FeathersJS-event → Redux-derive-state pipeline is leaky in many spots. **Suggestion:** invest in a small, declared "live query" abstraction (or react-query against socket events) and migrate state piece-by-piece. Right now every component invents its own sync logic and that's where every fix is going.

**Pattern B — Compaction / context-window pain.** #267, #230, the SDK comparison's own "Estimated" warning, the system overhead 46K admission. People feel Agor compacts more than the bare CLI. **Diagnosis:** every MCP tool definition is a system-prompt tax; the more MCP servers attached, the worse it gets. **Suggestion:** lazy MCP tool exposure (#411, "tool discovery"). Don't dump all tools into the system prompt — expose a single `agor_search_tools` and let the agent pull schemas on demand. (We already do this for some tools per the system reminder I saw — formalize it across all.)

**Pattern C — Onboarding / first-session UX.** #391 ("Nothing happens when session is made"), #382 (Codex 401), #355 (Claude Code JSON parsing / Gemini circular structure / Codex 401), #129 ("Newly created GitHub repo gives an error when adding a worktree"). **Diagnosis:** the first 5 minutes have too many ways to fail silently. **Suggestion:** a literal "preflight" check that runs on first launch (and on the gear icon menu): "Claude key valid ✓ / Codex key invalid ✗ / Git author email set ✓ / GitHub clone test ✓"… with one-click fix actions.

**Pattern D — Schedule / config persistence quirks.** #1085 (scheduler clobbers permission_mode), #351 (multi-tab settings only saves visible tab), #1064 (dragged sessions hang), #933 (fork uses modal with title now). Lots of "this form has stale state" bugs. **Diagnosis:** form-state isn't centralized; default-merging is happening at multiple layers. **Suggestion:** a session-config schema that's the single source of truth, with explicit override-vs-fallback display in the UI ("inherits from user defaults" badges next to fields).

**Pattern E — Permission UX confusion.** #407 ("Permission request not found"), #472 ("Agent stuck on run_shell_command"), the SDK comparison's own warning that OpenCode permissions are *auto-granted* "to prevent session hangs." **Diagnosis:** the permission-approval UX is a footgun across SDKs. **Suggestion:** a permission-mode preview ("for this mode, *N* tools will run automatically and *M* will require approval"), surfaced before the session starts. And in `auto`/`acceptEdits` modes, surface what's been auto-approved as a passive log so users know their power.

**Pattern F — Image paste, slash commands, web RAG (CLI parity).** #404 (paste images), #359 (slash commands), #417 (RAG / code indexing), #237 (chat without a worktree). **Diagnosis:** Agor's bet is "Agor > CLI for multiplayer", but in solo flow the CLI still wins for these features. **Suggestion:** every six months, do a "CLI parity sprint" — identify the top 5 things the bare CLI does better and close them.

**Pattern G — Deployment friction.** #751 (Helm chart), #1109 (k8s + non-persistent HOME), #1118 (REST endpoint to skip MCP), #1119 (custom agentic_tool peer), #205 (local-first). **Diagnosis:** Agor is positioned as self-hosted but the deployment story is bespoke. **Suggestion:** `agor deploy <kube|docker|fly|...>` codepaths that ship with manifests, plus a real `agor-server` Docker image story. Open the door for IT teams.

### h) Differentiation bets — where could Agor lap competitors?

**Claude Projects / Cursor / Replit Agents / GitHub Copilot Workspace** all have agents. None has all four of: (a) spatial multiplayer canvas, (b) genealogy-as-data (fork/spawn/btw), (c) self-aware agents over MCP, (d) shared dev envs as first-class.

**Agor's wedge is the *team*.** Solo-developer agent UX is a saturated market — Anthropic, OpenAI, Microsoft, Cursor, Cognition all have a horse. But "twelve developers, six assistants, three coding agents, one canvas, full audit trail, per-user OS identity" is a market with two competitors (Devin, maybe Codeium for Teams) and zero spatial UIs.

**Three biggest unfair-advantage bets:**

**B1. Genealogy as a native social object.** Make the fork/spawn/merge tree the *thing* people share — not the session. Permalink any subtree. Embed it in PR descriptions. Render it as the changelog of a feature. "Here's how this PR was actually built" replaces the artificial "I wrote this code myself" PR narrative. This redefines code review.

**B2. The board as the single source of project truth.** Pull issues, PRs, open questions, in-flight assistants, scheduled jobs, multiplayer comments, paged-on incidents *all onto one board*. Jira shows a list. Linear shows a faster list. Agor shows the *spatial state of work*. Tightly couple to GitHub/Linear/PagerDuty so the board *is* the project status — not a separate thing to update.

**B3. Agents that hire each other.** Today an assistant can spawn sessions. Push further: an assistant publishes a `Service` (a callable goal description: "I review TypeScript PRs for $0.10/PR, here's my SLA"). Other assistants discover and call it via MCP. Combined with the per-user budget (#9), this is internal economics for autonomous agent teams. Sounds esoteric — but a CTO who reads "I save $4,500/mo by having my QA-bot subcontract reviews to my docs-bot" cares.

---

## Prioritization

Scoring rubric: **Impact** (how much would users care, 1-5), **Effort** (rough build size, 1-5, lower = easier), **Differentiation** (would competitors find it hard to copy, 1-5).

### Top 5 picks (with reasoning)

| # | Idea | Impact | Effort | Diff. | Why this one |
|---|------|--------|--------|-------|--------------|
| **#1** | **Lazy MCP tool exposure (Pattern B fix)** | 5 | 2 | 4 | This is a *currently bleeding* user pain (#267, #230) and the fix is mostly mechanical. Ship a single `agor_search_tools` + `agor_execute_tool` proxy by default; gate full tool dumps behind an opt-in. Wins back ~30K tokens of every prompt's context. Cheapest visible quality jump on the list. |
| **#9** | **`Goal` primitive with budget + success criteria** | 5 | 4 | 5 | This is the missing primitive between "issue" and "session." Once goals exist, scheduling/spawning/branching all align around something measurable. Unlocks autonomy: "stop when goal hits 80% confidence or $5 spent." Nobody else in this space has a goal primitive — Devin has tasks, Linear has issues, neither has a runtime budget. |
| **B1** | **Genealogy as a shareable social object** | 4 | 3 | 5 | Permalinkable subtrees + a "render this fork-tree as a PR description" flow + a public/internal embed widget. Doubles as marketing — every shared genealogy is a billboard for Agor's branching model. Cheap to ship the URL story; medium-effort to ship the embed widget. |
| **#20** | **Session replay / time-scrub** | 4 | 3 | 4 | The transcript is already on disk; the diffs are already tracked per message. The job is mostly UI: a scrubber, a synchronized filesystem panel, a forking affordance from any past point. #628 is asking for it. Strongly differentiates from CLI agents. |
| **#33** | **IDE bridge (VSCode / Cursor / Zed extension)** | 5 | 4 | 3 | The existing roadmap item, and probably the single biggest unlock for the solo-dev path. Lower the activation energy. The differentiation is moderate (Cursor has agent integration), but it makes Agor's *team-first* story palatable to individuals, who can then bring Agor to their team. |

**Why not "Watcher" / autopilot / etc.?** They're great ideas but they sit on top of Goals. Ship Goals first; Watchers and autopilots fall out cheaply.

### Honorable mentions (cheap-to-ship, high quality-of-life)

- **#7** Re-trigger zone on demand. Trivial UI; #352 is asking. (Impact 3, Effort 1)
- **#15** Session-level review queue. A "send to human" affordance. Combines with attention-pulse. (Impact 4, Effort 2)
- **#25** Per-message hooks (#104). Pure plumbing; lets users build their own observability. (Impact 3, Effort 2)
- **#22** Trajectory diff viewer for sibling forks. Power-user feature, but cheap given the data is there. (Impact 3, Effort 2)
- **Pattern A live-query refactor**. Not a feature — a debt paydown. But every "real-time UI bug" PR is a tax that compounds. (Impact 4, Effort 3, Diff 2)

---

## Wild swings

Probably won't work. Might be game-changers if they do.

**W1. The agent commit-graph.** Replace `main` as the unit of integration. Each session's edits live on a per-session ref. The "merge to main" operation is *itself* an agent — a continuously running merge bot that watches all agent branches and proposes integrations when conflicts are tractable. Solves the "all-agents-stomp-the-same-file" problem at the scheduler level instead of the policy level.

**W2. Agor-as-a-PaaS.** Let users publish their boards / assistants / zones publicly. A founder describes "I want a coding company in a box: PR review, on-call summarization, dependency triage." They click "deploy." It spins up an Agor instance with three pre-baked assistants and pipes their GitHub in. We charge per agent-hour. (Lampoons Devin's pricing model with a richer surface.)

**W3. Voice as a first-class input.** A Whisper-driven mic button on the session. *But* with spatial context: "Send to the worktree on the right, no the OAuth one, ask it to add error handling." Useful for: walking, driving, multitasking. The board's spatial language fits voice surprisingly well — Cursor's chat doesn't have positions to refer to.

**W4. Agor-on-Agor: the dogfood platform.** The repo's GIFs already hint at this. Make it a real *deployment mode*: "this Agor instance is for building Agor itself." The README's "built by an army of Claudes" is a marketing line; productize it as a lean fork that ships with all the assistants/zones/templates a maintainer of any OSS repo would want, configured for *their* repo. Becomes a discoverable distribution: "I want what Agor uses."

**W5. The agent stockmarket.** Each assistant publishes performance metrics (success rate per task type, cost per PR reviewed, satisfaction scored by humans). Cross-org leaderboards. People hire each other's assistants on a marketplace. Wild but follows logically from #B3.

**W6. Synthesizable artifacts that link back to code.** Today's artifacts are one-way: agent writes code, you see UI. Make it bidirectional: the artifact has an "edit this" mode where dragging UI elements emits code suggestions back. Designers become first-class Agor users without learning to code.

**W7. Permanent agents living on a board, no human required.** A board mode where the *entire* state is agent-owned: assistants spawn worktrees, complete them, ship PRs, archive. The human checks in via Slack or once a week. Real autonomous engineering org. (Compliance and trust questions are real — but the technology is mostly here today.)

---

## TL;DR — what to do Monday

1. **Ship lazy MCP tool exposure** (Top pick #1). Cheapest, highest-impact user-perceived quality jump. Probably 1-2 weeks.
2. **Spec out the `Goal` primitive** (Top pick #9). It's the keystone for half the wild ideas above. Worth a design doc before building.
3. **Run a "CLI parity" sprint** (Pattern F). Image paste (#404), slash commands (#359), simple LLM session (#237). These lose users every day.
4. **Pay down Pattern A** (live-query state drift). Stops the "fix one real-time bug, three more pop up" tax. Boring but compounds.
5. **Pick one of the differentiation bets** (B1 / B2 / B3) and start a discovery worktree. Doesn't have to ship soon — but the brand needs a story bigger than "Figma for AI coding," and these three are candidates.

The pitch I'd run at a stakeholder: *"Agor is the only place where a team of AI coding agents leaves a permanent trail. Every PR has a genealogy. Every dollar is accounted for. Every agent runs as a real Unix user. The board is the project."*

That's the wedge.
