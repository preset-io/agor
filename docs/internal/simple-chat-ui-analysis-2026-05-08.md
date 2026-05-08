# Simple Chat UI Analysis — 2026-05-08

> An agent's take on the question: *"Should Agor ship a simple, ChatGPT-like
> entry point for sessions, separate from the canvas?"* Max framed this with
> a strong prior of "probably not." After working through it, I agree, but
> not for the reasons he hinted at — and I think there's a small, related
> thing worth building that the framing was hiding.

---

## TL;DR

**Don't build a separate simple chat UI.** Agor's whole positioning ("team
command center for all things agentic," "one agent in a terminal is fine,
five is chaos") is a direct argument *against* shipping the same primitive
that ChatGPT and the agentic CLIs already nail. A second UI duplicates
maintenance, dilutes identity, and doesn't actually solve the friction it
claims to ("the canvas is scary" is not why people drop off — *bring-your-
own-runtime credentials and a repo* is).

**But there is a small, real thing here.** Three reuse-the-panel
adjustments — a focus-mode session route, a public read-only share view,
and the already-scoped Scratch quick-ask flow from the brainstorm doc —
capture every concrete upside the "simple UI" framing gestures at, without
adding a parallel surface. Build those. Skip the separate UI.

---

## Reframing the question

The phrasing "should we add a simple chat UI" hides four very different
proposals that have very different answers:

| Variant | What it actually is | My read |
|---|---|---|
| **A. Alt-app onboarding** — `/chat` route, no boards visible, designed to lower the bar for first-timers | A second product surface | **No.** Wrong wedge, wrong diagnosis of the friction. |
| **B. Focus mode** — existing session, canvas chrome hidden, a single session URL anyone in the team can deep-link to | A view of an existing session | **Yes** — small, cheap, mostly already there. |
| **C. Public read-only embed** — share a session URL with a non-Agor user (or embed in GitHub/Slack) | A sharing/artifact play | **Yes**, if marketing/demo argument is real. Defer until asked. |
| **D. Scratch** — quick ephemeral ask, no worktree, no persistence past today, for existing users | A new lightweight workflow | **Yes** — already scoped in the brainstorm doc as #12; the right shape. |

The conflation matters. **A** is the only one that's "a parallel UI." **B,
C, D** are features inside the existing UI that happen to look chat-y when
viewed in isolation. The right answer is "don't build A, do B+D, watch
for C."

The rest of this doc argues why A specifically is a bad bet.

---

## Steel-man for (A — separate simple UI)

I tried hard to make this case stand up. The strongest version:

1. **Lower the activation cliff.** A new visitor at agor.live faces an
   onboarding wizard that requires picking a repo, creating a worktree,
   adding API keys, picking an agent. That's a lot of forced choice
   before any value. A "just start chatting" entry point gives them
   something working in 30 seconds and earns the right to ask for the
   rest later.

2. **Demos and screenshots.** Every screenshot of Agor today requires
   explaining the canvas. A clean conversation view is dramatically
   easier to put in a tweet, a hero image, a "look what I just shipped"
   post. The canvas is the moat, but it's also a screenshot tax.

3. **Casual collaborator on-ramp.** A PM, a designer, a non-Agor teammate
   that someone wants to share a conversation with. Pointing them at a
   board makes them learn React Flow. Pointing them at a chat URL just
   works.

4. **Mobile.** `MobileApp.tsx` exists, but a session is still tethered
   to a worktree-on-a-board. A pure mobile read-and-prompt view that
   doesn't try to render the canvas is genuinely useful for catch-up.

5. **Pattern match on the market.** Linear added Linear Asks. Notion
   added Notion AI. Slack added in-channel Claude/GPT. Every workspace
   product has a chat surface now. There may be a "table stakes" element
   to having one.

This is a real list. None of these are bad arguments on their own. They
just don't survive contact with the actual diagnosis (next section).

---

## Steel-man against (A — separate simple UI)

1. **Identity dilution, structural.** The messaging-and-positioning doc
   (`context/messaging-and-positioning.md`) is unusually explicit: the
   tagline is *Team command center for all things agentic*, the lead
   problem statement is literally *"One agent in a terminal is fine. Five
   agents across a team is chaos. Agor is the workspace that makes that
   scale."* A single-chat UI is the **terminal-agent UX rendered in the
   browser**. It is the thing the positioning doc says is the *problem
   Agor solves*, not what Agor is. Shipping it as an entry point inverts
   the message at the door.

2. **Onboarding diagnosis is wrong.** The premise is "the canvas is
   intimidating, lower the bar." But look at where actual friction lives
   in the OnboardingWizard flow: *create or pick a repo → create a
   worktree → enter API keys → pick an agent*. The canvas is not a step.
   It's not where people drop off. People drop off because Agor is BYO-
   runtime and self-hosted — they need credentials for a runtime that
   costs money before they see anything. ChatGPT can be a drive-by
   because OpenAI bundles the inference. Agor cannot, by design. A
   simpler UI doesn't change that.

3. **Schema does not support it cheaply.** Sessions require a worktree
   FK in the schema (`packages/core/src/types/`), in the
   `NewSessionModal` props, and at the service layer. To do "chat
   without worktree" you'd need either (a) a hidden auto-created scratch
   worktree under the hood — at which point you're just hiding chrome,
   not building a new UI — or (b) a parallel "ephemeral chat" entity
   that lives outside the worktree spine. (b) is a tax that compounds
   forever: every new feature (RBAC, MCP token issuance, environments,
   Unix isolation, presence, comments, scheduler) has to either skip
   the new entity or be re-implemented for it.

4. **Two-UI maintenance compounds non-linearly.** Look at the existing
   session surface: token + dollar accounting, effort selector, model
   selector, queueing, MCP server pills, completion chimes, structured
   tool blocks, run-as identity, RBAC permission tiers, Unix-mode
   awareness, presence, comments, multiplayer terminal, fork/spawn
   genealogy. Every one of these is in `SessionPanel`. Either the
   simple UI strips them (now it is a strictly worse ChatGPT clone) or
   it inherits them (now it is the existing UI with the canvas hidden —
   which is **B, focus mode**, not a separate UI).

5. **The conversion problem is its own UX project.** "User had a great
   chat in simple UI, now wants to point an agent at their actual repo,
   how do they get there?" The honest answer is "create a worktree" —
   which is the same wall they were avoiding. So the simple UI is a
   leak, not a funnel: it gives you the dopamine hit and then tells
   you the real product requires the thing you were trying not to do.
   This is worse than no entry point.

6. **Multiplayer story breaks at the seam.** The whole point of Agor is
   "your team rallies around the same live work." Users in a chat UI
   don't show up on the canvas; users on the canvas don't see chat-UI
   sessions in their facepile. Either the data model unifies (and the
   chat UI inherits all the multiplayer plumbing — see point 4) or it
   doesn't (and the multiplayer pitch has an asterisk).

7. **Pattern match cuts the other way.** Linear, Notion, and Slack added
   chat *inside their existing UI*, not as a separate product surface.
   Linear Asks lives in the Linear UI. Notion AI is a slash command in
   a Notion doc. Slack's Claude/GPT lives in a thread. None of them
   shipped a sibling app at a different URL. The lesson is "add a chat
   *primitive* to the existing surface," which Agor already has — the
   session view *is* a chat. The thing those products did not do is
   "ship a separate chat-only app." That's the proposal here, and it
   has no precedent in the comp set.

8. **Opportunity cost.** The team's strategic doc has 30+ candidate bets
   (Watcher, Bench, cross-repo worktrees, zone macros, etc.) — every
   week building a parallel UI is a week not building things that make
   Agor *more* differentiated. A simple chat UI is a strict regression
   on differentiation per unit of build time.

The asymmetry is the point. The for-list is real but mostly addressable
some other way; the against-list is structural and hard to fight.

---

## Frameworks applied

### Wedge

Agor's wedge, per the positioning doc and the bullets in `README.md`, is
**multiplayer + worktree-anchored + multi-runtime**. None of those work in
a chat-only UI:

- Multiplayer requires a place to be — the canvas. Chat is solo by default.
- Worktree-anchored means the session is *about something* — a repo, a
  branch, a PR. Chat-without-worktree is by construction not anchored.
- Multi-runtime is a feature you only care about *if you already know you
  want to run code* — a casual chat user does not. The runtime selector
  is overhead in a simple UI; in the real UI it is a differentiator.

A simple UI lands on zero of three. That is the definition of an off-wedge
feature.

### 2-year vision

Reading the positioning doc's "What Agor is NOT": *"Not just for AI
coding"* and *"Not an LLM or model gateway."* Both cut against a chat-only
UI. The 2-year direction in the brainstorm doc and the audience-tier
breakdown is **toward the team**, not toward the indie/drive-by user. The
audience tiers explicitly start at "solo dev (visibility, isolation,
durable history)" — not "drive-by chat user." A simple UI is courting an
audience the product is not built for.

