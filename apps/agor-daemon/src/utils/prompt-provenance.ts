import { shortId } from '@agor/core/db';
import {
  applyPromptProvenanceBlock,
  renderPromptProvenanceBlock,
} from '@agor/core/templates/prompt-provenance';
import type {
  BranchID,
  PersistedAgenticToolName,
  SessionID,
  TaskMetadata,
  UserID,
} from '@agor/core/types';

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
 * Render one agent-originated prompt's provenance and apply it to the body.
 *
 * The block names the origin by Session ID only. Branch and teammate names
 * are deliberately absent: the rendered text is persisted in `full_prompt`
 * and `rendered_block`, which every reader of the recipient Session can read,
 * so no single viewer's branch access can gate it. The recipient resolves the
 * origin with `agor_sessions_get`, which applies the reader's own RBAC.
 *
 * Pure and synchronous: no lookup can fail or slow delivery, and the same
 * stamp and body always produce the same text.
 */
export function resolvePromptProvenance(input: {
  stamp: McpPromptProvenanceStamp;
  /** Caller body with sentinels already neutralized by the admission route. */
  body: string;
  /** Sentinel occurrences the route neutralized, recorded on the stamp. */
  escapedSentinels: number;
  now?: () => Date;
}): PromptProvenanceResolution {
  const { stamp, body } = input;

  const block = renderPromptProvenanceBlock({
    ...(stamp.origin_session_id
      ? {
          origin: {
            sessionId: stamp.origin_session_id,
            sessionShortId: shortId(stamp.origin_session_id),
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
