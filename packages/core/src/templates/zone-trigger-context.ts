/**
 * Handlebars context shape for zone-trigger templates.
 *
 * Three sites render zone-trigger templates: the UI's live preview
 * (`ZoneTriggerModal`), the daemon's `POST /worktrees/:id/fire-zone-trigger`
 * route, and the MCP `agor_worktrees_set_zone(triggerTemplate: true)` tool.
 * Pre-consolidation each built a slightly different context — same template
 * could render differently depending on caller, which silently broke
 * user-saved templates that worked from one path but not another. All
 * three callers now build via this helper.
 *
 * **Both names are exposed on each scope** for backward compatibility:
 *   - `worktree.context`  ← canonical (what UI templates use)
 *   - `worktree.custom_context` ← alias (what MCP-fired templates used pre-PR)
 *
 * Same for `board` and `session`. Both keys point to the same object, so
 * templates authored against either shape keep working. New templates
 * should prefer `context`.
 */

export interface ZoneTriggerWorktreeInput {
  name?: string;
  ref?: string;
  issue_url?: string;
  pull_request_url?: string;
  notes?: string;
  path?: string;
  custom_context?: Record<string, unknown>;
}

export interface ZoneTriggerBoardInput {
  name?: string;
  description?: string;
  custom_context?: Record<string, unknown>;
}

export interface ZoneTriggerZoneInput {
  label?: string;
  status?: string;
}

export interface ZoneTriggerSessionInput {
  description?: string;
  custom_context?: Record<string, unknown>;
}

export interface BuildZoneTriggerContextInput {
  worktree?: ZoneTriggerWorktreeInput;
  board?: ZoneTriggerBoardInput;
  zone?: ZoneTriggerZoneInput;
  session?: ZoneTriggerSessionInput;
}

/**
 * Build the canonical zone-trigger Handlebars context.
 *
 * Returns the same shape regardless of caller. Missing inputs become
 * empty-string / empty-object defaults so templates referencing
 * `{{worktree.name}}` or `{{board.context.foo}}` don't render `undefined`.
 */
export function buildZoneTriggerContext(
  input: BuildZoneTriggerContextInput
): Record<string, unknown> {
  const { worktree, board, zone, session } = input;
  // Same value bound to both `context` (canonical) and `custom_context`
  // (legacy alias) so templates from either pre-PR shape render identically.
  const worktreeCtx = worktree?.custom_context ?? {};
  const boardCtx = board?.custom_context ?? {};
  const sessionCtx = session?.custom_context ?? {};
  return {
    worktree: {
      name: worktree?.name ?? '',
      ref: worktree?.ref ?? '',
      issue_url: worktree?.issue_url ?? '',
      pull_request_url: worktree?.pull_request_url ?? '',
      notes: worktree?.notes ?? '',
      path: worktree?.path ?? '',
      context: worktreeCtx,
      custom_context: worktreeCtx,
    },
    board: {
      name: board?.name ?? '',
      description: board?.description ?? '',
      context: boardCtx,
      custom_context: boardCtx,
    },
    zone: {
      label: zone?.label ?? '',
      status: zone?.status ?? '',
    },
    session: {
      description: session?.description ?? '',
      context: sessionCtx,
      custom_context: sessionCtx,
    },
  };
}
