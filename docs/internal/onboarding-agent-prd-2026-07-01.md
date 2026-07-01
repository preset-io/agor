# /onboarding - Resumable Conversational Onboarding Agent - PRD

**Status:** Canonical spec for the `feature-onboarding-agent` branch. Supersedes prior scattered chat instructions in that session.
**Branch:** `feature-onboarding-agent`
**Date:** 2026-07-01

---

## 1. Background

Agor is a self-hosted, multiplayer command center for orchestrating AI coding agents on isolated git branches, with a spatial 2D board UI. Core terminology to use consistently in all copy and code:

- **Branch** - the unit of work in Agor. A first-class git working directory on its own branch with its own dev environment. Conventionally one branch per feature/PR.
- **Session** - an agent conversation, tied to a branch. Sessions can fork (sibling) or spawn (child).
- **Task** - a single prompt-and-execution within a session.
- **Board** - the spatial canvas where branches live as cards.
- **Zone** - a region on a board with an optional prompt template that fires when a branch is dropped in.
- **Assistant** - a persistent AI companion living in a branch, with its own memory and identity.
- **Environment** - the running dev server instance for a branch.
- **Knowledge** - the built-in searchable markdown knowledge base, used here for durable state.
- **MCP** - a pluggable integration/capability your agent can use (e.g. Slack, GitHub, Shortcut).
- **Cards** - how branches are represented visually on a board.
- **Artifact** - a live app/preview a session can produce, visible on the board.

A multi-step Onboarding Wizard already exists and runs on first open, but investigation found it's a single "Assistant" bootstrap flow in this codebase (not the originally assumed 5-step Clone/Board/Branch/API-Keys/Launch wizard) - "API key skipped" is inferred live via `agor_users_get_current`, not read from stored wizard step state. This feature fills the gap: a persistent, resumable, conversational onboarding agent living in the chat, dismissable and re-invocable, that picks up exactly where a user left off.

This flow is meant to trigger after "Feature 1" (a separate in-flight "Connect AI" empty state feature, branch `feature-connect-ai-empty-state`, not yet merged) succeeds. Since that branch isn't merged into `main` yet, this flow can't literally hook into Feature 1's event today - see the Trigger section below for the required fallback.

## 2. Investigation findings already confirmed

Reference only - re-verify if anything here seems stale by the time it's read.

1. No real custom slash commands exist in Agor's chat UI. `/onboarding` is implemented as a server-authored system prompt queued via the same `/sessions/:id/prompt` mechanism the `env_vars` widget's auto-resume already uses.
2. `AskUserQuestion` is fully disallowed in this codebase - all structured choices must be plain conversational text, not a structured prompt call.
3. Knowledge persistence: per-user private Knowledge namespace (e.g. `onboarding-<shortId(userId)>`), one `kind: 'memory'` document (`progress.md`), step state keyed by string id in `metadata` (not a fixed array) so new steps can append later without a schema change. Created by the agent itself on first write, not pre-provisioned server-side.
4. Manual re-entry affordance: new "Setup guide" icon button in the `SessionPanel` toolbar, matching the existing `Button type="text"` + `Tooltip` idiom already used for other toolbar actions (e.g. "More actions", "Close Panel").
5. `env_vars` widget's dismissal convention (three terminal states: `submitted`, `dismissed`, `already_present`; non-looping after dismissal - ask before re-requesting rather than auto-re-prompting) is the pattern to mirror for both single-step skip and whole-flow dismiss.

If any of these turn out to be wrong on re-check, note the correction explicitly rather than silently reverting to the original spec's assumption.

## 3. Trigger (activation precondition, not a flow step)

The flow's precondition is "AI credential confirmed resolved" for that user - not merely "the Onboarding Wizard created the user's assistant session." A session can exist without a working AI credential (that's precisely the bug Feature 1 fixes - today a session with no resolved credential shows a raw CLI passthrough error when the user tries to prompt it). If the onboarding kickoff prompt fires before a credential resolves, the kickoff message itself could hit that same broken path.

