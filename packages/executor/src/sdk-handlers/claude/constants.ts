/**
 * Claude-Code-specific constants for the executor's SDK handler.
 *
 * Sibling of `models.ts`. Anything that's a static configuration of the
 * Claude Agent SDK invocation (and not derived per-session) belongs here.
 */

/**
 * Built-in Claude Agent SDK tools that don't fit Agor's execution model.
 *
 * Agor sessions run non-interactively — there's no TTY, no shell-bound user,
 * and (in gateway channels like Slack) no UI to render an inline prompt. Tools
 * that require synchronous user interaction or that compete with Agor's own
 * worktree management have to be removed from the model's context entirely.
 *
 * - `AskUserQuestion`: blocks the executor waiting for an out-of-band answer.
 *   Hangs silently in Slack (#1177); the agent should inline its A/B/C
 *   choices in normal text and let the user reply as a new turn.
 * - `ExitPlanMode`: only meaningful inside Claude Code's interactive
 *   plan-mode UX. Agor doesn't expose plan-mode approval; the agent should
 *   produce plans as text in its response.
 * - `EnterWorktree` / `ExitWorktree`: Agor owns worktree lifecycle. Letting
 *   the agent create/switch/remove worktrees from inside its own session
 *   would nest worktrees on the same branch and could delete the session's
 *   CWD.
 *
 * Passed to the SDK via `Options.disallowedTools`, which removes the named
 * tools from the model's context. The list is unioned with whatever
 * `~/.claude/settings.json`'s `permissions.deny` already contains, so
 * user customizations are preserved.
 */
export const CLAUDE_CODE_DISALLOWED_TOOLS = [
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
] as const satisfies readonly string[];
