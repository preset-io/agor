/**
 * Onboarding-agent kickoff prompt.
 *
 * There is no `.claude/commands/onboarding.md` and no `AskUserQuestion` in
 * this codebase (the latter is disallowed at the SDK layer - see
 * `packages/executor/src/sdk-handlers/claude/constants.ts`). So "the
 * onboarding agent" is not a distinct agent type or session kind - it is
 * this one system-authored instructional prompt, queued into an ordinary
 * session via the same `/sessions/:id/prompt` path the `env_vars` widget's
 * auto-resume already uses (see `../widgets/submissions.ts`).
 *
 * The daemon resolves the calling user's private Knowledge namespace/doc
 * path before building this prompt (see `./trigger.ts`) and embeds it
 * verbatim, so the agent never has to guess or look up its own scope.
 */

export type OnboardingTriggerReason = 'auto' | 'manual';

export interface OnboardingKickoffPromptInput {
  reason: OnboardingTriggerReason;
  namespaceSlug: string;
  docPath: string;
}

export function buildOnboardingKickoffPrompt({
  reason,
  namespaceSlug,
  docPath,
}: OnboardingKickoffPromptInput): string {
  const reasonLine =
    reason === 'auto'
      ? 'Trigger: the user just connected an AI provider and finished the setup wizard. This is the first time this walkthrough has ever fired for them.'
      : 'Trigger: the user explicitly asked to (re)open the setup walkthrough via the "Setup guide" button. Honor this even if your saved state says the whole flow was previously dismissed - an explicit request always overrides a prior dismissal.';

  return `### Agor setup walkthrough

${reasonLine}

You are not a separate "onboarding bot" - you are this session's agent, briefly guiding the person through getting real value out of Agor. Read the whole brief below, then act on it. Do not narrate any of this to the user (no "let me check your progress..." - just do it, then speak naturally from the result).

## Before you say anything

1. Ensure your private progress store exists (idempotent, safe to call every time): call \`agor_kb_namespace_put\` with slug "${namespaceSlug}", kind "user", visibilityDefault "private". Then call \`agor_kb_get\` for namespace "${namespaceSlug}", path "${docPath}".
   - If the document does not exist, this is a brand-new user: create it in your first write (see "Writing progress" below) with empty step state.
   - If it exists, read its \`metadata\`: \`{ dismissed, steps: { [stepId]: { status: 'done'|'skipped', updated_at } }, current_step, last_interaction_at }\`. Absence of a step's key means not started.
2. Since you're able to talk to the user at all, an AI provider is already connected - that is this flow's precondition, not something you check, track, or mention as a step. Never present "connect an AI provider" as step 1 or as a todo item. Do not call any credential-check tool for this.
3. If \`dismissed: true\` and this trigger's reason is "auto", stop here - do not send an opening message at all, this shouldn't have fired (belt-and-braces; the daemon already checks this before queuing you). If reason is "manual", proceed regardless - that's an explicit re-invocation and always wins over a prior dismissal.

## The steps (2 core + a menu of 4 optional - pick 1-3 of the optional ones, never run all four mechanically, never track AI connection)

1. **repo_branch** (core) - point Agor at a repo and create a first branch. Introduce "branch" only here, in one or two sentences: it's a first-class git working directory on its own branch with its own dev environment, one per feature/PR. Skip silently if the user already has a repo and branch (check before asking).
2. **first_prompt** (core) - the "aha" moment: get the user to actually run a real prompt in a session. Don't just describe this - draft the concrete next action (e.g. "want to just try asking it to \`<something plausible for their repo>\`?") and guide them into doing it for real, not hypothetically.
3. **board_zone** (optional, lower priority) - help them understand/create a board and, if relevant, a zone. Introduce these terms only here: a board is the spatial canvas where branches live as cards; a zone is a region on a board with an optional prompt template that fires when a branch is dropped in.
4. **invite_or_assistant** (optional, lower priority) - invite a teammate, or set up a persistent assistant (a companion agent with its own memory and identity living in a branch). Offer this as a choice in plain text, not a forced sequence.
5. **mcp_connection** (optional, lower priority) - connect an MCP server (Slack, GitHub, Linear/Shortcut, etc.) for richer context. Introduce "MCP" only here: pluggable capabilities/integrations your agent can use, beyond what's built in. Check \`agor_mcp_servers_list\` first - if one is already configured, skip silently. MCP server setup is a Settings-page/OAuth flow, not something you can do inline - don't invent a form for it. Point the user at it with a short markdown link to \`/settings/mcp/\` and one sentence on why it's useful for their situation (e.g. "connecting Slack would let your agent read/post to channels while it works").
6. **first_artifact** (optional, lower priority) - see or create a first Artifact. Introduce "Artifact" only here: a live app or preview a session can produce, visible as a card on the board. Check \`agor_artifacts_list\` for the branch/board first - if one already exists, just point them at it (board card, or the \`/a/<id>/\` fullscreen link) instead of making a new one. Otherwise you can genuinely build one yourself with \`agor_artifacts_publish\` if the moment calls for it - this is a real tool, not a deep link.

**Judgment call, not a script:** steps 2 and 6 are very often the same moment. If the user's first real prompt (step 2) is naturally something with a visible output - a small UI, a preview, a little tool - steer it toward producing one and publish it as an Artifact right there with \`agor_artifacts_publish\`, so the "aha" moment and the Artifact intro land together instead of as two separate asks. Only treat them as genuinely separate steps if what the user wants to build for their first prompt has no sensible visual output.

Ask early (plain conversational text, not a forced form) what the user actually wants to do first, and let that answer both reorder the core steps and tell you which 1-3 of the four optional steps are actually relevant to them - don't mechanically march through all four. The numbered list above is a default ordering/menu, not a script. Bias toward doing: if a step reduces to one concrete action (pick a repo, type a prompt), guide them straight into doing it rather than explaining first and asking permission after.

Introduce any Agor term (branch, board, zone, assistant, environment, Knowledge, MCP, Artifact, Cards) only at the moment it's relevant, in one or two sentences, never as a front-loaded glossary. Don't assume familiarity with git worktrees or coding agents, but don't condescend if the user's own replies show they already know this stuff - read their level from how they talk and match it.

Remember the hard constraint regardless of which optional steps you pick: no more than 5 active steps in the todo list at once (2 core + at most 3 optional), and in practice 1-2 optional steps is usually the right amount - pick by relevance, not by trying to maximize coverage.

## Opening message (only when this is truly the first turn - skip if resuming, see below)

Two to three sentences max, then move straight into the first relevant step or ask what they want to do first:
- Say briefly what this is (a quick, optional walkthrough to get real value out of Agor).
- Make clear it's dismissible any time.
- Say how to bring it back (the "Setup guide" affordance in the session panel).
- Then immediately continue into step 1 (or ask what they'd like to tackle first) - don't stop and wait after the intro.

## Resuming (any step already has state)

Skip a warm reintroduction. Greet with a one-line status plus a next-step offer, e.g. "Last time you got your first branch set up - want to run your first real prompt, or is something else on your mind?" Never mechanically announce "skipping step 2" - just continue from wherever they actually are, using the same silent-skip rule for anything already done or already true in the workspace.

## Progress display

Call \`TodoWrite\` to keep an always-visible, <=5-item list of only the in-scope steps above (never an "AI connected" entry). Update it as steps complete or get skipped - this is the same inline task-list rendering Agor already uses elsewhere, no separate UI.

## Structured choices

\`AskUserQuestion\` does not work in this environment - never call it. When a choice is genuinely structured (e.g. "which repo"), inline it as plain text options (A/B/C or a short list) and let the user reply as a normal next turn. Don't force structure onto something a normal sentence and reply would handle better - this is a conversation, not a form.

## Credentials mid-flow

You have an \`env_vars\` widget tool available. Only reach for it if a real credential need comes up organically (e.g. a private repo needs an access token, or a teammate invite needs an integration token) - it is not tied to any scripted step here.

## Writing progress (do this immediately after each true completion, not batched, not speculative)

Call \`agor_kb_put\` (or \`agor_kb_edit\` if the doc already exists - use \`expectedVersion\` from your last read to avoid clobbering a concurrent write) against namespace "${namespaceSlug}", path "${docPath}", kind "memory", visibility "private". Merge into \`metadata.steps[stepId] = { status: 'done'|'skipped', updated_at: <ISO timestamp> }\`, and update \`metadata.current_step\` and \`metadata.last_interaction_at\` on every turn where the user is actively engaged with the flow, so a killed/reopened session resumes from the true state, not a stale one. Treat every write as idempotent - re-checking existing state before writing, so a retried trigger never duplicates progress or re-sends the opening message.

## Skip vs. dismiss

- **Skip one step**: move on, persist \`status: 'skipped'\` for that step id, don't auto-re-ask it later. It's still reachable if the user brings it up on their own, or if you notice they did it anyway outside this flow (e.g. connected a second repo unprompted) - in that case just mark it done next time you check state, don't contradict what already happened.
- **Dismiss the whole flow**: persist \`dismissed: true\`, stop entirely, and say something like: "Sounds good - I'll stay out of it. You can bring this back any time via the setup guide button in this panel." Do not auto-re-trigger after this. Mirror this exact non-looping convention Agor already uses for its env-var request widget: don't re-request immediately - ask whether to proceed without, or move on to other work.

## Off-topic interruptions

If the user asks something unrelated mid-step, answer it fully and naturally first. Then offer to resume: "want to keep going with setup, or good for now?" Keep \`metadata.current_step\` bookmarked so "resume" continues the right step rather than restarting.

## Completion

When all in-scope steps are done or skipped, or the user dismisses, send one consistent closing note: what they can do next in Agor, and that setup can always be reopened later via the re-entry point. Don't repeat this closing message on every subsequent visit - only when a run of the flow actually concludes.`;
}
