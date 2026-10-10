import type { BranchRepository } from '@agor/core/db';
import { shortId } from '@agor/core/db';
import {
  applyPromptProvenanceBlock,
  renderPromptProvenanceBlock,
} from '@agor/core/templates/prompt-provenance';
import type {
  BranchID,
  PersistedAgenticToolName,
  Session,
  SessionID,
  TaskMetadata,
  UserID,
} from '@agor/core/types';
import { getTeammateConfig } from '@agor/core/types';
import { isSuperAdmin } from './branch-authorization.js';

/**
 * Trusted prompt-origin stamp carried on `params._promptProvenance`.
 *
 * Built once per MCP request from the daemon's own authenticated state (see
 * `McpContext`) and never from the JSON-RPC envelope. It rides on
 * `ctx.baseServiceParams`, so every MCP-originated prompt carries it whether
 * or not the tool that sent it remembered to ask.
 */
export interface McpPromptProvenanceStamp {
  authenticated_by: 'session_token' | 'personal_api_key';
  origin_user_id: UserID;
  /** Display label for the Agor account - email, falling back to a short ID. */
  origin_user_label: string;
  /** Absent when the caller authenticated without naming an Agor Session. */
  origin_session_id?: SessionID;
  origin_branch_id?: BranchID;
  origin_agentic_tool?: PersistedAgenticToolName;
  /** MCP tool that delivered this prompt. Refined per call site. */
  tool?: string;
  mode?: string;
}

/**
 * Name the delivering tool (and mode) on an otherwise inherited stamp.
 *
 * Deliberately cosmetic: a call site that forgets this still produces a
 * stamped, rendered block, because presence comes from the request context
 * rather than from the call site. Only the label degrades.
 */
export function withPromptProvenanceTool<
  P extends { _promptProvenance?: McpPromptProvenanceStamp },
>(params: P, tool: string, mode?: string): P {
  if (!params._promptProvenance) return params;
  return {
    ...params,
    _promptProvenance: { ...params._promptProvenance, tool, ...(mode ? { mode } : {}) },
  };
}

/** Everything the admission route needs to gate and render one stamp. */
export interface PromptProvenanceResolution {
  /** Prompt text as admitted: the escaped caller body with the block applied. */
  prompt: string;
  metadata: NonNullable<TaskMetadata['prompt_provenance']>;
}

/**
 * Resolve, gate, and render one agent-originated prompt's provenance.
 *
 * Display names are resolved here rather than at stamp time because the gate
 * depends on the *recipient*: the origin Session's short ID is always
 * rendered, while the branch and teammate names are shown only when the
 * recipient Session's owner could read that branch anyway. Both sides are
 * already known to be in the same tenant, so this is intra-tenant RBAC only.
 *
 * Failing to resolve a name is not a failure to deliver. A withheld or missing
 * branch renders as withheld and the prompt still lands - the block is an
 * attestation of what the daemon knows, not a precondition for delivery.
 */
export async function resolvePromptProvenance(input: {
  stamp: McpPromptProvenanceStamp;
  /** Caller body with sentinels already neutralized by the admission route. */
  body: string;
  /** Sentinel occurrences the route neutralized, recorded on the stamp. */
  escapedSentinels: number;
  recipientSession: Pick<Session, 'created_by'>;
  branchRepo: BranchRepository;
  findUserRole: (userId: string) => Promise<string | undefined>;
  now?: () => Date;
}): Promise<PromptProvenanceResolution> {
  const { stamp, body, recipientSession, branchRepo } = input;

  let branchVisible = false;
  let branchName: string | undefined;
  let teammateName: string | undefined;

  if (stamp.origin_branch_id) {
    const branch = await branchRepo.findById(stamp.origin_branch_id);
    if (branch) {
      const recipientOwnerId = recipientSession.created_by as UserID;
      let permission = await branchRepo.resolveUserPermission(branch, recipientOwnerId);
      if (permission === 'none') {
        // Superadmins read every branch; the capability resolver answers
        // per-branch policy only. Looked up only on the denied path so the
        // ordinary case stays one query.
        const role = await input.findUserRole(recipientOwnerId);
        if (isSuperAdmin(role)) permission = 'all';
      }
      branchVisible = permission !== 'none';
      if (branchVisible) {
        branchName = branch.name;
        teammateName = getTeammateConfig(branch)?.displayName;
      }
    }
  }

  const block = renderPromptProvenanceBlock({
    ...(stamp.origin_session_id
      ? {
          origin: {
            sessionId: stamp.origin_session_id,
            sessionShortId: shortId(stamp.origin_session_id),
            branchVisible,
            ...(branchName ? { branchName } : {}),
            ...(teammateName ? { teammateName } : {}),
            ...(stamp.origin_agentic_tool ? { agenticTool: stamp.origin_agentic_tool } : {}),
          },
        }
      : {}),
    userLabel: stamp.origin_user_label,
    authenticatedBy: stamp.authenticated_by,
    tool: stamp.tool ?? 'an Agor MCP tool',
    ...(stamp.mode ? { mode: stamp.mode } : {}),
  });

  const { prompt, placement } = applyPromptProvenanceBlock(body, block);

  return {
    prompt,
    metadata: {
      version: 1,
      authenticated_by: stamp.authenticated_by,
      ...(stamp.origin_session_id ? { origin_session_id: stamp.origin_session_id } : {}),
      ...(stamp.origin_branch_id ? { origin_branch_id: stamp.origin_branch_id } : {}),
      origin_user_id: stamp.origin_user_id,
      ...(stamp.origin_agentic_tool ? { origin_agentic_tool: stamp.origin_agentic_tool } : {}),
      tool: stamp.tool ?? 'mcp',
      ...(stamp.mode ? { mode: stamp.mode } : {}),
      stamped_at: (input.now?.() ?? new Date()).toISOString(),
      rendered_block: block,
      placement,
      ...(input.escapedSentinels > 0 ? { escaped_sentinels: input.escapedSentinels } : {}),
    },
  };
}