### Funnel diagnostic

I cannot tell from the repo where users actually drop off. There is no
analytics-funnel doc in `context/` or `docs/internal/`. The honest answer
is **"we don't know."** That alone should kill this proposal in its
current form: the case for a simple UI rests on a friction diagnosis no
one has actually instrumented.

What I'd want to see before greenlighting *any* onboarding rework:

- Drop-off rate at each step of the OnboardingWizard.
- Time-to-first-prompt for new users.
- % of users that abandon at "add API key."
- % of new sessions where the user picked "Assistant" path vs. "Own Repo"
  path. (If "Assistant" dominates, the wizard already *is* the simple
  path.)

If the data shows people churn at "API keys," a chat UI does not fix it.
If they churn at "create worktree," a Scratch quick-ask flow (default
scratch worktree, no naming required) fixes it inside the existing UI for
~5% of the cost of a parallel UI.

### MVP variants

Ranked by reuse:

1. **Focus-mode route** (`/s/:sessionId` deep link, hides board chrome,
   renders existing `SessionPanel` full-screen). Reuse: ~95%. New
   surface: a route + a `?focus=1` flag. **Cheap.**
2. **Read-only public share** (token-gated `/share/:token` route on the
   same component, no input box). Reuse: ~90%. New surface: a
   share-tokens table + a share button. **Modest.**
