# Agor — Messaging & Positioning

> **Internal source of truth for how Agor describes itself.** When you write
> copy that ships — README, Hero, docs landing, `package.json`, blog post,
> deck, slide, bio — start here. If a surface contradicts this doc, the
> surface is wrong.

---

## Tagline

**Team command center for all things agentic.**

Use it alone. Don't pair it with a co-tagline.

---

## Short paragraph (~50 words)

> **Team command center for all things agentic.** Agor is a shared canvas
> where coding agents (Claude Code, Codex, Gemini) and persisted
> assistants run side-by-side on isolated git worktrees. You see what every
> agent is doing in real time, your teammates see it too, and the agents
> themselves can drive Agor over MCP.

For: README intro, docs landing TL;DR, deck slide 1, blog lead.

---

## Long paragraph (~150 words)

> **Team command center for all things agentic.** Running one coding agent
> in a terminal works. Running five — across teammates, across repos, with
> assistants quietly grooming the backlog at night — falls apart fast.
> Conversations vanish, branches collide, dev servers fight for ports, and
> nobody can see what anyone else's agent is doing. Agor is a Figma-like
> spatial canvas for that work: every unit of work is a git worktree with
> its own branch, environment, and session tree; Claude Code, Codex,
> Gemini, and any MCP-driven assistant are interchangeable runtimes you
> pick per session; teammates show up live with cursors, facepile,
> comments, and shared terminals; and every action is exposed to agents
> themselves through Agor's MCP server, so the system can fork, spawn,
> schedule, and report on its own work. Self-hosted, with Unix-level
> isolation when you need it.

For: docs landing extended intro, sales one-pager, announcement post.

---

## What Agor is — bullets, ranked

Sorted by importance, relevance, and market appetite. Use the top of this
list when picking what to highlight — feature pages, launch threads, deck
slides, sales conversations.

1. **A team workspace for AI agents.** Multiplayer is the core
   differentiator: live cursors, facepile, scoped comments, attention
   pulse, shared tmux terminals. Most agentic tools today are solo. Agor
   isn't.
2. **A Figma-like spatial canvas.** Boards are 2D — worktrees are cards,
   zones are regions, you arrange your work and your teammates see where
   you're at. The spatial layout is what makes the multiplayer real.
3. **Multi-agent, multi-runtime.** Claude Code, Codex, Gemini, OpenCode,
   Copilot — interchangeable per session. Pick the right tool for the job;
   don't lock yourself into one vendor.
4. **Worktree-isolated.** Every unit of work is a git worktree with its
   own branch, environment, ports, and conversations. Parallel work
   doesn't collide.
5. **Observable.** Every session, every prompt, every tool call, every
   dollar — visible, durable, queryable. Status dots, completion chimes,
   token + dollar accounting per prompt, full conversation history per
   worktree. No more "what was that agent doing again."
6. **MCP-native.** Anything a user can do in Agor, an agent can do too.
   Sessions are auto-issued tokens; agents fork, spawn, schedule, and
   report on their own work.
7. **A home for persisted assistants.** Long-lived agents with file-based
   memory and skills, OpenClaw-style. Distinct from one-off sessions.
8. **A scheduler.** Cron-style triggers for templated prompts. Powers
   assistant heartbeats, daily standups, scheduled audits.
9. **Self-hosted.** BSL 1.1, your repos, your DB (LibSQL or Postgres),
   your Unix users when you turn on full isolation.

---

## How we speak at a high level

One-liner for talks, intros, and DMs:

> *Agor is the team command center for everything you're doing with AI agents — Claude Code, Codex, Gemini, custom assistants — on a shared spatial canvas, with full observability and self-hosted isolation.*

When the audience is technical and skeptical, lead with the problem:

> *One agent in a terminal is fine. Five agents across a team is chaos. Agor is the workspace that makes that scale.*

When the audience is multiplayer-curious, lead with the Figma frame:

> *Think Figma's spatial canvas, applied to AI agents. You see your teammates, you see what their agents are running, you coordinate live instead of after-the-fact.*

The Figma analogy is reserved for team / multiplayer / canvas framing —
it's the right reference there. Don't use it as the master tagline (the
"Figma for AI coding" framing we retired understates the product).

---

## What Agor is NOT

- **Not just for AI coding.** Persisted assistants and non-code workflows
  (Cards) are equal citizens.
- **Not an LLM or model gateway.** Bring your own runtime.
- **Not an IDE.** Roadmap is "bring your own IDE," attached to
  Agor-managed worktrees.
- **Not CI/CD.** Scheduler triggers prompts on a cadence; doesn't replace
  Actions/Buildkite/Argo.
- **Not closed SaaS.** Self-hosted-first, BSL 1.1.

---

## Vocabulary

✅ **Use:** team, team command center, agentic, multiplayer, Figma-like
spatial canvas (in team/multiplayer context), orchestrate, worktree,
session, board, zone, agent, assistant, observability, isolation,
real-time, MCP, self-hosted.

❌ **Avoid:** next-gen, AI-powered, swarm, spatial layer, control plane,
revolutionary, 10x, supercharge, productivity, "Figma for AI coding"
(retired as headline; OK as inline color in team/multiplayer context).

---

## Audience tiers

