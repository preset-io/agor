/**
 * Canonical Handlebars context shape for zone-trigger templates.
 *
 * Three sites render zone-trigger templates: the UI's live preview
 * (`ZoneTriggerModal`), the daemon's `POST /worktrees/:id/fire-zone-trigger`
 * route, and the MCP `agor_worktrees_set_zone(triggerTemplate: true)` tool.
 * Pre-consolidation each built a slightly different context — same template
 * could render differently depending on caller, which silently broke
 * user-saved templates that worked from one path but not another.
 *
 * The canonical shape uses `worktree.context` / `board.context` (mapping
 * the underlying `custom_context` field to a friendlier name in templates),
 * plus `zone` and `session` for completeness. All three callers now build
 * via this helper.
 *
 * **Migration note:** the MCP path previously exposed
 * `worktree.custom_context` and `board.custom_context` directly. Templates
 * that referenced those paths from MCP firings need to migrate to
 * `worktree.context` / `board.context`.
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
  return {
    worktree: {
      name: worktree?.name ?? '',
      ref: worktree?.ref ?? '',
      issue_url: worktree?.issue_url ?? '',
      pull_request_url: worktree?.pull_request_url ?? '',
      notes: worktree?.notes ?? '',
      path: worktree?.path ?? '',
      context: worktree?.custom_context ?? {},
    },
    board: {
      name: board?.name ?? '',
      description: board?.description ?? '',
      context: board?.custom_context ?? {},
    },
    zone: {
      label: zone?.label ?? '',
      status: zone?.status ?? '',
    },
    session: {
      description: session?.description ?? '',
      context: session?.custom_context ?? {},
    },
  };
}
