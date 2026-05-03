# Agor — Messaging & Positioning

> **Internal doc.** This is the source of truth for how Agor describes itself.
> When you write copy that ships to users — README intro, Hero subtitle, docs
> landing, package.json description, blog post lead, conference slide, sales
> deck — start here. If a surface contradicts this doc, the surface is wrong.
>
> This doc is **not** itself customer-facing. It's opinionated, names the
> off-brand phrases by file path, and exists so that future copy converges
> instead of diverging.

---

## Canonical tagline

**Team command center for all things agentic.**

Why these specific words:

- **"Team"** over "multiplayer." `Multiplayer` is a feature description (we
  built real-time presence, cursors, facepile) and stays in our vocabulary
  internally and on feature pages. `Team` is the audience description and
  belongs in the headline. It's shorter, more approachable, and immediately
  signals who Agor is for: groups of people who ship together.
- **"Command center"** over "control plane." `Control plane` is correct but
  infra-flavored — it lives next to Kubernetes and service meshes. Agor's
  primary surface is a UI you look at, not a YAML you apply. `Command center`
  carries the right register: a place humans sit, watch, and steer from. It
  also doesn't pretend Agor is plumbing — it foregrounds the canvas.
- **"All things agentic"** over "everything agentic" / "for AI agents" /
  "for AI coding." The phrase has rhythm (three stresses, idiomatic English),
  asserts category coverage without overreaching ("everything" sounds
  exhaustive in a way we can't defend), and — critically — the tail covers
  **both coding agents and persisted assistants**. Agor is not just for AI
  coding. Anchoring the line to "AI coding" as we have been (see
  `apps/agor-docs/pages/index.mdx:7`,
  `apps/agor-docs/pages/guide/index.mdx:18`,
  `apps/agor-docs/theme.config.tsx:83`) understates the product and will need
  to be re-pitched once Cards, Assistants, and non-code workflows lead more
  conversations.

The tagline is one line. Don't pair it with a co-tagline ("Think Figma, but
for AI coding assistants") — that's the bug we're fixing. Use the tagline
alone, then transition into a paragraph form below.

---

## Paragraph forms

Three forms, in increasing length. Pick the one that fits the surface.

### One-sentence (≤ 25 words)

> **Agor is a team command center for all things agentic — orchestrate coding
> agents and persisted assistants on a shared spatial canvas, with isolated
> worktrees, real-time presence, and an MCP surface agents can drive
> themselves.**

Suitable for: GitHub repo description, root `package.json` `description`
field, Twitter / X bio, link previews, JSON-LD `description`, OG meta.

### Short paragraph (~50 words, 2–3 sentences)

> **Team command center for all things agentic.** Agor is a shared canvas
> where coding agents (Claude Code, Codex, Gemini) and persisted assistants
> run side-by-side on isolated git worktrees. You see what every agent is
> doing in real time, your teammates see it too, and the agents themselves
> can drive Agor over MCP.

Suitable for: README intro under `# Agor`, docs landing TL;DR, pitch deck
slide 1, blog post lead paragraph, OSS directory listing.

### Long paragraph (~150 words)

> **Team command center for all things agentic.** Running one coding agent in
> a terminal works. Running five — across teammates, across repos, with
> assistants quietly grooming the backlog at night — falls apart fast.
> Conversations vanish, branches collide, dev servers fight for ports, and
> nobody can see what anyone else's agent is doing. Agor gives a team a
> single surface for that work: a 2D canvas where each unit of work is a git
> worktree with its own branch, environment, and session tree; where Claude
> Code, Codex, Gemini, and custom MCP-driven assistants are interchangeable
> runtimes you pick per session; where teammates show up live with cursors,
> facepile, comments, and shared terminals; and where every action is also
> exposed to agents themselves through Agor's MCP server, so the system can
> orchestrate, fork, spawn, and report on its own work. Self-hosted, with
> Unix-level isolation when you need it.

Suitable for: docs landing extended intro, sales one-pager, blog announcement
intro, investor / partner deck, conference talk abstract.

---

## What Agor is

Concrete claims. Each is defensible against the current implementation.

- **A spatial canvas** where worktrees, sessions, cards, and zones are
  first-class objects you can see, drag, and arrange.
- **A worktree manager** — every unit of work is an isolated git worktree
  with its own branch, environment, ports, and conversations attached.
- **A multi-agent runtime host** — Claude Code, Codex, Gemini, OpenCode, and
  GitHub Copilot are all interchangeable session runtimes; you pick per
  session.
- **A real-time multiplayer surface** — live cursors, facepile, scoped
  comments, attention pulse, shared tmux terminals.
- **An MCP server** — anything a user can do in Agor, an agent can do too,
  via the daemon's MCP surface. Sessions are auto-issued tokens.
- **A scheduler** — cron-style triggers for templated prompts; powers
  assistant heartbeats, daily standups, scheduled audits.
- **A home for persisted assistants** — long-lived agents with file-based
  memory and skills, OpenClaw-style.
- **A self-hosted product** — your repos, your database (LibSQL or Postgres),
  your Unix users when you turn on full isolation.

## What Agor is NOT

Disambiguations. The tagline can evoke the wrong mental model — these lines
exist to redirect.

- **Not just for AI coding.** Persisted assistants, non-code workflows
  (cards), and custom MCP integrations are equal citizens. Don't let
  "command center for agentic coding" become the implicit positioning the
  way "AI coding" did in earlier copy.
- **Not Figma.** The "Figma for AI coding" line was a useful early
  shorthand, and the spatial-canvas comparison is real, but Figma is for
  *designing* artifacts. Agor's canvas is for *coordinating real running
  work*. We retired the line.
- **Not an LLM and not a model gateway.** Agor doesn't ship a model. You
  bring agent runtimes (Claude Code, Codex, Gemini, custom MCP). Agor
  orchestrates them.
- **Not a CI/CD system.** Scheduler triggers prompts on a cadence; it does
  not replace GitHub Actions, Buildkite, or Argo. Sessions can call into
  CI; CI does not call into sessions.
- **Not an IDE.** Agor doesn't replace VSCode/Cursor/JetBrains. The
  "Bring Your Own IDE" roadmap item is the canonical position: keep your
  editor, attach it to Agor-managed worktrees.
- **Not a chatbot framework.** Sessions wrap real coding-agent SDKs. We
  don't build the agent — we run, watch, and connect them.
- **Not a closed SaaS.** Agor is BSL 1.1, self-hosted-first. There is no
  hosted "agor.com" tier today.

---

## Vocabulary — say this, not that

The brand voice. Use the ✅ words; flag the ❌ words in code review.

### ✅ On-brand

| Word | What it signals |
|---|---|
| **team / team command center** | Audience: groups, not lone hackers. Headline-grade. |
| **command center** | Humans sit here and steer. UI-flavored, not infra-flavored. |
| **agentic** | Covers coding agents *and* persisted assistants — broader than "AI coding." |
| **multiplayer** | Feature-page word for the real-time presence stack (cursors, facepile, comments). Stays in vocabulary, just not in the headline. |
| **orchestrate** | Active verb for what teams do with multiple agents. Pairs with "command center." |
| **worktree(s)** | Our primary unit of work. Always plural-friendly. Don't substitute "branch" or "task." |
| **session(s) / session tree** | Agent conversation with genealogy. Use "session" not "chat" or "thread." |
| **board(s) / zone(s)** | The 2D spatial surface and its regions. |
| **assistant(s)** | Persisted, long-lived agents with memory and skills. Distinct from "session." |
| **agent(s)** | The generic term for a runtime that takes prompts and acts. |
| **spatial canvas** | The board surface. Use sparingly — once per page, not every paragraph. |
| **isolation** | Worktree-level, environment-level, Unix-level. The security register. |
| **real-time** | What the multiplayer stack feels like; pairs with "presence." |
| **MCP / MCP server** | The agent-facing surface. Always uppercase. |
| **self-hosted** | Deployment posture. Not "on-prem" — wrong era. |

### ❌ Off-brand

| Word | Why we avoid it |
|---|---|
| **next-gen** | Empty intensifier. Used in `apps/agor-docs/pages/index.mdx:7` and `theme.config.tsx:83,85` — slated for removal. |
| **AI-powered** | Says nothing in 2026. Every product is. |
| **swarm** | Implies undirected mass; Agor is the opposite (named, orchestrated, observable). Currently in `apps/agor-docs/pages/guide/index.mdx:23` — slated for removal. |
| **spatial layer** | Infra metaphor for a UI product. From `apps/agor-docs/pages/index.mdx:8`. Use "spatial canvas" instead. |
| **revolutionary / revolutionize** | Marketing tic. We do not use it. |
| **10x / supercharge / unlock** | Hype register. We do not use it. |
| **productivity** | Vague benefit. Replace with the concrete capability ("parallel work without port collisions"). |
| **AI coding (as the only frame)** | Understates Agor — see "What Agor is NOT" item 1. Fine inside features pages where the context is coding; not fine in the headline. |
| **Figma for AI coding** | Retired. The comparison was useful early; it now caps the product. From `README.md:5` and `apps/agor-docs/pages/guide/index.mdx:16`. |
| **control plane** | Infra-flavored. Use "command center." |

---

## Audience tiers

Three audiences, three concrete pitches. Each starts from the same canonical
tagline and differentiates on what *changes* for that reader.

### 1. Solo dev with one agent

> **Team command center for all things agentic.** Even solo, Agor gives you
> a place where every agent run lands — branches don't collide, dev servers
> don't fight for ports, conversations don't disappear into terminal
> scrollback, and you can see at a glance what's running, what finished, and
> what stalled.

What they get: visibility, isolation, durable conversation history, a place
to land work.

### 2. Team lead with multiple devs each running agents

> **Team command center for all things agentic.** When five teammates each
> run two agents, the question stops being "is my agent working" and starts
> being "what is everyone's agent doing." Agor turns that into a shared
> board: live cursors, scoped comments, attention pulse on completed work,
> RBAC on worktrees, and a single audit trail across every session your
> team ran.

What changes: shared spatial awareness, RBAC, cross-team observability, no
more "share your screen" calls.

### 3. Platform engineer setting up Agor for an org

> **Team command center for all things agentic.** Agor is self-hosted, runs
> against LibSQL or Postgres, and supports four progressive isolation modes
> from open access to per-user Unix accounts with credential isolation.
> Agents reach internal tools through MCP servers you configure once; users
> get a UI that respects the OS permissions you've already invested in.

What changes: deployment modes (`simple` / `insulated` / `strict`), MCP
integration with internal tooling, sudoers-backed isolation when required,
audit + compliance posture.

---

## Where each form belongs

| Surface | Form | Notes |
|---|---|---|
| Docs landing Hero (`apps/agor-docs/pages/index.mdx`) | Tagline + short paragraph | Replace `subtitle="Next-gen agent orchestration for AI coding"` and the `description=` prop. |
| Guide overview (`apps/agor-docs/pages/guide/index.mdx`) | Tagline + short paragraph + TL;DR sentence | Currently 4 stacked one-liners (lines 16, 18, 20, 22–23) — collapse to one. |
| README intro (`README.md`) | Tagline + one-sentence + "What is Agor" bullets | Replace line 5–7. |
| Root `package.json` `description` | One-sentence (trimmed to fit npm registry rendering) | Replace `"Next-gen agent orchestration platform"`. |
| `packages/agor-live/package.json` `description` | One-sentence | Currently `"Multiplayer canvas for orchestrating AI coding sessions"` — refresh once tagline lands. |
| `theme.config.tsx` default `description` and `fullTitle` | One-sentence (description); tagline (title suffix) | Lines 83 and 85 — replace `"Next-gen agent orchestration"`. |
| GitHub repo description (Settings → About) | One-sentence | Public link previews. |
| Twitter / X bio, Discord description | Tagline only | Keep it to the headline. |
| Conference talk title slide | Tagline only | Optionally with a single subtitle: "Self-hosted. Multiplayer. MCP-native." |
| Blog post lead / announcement | Short or long paragraph depending on length | Long paragraph for first-touch posts. |
| Sales one-pager / partner deck | Long paragraph + audience-tiered pitches | Tier-2 and tier-3 pitches lead the doc. |
| OG / Twitter card meta description | One-sentence | Currently in `theme.config.tsx:82-83`. |
| JSON-LD `SoftwareApplication.description` | One-sentence | Currently in `theme.config.tsx:179-181`. |
| OSS directory listings (Awesome lists, Yo, etc.) | One-sentence | Match GitHub repo description. |

---

## Proposed `/guide/` hierarchy

The current `_meta.ts`
(`apps/agor-docs/pages/guide/_meta.ts`) is already grouped with separators
into Features / Reference / Development / Deployment. The grouping is
sensible. The proposal below mostly preserves it and tightens overlaps.

**Verdict: do not redesign. Tighten in place.** No page is an obvious
mistake; the docs are in much better shape than the homepage one-liners
suggest. Specific changes:

| Page | Verdict | Rationale |
|---|---|---|
| `index.mdx` | **Rewrite intro, keep structure** | Currently has 4 stacked taglines (lines 16, 18, 20, 22–23). Collapse to canonical tagline + short paragraph. |
| `getting-started.mdx` | **Keep** | Onboarding flow. Top-level. |
| `extended-install.mdx` | **Keep** | Alternative installs. Top-level. |
| `features-overview.mdx` | **Keep, retitle "What Agor does"** | Current title is fine; the page is the de-facto product map and is well-written. Consider linking to this messaging doc from the bottom (with a note that it's internal — or extract a public "positioning" page if we ever need one). |
| `worktrees.mdx` | **Keep — top-level concept** | One of the three foundations. |
| `sessions.mdx` | **Keep — top-level concept** | One of the three foundations. |
| `boards.mdx` | **Keep — top-level concept** | One of the three foundations. |
| `assistants.mdx` | **Keep — top-level concept** | The persisted-assistant pillar. Critical for the "all things agentic" framing. |
| `internal-mcp.mdx` | **Keep, consider rename to "Agor MCP server (built-in)"** | The current title in `_meta.ts` ("Agor MCP Server") is good; the file slug `internal-mcp` is fine. |
| `rich-chat-ux.mdx` | **Keep — top-level feature** | Differentiator vs. terminal CLI. |
| `multiplayer-social.mdx` | **Keep — top-level feature** | Cursors / facepile / comments / shared terminal. |
| `multiplayer-unix-isolation.mdx` | **Keep, but move under "Deployment" (already there)** | Already correctly grouped under Deployment in `_meta.ts:34-39`. Different concept from `multiplayer-social.mdx` — that one is the *user-facing* presence layer, this one is the *operator-facing* security mode. **They should NOT merge.** They have the same prefix because both relate to Agor's multi-user posture, but one is "what teammates see," the other is "how the OS protects them." Consider renaming for clarity: `multiplayer-social.mdx` → `presence-and-collaboration.mdx`, `multiplayer-unix-isolation.mdx` → `unix-isolation.mdx`. Flagging for Max — see "Open questions." |
| `environment-configuration.mdx` | **Keep** | Per-worktree dev servers. Top-level feature. |
| `scheduler.mdx` | **Keep** | Cron-style triggers. Top-level feature. |
| `cards.mdx` | **Keep — flagged Beta** | Generic non-code workflow units. Important for the "not just AI coding" framing. |
| `artifacts.mdx` | **Keep** | Sandpack-rendered apps. Top-level feature. |
| `message-gateway.mdx` | **Keep** | Slack / GitHub portals. Top-level feature. |
| `architecture.mdx` | **Keep — Reference** | Already grouped under Reference. |
| `typescript-client.mdx` | **Keep — Reference** | Already grouped under Reference. |
| `sdk-comparison.mdx` | **Keep — Reference** | Already grouped under Reference. |
| `development.mdx` | **Keep — Development** | Already grouped under Development. |
| `containerized-execution.mdx` | **Keep — Deployment** | Already grouped under Deployment. |

**Net change to hierarchy:** none. The cascade rollout's job is to update
copy on `index.mdx`, the Hero, and the README — not to restructure the guide.

**One additional suggestion** for the cascade: add a top-of-page summary
block on `features-overview.mdx` of the form "Agor is a *team command center
for all things agentic*. Below: the surfaces that make it that." — so the
features page anchors back to the canonical tagline.

---

## Survey appendix — current state

The phrases that exist in the codebase today, by file. This is the baseline
the cascade rollout will replace; cite this table when reviewing the cascade
PR.

### Taglines and pitch sentences

| File | Line | Quoted phrase | Category |
|---|---|---|---|
| `README.md` | 5 | "Think Figma, but for AI coding assistants. Orchestrate Claude Code, Codex, and Gemini sessions on a multiplayer canvas." | tagline + paragraph |
| `README.md` | 7 | "Agor is a multiplayer spatial canvas where you coordinate multiple AI coding assistants on parallel tasks, with GitHub-linked worktrees, automated workflow zones, and isolated test environments—all running simultaneously." | TL;DR paragraph |
| `README.md` | 98 | "Multiplayer spatial canvas with zones, worktrees, and real-time collaboration" | screenshot caption |
| `apps/agor-docs/pages/index.mdx` | 7 | "Next-gen agent orchestration for AI coding" | Hero subtitle |
| `apps/agor-docs/pages/index.mdx` | 8 | "The multiplayer-ready, spatial layer that connects Claude Code, Codex, Gemini, and any agentic coding tool into one unified workspace." | Hero description |
| `apps/agor-docs/pages/guide/index.mdx` | 3 | "Complete guide to agor - next-gen agent orchestration for AI coding. Learn about multiplayer workspaces, git worktrees, session trees, and real-time collaboration for Claude Code, Codex, and Gemini." | meta description |
| `apps/agor-docs/pages/guide/index.mdx` | 16 | "Think Figma, but for AI coding assistants." | tagline (#1) |
| `apps/agor-docs/pages/guide/index.mdx` | 18 | "Next-gen agent orchestration for AI coding. The multiplayer-ready, spatial layer that connects Claude Code, Codex, Gemini, and any agentic coding tool into one unified workspace." | tagline + paragraph (#2) |
| `apps/agor-docs/pages/guide/index.mdx` | 20 | "Agor is a multiplayer spatial canvas where you coordinate multiple AI coding assistants on parallel tasks…" | TL;DR paragraph (#3) |
| `apps/agor-docs/pages/guide/index.mdx` | 22–23 | "Visualize, coordinate, and automate your AI workflows across tools solo or with your team. Agor offers a place where you can coordinate entire swarms of AI agents." | follow-on paragraph (#4) |
| `apps/agor-docs/pages/guide/index.mdx` | 60 | "Multiplayer spatial canvas with custom-styled zones, session trees, and worktree pipelines" | screenshot caption |
| `apps/agor-docs/pages/guide/index.mdx` | 192 | "git tracks code, Agor tracks the conversations that produced it." | closing pull-quote |
| `apps/agor-docs/theme.config.tsx` | 83 | "Next-gen agent orchestration for AI coding. Multiplayer workspace for Claude Code, Codex, and Gemini." | default meta description |
| `apps/agor-docs/theme.config.tsx` | 85 | "agor – Next-gen agent orchestration" | site title fallback |
| `apps/agor-docs/theme.config.tsx` | 121 | "AI coding, agent orchestration, Claude Code, Codex, Gemini, AI development, multiplayer IDE, git worktrees, agentic coding, AI agents, developer tools" | meta keywords |
| `apps/agor-docs/theme.config.tsx` | 179–181 | "Next-gen agent orchestration for AI coding. Multiplayer workspace for Claude Code, Codex, and Gemini." | JSON-LD `SoftwareApplication.description` |

### `package.json` description fields

| File | Quoted phrase |
|---|---|
| `package.json` (root) | "Next-gen agent orchestration platform" |
| `packages/agor-live/package.json` | "Multiplayer canvas for orchestrating AI coding sessions" |
| `packages/client/package.json` | "TypeScript client for connecting to the Agor daemon" *(no positioning needed)* |
| `packages/executor/package.json` | "Agor executor process - isolated execution environment" *(no positioning needed)* |
| `packages/core/package.json` | *(no description)* |
| `apps/agor-cli/package.json` | *(no description)* |
| `apps/agor-daemon/package.json` | *(no description)* |
| `apps/agor-docs/package.json` | *(no description)* |
| `apps/agor-ui/package.json` | *(no description)* |

### Feature page tag-lines (kept, in scope only for future tightening)

These aren't competing top-level taglines — they're per-feature opening
hooks. Listed here for completeness; cascade rollout doesn't need to touch
them unless the wording references retired phrases.

| File | Quoted phrase |
|---|---|
| `apps/agor-docs/pages/guide/multiplayer-social.mdx:8` | "Agor is great solo. Multiplayer is what makes it Figma." |
| `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx:21` | "once upon a time, teams shared servers" |
| `apps/agor-docs/pages/guide/features-overview.mdx:70` | "Figma for AI coding." |

The two "Figma" references are the most important ones to revisit during
cascade — they're load-bearing on the retired comparison.

---

## Open questions for Max

These got flagged during drafting and need a call before the cascade lands:

1. **Rename `multiplayer-social.mdx` and `multiplayer-unix-isolation.mdx`?**
   They share a `multiplayer-` prefix but cover orthogonal concerns (one is
   user-facing presence; one is OS-level isolation). Suggested rename:
   `presence-and-collaboration.mdx` and `unix-isolation.mdx`. This is a
   redirect-tax cost vs. a clarity win. Defaulting to "leave the slugs, fix
   internal cross-references" unless you say otherwise.
2. **Keep "Figma" as a feature-page hook?** The README/Hero/landing
   "Figma for AI coding" framing is retired in this doc. The remaining
   in-the-wild references are the per-feature hooks listed in the survey
   appendix's last table. Rip them out entirely, or let them survive as
   inline color on feature pages where the spatial-canvas comparison still
   helps?
3. **Do we want a public version of this doc?** This file is internal /
   opinionated. A subset (canonical tagline + paragraph forms + audience
   tiers) could live as `apps/agor-docs/pages/about/positioning.mdx` for
   anyone evaluating Agor. Default: no — keep it internal until we have
   a clear external need.
4. **Replace the closing pull-quote** "git tracks code, Agor tracks the
   conversations that produced it." (`pages/guide/index.mdx:192`)? It's
   memorable and on-brand, but it leans on the "AI coding" frame. Keep it
   for now; flag for revisit if the broader "agentic" framing demands it.