3. **Scratch quick-ask** (default per-user scratch worktree, "Quick ask"
   button on home, ephemeral retention policy). Reuse: ~80%. New
   surface: a default-worktree concept + a retention sweep job.
   **Modest.** Already scoped in `docs/feature-brainstorm-2026-05-08.md`
   #12.
4. **Separate simple-chat app** (`/chat`, distinct router, distinct
   create-flow that bypasses worktrees). Reuse: ~30% (would inherit
   `SessionPanel`, would need new data flow + create flow + nav). New
   surface: very large; multiplies forever. **Expensive and off-wedge.**

The first three buy ~80% of every concrete benefit the steel-man-for list
named, at <10% of the cost of #4.

### Reuse-not-duplicate alternative

This is the load-bearing observation. **Every legitimate use case for a
"simple UI" reduces to "render the existing session panel in a different
context."** Demos: focus-mode screenshot. Embeds: read-only share. Mobile:
focus-mode mobile route (already partially there). Quick-ask: Scratch.

There is no use case that genuinely requires a *parallel authoring UI
with a different data model*. If we cannot find one, we should not build
one.

---

## Recommendation

**Don't build A (separate simple chat UI). Build B + D in the next quarter,
hold C until asked.**

Concretely:

1. **B — Focus-mode session route.** Add `/s/:sessionId` (or
   `?focus=1`) that renders `SessionPanel` full-screen with board chrome
   collapsed. Use it for demos, screenshots, "send my teammate this
   conversation." Stays in-app. No new data model. Probably < 1 week.

2. **D — Scratch.** Pick up brainstorm doc item #12 as currently scoped:
   default scratch worktree per user, "Quick ask" entry button, ephemeral
   retention. This is the *real* "simple chat" idea hiding inside Max's
   question — but it's a feature for *existing users* who want a fast
   lane, not a top-of-funnel onboarding hack. Frame it that way.

3. **C — Read-only share** is a sharing problem, not a UI problem. Worth
   doing eventually for marketing/embed reasons, but only when there is
   a concrete demand (a sales conversation, a launch post, a partner
   integration). Don't build it speculatively.

4. **Explicitly do not.** Do not add a `/chat` route, a "simple session"
   create flow, or any session creation path that bypasses the worktree
   FK. The worktree-anchored data model is the wedge. Hide it in the
   UI when appropriate (Scratch); don't sever it underneath.

This recommendation matches Max's prior. I checked carefully whether to
push back. I don't think I should — the wedge argument is too strong and
the friction diagnosis is too unsupported. The thing I *do* want to push
back on is the framing: there is a real, smaller idea in here (Scratch +
focus mode), and "kill the simple UI" should not also kill that.

---

## What I'd want to know to be more confident

In order of importance:

1. **Onboarding funnel data.** Where do new users actually drop off?
   Without this, every "make it simpler" argument is vibes. If the data
   shows the canvas itself is a churn point, my recommendation softens.
   It would not flip — the wedge argument stands — but it would put more
   weight on focus-mode being the front door.

2. **What share of sessions are short-lived / single-task?** If a large
   fraction of real Agor sessions are one-prompt-and-done, Scratch is
   table-stakes. If they're nearly all long-running multi-task work,
   Scratch is a nice-to-have.

3. **Demo / sales testimony.** Is Max (or anyone doing GTM) actually
   blocked on screenshots or share links? If yes, focus-mode + share
   moves up. If "demos are fine," they stay deferred.

4. **Mobile usage data.** If mobile is non-trivial, a focus-mode mobile
   view is worth doing first because mobile users probably can't use
   the canvas at all. If mobile is rounding-error, defer.

5. **Have any existing users asked for it?** Discord, GitHub
   discussions, sales calls. The brainstorm doc was synthesized from
   issues and PRs — if "simple chat UI" is not in the issue tracker, we
   are inventing demand.

---

## Open follow-ups

- **Settle "is `/s/:sessionId` already implicitly there?"** The router
  defaults to `/b/:boardId/:sessionId` — there may already be a way to
  deep-link a session that I missed. If so, focus-mode is even cheaper:
  a CSS toggle on an existing route.
- **Decide where Scratch's default worktree lives.** Per-user scratch
  board? A reserved zone on the user's home board? Implementation
  detail, but it bears on Unix-isolation modes (strict mode requires a
  unix_username — does the scratch worktree run as that user?).
- **Public-share threat model.** If C ever happens, MCP token leakage
  risk needs explicit treatment (the existing
  `dangerously_allow_session_sharing` flag is the right place to look —
  see `context/explorations/session-sharing.md`).
- **Marketing / hero shot.** If the screenshot argument is the real
  driver, consider whether the hero asset should *change* (lead with a
  conversation, then reveal the canvas) — that's a copy/asset
  decision, not a product decision. Cheaper than building a UI to fix a
  screenshot problem.