- Prefer hooking the trigger into wherever credential resolution success already happens server-side today (e.g. wherever a session's first successful model call happens, or wherever credential resolution is checked) - not session-creation time.
- If no such clean hook exists yet in `main`, fall back to a live resolution check (reuse whatever logic Feature 1's empty-state check uses, or its underlying function) immediately before firing the kickoff, rather than assuming "wizard ran" implies "credential resolved."
- Once Feature 1 merges, the long-term correct hook is its own success event (user completes the empty-state CTA) - note this explicitly as a documented follow-up integration point in the PR description, don't block on it.

## 4. Step list (canonical - replaces any earlier step list)

**"Connect an AI provider" is explicitly NOT an in-flow step.** It cannot be, because this agent only exists inside a working chat session, which cannot run without AI already connected - trying to track it as a done/skipped/not-started step is a logical contradiction. It is purely the activation trigger described above. Do not include it in the Knowledge state schema, the todo list, or the opening message's step framing.

Core steps (near-always active unless already done):

1. Point Agor at a repo and create a first branch.
2. Run a first real prompt in a session - the "aha" moment.

Optional steps (agent picks 1-3 of these based on early conversational read of what the user wants, or what's most relevant - not run mechanically every time):

3. Create/understand a board and a zone.
4. Invite a teammate, or set up a persistent assistant.
5. Connect an MCP server (e.g. Slack, GitHub, Shortcut) for richer context. Investigation should confirm today's actual connection flow (Settings page vs. inline) - if it's Settings/OAuth-based rather than something with an inline capture widget, deep-link there (mirroring how Feature 1 deep-links to Settings -> Agentic Tools) rather than building a new capture widget (out of scope per Non-goals).
6. See/create a first artifact. Investigation should confirm how artifacts currently surface in the UI (board, session view) so the agent points the user at the right existing place rather than building anything new.

**Judgment call:** steps 2 and 6 can be the same moment if it fits naturally - if the user's first real prompt would naturally produce a visible artifact (e.g. a small UI/preview task), nudge them toward that framing so the "aha" moment and the artifact introduction happen together, rather than forcing two separate asks.

**Hard constraint, still in force:** no more than 3-5 _active_ steps in any single flow run (2 core + up to 3 of the 4 optional).

## 5. Conversation design requirements

- Introduce a term (Branch, Board, Zone, Assistant, Environment, Knowledge, MCP, Cards, Artifact) only at the moment it's relevant to the step at hand, in 1-2 sentences - never front-load a glossary. Assume no prior familiarity with git worktrees or coding agents, but don't condescend to users who clearly have that background - read it from how they respond.
- Bias toward doing, not describing: if a step can be completed by one concrete action, guide the user straight into doing it. Generate the next concrete action immediately rather than waiting on "what next."
- Opening message: 2-3 sentences max. Say what this is, that it's optional/dismissible, how to bring it back later, then move straight into the first relevant step or question.
- Tone: collaborative and competent, like a teammate who's done this many times - not a corporate wizard, not falsely enthusiastic, not robotic. Match Agor's existing product copy voice if inferable; default direct and slightly informal.

## 6. Interaction and state requirements

- **Persistence:** per-user, private, `memory`-tagged Knowledge document (per finding #3 above). Must survive across sessions, days, devices.
- **Resumability:** read state first, before saying anything substantive, on every trigger. Skip done steps silently - no mechanical "skipping step 2" narration. Greet returning users with a one-line status ("last time you got your first branch set up - want to run your first prompt, or is something else on your mind?").
- **Short-circuit already-satisfied steps:** if a step's precondition is already true when reached, skip it silently - mirrors `env_vars` widget's `already_present` behavior.
- **Off-topic interruptions:** answer fully and naturally, then offer to resume ("want to keep going with setup, or good for now?"). Bookmark the current step internally so resume is accurate.
- **Skip vs. dismiss:** skipping a single step persists as skipped, doesn't auto-re-ask, but is still reachable if the user brings it up manually. Dismissing the whole flow persists and stops all auto-triggering - only re-enterable via explicit re-invocation. Mirror the `env_vars` widget's exact non-looping dismissal convention (don't re-request immediately - ask whether to proceed without, or move on).
- **Progress visibility:** Agor's existing inline Todo List rendering, always visible, never more than 5 items.
- **Completion:** one consistent closing message for "all steps done" or "flow dismissed," leaving the user clear on what's next and that setup can be reopened later.

## 7. Discovery banner (new UI chrome)

- One-time, dismissable banner shown on a user's first session ever (or the best available proxy if "first session ever" can't be cleanly detected - state which proxy and why).
- Points at the re-entry affordance ("Setup guide" button / confirmed equivalent). Rationale: solves discoverability even though the button/mechanism exists, since a brand-new user has no way to know it's there otherwise.
- Dismissal persists per-user, separate from onboarding flow progress itself (a user can dismiss this banner without ever starting or dismissing the onboarding flow). Check whether Agor already has a per-user UI-dismissal mechanism (e.g. via the `users` domain) to reuse before inventing new persistence or overloading the onboarding Knowledge doc.
- Component: Ant Design's existing dismissable alert/banner pattern, matching whatever's already used elsewhere in the app for one-time notices - not a new visual treatment.
- Copy: one short sentence plus a dismiss control. Example: "New here? Use the Setup guide anytime to get set up." (adjust wording to match the real affordance).

## 8. Claude-agent-specific best practices

- Do NOT use `AskUserQuestion` (confirmed disallowed in this codebase, finding #2) - use plain conversational text for all structured choices instead.
- One step or sub-decision per agent turn - don't stack unrelated asks.
- Write to Knowledge immediately after a step's true completion is confirmed, not speculatively or batched.
- Every write should be idempotent - a retried/duplicated trigger should not create duplicate Knowledge entries or double-fire the opening message. Check existing state before writing new state.
- Never narrate internal mechanics to the user ("I'm now checking your Knowledge state...") - do the check, then speak naturally based on the result.

## 9. UI/component requirements

- Most of this feature lives inside the existing chat transcript (text, inline Todo Lists) - no new visual components needed there.
- New UI chrome, both must be Ant Design components matching Agor's existing patterns exactly, no new component library or custom styling divergence:
  - The "Setup guide" re-entry button in `SessionPanel` toolbar (matches existing `Button type="text"` + `Tooltip` idiom).
  - The discovery banner (matches existing dismissable alert/banner pattern in the app).

## 10. Edge cases to explicitly handle

- User re-invokes the flow while a whole-flow dismissal is on record - respect it as an explicit request, resume from stored progress, don't treat it as contradicting the dismissal.
- Two team members on the same board, each with independent onboarding progress - state must be scoped per-user, not per-board or per-session.
- Step list/state schema should be appendable later without redesign (string-keyed metadata, not a fixed array - see finding #3).
- User skips a step, then later organically does that thing anyway outside the flow (e.g. connects a second MCP server unprompted) - don't contradict or re-ask about something already done if the conversation re-enters that area.
- Onboarding wizard was never run at all (e.g. self-hosted setups) - flow must still degrade gracefully, not assume wizard-specific state exists.

## 11. Explicit non-goals

- No new general-purpose widget types (confirmations, OAuth-connect flows, pickers). Only the `env_vars` widget exists today - reuse it for the credential step specifically; drive everything else through conversational text and inline Todo Lists (no `AskUserQuestion` per finding #2).
- Do not duplicate or replace the existing Onboarding Wizard.
- Do not modify credential storage, MCP token issuance, or Scheduler internals.
- Do not build analytics/instrumentation dashboards - just keep the state schema clean enough to be queryable for that later.

## 12. Testing / verification

- Full flow start to finish as a new user with nothing pre-configured, including the "aha" first-prompt step actually succeeding.
- Kill/reopen a session mid-flow - confirm resumption reflects true progress, no duplicate opening messages, no lost state.
- Skip-one-step, then dismiss-whole-flow, then manually re-invoke - confirm each behaves per spec, especially that dismiss doesn't auto-re-trigger and manual re-invocation overrides a prior dismissal.
- Off-topic interruption mid-step - confirm the agent answers fully, then correctly offers/executes resumption.
- "Already satisfied" short-circuit - confirm the flow degrades gracefully if the wizard never ran, and that steps skip silently when already true.
- Trigger-timing correctness: confirm the kickoff does NOT fire before a credential is confirmed resolved (not merely after the wizard runs).
- Discovery banner: confirm it shows once on first session, never again after dismissal, and dismissal is scoped per-user.
- Two different users on the same workspace/board - confirm state isolation.
- Run this repo's lint/typecheck/build/test commands and confirm clean.
- Read the full opening message and step transitions as a first-time, non-technical user - confirm nothing assumes un-introduced prior knowledge.

## 13. Definition of done

- Re-entry affordance reliably re-opens the flow from correct, true state at any time.
- A brand-new user is offered the flow automatically once their AI credential is confirmed resolved (not merely once a session/wizard exists), with a warm, correctly-oriented opening message.
- Core steps (repo+branch, first prompt) plus up to 3 relevant optional steps work end-to-end, including the user genuinely completing a first real prompt.
- Progress is visibly shown, persists correctly across sessions/days, distinguishes done/skipped/not-started per user, and does not track AI-connection as an in-flow step.
- Skip and dismiss behave per spec, including non-looping after dismissal.
- Off-topic interruptions handled gracefully with correct resumption.
- Discovery banner shows once per user, on first session, dismissable, never reappears after dismissal.
- No duplicate/contradictory behavior re-entering a partially-complete flow.
- Lint/typecheck/build/tests all pass.

## 14. Org conventions for this repo

- No em dashes anywhere in copy, docs, or PR text - use a short dash (-) instead.
- No `Co-Authored-By` lines in any commit.
- Run lint, typecheck, build, and test locally before pushing; batch fixes into sensible commits.
- Open the PR as a draft, no exceptions.
- No self-attribution or "generated by" language in the PR description.
- Pre-existing/unrelated CI failures are out of scope - note them and stop, don't expand scope.
