/**
 * Shared tool status derivation and icon rendering.
 *
 * Used by both AgentChain (for chain items) and MessageBlock (for inline tools)
 * to avoid duplicating the stale-detection / icon-selection logic.
 */

import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { Spin, Tooltip } from 'antd';
import type React from 'react';

export type ToolStatus = 'success' | 'error' | 'pending' | 'stale';

/** Tools whose content is always shown expanded by default */
export const ALWAYS_EXPANDED_TOOLS = new Set(['Edit', 'Write', 'edit', 'write', 'edit_files']);

/**
 * Tools whose invocation payload itself represents terminal state, even without
 * a dedicated tool_result block.
 */
export const IMPLICIT_RESULT_TOOLS = new Set(['TodoWrite']);

interface ToolStatusInput {
  /** Whether a tool result exists */
  hasResult: boolean;
  /** Whether the result is an error */
  isError?: boolean;
  /**
   * Whether this tool is potentially still running.
   *
   * True when no subsequent tool in the block has a result AND the block
   * is still active (latest chain/message).  This correctly handles
   * concurrent tool calls: when multiple tools run in parallel none of
   * them have a subsequent result, so they all remain "pending".
   */
  isPotentiallyRunning: boolean;
  /** Whether the parent task is still running */
  isTaskRunning: boolean;
}

/**
 * Derive the display status for a tool block.
 *
 * Rules:
 * - Has result + error → 'error'
 * - Has result + no error → 'success'
 * - No result + potentially running + task running → 'pending' (spinner)
 * - No result + (not potentially running OR task done) → 'stale' (agent moved on)
 */
export function deriveToolStatus({
  hasResult,
  isError,
  isPotentiallyRunning,
  isTaskRunning,
}: ToolStatusInput): ToolStatus {
  if (hasResult) return isError ? 'error' : 'success';
  return isPotentiallyRunning && isTaskRunning ? 'pending' : 'stale';
}

/** Render the icon for a given tool status. */
export function renderToolStatusIcon(status: ToolStatus): React.ReactNode {
  switch (status) {
    case 'error':
      return <CloseCircleOutlined style={{ fontSize: 14 }} />;
    case 'success':
      return <CheckCircleOutlined style={{ fontSize: 14 }} />;
    case 'pending':
      return <Spin size="small" />;
    case 'stale':
      return (
        <Tooltip title="Agent moved on — result not captured">
          <ClockCircleOutlined style={{ fontSize: 14 }} />
        </Tooltip>
      );
  }
}
