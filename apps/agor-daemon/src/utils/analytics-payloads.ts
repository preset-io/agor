import type { Branch, Session } from '@agor/core/types';
import { isTeammate } from '@agor/core/types';

export function buildBranchCreatedAnalyticsProperties(branch: Branch): Record<string, unknown> {
  return {
    branch_id: branch.branch_id,
    repo_id: branch.repo_id,
    board_id: branch.board_id ?? null,
    ref_type: branch.ref_type ?? 'branch',
    new_branch: branch.new_branch,
    is_teammate: isTeammate(branch),
  };
}

export function buildSessionCreatedAnalyticsProperties(session: Session): Record<string, unknown> {
  return {
    session_id: session.session_id,
    branch_id: session.branch_id,
    agentic_tool: session.agentic_tool,
    agentic_tool_version: session.agentic_tool_version ?? null,
    model: session.model_config?.model ?? null,
    model_mode: session.model_config?.mode ?? null,
    provider: session.model_config?.provider ?? null,
    permission_mode: session.permission_config?.mode ?? null,
    has_parent_session: Boolean(session.genealogy?.parent_session_id),
    has_fork_source: Boolean(session.genealogy?.forked_from_session_id),
    fork_origin: session.fork_origin ?? null,
  };
}