| Audience | Lead with |
|---|---|
| **Solo dev** | Visibility, isolation, durable conversation history. "Even solo, every agent run lands somewhere — branches don't collide, dev servers don't fight, conversations don't vanish." |
| **Team lead** | Shared canvas, RBAC, cross-team observability. "Five teammates each running two agents — Agor is what turns that from chaos into a board you can actually read." |
| **Platform engineer** | Self-hosted, four progressive isolation modes (`simple` / `insulated` / `strict`), MCP integration with internal tools. "Your OS permissions, your DB, your audit trail." |

---

## Where each form belongs

| Surface | Form |
|---|---|
| Docs landing Hero (`apps/agor-docs/pages/index.mdx`) | Tagline + short paragraph |
| Guide overview (`apps/agor-docs/pages/guide/index.mdx`) | Tagline + short paragraph |
| README intro | Tagline + short paragraph + top 3–4 bullets from "What Agor is" |
| `package.json` `description` (root) | One-liner |
| Meta description / OG / JSON-LD (`theme.config.tsx`) | One-liner |
| GitHub repo description, X bio, Discord description | Tagline only |
| Conference / talk title slide | Tagline only |
| Blog announcement, deck slide 1 | Short paragraph |
| Sales one-pager, partner deck, deep blog post | Long paragraph + audience tiers |

---

## `/guide/` hierarchy — proposal

Current structure (`apps/agor-docs/pages/guide/_meta.ts`) is already
grouped Features / Reference / Development / Deployment, and works.
**Don't redesign. Tighten copy in place.** Cascade rollout scope:

1. **`pages/guide/index.mdx`** — collapse the four stacked taglines
   (lines 16, 18, 20, 22–23) to canonical tagline + short paragraph.
2. **`pages/index.mdx`** — replace Hero `subtitle` and `description`
   props with tagline + short paragraph.
3. **`README.md`** — replace lines 5–7 with tagline + short paragraph +
   top 3–4 bullets.
4. **`theme.config.tsx`** — replace default `description` (line 83),
   `fullTitle` suffix (line 85), and JSON-LD `description` (lines 179–181)
   with the one-liner.
5. **`package.json`** descriptions — root and `packages/agor-live`.
6. **Slugs left alone** — `multiplayer-social.mdx` and
   `multiplayer-unix-isolation.mdx` keep their names; the prefix overlap
   is acceptable.
7. **Closing pull-quote** at `pages/guide/index.mdx:192` ("git tracks
   code, Agor tracks the conversations that produced it") — retire.
   Observability is in the bullets above; it doesn't need a tagline.
8. **"Figma" references on feature pages** —
   `multiplayer-social.mdx:8` and `features-overview.mdx:70` are kept;
   they're the right place for the Figma-like-canvas framing per the
   "How we speak" section.

---

## Survey appendix — current copy in the codebase

Baseline for the cascade rollout. Cite this when reviewing the cascade PR.

| File | Line | Quoted phrase | Action |
|---|---|---|---|
| `README.md` | 5 | "Think Figma, but for AI coding assistants. Orchestrate Claude Code, Codex, and Gemini sessions on a multiplayer canvas." | Replace |
| `README.md` | 7 | "Agor is a multiplayer spatial canvas where you coordinate multiple AI coding assistants on parallel tasks…" | Replace |
| `apps/agor-docs/pages/index.mdx` | 7 | "Next-gen agent orchestration for AI coding" (Hero subtitle) | Replace |
| `apps/agor-docs/pages/index.mdx` | 8 | "The multiplayer-ready, spatial layer that connects Claude Code, Codex, Gemini, and any agentic coding tool into one unified workspace." | Replace |
| `apps/agor-docs/pages/guide/index.mdx` | 3 | "Complete guide to agor - next-gen agent orchestration for AI coding…" (meta) | Replace |
| `apps/agor-docs/pages/guide/index.mdx` | 16 | "Think Figma, but for AI coding assistants." | Remove |
| `apps/agor-docs/pages/guide/index.mdx` | 18 | "Next-gen agent orchestration for AI coding. The multiplayer-ready, spatial layer…" | Remove |
| `apps/agor-docs/pages/guide/index.mdx` | 20 | "Agor is a multiplayer spatial canvas where you coordinate multiple AI coding assistants on parallel tasks…" | Remove |
| `apps/agor-docs/pages/guide/index.mdx` | 22–23 | "Visualize, coordinate, and automate your AI workflows… coordinate entire swarms of AI agents." | Remove |
| `apps/agor-docs/pages/guide/index.mdx` | 192 | "git tracks code, Agor tracks the conversations that produced it." | Remove |
| `apps/agor-docs/theme.config.tsx` | 83 | "Next-gen agent orchestration for AI coding. Multiplayer workspace for Claude Code, Codex, and Gemini." (default meta) | Replace |
| `apps/agor-docs/theme.config.tsx` | 85 | "agor – Next-gen agent orchestration" (title fallback) | Replace |
| `apps/agor-docs/theme.config.tsx` | 121 | meta keywords list | Refresh |
| `apps/agor-docs/theme.config.tsx` | 179–181 | JSON-LD `SoftwareApplication.description` | Replace |
| `package.json` (root) | — | "Next-gen agent orchestration platform" | Replace |
| `packages/agor-live/package.json` | — | "Multiplayer canvas for orchestrating AI coding sessions" | Refresh |
| `apps/agor-docs/pages/guide/multiplayer-social.mdx` | 8 | "Agor is great solo. Multiplayer is what makes it Figma." | Keep |
| `apps/agor-docs/pages/guide/features-overview.mdx` | 70 | "Figma for AI coding." | Keep (in multiplayer/team context only) |
