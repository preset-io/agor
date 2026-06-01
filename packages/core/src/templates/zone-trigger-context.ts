/**
 * Handlebars context shape for zone-trigger templates.
 *
 * Three sites render zone-trigger templates: the UI's live preview
 * (`ZoneTriggerModal`), the daemon's `POST /branches/:id/fire-zone-trigger`
 * route, and the MCP `agor_branches_set_zone(triggerTemplate: true)` tool.
 * Pre-consolidation each built a slightly different context — same template
 * could render differently depending on caller, which silently broke
 * user-saved templates that worked from one path but not another. All
 * three callers now build via this helper.
 *
 * **Both names are exposed on each scope** for backward compatibility:
 *   - `branch.context`  ← canonical (what UI templates use)
 *   - `branch.custom_context` ← alias (what MCP-fired templates used pre-PR)
 *
 * Same for `board` and `session`. Both keys point to the same object, so
 * templates authored against either shape keep working. New templates
 * should prefer `context`.
 */

export interface ZoneTriggerBranchInput {
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
  branch?: ZoneTriggerBranchInput;
  board?: ZoneTriggerBoardInput;
  zone?: ZoneTriggerZoneInput;
  session?: ZoneTriggerSessionInput;
}

/**
 * Build the canonical zone-trigger Handlebars context.
 *
 * Returns the same shape regardless of caller. Missing inputs become
 * empty-string / empty-object defaults so templates referencing
 * `{{branch.name}}` or `{{board.context.foo}}` don't render `undefined`.
 */
export function buildZoneTriggerContext(
  input: BuildZoneTriggerContextInput
): Record<string, unknown> {
  const { branch, board, zone, session } = input;
  // Same value bound to both `context` (canonical) and `custom_context`
  // (legacy alias) so templates from either pre-PR shape render identically.
  const branchCtx = branch?.custom_context ?? {};
  const boardCtx = board?.custom_context ?? {};
  const sessionCtx = session?.custom_context ?? {};
  const branchEntity = {
    name: branch?.name ?? '',
    ref: branch?.ref ?? '',
    issue_url: branch?.issue_url ?? '',
    pull_request_url: branch?.pull_request_url ?? '',
    notes: branch?.notes ?? '',
    path: branch?.path ?? '',
    context: branchCtx,
    custom_context: branchCtx,
  };
  return {
    branch: branchEntity,
    // v0.19 backwards-compat alias: keep `{{worktree.*}}` available for
    // existing zone-trigger templates. Shares the same object so updates
    // stay in sync. Prefer `{{branch.*}}` in new templates.
    worktree: branchEntity,
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
